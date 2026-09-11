import { beforeEach, describe, expect, it } from 'bun:test';
import { createServer } from '../../core/index.js';
import { seedFromConfig, workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';

const baseUrl = 'http://localhost:4100';
const callback = 'http://localhost:3000/callback?existing=1';
const headers = { Authorization: 'Bearer sk_test_default', 'Content-Type': 'application/json' };
const user = { id: 'user_12345', email: 'marcelina.davis@example.com' };
const json = (res: Response) => res.json() as Promise<any>;

function createTestApp() {
  const server = createServer(workosPlugin, {
    port: 0,
    baseUrl,
    apiKeys: { sk_test_default: { environment: 'test' } },
  });
  seedFromConfig(server.store, baseUrl, {
    connectApplications: [
      {
        name: 'Standalone',
        type: 'oauth',
        client_id: 'client_standalone',
        client_secret: 'secret_standalone',
        login_url: 'http://localhost:3000/login?existing=1',
        redirect_uris: [callback],
        scopes: ['profile', 'email'],
        audience: 'https://api.example.test',
      },
    ],
  });
  return server;
}

describe('Standalone Connect', () => {
  let server: ReturnType<typeof createTestApp>;
  let ws: ReturnType<typeof getWorkOSStore>;

  beforeEach(() => {
    server = createTestApp();
    ws = getWorkOSStore(server.store);
  });

  const authorize = (overrides: Record<string, string> = {}) =>
    server.app.request(
      `/oauth2/authorize?${new URLSearchParams({
        client_id: 'client_standalone',
        redirect_uri: callback,
        response_type: 'code',
        state: 'state + /?&=',
        ...overrides,
      })}`,
    );
  const mint = async () => {
    const res = await authorize();
    expect(res.status).toBe(302);
    const login = new URL(res.headers.get('location')!);
    expect(login.origin + login.pathname).toBe('http://localhost:3000/login');
    expect(login.searchParams.get('existing')).toBe('1');
    const id = login.searchParams.get('external_auth_id')!;
    expect(id).toMatch(/^ext_auth_[0-9A-HJKMNP-TV-Z]{26}$/);
    return id;
  };
  const complete = (id: string, input: Record<string, unknown> = user) =>
    server.app.request('/authkit/oauth2/complete', {
      method: 'POST',
      headers,
      body: JSON.stringify({ external_auth_id: id, user: input }),
    });
  const issueCode = async () => {
    const id = await mint();
    const res = await complete(id);
    expect(res.status).toBe(200);
    const { redirect_uri } = await json(res);
    const redirect = await server.app.request(redirect_uri);
    expect(redirect.status).toBe(302);
    return { id, redirect_uri, callbackUrl: new URL(redirect.headers.get('location')!) };
  };
  const exchange = (code: string, overrides: Record<string, string> = {}) =>
    server.app.request('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'client_standalone',
        client_secret: 'secret_standalone',
        redirect_uri: callback,
        code,
        ...overrides,
      }),
    });

  it('finishes authorize → login → complete → callback → signed access token', async () => {
    const { id, callbackUrl } = await issueCode();
    expect(callbackUrl.origin + callbackUrl.pathname).toBe('http://localhost:3000/callback');
    expect(callbackUrl.searchParams.get('existing')).toBe('1');
    expect(callbackUrl.searchParams.get('state')).toBe('state + /?&=');
    const created = ws.users.findOneBy('external_id', user.id)!;
    expect(created.email).toBe(user.email);
    expect(created.email_verified).toBe(true);
    expect(created.id).not.toBe(user.id);
    expect(ws.events.findBy('event', 'user.created').some((e) => e.data.id === created.id)).toBe(true);
    expect(ws.externalAuthSessions.get(id)?.user_id).toBe(created.id);
    const code = callbackUrl.searchParams.get('code')!;
    const tokenRes = await exchange(code);
    expect(tokenRes.status).toBe(200);
    const token = await json(tokenRes);
    expect(token.token_type).toBe('Bearer');
    expect(token.expires_in).toBe(3600);
    expect(token.refresh_token).toBeUndefined();
    expect(token.id_token).toBeUndefined();
    const claims = server.jwt.verify(token.access_token);
    expect(claims.sub).toBe(created.id);
    expect(claims.aud).toBe('https://api.example.test');
    expect(claims.iss).toBe(baseUrl);
    expect(claims.scope).toBe('profile email');
    expect(claims.jti).toBeDefined();
    expect(ws.authCodes.findOneBy('code', code)).toBeUndefined();
    const replay = await exchange(code);
    expect(replay.status).toBe(400);
    expect((await json(replay)).error).toBe('invalid_grant');
  });

  it('requires API-key authentication for server-side completion', async () => {
    const id = await mint();
    for (const authorization of ['', 'Bearer sk_invalid']) {
      const res = await server.app.request('/authkit/oauth2/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: authorization },
        body: JSON.stringify({ external_auth_id: id, user }),
      });
      expect(res.status).toBe(401);
    }
    expect(ws.externalAuthSessions.get(id)?.completed_at).toBeNull();
  });

  it('rejects repeat completion with the specified error without updating the user', async () => {
    const id = await mint();
    expect((await complete(id)).status).toBe(200);
    const res = await complete(id, { ...user, email: 'changed@example.com' });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('external_auth_session_already_completed');
    expect(ws.users.findOneBy('external_id', user.id)?.email).toBe(user.email);
  });

  it('returns 404 for unknown and expired external auth ids', async () => {
    const id = await mint();
    ws.externalAuthSessions.update(id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    for (const invalid of ['ext_auth_unknown', id]) {
      const res = await complete(invalid);
      expect(res.status).toBe(404);
      expect((await json(res)).code).toBe('not_found');
    }
    expect(ws.users.findOneBy('external_id', user.id)).toBeUndefined();
  });

  it('requires external_auth_id and user.id/email with 422, including wrong JSON types', async () => {
    const id = await mint();
    for (const body of [
      {},
      { user },
      { external_auth_id: id },
      { external_auth_id: id, user: [] },
      { external_auth_id: id, user: { email: user.email } },
      { external_auth_id: id, user: { id: user.id } },
      { external_auth_id: id, user: { ...user, id: 123 } },
      { external_auth_id: id, user: { ...user, email: ' ' } },
    ]) {
      const res = await server.app.request('/authkit/oauth2/complete', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).code).toBe('unprocessable_entity');
    }
  });

  it('rejects malformed email without consuming the session', async () => {
    const id = await mint();
    const res = await complete(id, { ...user, email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('invalid_email');
    expect(ws.externalAuthSessions.get(id)?.completed_at).toBeNull();
    expect((await complete(id)).status).toBe(200);
  });

  it('rejects another external id claiming an owned email case-insensitively', async () => {
    expect((await complete(await mint())).status).toBe(200);
    const id = await mint();
    const res = await complete(id, { id: 'different-user', email: user.email.toUpperCase() });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('email_not_available');
    expect(ws.externalAuthSessions.get(id)?.completed_at).toBeNull();
    expect(ws.users.findOneBy('external_id', 'different-user')).toBeUndefined();
  });

  it('updates by external_id, preserves omitted fields, and emits user.updated', async () => {
    expect(
      (
        await complete(await mint(), {
          ...user,
          name: 'Marcelina Davis',
          first_name: 'Marcelina',
          metadata: { team: 'dev' },
        })
      ).status,
    ).toBe(200);
    const original = ws.users.findOneBy('external_id', user.id)!;
    const res = await complete(await mint(), { ...user, email: 'new@example.com', last_name: 'Davis' });
    expect(res.status).toBe(200);
    expect(ws.users.findBy('external_id', user.id)).toHaveLength(1);
    const updated = ws.users.get(original.id)!;
    expect(updated.email).toBe('new@example.com');
    expect(updated.name).toBe('Marcelina Davis');
    expect(updated.first_name).toBe('Marcelina');
    expect(updated.last_name).toBe('Davis');
    expect(updated.metadata).toEqual({ team: 'dev' });
    expect(ws.events.findBy('event', 'user.updated').some((e) => e.data.id === original.id)).toBe(true);
  });

  it('rejects email conflicts on updates as well as creates', async () => {
    await complete(await mint());
    await complete(await mint(), { id: 'other', email: 'other@example.com' });
    const res = await complete(await mint(), { ...user, email: 'other@example.com' });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('email_not_available');
  });

  it('rejects redirect replay and incomplete, unknown, and expired sessions', async () => {
    const { id, redirect_uri } = await issueCode();
    expect((await server.app.request(redirect_uri)).status).toBe(404);
    expect(ws.authCodes.all()).toHaveLength(1);
    const pending = await mint();
    for (const invalid of [pending, 'ext_auth_unknown']) {
      expect((await server.app.request(`/oauth2/authorize/complete?external_auth_id=${invalid}`)).status).toBe(404);
    }
    ws.externalAuthSessions.update(id, { expires_at: new Date(Date.now() - 1000).toISOString(), redeemed_at: null });
    expect((await server.app.request(redirect_uri)).status).toBe(404);
  });

  it('rejects invalid authorize parameters before minting a session', async () => {
    for (const params of [
      { client_id: '' },
      { client_id: 'unknown' },
      { redirect_uri: '' },
      { response_type: 'token' },
      { redirect_uri: 'http://localhost:3000/unregistered' },
    ] as Record<string, string>[]) {
      expect((await authorize(params)).status).toBe(400);
    }
    expect(ws.externalAuthSessions.all()).toHaveLength(0);
  });

  it('requires an OAuth application configured with login_url', async () => {
    const application = ws.connectApplications.findOneBy('client_id', 'client_standalone')!;
    ws.connectApplications.update(application.id, { application_type: 'm2m' });
    expect((await authorize()).status).toBe(400);
    ws.connectApplications.update(application.id, { application_type: 'oauth', login_url: null });
    expect((await authorize()).status).toBe(400);
    expect(ws.externalAuthSessions.all()).toHaveLength(0);
  });

  it('applies redirect-host and unsafe-scheme guards to both browser destinations', async () => {
    const application = ws.connectApplications.findOneBy('client_id', 'client_standalone')!;
    ws.connectApplications.update(application.id, { redirect_uris: [] });
    for (const uri of ['https://untrusted.example/cb', 'javascript:alert(1)', 'not-a-url']) {
      expect((await authorize({ redirect_uri: uri })).status).toBe(400);
    }
    ws.connectApplications.update(application.id, { login_url: 'https://untrusted.example/login' });
    expect((await authorize()).status).toBe(400);
    expect(ws.externalAuthSessions.all()).toHaveLength(0);
  });

  it('binds token exchange to the secret, client, redirect_uri, and unexpired code', async () => {
    const { callbackUrl } = await issueCode();
    const code = callbackUrl.searchParams.get('code')!;
    const wrongSecret = await exchange(code, { client_secret: 'wrong' });
    expect(wrongSecret.status).toBe(401);
    expect((await json(wrongSecret)).error).toBe('invalid_client');
    const wrongRedirect = await exchange(code, { redirect_uri: 'http://localhost:3000/other' });
    expect(wrongRedirect.status).toBe(400);
    expect((await json(wrongRedirect)).error).toBe('invalid_grant');
    seedFromConfig(server.store, baseUrl, {
      connectApplications: [{ name: 'Other', type: 'oauth', client_id: 'client_other', client_secret: 'secret_other' }],
    });
    const wrongClient = await exchange(code, { client_id: 'client_other', client_secret: 'secret_other' });
    expect(wrongClient.status).toBe(400);
    expect((await json(wrongClient)).error).toBe('invalid_grant');
    expect((await exchange('unknown')).status).toBe(400);
    for (const params of [{ code: '' }, { redirect_uri: '' }] as Record<string, string>[]) {
      const res = await exchange(code, params);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('invalid_request');
    }
    const record = ws.authCodes.findOneBy('code', code)!;
    ws.authCodes.update(record.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const expired = await exchange(code);
    expect(expired.status).toBe(400);
    expect((await json(expired)).error).toBe('invalid_grant');
  });

  it('rejects Standalone Connect codes at AuthKit authenticate without consuming them', async () => {
    const { callbackUrl } = await issueCode();
    const code = callbackUrl.searchParams.get('code')!;
    const record = ws.authCodes.findOneBy('code', code)!;
    for (const clientId of ['client_standalone', 'client_unrelated']) {
      const res = await server.app.request('/user_management/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', client_id: clientId, code }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('invalid_grant');
      expect(ws.authCodes.findOneBy('code', code)).toEqual(record);
      expect(ws.sessions.all()).toHaveLength(0);
      expect(ws.refreshTokens.all()).toHaveLength(0);
    }
    const tokenRes = await exchange(code);
    expect(tokenRes.status).toBe(200);
    expect(server.jwt.verify((await json(tokenRes)).access_token).sub).toBe(record.user_id);
    expect(ws.authCodes.findOneBy('code', code)).toBeUndefined();
  });

  it('rejects codes minted by another authentication flow', async () => {
    const { callbackUrl } = await issueCode();
    const code = callbackUrl.searchParams.get('code')!;
    ws.authCodes.update(ws.authCodes.findOneBy('code', code)!.id, { auth_method: 'Password' });
    const res = await exchange(code);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_grant');
  });
});
