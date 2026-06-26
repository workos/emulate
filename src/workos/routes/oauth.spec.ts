import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin, seedFromConfig } from '../index.js';
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
    expect(body.token_type).toBe('Bearer');
    expect(body.expires_in).toBe(3600);
    expect(body.scope).toBe('invoices:read invoices:write');

    // The token validates against the emulator's signing key (the one served at JWKS).
    const claims = jwt.verify(body.access_token);
    expect(claims.sub).toBe('client_billing');
    expect(claims.aud).toBe('client_billing');
    expect(claims.iss).toBe('http://localhost:0');
    expect(claims.scp).toEqual(['invoices:read', 'invoices:write']);
    expect(claims.org_id).toMatch(/^org_/);
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
    expect(jwt.verify(body.access_token).scp).toEqual(['invoices:read']);
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
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('unauthorized_client');
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
});
