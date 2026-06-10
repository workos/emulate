import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';
import { STORE_KEYS } from '../constants.js';
import type { Store } from '../../core/index.js';

const apiKeys: ApiKeyMap = { sk_test_auth: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_auth', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Auth routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  async function createUser(
    email: string,
    opts?: { password?: string; impersonator?: { email: string; reason: string } },
  ) {
    const ws = getWorkOSStore(store);
    return ws.users.insert({
      object: 'user',
      email,
      first_name: null,
      last_name: null,
      email_verified: false,
      profile_picture_url: null,
      last_sign_in_at: null,
      external_id: null,
      metadata: {},
      locale: null,
      password_hash: null,
      impersonator: opts?.impersonator ?? null,
    });
  }

  it('authorize redirects with code when user exists', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'auth@test.com' }),
    });

    const res = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&state=mystate',
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const url = new URL(location);
    expect(url.searchParams.get('code')).toBeTruthy();
    expect(url.searchParams.get('state')).toBe('mystate');
  });

  it('authenticate with password grant', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'pass@test.com', password: 'secret' }),
    });

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        email: 'pass@test.com',
        password: 'secret',
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.access_token).toBeDefined();
    expect(body.user.email).toBe('pass@test.com');
    expect(body.authentication_method).toBe('Password');
  });

  it('rejects invalid password', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'bad@test.com', password: 'correct' }),
    });

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        email: 'bad@test.com',
        password: 'wrong',
      }),
    });
    expect(res.status).toBe(401);
  });

  it('authorization_code grant flow', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'code@test.com' }),
    });

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code',
    );
    const location = authRes.headers.get('location')!;
    const code = new URL(location).searchParams.get('code')!;

    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    expect(body.access_token).toBeDefined();
    expect(body.authentication_method).toBe('OAuth');
  });

  it('authorize rejects non-localhost redirect_uri', async () => {
    const res = await app.request(
      '/user_management/authorize?redirect_uri=https://evil.example.com/callback&response_type=code',
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('invalid_redirect_uri');
  });

  it('authorize allows 127.0.0.1 redirect_uri', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'ip@test.com' }),
    });

    const res = await app.request(
      '/user_management/authorize?redirect_uri=http://127.0.0.1:5000/callback&response_type=code',
    );
    expect(res.status).toBe(302);
  });

  // --- login_hint tests ---

  it('authorize with login_hint selects correct user', async () => {
    await createUser('first@test.com');
    await createUser('second@test.com');

    const res = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&login_hint=second@test.com',
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const code = new URL(location).searchParams.get('code')!;

    // Exchange code and verify the correct user
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    const body = await json(tokenRes);
    expect(body.user.email).toBe('second@test.com');
  });

  it('authorize with unknown login_hint redirects with error', async () => {
    await createUser('exists@test.com');

    const res = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&login_hint=nope@test.com&state=s1',
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    const url = new URL(location);
    expect(url.searchParams.get('error')).toBe('user_not_found');
    expect(url.searchParams.get('state')).toBe('s1');
  });

  // --- Refresh token tests ---

  it('refresh_token grant returns new tokens and invalidates old', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'refresh@test.com', password: 'pw' }),
    });

    // Authenticate to get a refresh token
    const authRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'refresh@test.com', password: 'pw' }),
    });
    const authBody = await json(authRes);
    const oldRefresh = authBody.refresh_token;
    expect(oldRefresh).toBeDefined();

    // Use refresh token
    const refreshRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oldRefresh }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await json(refreshRes);
    expect(refreshBody.access_token).toBeDefined();
    expect(refreshBody.refresh_token).toBeDefined();
    expect(refreshBody.refresh_token).not.toBe(oldRefresh);

    // Old refresh token should be invalidated (rotation)
    const retryRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oldRefresh }),
    });
    expect(retryRes.status).toBe(400);
    const retryBody = await json(retryRes);
    expect(retryBody.code).toBe('invalid_grant');
  });

  it('rejects invalid refresh token', async () => {
    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'bogus_token' }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('invalid_grant');
  });

  // --- Impersonation tests ---

  it('includes impersonator in response when configured', async () => {
    await createUser('target@test.com', {
      impersonator: { email: 'admin@test.com', reason: 'debugging' },
    });

    // Authorize + authenticate to get the response
    const authRes = await app.request('/user_management/authorize?redirect_uri=http://localhost:3000/callback');
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    const body = await json(tokenRes);
    expect(body.impersonator).toEqual({ email: 'admin@test.com', reason: 'debugging' });
  });

  it('omits impersonator when not configured', async () => {
    await createUser('normal@test.com');

    const authRes = await app.request('/user_management/authorize?redirect_uri=http://localhost:3000/callback');
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    const body = await json(tokenRes);
    expect(body.impersonator).toBeUndefined();
  });

  // --- Sealed session tests ---

  it('returns sealed_session when client_secret provided', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'sealed@test.com', password: 'pw' }),
    });

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        email: 'sealed@test.com',
        password: 'pw',
        client_secret: 'sk_test_secret',
      }),
    });
    const body = await json(res);
    expect(body.sealed_session).toBeTruthy();
    expect(typeof body.sealed_session).toBe('string');
  });

  // --- Grant type alias tests ---

  it('accepts new magic-auth:code grant type alias', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'magic@test.com' }),
    });

    // Create magic auth
    const magicRes = await req('/user_management/magic_auth', {
      method: 'POST',
      body: JSON.stringify({ email: 'magic@test.com' }),
    });
    const magicBody = await json(magicRes);

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:magic-auth:code',
        code: magicBody.code,
        email: 'magic@test.com',
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.authentication_method).toBe('MagicAuth');
  });

  // --- Device code tests ---

  it('device authorization + device_code grant flow', async () => {
    await createUser('device@test.com');

    // Create device authorization
    const deviceRes = await req('/user_management/authorize/device', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'test_client' }),
    });
    expect(deviceRes.status).toBe(200);
    const deviceBody = await json(deviceRes);
    expect(deviceBody.device_code).toBeDefined();
    expect(deviceBody.user_code).toBeDefined();

    // Exchange device code (auto-approved in emulator)
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceBody.device_code,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await json(tokenRes);
    expect(tokenBody.access_token).toBeDefined();
    expect(tokenBody.user.email).toBe('device@test.com');
  });

  // --- Organization selection grant tests ---

  it('organization-selection grant scopes session to selected org', async () => {
    const user = await createUser('orgsel@test.com');
    const ws = getWorkOSStore(store);
    const org = ws.organizations.insert({
      object: 'organization',
      name: 'Test Org',
      external_id: null,
      metadata: {},
      stripe_customer_id: null,
    });

    // Create a pending auth token
    const pendingToken = 'pending_test_token';
    store.setData(`pending_auth:${pendingToken}`, {
      user_id: user.id,
      organization_id: null,
      auth_method: 'Password',
    });

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:organization-selection',
        pending_authentication_token: pendingToken,
        organization_id: org.id,
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.organization_id).toBe(org.id);
    expect(body.user.email).toBe('orgsel@test.com');
  });

  // --- MFA TOTP grant tests ---

  it('mfa-totp grant with valid code succeeds', async () => {
    const user = await createUser('mfa@test.com');
    const ws = getWorkOSStore(store);

    // Create an auth factor
    const factor = ws.authFactors.insert({
      object: 'authentication_factor',
      user_id: user.id,
      type: 'totp',
      totp: { issuer: 'Test', user: user.email, uri: 'otpauth://...' },
    });

    // Create a challenge
    const challenge = ws.authChallenges.insert({
      object: 'authentication_challenge',
      user_id: user.id,
      factor_id: factor.id,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      code: '123456',
    });

    // Create pending auth
    const pendingToken = 'pending_mfa_token';
    store.setData(`pending_auth:${pendingToken}`, {
      user_id: user.id,
      organization_id: null,
      auth_method: 'MFA',
    });

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:mfa-totp',
        code: '123456',
        pending_authentication_token: pendingToken,
        authentication_challenge_id: challenge.id,
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.access_token).toBeDefined();
    expect(body.authentication_method).toBe('MFA');
  });

  it('mfa-totp grant with invalid code returns error', async () => {
    const user = await createUser('mfa2@test.com');
    const ws = getWorkOSStore(store);

    const factor = ws.authFactors.insert({
      object: 'authentication_factor',
      user_id: user.id,
      type: 'totp',
      totp: { issuer: 'Test', user: user.email, uri: 'otpauth://...' },
    });

    const challenge = ws.authChallenges.insert({
      object: 'authentication_challenge',
      user_id: user.id,
      factor_id: factor.id,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      code: '123456',
    });

    const pendingToken = 'pending_mfa_bad';
    store.setData(`pending_auth:${pendingToken}`, {
      user_id: user.id,
      organization_id: null,
      auth_method: 'MFA',
    });

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:mfa-totp',
        code: '000000',
        pending_authentication_token: pendingToken,
        authentication_challenge_id: challenge.id,
      }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('invalid_one_time_code');
  });
});

describe('AuthKit interactive auth', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
    store.setData(STORE_KEYS.interactiveAuth, true);
  });

  const json = (res: Response) => res.json() as Promise<any>;

  it('GET /user_management/authorize returns HTML login page', async () => {
    const ws = getWorkOSStore(store);
    ws.users.insert({
      object: 'user',
      email: 'alice@test.com',
      first_name: null,
      last_name: null,
      email_verified: false,
      profile_picture_url: null,
      last_sign_in_at: null,
      external_id: null,
      metadata: {},
      locale: null,
      password_hash: null,
      impersonator: null,
    });

    const res = await app.request('/user_management/authorize?redirect_uri=http://localhost:3000/callback&state=abc');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Sign In');
    expect(html).toContain('<form');
    expect(html).toContain('name="email"');
    expect(html).toContain('name="redirect_uri"');
  });

  it('GET /user_management/authorize pre-fills login_hint', async () => {
    const res = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&login_hint=bob@test.com',
    );
    const html = await res.text();
    expect(html).toContain('value="bob@test.com"');
  });

  it('POST /user_management/authorize processes form and redirects with code', async () => {
    const ws = getWorkOSStore(store);
    ws.users.insert({
      object: 'user',
      email: 'post@test.com',
      first_name: null,
      last_name: null,
      email_verified: false,
      profile_picture_url: null,
      last_sign_in_at: null,
      external_id: null,
      metadata: {},
      locale: null,
      password_hash: null,
      impersonator: null,
    });

    const formBody = new URLSearchParams({
      email: 'post@test.com',
      redirect_uri: 'http://localhost:3000/callback',
      state: 'xyz',
    });

    const res = await app.request('/user_management/authorize', {
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

  it('full interactive flow: form submit → code → authenticate', async () => {
    const ws = getWorkOSStore(store);
    ws.users.insert({
      object: 'user',
      email: 'e2e@test.com',
      first_name: null,
      last_name: null,
      email_verified: false,
      profile_picture_url: null,
      last_sign_in_at: null,
      external_id: null,
      metadata: {},
      locale: null,
      password_hash: null,
      impersonator: null,
    });

    const formBody = new URLSearchParams({
      email: 'e2e@test.com',
      redirect_uri: 'http://localhost:3000/callback',
    });

    const authRes = await app.request('/user_management/authorize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString(),
    });
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;

    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    expect(body.user.email).toBe('e2e@test.com');
    expect(body.access_token).toBeDefined();
  });
});

describe('authentication events (spec-named, spec-shaped)', () => {
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

  async function registerUser(email: string, password: string) {
    const res = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return json(res);
  }

  it('emits authentication.password_succeeded with the spec payload', async () => {
    const user = await registerUser('evt-pass@test.com', 'secret');

    await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'spec-agent' },
      body: JSON.stringify({ grant_type: 'password', email: 'evt-pass@test.com', password: 'secret' }),
    });

    const [event] = eventsNamed('authentication.password_succeeded');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({
      type: 'password',
      status: 'succeeded',
      user_id: user.id,
      email: 'evt-pass@test.com',
      user_agent: 'spec-agent',
    });
    expect(event.data).toHaveProperty('ip_address');
  });

  it('emits authentication.password_failed with a required error object', async () => {
    await registerUser('evt-fail@test.com', 'secret');

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'evt-fail@test.com', password: 'wrong' }),
    });
    expect(res.status).toBe(401);

    const [event] = eventsNamed('authentication.password_failed');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({
      type: 'password',
      status: 'failed',
      email: 'evt-fail@test.com',
      error: { code: 'invalid_credentials', message: 'Invalid credentials' },
    });
  });

  it('emits authentication.oauth_succeeded for the authorization code flow', async () => {
    await registerUser('evt-oauth@test.com', 'secret');

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;

    await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });

    const [event] = eventsNamed('authentication.oauth_succeeded');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({ type: 'oauth', status: 'succeeded' });
  });

  it('emits authentication.oauth_failed for an invalid code', async () => {
    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: 'bogus' }),
    });
    expect(res.status).toBe(400);

    const [event] = eventsNamed('authentication.oauth_failed');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({
      type: 'oauth',
      status: 'failed',
      error: { code: 'invalid_code', message: 'Invalid code' },
    });
  });

  it('emits magic_auth.created on code request and magic_auth_succeeded on exchange', async () => {
    const user = await registerUser('evt-magic@test.com', 'secret');

    await req('/user_management/magic_auth', {
      method: 'POST',
      body: JSON.stringify({ email: 'evt-magic@test.com' }),
    });

    const [created] = eventsNamed('magic_auth.created');
    expect(created).toBeDefined();
    expect(created.data).toMatchObject({ user_id: user.id, email: 'evt-magic@test.com' });
    const code = created.data.code as string;

    await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:magic-auth:code',
        code,
        email: 'evt-magic@test.com',
      }),
    });

    const [succeeded] = eventsNamed('authentication.magic_auth_succeeded');
    expect(succeeded).toBeDefined();
    expect(succeeded.data).toMatchObject({ type: 'magic_auth', status: 'succeeded', user_id: user.id });
  });

  it('emits email_verification.created and email_verification_succeeded', async () => {
    const user = await registerUser('evt-verify@test.com', 'secret');

    const sendRes = await req(`/user_management/users/${user.id}/email_verification/send`, { method: 'POST' });
    const verification = await json(sendRes);

    const [created] = eventsNamed('email_verification.created');
    expect(created).toBeDefined();
    expect(created.data).toMatchObject({ user_id: user.id, email: 'evt-verify@test.com' });

    await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:email-verification:code',
        code: verification.code,
        user_id: user.id,
      }),
    });

    const [succeeded] = eventsNamed('authentication.email_verification_succeeded');
    expect(succeeded).toBeDefined();
    expect(succeeded.data).toMatchObject({ type: 'email_verification', status: 'succeeded', user_id: user.id });
  });

  it('creates sessions with spec-required fields (auth_method, status, expires_at)', async () => {
    await registerUser('evt-session@test.com', 'secret');

    await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'evt-session@test.com', password: 'secret' }),
    });

    const [event] = eventsNamed('session.created');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({ auth_method: 'password', status: 'active', ended_at: null });
    expect(event.data.expires_at).toBeTruthy();
  });

  it('MFA-completed sessions report auth_method: unknown (no spec enum value)', async () => {
    const user = await registerUser('evt-mfa@test.com', 'secret');
    const ws = getWorkOSStore(store);

    const factor = ws.authFactors.insert({
      object: 'authentication_factor',
      user_id: user.id,
      type: 'totp',
      totp: { issuer: 'Test', user: user.email, uri: 'otpauth://...' },
    });
    const challenge = ws.authChallenges.insert({
      object: 'authentication_challenge',
      user_id: user.id,
      factor_id: factor.id,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      code: '123456',
    });
    const pendingToken = 'pending_evt_mfa';
    store.setData(`pending_auth:${pendingToken}`, { user_id: user.id, organization_id: null, auth_method: 'MFA' });

    await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:mfa-totp',
        code: '123456',
        pending_authentication_token: pendingToken,
        authentication_challenge_id: challenge.id,
      }),
    });

    // No 'mfa' value exists in the spec session auth_method enum; we report the valid 'unknown'.
    const [session] = eventsNamed('session.created');
    expect(session).toBeDefined();
    expect(session.data).toMatchObject({ auth_method: 'unknown' });
  });

  it('email-verification sessions report auth_method: unknown (no spec enum value)', async () => {
    const user = await registerUser('evt-verify-session@test.com', 'secret');

    const sendRes = await req(`/user_management/users/${user.id}/email_verification/send`, { method: 'POST' });
    const verification = await json(sendRes);

    await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:email-verification:code',
        code: verification.code,
        user_id: user.id,
      }),
    });

    const [session] = eventsNamed('session.created');
    expect(session).toBeDefined();
    expect(session.data).toMatchObject({ auth_method: 'unknown' });
  });

  it('token refresh does not emit an authentication event', async () => {
    await registerUser('evt-refresh@test.com', 'secret');

    const loginRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'evt-refresh@test.com', password: 'secret' }),
    });
    const { refresh_token } = await json(loginRes);

    const authEventsAfterLogin = getWorkOSStore(store)
      .events.all()
      .filter((e) => e.event.startsWith('authentication.')).length;

    const refreshRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token }),
    });
    expect(refreshRes.status).toBe(200);

    // A rotation is not a fresh login, so it must add no authentication.* event...
    const authEventsAfterRefresh = getWorkOSStore(store)
      .events.all()
      .filter((e) => e.event.startsWith('authentication.')).length;
    expect(authEventsAfterRefresh).toBe(authEventsAfterLogin);
    // ...and specifically no spurious oauth_succeeded, which the OAuth authMethod would otherwise fire.
    expect(eventsNamed('authentication.oauth_succeeded')).toHaveLength(0);
  });
});
