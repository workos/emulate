import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';
import { STORE_KEYS } from '../constants.js';
import type { Store } from '../../core/index.js';

const apiKeys: ApiKeyMap = { sk_test_sso: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_sso', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('SSO routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  async function createOrgWithConnection() {
    const org = await json(
      await req('/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: 'SSO Org' }),
      }),
    );
    const conn = await json(
      await req('/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test SSO',
          organization_id: org.id,
          connection_type: 'GenericSAML',
          domains: ['sso.example.com'],
        }),
      }),
    );
    return { org, conn };
  }

  it('sso authorize flow with connection', async () => {
    const { conn } = await createOrgWithConnection();

    const res = await app.request(
      `/sso/authorize?connection=${conn.id}&redirect_uri=http://localhost:3000/callback&state=abc`,
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const url = new URL(location);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('abc');
  });

  it('sso token exchange returns profile and access_token', async () => {
    const { conn } = await createOrgWithConnection();

    // Get code
    const authRes = await app.request(
      `/sso/authorize?connection=${conn.id}&redirect_uri=http://localhost:3000/callback`,
    );
    const location = authRes.headers.get('location')!;
    const code = new URL(location).searchParams.get('code')!;

    // Exchange
    const tokenRes = await app.request('/sso/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    expect(body.profile).toBeDefined();
    expect(body.profile.object).toBe('profile');
    expect(body.access_token).toBeDefined();
  });

  it('returns 404 when no active connection found', async () => {
    const res = await app.request(
      '/sso/authorize?connection=conn_nonexistent&redirect_uri=http://localhost:3000/callback',
    );
    expect(res.status).toBe(404);
  });

  it('jwks endpoint returns keys', async () => {
    const res = await app.request('/sso/jwks');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0].alg).toBe('RS256');
  });

  it('sso authorize rejects non-localhost redirect_uri', async () => {
    const { conn } = await createOrgWithConnection();

    const res = await app.request(
      `/sso/authorize?connection=${conn.id}&redirect_uri=https://evil.example.com/callback`,
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('invalid_redirect_uri');
  });
});

describe('SSO interactive auth', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
    store = result.store;
    store.setData(STORE_KEYS.interactiveAuth, true);
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  async function createOrgWithConnection() {
    const org = await json(
      await req('/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: 'SSO Org' }),
      }),
    );
    const conn = await json(
      await req('/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Test SSO',
          organization_id: org.id,
          connection_type: 'GenericSAML',
          domains: ['sso.example.com'],
        }),
      }),
    );
    return { org, conn };
  }

  it('GET /sso/authorize returns HTML login page', async () => {
    const { conn } = await createOrgWithConnection();

    const res = await app.request(
      `/sso/authorize?connection=${conn.id}&redirect_uri=http://localhost:3000/callback&state=abc`,
    );
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('SSO Login');
    expect(html).toContain('<form');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="redirect_uri"');
    expect(html).toContain('name="state"');
  });

  it('GET /sso/authorize pre-fills login_hint in email field', async () => {
    const { conn } = await createOrgWithConnection();

    const res = await app.request(
      `/sso/authorize?connection=${conn.id}&redirect_uri=http://localhost:3000/callback&login_hint=alice@sso.example.com`,
    );
    const html = await res.text();
    expect(html).toContain('value="alice@sso.example.com"');
  });

  it('POST /sso/authorize processes form and redirects with code', async () => {
    const { conn } = await createOrgWithConnection();

    const formBody = new URLSearchParams({
      email: 'test@sso.example.com',
      redirect_uri: 'http://localhost:3000/callback',
      state: 'xyz',
      connection: conn.id,
    });

    const res = await app.request('/sso/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString(),
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const url = new URL(location);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('xyz');
  });

  it('POST /sso/authorize + token exchange returns correct profile', async () => {
    const { conn } = await createOrgWithConnection();

    const formBody = new URLSearchParams({
      email: 'alice@sso.example.com',
      redirect_uri: 'http://localhost:3000/callback',
      connection: conn.id,
    });

    const authRes = await app.request('/sso/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString(),
    });
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;

    const tokenRes = await app.request('/sso/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    expect(body.profile.email).toBe('alice@sso.example.com');
  });
});

describe('SSO authentication events', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  const eventsNamed = (name: string) =>
    getWorkOSStore(store)
      .events.all()
      .filter((e) => e.event === name);

  async function createOrgWithConnection() {
    const org = await json(
      await req('/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: 'SSO Events Org' }),
      }),
    );
    const conn = await json(
      await req('/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Events SSO',
          organization_id: org.id,
          connection_type: 'GenericSAML',
          domains: ['sso-events.example.com'],
        }),
      }),
    );
    return { org, conn };
  }

  it('emits authentication.sso_succeeded with the spec sso object on token exchange', async () => {
    const { org, conn } = await createOrgWithConnection();

    const authRes = await app.request(
      `/sso/authorize?connection=${conn.id}&redirect_uri=http://localhost:3000/callback`,
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;

    await app.request('/sso/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });

    const [event] = eventsNamed('authentication.sso_succeeded');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({
      type: 'sso',
      status: 'succeeded',
      sso: { organization_id: org.id, connection_id: conn.id, session_id: null },
    });
    expect(event.data).toHaveProperty('user_id');
    expect(event.data).toHaveProperty('email');
  });

  it('emits authentication.sso_failed with an error object for an invalid code', async () => {
    const res = await app.request('/sso/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: 'sso_bogus' }),
    });
    expect(res.status).toBe(400);

    const [event] = eventsNamed('authentication.sso_failed');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({
      type: 'sso',
      status: 'failed',
      error: { code: 'invalid_code', message: 'Invalid authorization code' },
    });
  });
});
