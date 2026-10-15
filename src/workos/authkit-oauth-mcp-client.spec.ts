/**
 * End to end, as an MCP client sees the AuthKit domain: over real HTTP against a running emulator,
 * holding no API key, learning every URL from discovery and verifying the tokens it is given
 * against the JWKS discovery names — the way an MCP resource server would, with nothing shared
 * with the emulator's in-process state. Only the seeded user and the resource indicator are set up
 * out of band, as the environment's owner would in the dashboard.
 */
import { createHash, createPublicKey, createVerify, randomBytes, type JsonWebKey } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createEmulator, type Emulator } from '../index.js';
import { getWorkOSStore } from './store.js';

const RESOURCE = 'https://mcp.example.test/mcp';
const REDIRECT_URI = 'http://localhost:33418/callback';

interface Jwks {
  keys: Array<JsonWebKey & { kid: string; alg?: string; use?: string }>;
}

/** What a resource server does with a bearer token: check the signature against the JWKS, then the claims. */
function verifyAccessToken(token: string, jwks: Jwks): { header: Record<string, any>; claims: Record<string, any> } {
  const [headerB64, payloadB64, signature] = token.split('.');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
  expect(header.alg).toBe('RS256');
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  expect(jwk).toBeDefined();
  const verifier = createVerify('RSA-SHA256').update(`${headerB64}.${payloadB64}`);
  expect(verifier.verify(createPublicKey({ key: jwk!, format: 'jwk' }), signature, 'base64url')).toBe(true);
  expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  return { header, claims };
}

describe('MCP client against the AuthKit OAuth server', () => {
  let emulator: Emulator;

  beforeAll(async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'alice@acme.test', first_name: 'Alice' }],
        organizations: [{ name: 'Acme', memberships: [{ email: 'alice@acme.test' }] }],
        resourceIndicators: [{ uri: RESOURCE }],
      },
    });
  });

  afterAll(async () => {
    await emulator.close();
  });

  const postForm = (url: string, body: Record<string, string>) =>
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });

  /** Follow redirects by hand until one lands on the client's own callback, as a browser would. */
  async function followToCallback(start: string): Promise<URL> {
    let next = start;
    for (let hop = 0; hop < 5; hop++) {
      const res = await fetch(next, { redirect: 'manual' });
      expect(res.status).toBe(302);
      next = new URL(res.headers.get('location')!, next).toString();
      if (next.startsWith(REDIRECT_URI)) return new URL(next);
    }
    throw new Error('never reached the callback');
  }

  it('discovers, registers, authorizes with PKCE and a resource, exchanges, verifies and refreshes', async () => {
    // 1. Discovery, unauthenticated.
    const discovery = await fetch(`${emulator.url}/.well-known/oauth-authorization-server`);
    expect(discovery.status).toBe(200);
    const metadata = (await discovery.json()) as Record<string, any>;
    expect(metadata.issuer).toBe(emulator.url);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
    expect(metadata.token_endpoint_auth_methods_supported).toContain('none');

    // 2. Dynamic client registration: a public client.
    const registration = await fetch(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'MCP test client',
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(registration.status).toBe(201);
    const client = (await registration.json()) as { client_id: string };

    // 3. Authorize with PKCE and the RFC 8707 resource; the hosted sign-in completes on its own
    // because the emulator is not interactive.
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(8).toString('hex');
    const callback = await followToCallback(
      `${metadata.authorization_endpoint}?${new URLSearchParams({
        response_type: 'code',
        client_id: client.client_id,
        redirect_uri: REDIRECT_URI,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: 'openid profile offline_access',
        state,
        resource: RESOURCE,
      })}`,
    );
    expect(callback.searchParams.get('state')).toBe(state);
    const code = callback.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // 4. Exchange: no client secret, only the verifier.
    const tokenResponse = await postForm(metadata.token_endpoint, {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      resource: RESOURCE,
    });
    expect(tokenResponse.status).toBe(200);
    const tokens = (await tokenResponse.json()) as Record<string, any>;
    // Production's code-exchange field set: lowercase `bearer`, an `id_token`, no `scope`.
    expect(tokens).toMatchObject({ token_type: 'bearer', expires_in: 3600 });
    expect(tokens.id_token.split('.')).toHaveLength(3);
    expect(tokens).not.toHaveProperty('scope');
    // `offline_access` was granted, so a refresh token comes with it.
    expect(tokens.refresh_token).toMatch(/^ref_/);

    // 5. Verify against the JWKS discovery named.
    const jwks = (await (await fetch(metadata.jwks_uri)).json()) as Jwks;
    const ws = getWorkOSStore(emulator.store);
    const alice = ws.users.findOneBy('email', 'alice@acme.test')!;
    const first = verifyAccessToken(tokens.access_token, jwks);
    expect(first.claims).toMatchObject({
      iss: metadata.issuer,
      aud: RESOURCE,
      sub: alice.id,
      client_id: client.client_id,
      // Sorted, as production formats the claim.
      scope: 'offline_access openid profile',
    });
    expect(typeof first.claims.auth_time).toBe('number');
    expect(first.claims.org_id).toBe(ws.organizations.findOneBy('name', 'Acme')!.id);
    expect(first.claims.sid).toBeTruthy();
    expect(first.claims.jti).toBeTruthy();
    expect(first.claims).not.toHaveProperty('email');

    // 6. Refresh, then verify the new token the same way.
    const refreshed = await postForm(metadata.token_endpoint, {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as Record<string, any>;
    expect(next.refresh_token).not.toBe(tokens.refresh_token);
    const second = verifyAccessToken(next.access_token, jwks);
    expect(second.claims).toMatchObject({
      iss: metadata.issuer,
      aud: RESOURCE,
      sub: alice.id,
      client_id: client.client_id,
      sid: first.claims.sid,
    });
    expect(second.claims.jti).not.toBe(first.claims.jti);

    // The spent refresh token is refused.
    const replay = await postForm(metadata.token_endpoint, {
      grant_type: 'refresh_token',
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
  });
});
