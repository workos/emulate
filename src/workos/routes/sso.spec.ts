import { describe, it, expect, beforeEach } from 'bun:test';
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

  // The last exact-match lookup by email. A login_hint differing only in case is the same
  // federated person, so it reuses the profile rather than minting a second one for the same
  // connection — which is the pair of records no lookup by email can tell apart, in profile form.
  it('reuses one profile across casings of the same login_hint', async () => {
    const { conn } = await createOrgWithConnection();

    for (const hint of ['Person%40sso.example.com', 'person%40sso.example.com', 'PERSON%40SSO.EXAMPLE.COM']) {
      const res = await app.request(
        `/sso/authorize?connection=${conn.id}&redirect_uri=http://localhost:3000/callback&login_hint=${hint}`,
      );
      expect(res.status).toBe(302);
    }

    const profiles = getWorkOSStore(store).ssoProfiles.all();
    expect(profiles).toHaveLength(1);
    // Stored as first given, like every other address the emulator writes.
    expect(profiles[0].email).toBe('Person@sso.example.com');
  });

  // Matching on the connection at the same time as the email, not after: `findOneBy` returned the
  // first profile for the address whatever connection it belonged to, so the second connection
  // never matched its own profile and minted another on every authorize.
  it('keeps one profile per connection for the same address', async () => {
    const { conn } = await createOrgWithConnection();
    const org2 = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Other' }) }));
    const conn2 = await json(
      await req('/connections', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Other SSO',
          organization_id: org2.id,
          connection_type: 'GenericSAML',
          domains: ['sso.example.com'],
        }),
      }),
    );

    for (const id of [conn.id, conn2.id, conn.id, conn2.id]) {
      await app.request(
        `/sso/authorize?connection=${id}&redirect_uri=http://localhost:3000/callback&login_hint=shared%40sso.example.com`,
      );
    }

    const profiles = getWorkOSStore(store).ssoProfiles.all();
    expect(profiles).toHaveLength(2);
    expect(new Set(profiles.map((p) => p.connection_id))).toEqual(new Set([conn.id, conn2.id]));
  });

  describe('SSO code redeemed for a user-management session', () => {
    /** Start SSO through `conn` and return the code the redirect carries. */
    async function ssoCode(connId: string, loginHint?: string) {
      const res = await app.request(
        `/sso/authorize?connection=${connId}&redirect_uri=http://localhost:3000/callback` +
          (loginHint ? `&login_hint=${encodeURIComponent(loginHint)}` : ''),
      );
      return new URL(res.headers.get('location')!).searchParams.get('code')!;
    }

    const authenticate = (code: string) =>
      app.request('/user_management/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'client_x' }),
      });

    it('signs the profile in, keying the session to sso', async () => {
      const { org, conn } = await createOrgWithConnection();
      const ws = getWorkOSStore(store);
      const user = ws.users.insert({
        object: 'user',
        email: 'alice@sso.example.com',
        name: null,
        first_name: null,
        last_name: null,
        email_verified: true,
        profile_picture_url: null,
        last_sign_in_at: null,
        external_id: null,
        metadata: {},
        locale: null,
        password_hash: null,
        impersonator: null,
      });

      const res = await authenticate(await ssoCode(conn.id, 'alice@sso.example.com'));

      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body.user.id).toBe(user.id);
      expect(body.organization_id).toBe(org.id);
      expect(body.authentication_method).toBe('SSO');
      const [session] = ws.sessions.findBy('user_id', user.id);
      expect(session.auth_method).toBe('sso');

      // The spec requires an `sso` block on authentication.sso_succeeded; this is the only SSO
      // path that reaches a session, so it is the only one that can fill in session_id.
      const [event] = ws.events.all().filter((e) => e.event === 'authentication.sso_succeeded');
      expect(event.data).toMatchObject({
        type: 'sso',
        status: 'succeeded',
        user_id: user.id,
        sso: { organization_id: org.id, connection_id: conn.id, session_id: session.id },
      });
    });

    it('provisions a user the federated profile has no account for', async () => {
      const { conn } = await createOrgWithConnection();

      const body = await json(await authenticate(await ssoCode(conn.id, 'newcomer@sso.example.com')));

      expect(body.user.email).toBe('newcomer@sso.example.com');
      // The IdP asserted the address, which is what verification proves.
      expect(body.user.email_verified).toBe(true);
      expect(getWorkOSStore(store).users.all()).toHaveLength(1);
    });

    it('spends the code once, and reports an expired one as invalid_grant', async () => {
      const { org, conn } = await createOrgWithConnection();
      const ws = getWorkOSStore(store);

      const code = await ssoCode(conn.id, 'once@sso.example.com');
      expect((await authenticate(code)).status).toBe(200);
      const replay = await authenticate(code);
      expect(replay.status).toBe(400);
      expect((await json(replay)).error).toBe('invalid_grant');

      const expired = await ssoCode(conn.id, 'stale@sso.example.com');
      const stored = ws.ssoAuthorizations.findOneBy('code', expired)!;
      ws.ssoAuthorizations.update(stored.id, { expires_at: new Date(Date.now() - 1000).toISOString() });

      const res = await authenticate(expired);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('invalid_grant');
      const [failed] = ws.events.all().filter((e) => e.event === 'authentication.sso_failed');
      expect(failed.data).toMatchObject({
        type: 'sso',
        status: 'failed',
        email: 'stale@sso.example.com',
        sso: { organization_id: org.id, connection_id: conn.id, session_id: null },
      });
    });
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

  // The per-client path is the one the spec documents and the SDKs fetch when verifying a
  // session or M2M token. A bare /sso/jwks does not match it, so it is registered too.
  it('serves the same JWKS from the per-client path the SDKs fetch', async () => {
    const res = await app.request('/sso/jwks/client_01ABCDEF');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual(await json(await app.request('/sso/jwks')));
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

  // SSO is profile-based, so the event's user_id is resolved from the profile's email. Resolving it
  // exactly reported user_id: null for an account that existed under a different case — and Magic
  // Auth sign-up creates accounts under whatever case it was handed.
  it('resolves the event user_id for an account stored under a different case', async () => {
    const { conn } = await createOrgWithConnection();
    const user = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'Federated@SSO-Events.example.com' }),
      }),
    );

    const authRes = await app.request(
      `/sso/authorize?connection=${conn.id}&redirect_uri=http://localhost:3000/callback&login_hint=federated%40sso-events.example.com`,
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    await app.request('/sso/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });

    const [event] = eventsNamed('authentication.sso_succeeded');
    expect(event.data).toMatchObject({ user_id: user.id, email: 'federated@sso-events.example.com' });
  });

  it('emits authentication.sso_failed with an error object for an invalid code', async () => {
    const res = await app.request('/sso/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: 'sso_bogus' }),
    });
    expect(res.status).toBe(400);
    // The response is OAuth-shaped, but the event's error object keeps the spec's
    // {code, message} — OauthApiError reuses those fields, so both stay correct.
    expect(await res.json()).toEqual({
      error: 'invalid_grant',
      error_description: "The code 'sso_bogus' has expired or is invalid.",
    });

    const [event] = eventsNamed('authentication.sso_failed');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({
      type: 'sso',
      status: 'failed',
      error: { code: 'invalid_grant', message: "The code 'sso_bogus' has expired or is invalid." },
      sso: { organization_id: null, connection_id: null, session_id: null },
    });
  });

  // The expired branch is not the invalid one with a different label: it resolves the profile
  // behind the code first, so the event it emits carries the organization and connection the
  // unknown-code event has to leave null. Both still answer the caller the same OAuth-shaped
  // invalid_grant, because production does not distinguish aged-out from never-existed.
  it('emits authentication.sso_failed with the profile’s org and connection for an expired code', async () => {
    const { org, conn } = await createOrgWithConnection();

    const authRes = await app.request(
      `/sso/authorize?connection=${conn.id}&redirect_uri=http://localhost:3000/callback`,
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;

    const ws = getWorkOSStore(store);
    const stored = ws.ssoAuthorizations.findOneBy('code', code)!;
    ws.ssoAuthorizations.update(stored.id, { expires_at: new Date(Date.now() - 60_000).toISOString() });

    const res = await app.request('/sso/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'invalid_grant',
      error_description: `The code '${code}' has expired or is invalid.`,
    });

    const [event] = eventsNamed('authentication.sso_failed');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({
      type: 'sso',
      status: 'failed',
      error: { code: 'invalid_grant', message: `The code '${code}' has expired or is invalid.` },
      sso: { organization_id: org.id, connection_id: conn.id, session_id: null },
    });

    // Spent, unlike the unknown-code path — there was a real authorization to consume.
    expect(ws.ssoAuthorizations.findOneBy('code', code)).toBeUndefined();
  });

  // Every /sso/token failure a caller can cause is OAuth-shaped, including the two they hit
  // before they have a code to present. The only plain body the endpoint can return is the
  // profile-missing 500, which no request can provoke.
  it('rejects a wrong grant type and a missing code OAuth-style', async () => {
    const wrongGrant = await app.request('/sso/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', code: 'whatever' }),
    });
    expect(wrongGrant.status).toBe(400);
    expect(await wrongGrant.json()).toEqual({
      error: 'unsupported_grant_type',
      error_description: 'The grant type is not supported: client_credentials',
    });

    const noCode = await app.request('/sso/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code' }),
    });
    expect(noCode.status).toBe(400);
    expect(await noCode.json()).toEqual({ error: 'invalid_request', error_description: 'code is required.' });
  });

  // Absent is a malformed request, not a request for an unsupported grant — and describing it as
  // "not supported: undefined" names neither the problem nor anything the caller sent.
  it('reports an omitted grant type as invalid_request, not unsupported_grant_type', async () => {
    const res = await app.request('/sso/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'whatever' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request', error_description: 'grant_type is required.' });
  });

  // The redirect endpoint takes `token`; only the Logout Authorize response body names it
  // `logout_token`. Reading the wrong one made every logout_url the emulator handed out
  // unusable against the emulator itself.
  it('single logout accepts the token param and the logout_url it issues', async () => {
    const { conn } = await createOrgWithConnection();
    await app.request(
      `/sso/authorize?connection=${conn.id}&redirect_uri=http://localhost:3000/callback&login_hint=bye%40sso.example.com`,
    );
    const profile = getWorkOSStore(store).ssoProfiles.all()[0];

    const authorize = await json(
      await req('/sso/logout/authorize', { method: 'POST', body: JSON.stringify({ profile_id: profile.id }) }),
    );
    expect(new URL(authorize.logout_url).searchParams.get('token')).toBe(authorize.logout_token);

    // The issued URL works as handed out, and the old param name is not accepted.
    const stale = await app.request(`/sso/logout?logout_token=${authorize.logout_token}`);
    expect(stale.status).toBe(400);

    const res = await app.request(new URL(authorize.logout_url).pathname + new URL(authorize.logout_url).search);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });
});
