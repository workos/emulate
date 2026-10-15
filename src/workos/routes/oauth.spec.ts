import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin, seedFromConfig } from '../index.js';
import { getWorkOSStore } from '../store.js';
import type { Store } from '../../core/index.js';
import type { JWTManager } from '../../core/jwt.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' } };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

/** Seed an org + an m2m Connect Application with pinned creds and scopes. */
function seedM2M(store: Store) {
  seedFromConfig(store, 'http://localhost:0', {
    organizations: [{ name: 'Acme' }],
    connectApplications: [
      {
        name: 'Billing Service',
        type: 'm2m',
        organization: 'Acme',
        client_id: 'client_billing',
        client_secret: 'secret_billing_value',
        scopes: ['invoices:read', 'invoices:write'],
      },
    ],
  });
}

describe('OAuth M2M token routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;
  let jwt: JWTManager;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
    jwt = server.jwt;
    seedM2M(store);
  });

  const form = (body: Record<string, string>) =>
    app.request('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  const json = (res: Response) => res.json() as Promise<any>;

  it('exchanges client_credentials for a signed JWT carrying scopes (form-encoded)', async () => {
    const res = await form({
      grant_type: 'client_credentials',
      client_id: 'client_billing',
      client_secret: 'secret_billing_value',
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.token_type).toBe('bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe('invoices:read invoices:write');

    // The token validates against the emulator's signing key (the one served at JWKS).
    const claims = jwt.verify(body.access_token);
    expect(claims.sub).toBe('client_billing');
    expect(claims.aud).toBe('client_billing');
    expect(claims.iss).toBe('http://localhost:0');
    // Space-delimited `scope` string, not a `scp` array — what production emits and what
    // the SDKs read. An array here would pass locally and break against the real API.
    expect(claims.scope).toBe('invoices:read invoices:write');
    expect(claims.org_id).toMatch(/^org_/);
    // The SDKs' M2M claim guard requires `jti`; without it a valid token reads as invalid.
    expect(claims.jti).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('gives each token a distinct jti', async () => {
    const credentials = {
      grant_type: 'client_credentials',
      client_id: 'client_billing',
      client_secret: 'secret_billing_value',
    };
    const first = jwt.verify((await json(await form(credentials))).access_token);
    const second = jwt.verify((await json(await form(credentials))).access_token);
    expect(first.jti).not.toBe(second.jti);
  });

  it('accepts a JSON body', async () => {
    const res = await app.request('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: 'client_billing',
        client_secret: 'secret_billing_value',
      }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).access_token).toBeDefined();
  });

  it('accepts client credentials via HTTP Basic auth', async () => {
    const basic = Buffer.from('client_billing:secret_billing_value').toString('base64');
    const res = await app.request('/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).access_token).toBeDefined();
  });

  it('narrows to a requested subset of scopes', async () => {
    const res = await form({
      grant_type: 'client_credentials',
      client_id: 'client_billing',
      client_secret: 'secret_billing_value',
      scope: 'invoices:read',
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.scope).toBe('invoices:read');
    expect(jwt.verify(body.access_token).scope).toBe('invoices:read');
  });

  it('ignores a caller-supplied organization_id; the token org is the application org', async () => {
    const res = await form({
      grant_type: 'client_credentials',
      client_id: 'client_billing',
      client_secret: 'secret_billing_value',
      organization_id: 'org_attacker',
    });
    expect(res.status).toBe(200);
    const claims = jwt.verify((await json(res)).access_token);
    expect(claims.org_id).not.toBe('org_attacker');
    expect(claims.org_id).toMatch(/^org_/);
  });

  it('rejects a requested scope the application does not have', async () => {
    const res = await form({
      grant_type: 'client_credentials',
      client_id: 'client_billing',
      client_secret: 'secret_billing_value',
      scope: 'invoices:read admin:all',
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_scope');
  });

  it('rejects an invalid client secret', async () => {
    const res = await form({
      grant_type: 'client_credentials',
      client_id: 'client_billing',
      client_secret: 'wrong',
    });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('invalid_client');
  });

  it('rejects an unknown client_id', async () => {
    const res = await form({
      grant_type: 'client_credentials',
      client_id: 'client_nope',
      client_secret: 'secret_billing_value',
    });
    expect(res.status).toBe(401);
    expect((await json(res)).error).toBe('invalid_client');
  });

  it('rejects an unsupported grant_type', async () => {
    const res = await form({
      grant_type: 'password',
      client_id: 'client_billing',
      client_secret: 'secret_billing_value',
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('unsupported_grant_type');
  });

  it('rejects the client_credentials grant for a non-m2m (oauth) application', async () => {
    seedFromConfig(store, 'http://localhost:0', {
      connectApplications: [
        {
          name: 'Web App',
          type: 'oauth',
          client_id: 'client_web',
          client_secret: 'secret_web',
          redirect_uris: ['http://localhost:3000/cb'],
        },
      ],
    });
    const res = await form({
      grant_type: 'client_credentials',
      client_id: 'client_web',
      client_secret: 'secret_web',
    });
    // Production's client_credentials handler: the grant is not enabled for the application, which
    // it answers as a client failure, without the Basic challenge or a description.
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'invalid_client' });
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('rejects authorization_code for an m2m application', async () => {
    const res = await form({
      grant_type: 'authorization_code',
      client_id: 'client_billing',
      client_secret: 'secret_billing_value',
      code: 'any_code',
      redirect_uri: 'http://localhost:3000/cb',
    });
    // The authorization-code grant is likewise not enabled for an M2M application.
    expect(res.status).toBe(401);
    expect(await json(res)).toEqual({ error: 'invalid_client' });
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  it('requires no API key (token endpoint is public)', async () => {
    // No Authorization header at all — must not be rejected by the auth middleware.
    const res = await form({
      grant_type: 'client_credentials',
      client_id: 'client_billing',
      client_secret: 'secret_billing_value',
    });
    expect(res.status).toBe(200);
  });

  it('serves the M2M JWKS publicly', async () => {
    const res = await app.request('/oauth2/jwks');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(Array.isArray(body.keys)).toBe(true);
    expect(body.keys[0].kid).toBeDefined();
    expect(body.keys[0].use).toBe('sig');
  });

  it('mints the configured audience as the aud claim when the app pins one', async () => {
    const ws = getWorkOSStore(store);
    const org = ws.organizations.findOneBy('name', 'Acme')!;
    const appRec = ws.connectApplications.insert({
      object: 'connect_application',
      name: 'Audience Svc',
      description: null,
      application_type: 'm2m',
      organization_id: org.id,
      scopes: ['x:read'],
      audience: 'https://api.acme.test',
      redirect_uris: [],
      client_id: 'client_aud',
      logo_url: null,
      login_url: null,
      is_first_party: true,
      was_dynamically_registered: false,
      uses_pkce: false,
    });
    ws.clientSecrets.insert({
      object: 'connect_application_secret',
      application_id: appRec.id,
      value: 'secret_aud',
      secret_hint: '_aud',
      last_used_at: null,
    });

    const res = await form({ grant_type: 'client_credentials', client_id: 'client_aud', client_secret: 'secret_aud' });
    expect(res.status).toBe(200);
    expect(jwt.verify((await json(res)).access_token).aud).toBe('https://api.acme.test');
  });

  it('handles a client secret containing a percent sign via Basic auth without erroring', async () => {
    const ws = getWorkOSStore(store);
    const org = ws.organizations.findOneBy('name', 'Acme')!;
    const appRec = ws.connectApplications.insert({
      object: 'connect_application',
      name: 'Percent Svc',
      description: null,
      application_type: 'm2m',
      organization_id: org.id,
      scopes: ['x:read'],
      audience: null,
      redirect_uris: [],
      client_id: 'client_percent',
      logo_url: null,
      login_url: null,
      is_first_party: true,
      was_dynamically_registered: false,
      uses_pkce: false,
    });
    ws.clientSecrets.insert({
      object: 'connect_application_secret',
      application_id: appRec.id,
      value: 'secret_%_local',
      secret_hint: 'ocal',
      last_used_at: null,
    });

    const basic = Buffer.from('client_percent:secret_%_local').toString('base64');
    const res = await app.request('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    // The literal `%` must not crash the decode; valid creds yield a token.
    expect(res.status).toBe(200);
    expect((await json(res)).access_token).toBeDefined();
  });

  it('does not crash or substring-match when stored scopes are a malformed non-array', async () => {
    const ws = getWorkOSStore(store);
    const org = ws.organizations.findOneBy('name', 'Acme')!;
    const appRec = ws.connectApplications.insert({
      object: 'connect_application',
      name: 'Malformed Scopes',
      description: null,
      application_type: 'm2m',
      organization_id: org.id,
      // Simulate a value persisted through an unguarded path.
      scopes: 'admin:all' as unknown as string[],
      audience: null,
      redirect_uris: [],
      client_id: 'client_malformed',
      logo_url: null,
      login_url: null,
      is_first_party: true,
      was_dynamically_registered: false,
      uses_pkce: false,
    });
    ws.clientSecrets.insert({
      object: 'connect_application_secret',
      application_id: appRec.id,
      value: 'secret_malformed',
      secret_hint: 'rmed',
      last_used_at: null,
    });

    // No scope requested: must not throw on a non-array (no .join on a string).
    const noScope = await form({
      grant_type: 'client_credentials',
      client_id: 'client_malformed',
      client_secret: 'secret_malformed',
    });
    expect(noScope.status).toBe(200);
    expect(await json(noScope)).not.toHaveProperty('scope');

    // A scope must not be accepted by substring-matching the stored string.
    const scoped = await form({
      grant_type: 'client_credentials',
      client_id: 'client_malformed',
      client_secret: 'secret_malformed',
      scope: 'admin',
    });
    expect(scoped.status).toBe(400);
    expect((await json(scoped)).error).toBe('invalid_scope');
  });
});

/**
 * Client failures at the token endpoint. Observed against a production AuthKit domain, 2026-09-30:
 * no client is `401 invalid_client` "Missing authorization header."; an unknown client_id is
 * `401 invalid_client` "Application not found." under every grant type, an unsupported one
 * included (so the client lookup runs before grant-type validation); both carry
 * `WWW-Authenticate: Basic realm="AuthKit"`. This deliberately replaces the endpoint's earlier
 * 400s for a missing client and its 401 with a different description for an unknown one.
 */
describe('OAuth token endpoint client errors', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    seedM2M(server.store);
  });

  const post = (body: Record<string, string>) =>
    app.request('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
  const expectInvalidClient = async (res: Response, description: string) => {
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="AuthKit"');
    expect(await res.json()).toEqual({ error: 'invalid_client', error_description: description });
  };

  it('answers no client at all with Missing authorization header', async () => {
    await expectInvalidClient(await post({ grant_type: 'client_credentials' }), 'Missing authorization header.');
    await expectInvalidClient(await post({}), 'Missing authorization header.');
  });

  it('answers a known confidential client that presents no secret with Missing client_secret', async () => {
    // Production's ApplicationCredentialsOrPublicClientGuard, for a client that is not public.
    await expectInvalidClient(
      await post({ grant_type: 'client_credentials', client_id: 'client_billing' }),
      'Missing client_secret.',
    );
  });

  it('answers a wrong secret with Application not found, as the credentials lookup does', async () => {
    await expectInvalidClient(
      await post({ grant_type: 'client_credentials', client_id: 'client_billing', client_secret: 'secret_wrong' }),
      'Application not found.',
    );
  });

  it('answers an unknown client_id with Application not found under every grant type', async () => {
    const bodies: Record<string, string>[] = [
      { grant_type: 'client_credentials' },
      { grant_type: 'client_credentials', client_secret: 'secret_billing_value' },
      { grant_type: 'authorization_code', code: 'x', redirect_uri: 'http://localhost:3000/cb' },
      { grant_type: 'refresh_token', refresh_token: 'ref_x' },
      { grant_type: 'not_a_grant' },
      {},
    ];
    for (const body of bodies) {
      await expectInvalidClient(await post({ client_id: 'client_nope', ...body }), 'Application not found.');
    }
  });

  it('checks the client before the grant type', async () => {
    const known = await post({
      grant_type: 'not_a_grant',
      client_id: 'client_billing',
      client_secret: 'secret_billing_value',
    });
    expect(known.status).toBe(400);
    expect(await known.json()).toEqual({
      error: 'unsupported_grant_type',
      error_description: "Unsupported grant_type: 'not_a_grant'.",
    });
    // And the secret before the grant type: a confidential client's wrong secret is the client's
    // failure whatever grant it names, as production's guards run before its body validation.
    await expectInvalidClient(
      await post({ grant_type: 'not_a_grant', client_id: 'client_billing', client_secret: 'wrong' }),
      'Application not found.',
    );
    await expectInvalidClient(
      await post({ grant_type: 'not_a_grant', client_id: 'client_billing' }),
      'Missing client_secret.',
    );
    // No grant type at all is an invalid body, once the client is authenticated.
    const none = await post({ client_id: 'client_billing', client_secret: 'secret_billing_value' });
    expect(none.status).toBe(400);
    expect(await none.json()).toEqual({ error: 'invalid_request', error_description: 'Invalid token request body.' });
  });

  it("reads the credentials from the body alone when it names a client_id, as production's parseAuthorization does", async () => {
    // A client_id in the body means the Authorization header is never read: the secret there
    // is a missing secret. Without one, the header is decoded as base64 and split on the first
    // colon, with no form-decoding.
    const basic = Buffer.from('client_billing:secret_billing_value').toString('base64');
    const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` };
    const bodyWins = await app.request('/oauth2/token', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'client_billing' }).toString(),
    });
    await expectInvalidClient(bodyWins, 'Missing client_secret.');
    const headerOnly = await app.request('/oauth2/token', {
      method: 'POST',
      headers,
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    expect(headerOnly.status).toBe(200);
    const noId = await app.request('/oauth2/token', {
      method: 'POST',
      headers: { ...headers, Authorization: `Basic ${Buffer.from(':secret_billing_value').toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    await expectInvalidClient(noId, 'Missing client_id.');
    const notBasic = await app.request('/oauth2/token', {
      method: 'POST',
      headers: { ...headers, Authorization: 'Bearer something' },
      body: new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    });
    await expectInvalidClient(notBasic, 'Missing client_id.');
  });

  for (const method of ['post', 'basic']) {
    it(`rejects ${method} secret authentication for a public client even after an admin adds a matching secret`, async () => {
      const registration = await app.request('/oauth2/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Test client',
          redirect_uris: ['http://localhost:3000/cb'],
          token_endpoint_auth_method: 'none',
        }),
      });
      expect(registration.status).toBe(201);
      const client = (await registration.json()) as any;
      expect(client.client_secret).toBeUndefined();
      const added = await app.request(`/connect/applications/${client.client_id}/client_secrets`, {
        method: 'POST',
        headers: { Authorization: 'Bearer sk_test_org' },
      });
      expect(added.status).toBe(201);
      const { secret } = (await added.json()) as any;
      const body: Record<string, string> = {
        grant_type: 'authorization_code',
        code: 'unknown_code',
        redirect_uri: 'http://localhost:3000/cb',
      };
      const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (method === 'post') {
        body.client_id = client.client_id;
        body.client_secret = secret;
      } else {
        headers.Authorization = `Basic ${Buffer.from(`${client.client_id}:${secret}`).toString('base64')}`;
      }
      const res = await app.request('/oauth2/token', {
        method: 'POST',
        headers,
        body: new URLSearchParams(body).toString(),
      });
      await expectInvalidClient(res, 'Unsupported client_secret.');
    });
  }

  it('carries the header on a wrong secret too, and not on successes', async () => {
    const wrong = await post({ grant_type: 'client_credentials', client_id: 'client_billing', client_secret: 'nope' });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('www-authenticate')).toBe('Basic realm="AuthKit"');
    const ok = await post({
      grant_type: 'client_credentials',
      client_id: 'client_billing',
      client_secret: 'secret_billing_value',
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('www-authenticate')).toBeNull();
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('pragma')).toBe('no-cache');
  });
});
