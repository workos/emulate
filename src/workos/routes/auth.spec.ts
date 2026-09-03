import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';
import { STORE_KEYS } from '../constants.js';
import { hashPassword } from '../helpers.js';
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

  // Verified by default: the password grant gates an unverified mailbox with
  // email_verification_required, so a fixture for anything other than that gate is a user who
  // has already been through it.
  async function createUser(
    email: string,
    opts?: { password?: string; impersonator?: { email: string; reason: string }; email_verified?: boolean },
  ) {
    const ws = getWorkOSStore(store);
    return ws.users.insert({
      object: 'user',
      name: null,
      email,
      first_name: null,
      last_name: null,
      email_verified: opts?.email_verified ?? true,
      profile_picture_url: null,
      last_sign_in_at: null,
      external_id: null,
      metadata: {},
      locale: null,
      password_hash: null,
      impersonator: opts?.impersonator ?? null,
    });
  }

  function createOrg(name: string, entitlements: string[] = []) {
    return getWorkOSStore(store).organizations.insert({
      object: 'organization',
      name,
      external_id: null,
      metadata: {},
      stripe_customer_id: null,
      allow_profiles_outside_organization: false,
      entitlements,
    });
  }

  /** Invite `email` to `orgId`, returning the invitation including the token a client would use. */
  async function invite(email: string, orgId: string | null, roleSlug?: string) {
    const res = await req('/user_management/invitations', {
      method: 'POST',
      body: JSON.stringify({ email, organization_id: orgId, role_slug: roleSlug }),
    });
    return json(res);
  }

  const readInvitation = async (token: string) => json(await req(`/user_management/invitations/by_token/${token}`));

  const membershipsIn = async (orgId: string) =>
    (await json(await req(`/user_management/organization_memberships?organization_id=${orgId}`))).data;

  /** Create an organization and join `userId` to it, defaulting to an active membership. */
  function joinOrg(
    userId: string,
    name: string,
    opts?: { status?: 'active' | 'inactive' | 'pending'; role?: string; entitlements?: string[] },
  ) {
    const ws = getWorkOSStore(store);
    const org = createOrg(name, opts?.entitlements);
    ws.organizationMemberships.insert({
      object: 'organization_membership',
      organization_id: org.id,
      user_id: userId,
      role: { slug: opts?.role ?? 'member' },
      status: opts?.status ?? 'active',
      external_id: null,
      metadata: {},
    });
    return org;
  }

  function createFlag(
    slug: string,
    opts?: { enabled?: boolean; type?: 'boolean' | 'string' | 'number'; default_value?: unknown },
  ) {
    return getWorkOSStore(store).featureFlags.insert({
      object: 'feature_flag',
      slug,
      name: slug,
      description: null,
      type: opts?.type ?? 'boolean',
      default_value: opts?.default_value ?? true,
      enabled: opts?.enabled ?? true,
    });
  }

  function targetFlag(slug: string, resourceId: string, value: unknown, resourceType = 'user') {
    return getWorkOSStore(store).flagTargets.insert({
      object: 'flag_target',
      flag_slug: slug,
      resource_id: resourceId,
      resource_type: resourceType,
      value,
    });
  }

  /** Decode a JWT payload without verifying — these tests only inspect claims. */
  function decodeJwt(token: string): Record<string, any> {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
  }

  /** Mint a magic auth code for `email` and exchange it, as a client signing in would. */
  async function signInWithMagicAuth(email: string, invitationToken?: string) {
    const magicRes = await req('/user_management/magic_auth', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    const { code } = await json(magicRes);
    return app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:magic-auth:code',
        code,
        email,
        invitation_token: invitationToken,
      }),
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
      body: JSON.stringify({ email: 'pass@test.com', password: 'secret', email_verified: true }),
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
      body: JSON.stringify({ email: 'bad@test.com', password: 'correct', email_verified: true }),
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
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      code: 'invalid_credentials',
      message: "Invalid credentials for 'bad@test.com'.",
    });
  });

  describe('email verification gate', () => {
    const post = (body: unknown) =>
      app.request('/user_management/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    /** Sign up unverified and take the password grant's 403 to the verification step. */
    async function gatedSignIn(email: string, extra?: Record<string, unknown>) {
      const user = await json(
        await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email, password: 'pw' }) }),
      );
      const res = await post({ grant_type: 'password', email, password: 'pw', ...extra });
      return { user, res, body: await json(res) };
    }

    it('refuses an unverified password sign-in with email_verification_required', async () => {
      const { user, res, body } = await gatedSignIn('unverified@test.com');

      expect(res.status).toBe(403);
      expect(body).toMatchObject({
        code: 'email_verification_required',
        pending_authentication_token: expect.any(String),
        email_verification_id: expect.any(String),
        email: 'unverified@test.com',
      });
      // No session, and the user is still unverified: the gate is not a login.
      expect(getWorkOSStore(store).sessions.findBy('user_id', user.id)).toHaveLength(0);
      expect((await json(await req(`/user_management/users/${user.id}`))).email_verified).toBe(false);
    });

    it('redeems the pending token with the code the SDK sends, keying the session to password', async () => {
      const { user, body } = await gatedSignIn('verify-me@test.com');
      const verification = await json(await req(`/user_management/email_verification/${body.email_verification_id}`));

      // Exactly what serializeAuthenticateWithEmailVerificationOptions sends: no user_id.
      const res = await post({
        grant_type: 'urn:workos:oauth:grant-type:email-verification:code',
        pending_authentication_token: body.pending_authentication_token,
        code: verification.code,
      });

      expect(res.status).toBe(200);
      const authenticated = await json(res);
      expect(authenticated.access_token).toBeDefined();
      expect(authenticated.user.email_verified).toBe(true);
      const [session] = getWorkOSStore(store).sessions.findBy('user_id', user.id);
      expect(session.auth_method).toBe('password');

      // The token is one-time: a replay finds nothing to resolve the user from.
      const replay = await post({
        grant_type: 'urn:workos:oauth:grant-type:email-verification:code',
        pending_authentication_token: body.pending_authentication_token,
        code: verification.code,
      });
      expect(replay.status).toBe(400);
      expect((await json(replay)).code).toBe('invalid_pending_authentication_token');
    });

    it('carries an invitation across the gate', async () => {
      const org = createOrg('Gated Corp');
      const invitation = await invite('invited@test.com', org.id, 'admin');
      const { user, body } = await gatedSignIn('invited@test.com', { invitation_token: invitation.token });

      // Not spent by the gate — the client may never come back from a 403.
      expect((await readInvitation(invitation.token)).state).toBe('pending');

      const verification = await json(await req(`/user_management/email_verification/${body.email_verification_id}`));
      const res = await post({
        grant_type: 'urn:workos:oauth:grant-type:email-verification:code',
        pending_authentication_token: body.pending_authentication_token,
        code: verification.code,
      });

      expect(res.status).toBe(200);
      expect((await json(res)).organization_id).toBe(org.id);
      expect((await readInvitation(invitation.token)).state).toBe('accepted');
      expect((await membershipsIn(org.id)).map((m: any) => m.user_id)).toEqual([user.id]);
    });

    it('still accepts user_id, and names both ways in when neither is sent', async () => {
      const user = await createUser('by-id@test.com', { email_verified: false });
      const verification = await json(
        await req(`/user_management/users/${user.id}/email_verification/send`, { method: 'POST' }),
      );

      const missing = await post({ grant_type: 'urn:workos:oauth:grant-type:email-verification:code', code: '123456' });
      expect(missing.status).toBe(400);
      expect(await json(missing)).toEqual({
        error: 'invalid_request',
        error_description: 'code and pending_authentication_token (or user_id) are required.',
      });

      const res = await post({
        grant_type: 'urn:workos:oauth:grant-type:email-verification:code',
        user_id: user.id,
        code: verification.code,
      });
      expect(res.status).toBe(200);
    });
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
    // authorization_code is an OAuth grant. The hosted flow carries no provider info, so with no
    // oauth_provider configured on the user the emulator omits authentication_method rather than
    // emitting the (non-spec) internal 'OAuth' category or inventing a provider.
    expect(body.authentication_method).toBeUndefined();
  });

  it('authorization_code grant reports the user configured oauth_provider', async () => {
    const ws = getWorkOSStore(store);
    ws.users.insert({
      object: 'user',
      name: null,
      email: 'msft@test.com',
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
      oauth_provider: 'MicrosoftOAuth',
    });

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=msft@test.com',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;

    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    // A spec-valid provider was explicitly configured, so it flows through verbatim.
    expect(body.authentication_method).toBe('MicrosoftOAuth');
    // ...and the internal field never leaks into the user object.
    expect(body.user.oauth_provider).toBeUndefined();
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
      body: JSON.stringify({ email: 'refresh@test.com', password: 'pw', email_verified: true }),
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
    expect(authBody.authentication_method).toBe('Password');

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
    // A refresh reuses the session, so it echoes the original method ('Password') rather than the
    // grant's internal 'OAuth' category — which would otherwise drop the field for this user.
    expect(refreshBody.authentication_method).toBe('Password');

    // Old refresh token should be invalidated (rotation)
    const retryRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: oldRefresh }),
    });
    expect(retryRes.status).toBe(400);
    const retryBody = await json(retryRes);
    expect(retryBody.error).toBe('invalid_grant');
    expect(retryBody.error_description).toBe('Invalid refresh token.');
  });

  it('rejects invalid refresh token', async () => {
    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: 'bogus_token' }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body).toEqual({ error: 'invalid_grant', error_description: 'Invalid refresh token.' });
  });

  it('fails an expired refresh token OAuth-style, with its own description', async () => {
    await createUser('staletoken@test.com');
    const auth = await json(await signInWithMagicAuth('staletoken@test.com'));

    const ws = getWorkOSStore(store);
    const stored = ws.refreshTokens.findOneBy('token', auth.refresh_token)!;
    ws.refreshTokens.update(stored.id, { expires_at: new Date(Date.now() - 60_000).toISOString() });

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: auth.refresh_token }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid_grant', error_description: 'Refresh token has expired.' });
  });

  it('fails refresh OAuth-style when the user behind the token was deleted', async () => {
    await createUser('deleted@test.com');
    const auth = await json(await signInWithMagicAuth('deleted@test.com'));
    getWorkOSStore(store).users.delete(auth.user.id);

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: auth.refresh_token }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body).toEqual({ error: 'invalid_grant', error_description: 'Invalid refresh token.' });
  });

  it('fails an unknown authorization code OAuth-style', async () => {
    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: 'bogus' }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body).toEqual({
      error: 'invalid_grant',
      error_description: "The code 'bogus' has expired or is invalid.",
    });
  });

  // Production does not distinguish unknown from expired here, so a code that was real and aged
  // out has to be indistinguishable from one that never existed — same OAuth shape, same code,
  // same description. A client that can tell them apart locally is reading a difference that
  // production will not give it.
  it('fails an expired authorization code exactly like an unknown one', async () => {
    await createUser('stalecode@test.com');
    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;

    const ws = getWorkOSStore(store);
    const stored = ws.authCodes.findOneBy('code', code)!;
    ws.authCodes.update(stored.id, { expires_at: new Date(Date.now() - 60_000).toISOString() });

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: 'invalid_grant',
      error_description: `The code '${code}' has expired or is invalid.`,
    });
  });

  // The third grant to need this, and the one an AuthKit callback takes. Deleting a user does not
  // cascade to its authorization codes, so the code outlives the user; before the guard the shared
  // lookup answered a 404, which is the bare {message} the spec shapes 404s as — nothing for a
  // client matching on invalid_grant, on the path authkit-nextjs uses to end a dead session.
  it('fails an authorization code OAuth-style when its user was deleted', async () => {
    const user = await createUser('codegone@test.com');
    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;

    // Through the route, so the test breaks if a future cascade starts collecting auth codes.
    const del = await req(`/user_management/users/${user.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: 'invalid_grant',
      error_description: `The code '${code}' has expired or is invalid.`,
    });

    const ws = getWorkOSStore(store);
    // Unspent, like the device code's twin of this: polling or retrying cannot fix it, so the
    // caller should not pay their code for the answer.
    expect(ws.authCodes.findOneBy('code', code)).toBeDefined();
    // And it reports the failure, which the 404 path skipped — every other authorization_code
    // failure emits this event.
    const [event] = ws.events.all().filter((e) => e.event === 'authentication.oauth_failed');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({
      type: 'oauth',
      status: 'failed',
      error: { code: 'invalid_grant', message: `The code '${code}' has expired or is invalid.` },
    });
  });

  // The spec's authenticate 400 lists `invalid_request` among its {error, error_description}
  // variants and never among its {code, message} ones, so a malformed request is OAuth-shaped
  // whatever grant it names — including the grants whose credential failures are plain. That
  // makes the envelope a property of the failure, not only of the grant.
  it('fails a malformed request OAuth-style on every grant, plain-shaped ones included', async () => {
    const post = (payload: Record<string, unknown>) =>
      app.request('/user_management/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

    const noGrant = await post({ code: 'whatever' });
    expect(noGrant.status).toBe(400);
    expect(await json(noGrant)).toEqual({ error: 'invalid_request', error_description: 'grant_type is required.' });

    const noCode = await post({ grant_type: 'authorization_code' });
    expect(noCode.status).toBe(400);
    expect(await json(noCode)).toEqual({ error: 'invalid_request', error_description: 'code is required.' });

    // `password` renders its *credential* failure plain; a missing parameter is a different
    // failure and the spec shapes it the other way.
    const noPassword = await post({ grant_type: 'password', email: 'nobody@test.com' });
    expect(noPassword.status).toBe(400);
    expect(await json(noPassword)).toEqual({
      error: 'invalid_request',
      error_description: 'email and password are required.',
    });

    // An unrecognized grant_type fails authenticate's oneOf body validation, so the spec's code
    // for it is invalid_request — `unsupported_grant_type` appears only under /sso/token.
    const badGrant = await post({ grant_type: 'urn:workos:oauth:grant-type:nonsense' });
    expect(badGrant.status).toBe(400);
    expect(await json(badGrant)).toEqual({
      error: 'invalid_request',
      error_description: 'The grant type is not supported: urn:workos:oauth:grant-type:nonsense',
    });
  });

  // A PKCE code's two adjacent failures used to answer in two envelopes: a wrong verifier
  // OAuth-shaped, a missing one plain. Both are OAuth-shaped now, with the codes that name what
  // went wrong — absent is malformed, wrong is a failed grant.
  it('separates a missing code_verifier from a wrong one without changing envelope', async () => {
    const user = await createUser('pkce-missing@test.com');
    getWorkOSStore(store).authCodes.insert({
      object: 'authorization_code',
      code: 'pkce-needs-verifier',
      user_id: user.id,
      organization_id: null,
      client_id: null,
      code_challenge: 'a-challenge-no-verifier-will-hash-to',
      code_challenge_method: 'S256',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    } as never);

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: 'pkce-needs-verifier' }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid_request', error_description: 'code_verifier is required.' });
  });

  it('fails a wrong magic auth code with the plain shape and production code string', async () => {
    await createUser('wrongcode@test.com');
    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:magic-auth:code',
        email: 'wrongcode@test.com',
        code: '000000',
      }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body).toEqual({ code: 'invalid_one_time_code', message: 'Invalid one-time code' });
  });

  it('fails a PKCE verifier mismatch OAuth-style, like any other bad authorization code', async () => {
    const user = await createUser('pkce@test.com');
    getWorkOSStore(store).authCodes.insert({
      object: 'authorization_code',
      code: 'pkce-code',
      user_id: user.id,
      organization_id: null,
      client_id: null,
      code_challenge: 'a-challenge-no-verifier-will-hash-to',
      code_challenge_method: 'S256',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    } as never);

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code: 'pkce-code', code_verifier: 'wrong' }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      error: 'invalid_grant',
      error_description: "The code 'pkce-code' has expired or is invalid.",
    });
  });

  it('fails device-code polling OAuth-style at every stage', async () => {
    const start = await req('/user_management/authorize/device', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'client_device' }),
    });
    const { device_code } = await json(start);

    // Nobody has approved it yet.
    const pending = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code }),
    });
    expect(pending.status).toBe(400);
    expect(await json(pending)).toEqual({
      error: 'authorization_pending',
      error_description: 'The authorization request is still pending.',
    });

    const unknown = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: 'nope' }),
    });
    expect(unknown.status).toBe(400);
    expect(await json(unknown)).toEqual({ error: 'invalid_grant', error_description: 'Invalid device code.' });

    // The third stage: the user walked away and the code aged out. Its own OAuth code, since a
    // polling client stops on expired_token where it would keep polling on authorization_pending.
    const ws = getWorkOSStore(store);
    const stored = ws.deviceAuthorizations.findOneBy('device_code', device_code)!;
    ws.deviceAuthorizations.update(stored.id, { expires_at: new Date(Date.now() - 60_000).toISOString() });

    const expired = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code }),
    });
    expect(expired.status).toBe(400);
    expect(await json(expired)).toEqual({
      error: 'expired_token',
      error_description: 'The device code has expired.',
    });
  });

  // The same hole the refresh_token grant had: an approved code whose user is gone fell through
  // to the shared lookup and answered a polling client with the one plain 404 this endpoint never
  // otherwise returns — a body it has no reason to be able to parse.
  it('fails an approved device code OAuth-style when its user was deleted', async () => {
    const user = await createUser('devicegone@test.com');
    const start = await req('/user_management/authorize/device', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'client_device' }),
    });
    const { device_code } = await json(start);

    const ws = getWorkOSStore(store);
    const stored = ws.deviceAuthorizations.findOneBy('device_code', device_code)!;
    ws.deviceAuthorizations.update(stored.id, { user_id: user.id });
    ws.users.delete(user.id);

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ error: 'invalid_grant', error_description: 'Invalid device code.' });
    // Nothing consumed on a failure the caller cannot fix by polling again.
    expect(ws.deviceAuthorizations.findOneBy('device_code', device_code)).toBeDefined();
  });

  it('fails an expired magic auth code with the production code string', async () => {
    const user = await createUser('expired@test.com');
    getWorkOSStore(store).magicAuths.insert({
      object: 'magic_auth',
      user_id: user.id,
      email: user.email,
      code: '123456',
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:magic-auth:code',
        email: 'expired@test.com',
        code: '123456',
      }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body).toEqual({
      code: 'one_time_code_expired',
      message: "One-time code for 'expired@test.com' has expired.",
    });
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
  // Production never returns sealed_session for API requests: session sealing is done
  // client-side by the SDKs with a caller-supplied cookie password the server never sees.
  // A non-null value here pushes authkit-nextjs session cookies past the 4096-byte browser
  // cap (issue #93), so the field is always null regardless of which credentials the
  // request carries.

  it('returns sealed_session: null even when client_secret is provided', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'sealed@test.com', password: 'pw', email_verified: true }),
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
    expect(body.sealed_session).toBeNull();
  });

  it('returns sealed_session: null for the SDK refresh-token call shape', async () => {
    // @workos-inc/node's authenticateWithRefreshToken sends both an Authorization: Bearer
    // header (the API key) and the same key as client_secret in the body — exactly the
    // shape that used to opt into sealing via `clientSecret ?? apiKey`.
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'sealed-refresh@test.com', password: 'pw', email_verified: true }),
    });

    const authRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        client_id: 'test_client',
        email: 'sealed-refresh@test.com',
        password: 'pw',
      }),
    });
    expect(authRes.status).toBe(200);
    const authBody = await json(authRes);

    const refreshRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk_test_auth' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: authBody.refresh_token,
        client_id: 'test_client',
        client_secret: 'sk_test_auth',
      }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await json(refreshRes);
    expect(refreshBody.sealed_session).toBeNull();
    expect(refreshBody.access_token).toBeTruthy();
    expect(refreshBody.refresh_token).toBeTruthy();
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

  it('rejects a non-string email on magic auth creation', async () => {
    const res = await req('/user_management/magic_auth', {
      method: 'POST',
      body: JSON.stringify({ email: 123 }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('invalid_request');
    // Named for what it is. Routing this into the presence check reported "email is required" for
    // an address that was supplied — the same backwards message the shape guard exists to avoid.
    expect(body.message).toBe('email must be a string');
  });

  // Every one of these paths type-asserted `email` and then lowercased it to resolve the account
  // case-insensitively, so a non-string arrived at `.toLowerCase()` and came back a 500 —
  // `server_error` in a consumer's suite reads as an emulator defect, not a malformed request.
  it('rejects a non-string email with 400 on every grant that resolves one', async () => {
    const password = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 123, password: 'whatever' }),
    });
    expect(password.status).toBe(400);
    expect((await json(password)).message).toBe('email must be a string');

    const magic = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:magic-auth:code',
        code: '123456',
        email: { not: 'a string' },
      }),
    });
    expect(magic.status).toBe(400);
    expect((await json(magic)).message).toBe('email must be a string');
  });

  // Creation trims before storing, so a read that skipped the trim could not find the account
  // creation had just written under the same address.
  it('trims a padded address on the paths that resolve one', async () => {
    const signup = await json(
      await req('/user_management/magic_auth', {
        method: 'POST',
        body: JSON.stringify({ email: '  padded@x.test  ' }),
      }),
    );
    expect(signup.email).toBe('padded@x.test');

    getWorkOSStore(store).users.update(signup.user_id, { password_hash: hashPassword('pw'), email_verified: true });
    const password = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: ' padded@x.test ', password: 'pw' }),
    });
    expect(password.status).toBe(200);

    const reset = await req('/user_management/password_reset', {
      method: 'POST',
      body: JSON.stringify({ email: ' padded@x.test ' }),
    });
    expect(reset.status).toBe(201);
  });

  it('creates the user at magic auth code creation for an unknown email', async () => {
    const magicRes = await req('/user_management/magic_auth', {
      method: 'POST',
      body: JSON.stringify({ email: 'signup@test.com' }),
    });
    expect(magicRes.status).toBe(201);
    const magicBody = await json(magicRes);
    expect(magicBody.user_id).toBeTruthy();

    const usersRes = await req('/user_management/users?email=signup%40test.com');
    const users = await json(usersRes);
    expect(users.data).toHaveLength(1);
    expect(users.data[0].id).toBe(magicBody.user_id);
    expect(users.data[0].email_verified).toBe(false);
  });

  // A sign-up that creates a user is a sign-up a webhook consumer expects to hear about, which is
  // a large part of why this endpoint creating one is useful to test against at all.
  it('emits user.created for a sign-up, and none when the user already existed', async () => {
    const ws = getWorkOSStore(store);
    const created = () =>
      ws.events.all().filter((e: { event: string; data: Record<string, unknown> }) => e.event === 'user.created');

    const signup = await json(
      await req('/user_management/magic_auth', { method: 'POST', body: JSON.stringify({ email: 'evented@test.com' }) }),
    );
    expect(created()).toHaveLength(1);
    expect(created()[0].data).toMatchObject({ id: signup.user_id, email: 'evented@test.com', email_verified: false });

    // A second code for the same address resolves the existing user, so nothing was created.
    await req('/user_management/magic_auth', { method: 'POST', body: JSON.stringify({ email: 'evented@test.com' }) });
    expect(created()).toHaveLength(1);
  });

  it('resolves an existing user case-insensitively instead of forking the account', async () => {
    const first = await json(
      await req('/user_management/magic_auth', {
        method: 'POST',
        body: JSON.stringify({ email: 'Casing@Test.com' }),
      }),
    );
    const second = await json(
      await req('/user_management/magic_auth', {
        method: 'POST',
        body: JSON.stringify({ email: 'casing@test.com' }),
      }),
    );

    expect(second.user_id).toBe(first.user_id);
    // Stored as first given — production preserves the case it was handed.
    const users = getWorkOSStore(store).users.all();
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('Casing@Test.com');

    // And the code is redeemable with the address it was requested for, not only the stored
    // casing. Resolving the user case-insensitively while matching the code exactly would
    // return a 201 carrying a code that this authenticate call could never spend.
    const auth = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:magic-auth:code',
        code: second.code,
        email: 'casing@test.com',
      }),
    });
    expect(auth.status).toBe(200);
    expect((await json(auth)).user.id).toBe(first.user_id);
  });

  it('rejects an email that could only be a typo, rather than creating a ghost user', async () => {
    for (const email of ['', '   ', 'not-an-email', 'a b@test.com', '@test.com', 'nope@']) {
      const res = await req('/user_management/magic_auth', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('invalid_request');
    }
    expect(getWorkOSStore(store).users.all()).toHaveLength(0);
  });

  // Absent and malformed have the same fix only if the caller is told which one happened. `null`
  // counts as absent — it is how a JSON body spells it, and both creation paths agree on that.
  it('distinguishes a missing email from an unusable one', async () => {
    for (const body of [{}, { email: null }]) {
      const missing = await req('/user_management/magic_auth', { method: 'POST', body: JSON.stringify(body) });
      expect(missing.status).toBe(400);
      expect((await json(missing)).message).toBe('email is required');
    }

    const malformed = await req('/user_management/magic_auth', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    });
    expect((await json(malformed)).message).toBe('email must be a valid email address');
  });

  // Magic Auth stores the case it was handed, so every other way in has to resolve that way too
  // — otherwise a sign-up creates an account the rest of the API cannot reach.
  it('reaches a Magic Auth account by any casing of its address', async () => {
    await req('/user_management/magic_auth', { method: 'POST', body: JSON.stringify({ email: 'Mixed@Case.test' }) });
    const user = getWorkOSStore(store).users.all()[0];
    getWorkOSStore(store).users.update(user.id, { password_hash: hashPassword('correct horse'), email_verified: true });

    const password = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'mixed@case.test', password: 'correct horse' }),
    });
    expect(password.status).toBe(200);
    expect((await json(password)).user.id).toBe(user.id);

    const reset = await req('/user_management/password_reset', {
      method: 'POST',
      body: JSON.stringify({ email: 'mixed@case.test' }),
    });
    expect(reset.status).toBe(201);
  });

  it('emits one user.updated per magic auth sign-in, and none for a no-op re-verify', async () => {
    const ws = getWorkOSStore(store);
    const countUpdates = () => ws.events.all().filter((e: { event: string }) => e.event === 'user.updated').length;

    await signInWithMagicAuth('quiet@test.com');
    const afterFirst = countUpdates();
    // The sign-up login verifies the email (a real attribute change), which emits
    // user.updated. last_sign_in_at rides along in the same write.
    expect(afterFirst).toBe(1);

    await signInWithMagicAuth('quiet@test.com');
    // The second login only stamps last_sign_in_at, which production writes silently via
    // updateWithSignIn (no user.updated); email_verified is already true. See #55.
    expect(countUpdates()).toBe(1);
  });

  it('magic auth sign-up verifies the email and yields an org-less session', async () => {
    const res = await signInWithMagicAuth('signup2@test.com');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.user.email_verified).toBe(true);
    expect(decodeJwt(body.access_token).org_id).toBeUndefined();
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

  it('device authorization derives verification_uri from the server baseUrl', async () => {
    const local = createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:9999', apiKeys });
    const res = await local.app.request('/user_management/authorize/device', {
      method: 'POST',
      headers,
      body: JSON.stringify({ client_id: 'test_client' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).verification_uri).toBe('http://localhost:9999/user_management/authorize/device/verify');
  });

  it('GET /user_management/authorize/device/verify serves an HTML confirmation page', async () => {
    const res = await app.request('/user_management/authorize/device/verify');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Device approved');
  });

  it('device authorization accepts form-encoded bodies', async () => {
    await createUser('formdevice@test.com');
    const res = await app.request('/user_management/authorize/device', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer sk_test_auth',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ client_id: 'test_client' }).toString(),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.device_code).toBeDefined();
    expect(body.user_code).toBeDefined();
  });

  it('device_code grant accepts form-encoded bodies', async () => {
    await createUser('formgrant@test.com');
    const start = await req('/user_management/authorize/device', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'test_client' }),
    });
    const { device_code } = await json(start);

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code,
      }).toString(),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.access_token).toBeDefined();
    expect(body.user.email).toBe('formgrant@test.com');
  });

  it('password grant accepts form-encoded bodies', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'formpass@test.com', password: 'secret', email_verified: true }),
    });

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        email: 'formpass@test.com',
        password: 'secret',
      }).toString(),
    });
    // Production accepts form-encoded on every /authenticate grant (Nest's default urlencoded
    // parser is active), not just device_code, so the emulator mirrors that rather than being
    // more restrictive and producing a false failure.
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.access_token).toBeDefined();
    expect(body.user.email).toBe('formpass@test.com');
    expect(body.authentication_method).toBe('Password');
  });

  // --- Organization selection grant tests ---

  it('organization-selection grant scopes session to selected org', async () => {
    const user = await createUser('orgsel@test.com');
    // The user must be an active member of the org they select — production issues no token
    // for an organization the user does not belong to.
    const org = joinOrg(user.id, 'Test Org');

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

  it('organization-selection grant rejects an org the user does not actively belong to', async () => {
    const user = await createUser('orgsel-outsider@test.com');
    const other = await createUser('orgsel-insider@test.com');
    const foreignOrg = joinOrg(other.id, 'Someone Elses Org');
    const invitedOrg = joinOrg(user.id, 'Invited But Unaccepted', { status: 'pending' });

    const pendingToken = 'pending_outsider_token';
    const setPending = () =>
      store.setData(`pending_auth:${pendingToken}`, {
        user_id: user.id,
        organization_id: null,
        auth_method: 'Password',
      });

    const select = (organizationId: string) =>
      app.request('/user_management/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:workos:oauth:grant-type:organization-selection',
          pending_authentication_token: pendingToken,
          organization_id: organizationId,
        }),
      });

    setPending();
    const foreignRes = await select(foreignOrg.id);
    expect(foreignRes.status).toBe(400);
    expect((await json(foreignRes)).code).toBe('organization_membership_not_found');

    // A rejected selection must not consume the pending token: the client retries with another
    // organization. An unaccepted invitation is not one it can pick.
    const pendingRes = await select(invitedOrg.id);
    expect(pendingRes.status).toBe(400);
    expect((await json(pendingRes)).code).toBe('organization_membership_not_found');
  });

  // --- Organization resolution on fresh logins ---

  it('magic-auth resolves the single active organization onto the session and token', async () => {
    const user = await createUser('solo-org@test.com');
    const org = joinOrg(user.id, 'Solo Corp', { role: 'admin' });

    const res = await signInWithMagicAuth('solo-org@test.com');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.organization_id).toBe(org.id);

    const claims = decodeJwt(body.access_token);
    expect(claims.org_id).toBe(org.id);
    expect(claims.role).toBe('admin');
    expect(claims.roles).toEqual(['admin']);
    // AuthKit access tokens carry a ULID jti, matching production and the M2M path.
    expect(claims.jti).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    // The session records the same organization the token claims.
    const session = getWorkOSStore(store).sessions.get(claims.sid);
    expect(session?.organization_id).toBe(org.id);
  });

  it('mints the permissions claim from the organization role when it shadows an environment role', async () => {
    const ws = getWorkOSStore(store);

    // Environment 'admin' role inserted first
    const envPerm = ws.permissions.insert({ object: 'permission', slug: 'env:perm', name: 'Env', description: null });
    const envRole = ws.roles.insert({
      object: 'role',
      slug: 'admin',
      name: 'Admin',
      description: null,
      type: 'EnvironmentRole',
      organization_id: null,
      is_default_role: false,
      priority: 0,
    });
    ws.rolePermissions.insert({ role_id: envRole.id, permission_id: envPerm.id });

    const user = await createUser('shadowed-role@test.com');
    const org = joinOrg(user.id, 'Shadow Corp', { role: 'admin' });

    // Org-scoped 'admin' shadows the environment role — the token must agree
    // with /check and effective-permissions, which resolve the org role.
    const orgPerm = ws.permissions.insert({ object: 'permission', slug: 'org:perm', name: 'Org', description: null });
    const orgRole = ws.roles.insert({
      object: 'role',
      slug: 'admin',
      name: 'Org Admin',
      description: null,
      type: 'OrganizationRole',
      organization_id: org.id,
      is_default_role: false,
      priority: 0,
    });
    ws.rolePermissions.insert({ role_id: orgRole.id, permission_id: orgPerm.id });

    const res = await signInWithMagicAuth('shadowed-role@test.com');
    expect(res.status).toBe(200);
    const claims = decodeJwt((await json(res)).access_token);
    expect(claims.role).toBe('admin');
    expect(claims.permissions).toEqual(['org:perm']);
  });

  it('includes client_id on the access token when the authorize flow carries one', async () => {
    await createUser('cid@test.com');

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=cid@test.com&client_id=test_client',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'test_client' }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    expect(decodeJwt(body.access_token).client_id).toBe('test_client');
  });

  it('includes auth_time as a Unix-seconds number on the access token', async () => {
    await createUser('authtime@test.com');

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=authtime@test.com&client_id=test_client',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'test_client' }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    const claims = decodeJwt(body.access_token);
    expect(claims.auth_time).toBeNumber();
    expect(Number.isInteger(claims.auth_time)).toBe(true);
    // Stamped at sign-in, so it is within a few seconds of now.
    expect(Math.abs(claims.auth_time - Math.floor(Date.now() / 1000))).toBeLessThan(60);
  });

  it('carries auth_time unchanged across a refresh_token grant', async () => {
    await createUser('authtime-refresh@test.com');

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=authtime-refresh@test.com&client_id=test_client',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'test_client' }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await json(tokenRes);
    const originalAuthTime = decodeJwt(tokenBody.access_token).auth_time;
    expect(originalAuthTime).toBeNumber();

    // A refresh reuses the existing session, so auth_time must not advance.
    const refreshRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokenBody.refresh_token,
        client_id: 'test_client',
      }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await json(refreshRes);
    expect(decodeJwt(refreshBody.access_token).auth_time).toBe(originalAuthTime);
  });

  it('binds client_id to the authorization grant, not the redemption request', async () => {
    await createUser('cid-mismatch@test.com');

    // Authorize with one client_id…
    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=cid-mismatch@test.com&client_id=original_client',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    // …then redeem the code with a different one. The token must carry the originating client.
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'spoofed_client' }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    const claims = decodeJwt(body.access_token);
    expect(claims.client_id).toBe('original_client');
    expect(claims.aud).toBe('original_client');
  });

  it('carries the bound client_id across a refresh_token rotation', async () => {
    await createUser('cid-refresh@test.com');

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=cid-refresh@test.com&client_id=original_client',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'original_client' }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await json(tokenRes);
    expect(decodeJwt(tokenBody.access_token).client_id).toBe('original_client');

    // Refresh with a different client_id — the bound value must persist.
    const refreshRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokenBody.refresh_token,
        client_id: 'spoofed_client',
      }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await json(refreshRes);
    expect(decodeJwt(refreshBody.access_token).client_id).toBe('original_client');
  });

  it('includes the RFC 8693 act claim when the session is impersonated', async () => {
    await createUser('impersonated@test.com', {
      impersonator: { email: 'admin@test.com', reason: 'debugging' },
    });

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=impersonated@test.com&client_id=test_client',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'test_client' }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    // The session-tokens reference puts the impersonator's email in the nested sub.
    expect(decodeJwt(body.access_token).act).toEqual({ sub: 'admin@test.com' });
  });

  it('keeps the act claim across a refresh_token grant', async () => {
    await createUser('impersonated-refresh@test.com', {
      impersonator: { email: 'admin@test.com', reason: 'debugging' },
    });

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=impersonated-refresh@test.com&client_id=test_client',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'test_client' }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await json(tokenRes);
    expect(decodeJwt(tokenBody.access_token).act).toEqual({ sub: 'admin@test.com' });

    // A refreshed token still represents the same impersonated session.
    const refreshRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokenBody.refresh_token,
        client_id: 'test_client',
      }),
    });
    expect(refreshRes.status).toBe(200);
    const refreshBody = await json(refreshRes);
    expect(decodeJwt(refreshBody.access_token).act).toEqual({ sub: 'admin@test.com' });
  });

  it('mints the organization entitlements on org-scoped tokens and re-reads them on refresh', async () => {
    const user = await createUser('entitled@test.com');
    const org = joinOrg(user.id, 'Entitled Corp', { entitlements: ['audit-logs', 'sso'] });

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=entitled@test.com&client_id=test_client',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'test_client' }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await json(tokenRes);
    expect(decodeJwt(tokenBody.access_token).entitlements).toEqual(['audit-logs', 'sso']);

    // Re-read at every mint: a plan change shows up in the next refreshed token.
    getWorkOSStore(store).organizations.update(org.id, { entitlements: ['audit-logs'] });
    const refreshRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokenBody.refresh_token,
        client_id: 'test_client',
      }),
    });
    expect(refreshRes.status).toBe(200);
    expect(decodeJwt((await json(refreshRes)).access_token).entitlements).toEqual(['audit-logs']);
  });

  it('mints feature_flags from flags resolving strictly true for the user', async () => {
    const user = await createUser('flags@test.com');
    createFlag('on-by-default');
    createFlag('switched-off', { enabled: false });
    createFlag('targeted-on', { enabled: false });
    targetFlag('targeted-on', user.id, true);
    createFlag('typed', { type: 'string', default_value: 'variant-a' });

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=flags@test.com&client_id=test_client',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'test_client' }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    // Enabled default and true user target are in; disabled and non-boolean flags are not.
    expect(decodeJwt(body.access_token).feature_flags!.sort()).toEqual(['on-by-default', 'targeted-on']);
  });

  it('resolves org-targeted flags for org-scoped sessions, with user targets winning', async () => {
    const user = await createUser('org-flags@test.com');
    const org = joinOrg(user.id, 'Flag Corp');
    createFlag('org-flag', { enabled: false });
    targetFlag('org-flag', org.id, true, 'organization');
    createFlag('user-off');
    targetFlag('user-off', user.id, false);

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=org-flags@test.com&client_id=test_client',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'test_client' }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    const flags = decodeJwt(body.access_token).feature_flags!;
    expect(flags).toContain('org-flag');
    expect(flags).not.toContain('user-off');
  });

  it('re-resolves feature_flags on refresh and omits the claim when nothing is on', async () => {
    await createUser('flag-toggle@test.com');
    const flag = createFlag('beta');

    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=flag-toggle@test.com&client_id=test_client',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;
    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'test_client' }),
    });
    expect(tokenRes.status).toBe(200);
    const tokenBody = await json(tokenRes);
    expect(decodeJwt(tokenBody.access_token).feature_flags).toEqual(['beta']);

    // The toggle lands in the next mint; with nothing on, the claim is omitted, not [].
    getWorkOSStore(store).featureFlags.update(flag.id, { enabled: false });
    const refreshRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokenBody.refresh_token,
        client_id: 'test_client',
      }),
    });
    expect(refreshRes.status).toBe(200);
    expect(decodeJwt((await json(refreshRes)).access_token).feature_flags).toBeUndefined();
  });

  it('gives each AuthKit access token a distinct jti', async () => {
    await createUser('jti-a@test.com');
    await createUser('jti-b@test.com');
    const first = decodeJwt((await json(await signInWithMagicAuth('jti-a@test.com'))).access_token);
    const second = decodeJwt((await json(await signInWithMagicAuth('jti-b@test.com'))).access_token);
    expect(first.jti).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(second.jti).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(first.jti).not.toBe(second.jti);
  });

  it('resolves the single active organization through the AuthKit hosted flow', async () => {
    const user = await createUser('hosted@test.com');
    const org = joinOrg(user.id, 'Hosted Corp');

    // Codes are minted with organization_id: null, so the hosted flow relies entirely on the
    // resolution step at the token endpoint.
    const authRes = await app.request(
      '/user_management/authorize?redirect_uri=http://localhost:3000/callback&response_type=code&login_hint=hosted@test.com',
    );
    const code = new URL(authRes.headers.get('location')!).searchParams.get('code')!;

    const tokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    expect(tokenRes.status).toBe(200);
    const body = await json(tokenRes);
    expect(body.organization_id).toBe(org.id);
    expect(decodeJwt(body.access_token).org_id).toBe(org.id);
  });

  it('resolves the single active organization on password, email-verification and device_code', async () => {
    const created = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'multi-grant@test.com', password: 'pw', email_verified: true }),
    });
    const user = await json(created);
    const org = joinOrg(user.id, 'Grant Corp');

    const passwordRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'multi-grant@test.com', password: 'pw' }),
    });
    expect((await json(passwordRes)).organization_id).toBe(org.id);

    const ws = getWorkOSStore(store);
    const verification = ws.emailVerifications.insert({
      object: 'email_verification',
      user_id: user.id,
      email: user.email,
      code: '424242',
      expires_at: new Date(Date.now() + 600000).toISOString(),
    });
    const verifyRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:email-verification:code',
        code: verification.code,
        user_id: user.id,
      }),
    });
    expect((await json(verifyRes)).organization_id).toBe(org.id);

    const deviceRes = await req('/user_management/authorize/device', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'test_client' }),
    });
    const device = await json(deviceRes);
    const deviceTokenRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
      }),
    });
    expect((await json(deviceTokenRes)).organization_id).toBe(org.id);
  });

  it('returns organization_selection_required for a user with several active organizations', async () => {
    const created = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'multi-org@test.com', password: 'pw', email_verified: true }),
    });
    const user = await json(created);
    const first = joinOrg(user.id, 'Alpha Corp');
    const second = joinOrg(user.id, 'Beta Corp');

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'multi-org@test.com', password: 'pw' }),
    });
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.code).toBe('organization_selection_required');
    expect(body.pending_authentication_token).toBeTruthy();
    expect(body.user.id).toBe(user.id);
    expect(body.organizations).toEqual([
      { id: first.id, name: 'Alpha Corp' },
      { id: second.id, name: 'Beta Corp' },
    ]);
    // No session and no sign-in: the authentication is not finished until an org is chosen.
    expect(body.access_token).toBeUndefined();
    const ws = getWorkOSStore(store);
    expect(ws.sessions.findBy('user_id', user.id)).toHaveLength(0);
    expect(ws.users.get(user.id)?.last_sign_in_at).toBeNull();

    // The pending token it hands back completes the sign-in against a chosen organization.
    const selected = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:organization-selection',
        pending_authentication_token: body.pending_authentication_token,
        organization_id: second.id,
      }),
    });
    expect(selected.status).toBe(200);
    const selectedBody = await json(selected);
    expect(selectedBody.organization_id).toBe(second.id);
    expect(decodeJwt(selectedBody.access_token).org_id).toBe(second.id);
    // The pending token recorded the primary factor, so the session reports it.
    expect(selectedBody.authentication_method).toBe('Password');
  });

  it('requires the second factor before organization selection', async () => {
    const created = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'mfa-multi-org@test.com', password: 'pw', email_verified: true }),
    });
    const user = await json(created);
    joinOrg(user.id, 'Gamma Corp');
    const chosen = joinOrg(user.id, 'Delta Corp');

    const ws = getWorkOSStore(store);
    ws.authFactors.insert({
      object: 'authentication_factor',
      user_id: user.id,
      type: 'totp',
      totp: { issuer: 'Test', user: user.email, uri: 'otpauth://...' },
    });

    // MFA comes first: the org is not resolved while the login is still unauthenticated.
    const passwordRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'mfa-multi-org@test.com', password: 'pw' }),
    });
    expect(passwordRes.status).toBe(403);
    const challengeBody = await json(passwordRes);
    expect(challengeBody.code).toBe('mfa_challenge');

    // The response withholds the one-time code, as production does; read it off the challenge.
    const challengeCode = ws.authChallenges.get(challengeBody.authentication_challenge.id)!.code;

    // Clearing the factor surfaces the organization choice, on a fresh pending token.
    const mfaRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:mfa-totp',
        code: challengeCode,
        pending_authentication_token: challengeBody.pending_authentication_token,
        authentication_challenge_id: challengeBody.authentication_challenge.id,
      }),
    });
    expect(mfaRes.status).toBe(403);
    const selectionBody = await json(mfaRes);
    expect(selectionBody.code).toBe('organization_selection_required');
    expect(selectionBody.pending_authentication_token).not.toBe(challengeBody.pending_authentication_token);

    const selected = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:organization-selection',
        pending_authentication_token: selectionBody.pending_authentication_token,
        organization_id: chosen.id,
      }),
    });
    expect(selected.status).toBe(200);
    const selectedBody = await json(selected);
    expect(selectedBody.organization_id).toBe(chosen.id);
    // The primary factor survives both hops, so the session reports 'Password', not 'MFA'.
    expect(selectedBody.authentication_method).toBe('Password');
  });

  it('ignores pending and inactive memberships when resolving an organization', async () => {
    const user = await createUser('not-yet@test.com');
    joinOrg(user.id, 'Unaccepted Invite', { status: 'pending' });
    joinOrg(user.id, 'Deactivated', { status: 'inactive' });

    const res = await signInWithMagicAuth('not-yet@test.com');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.organization_id).toBeNull();
    expect(decodeJwt(body.access_token).org_id).toBeUndefined();
  });

  it('leaves an unscoped session unscoped across a refresh', async () => {
    const user = await createUser('later-member@test.com');

    const signIn = await signInWithMagicAuth('later-member@test.com');
    const { refresh_token } = await json(signIn);

    // Joining an org mid-session must not silently upgrade the session's scope on refresh —
    // only an explicit organization_id moves an existing session between organizations.
    const org = joinOrg(user.id, 'Joined Later');

    const refreshed = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token }),
    });
    expect(refreshed.status).toBe(200);
    const refreshedBody = await json(refreshed);
    expect(refreshedBody.organization_id).toBeNull();

    const switched = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshedBody.refresh_token,
        organization_id: org.id,
      }),
    });
    expect((await json(switched)).organization_id).toBe(org.id);
  });

  // --- invitation_token ---

  it('accepts an invitation_token, joining the org and scoping the session', async () => {
    await createUser('invited@test.com');
    const org = createOrg('Invited Corp');
    const invitation = await invite('invited@test.com', org.id, 'admin');

    const magicRes = await req('/user_management/magic_auth', {
      method: 'POST',
      body: JSON.stringify({ email: 'invited@test.com' }),
    });
    const { code } = await json(magicRes);

    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:magic-auth:code',
        code,
        email: 'invited@test.com',
        invitation_token: invitation.token,
      }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.organization_id).toBe(org.id);

    const claims = decodeJwt(body.access_token);
    expect(claims.org_id).toBe(org.id);
    // The invitation's role_slug becomes the membership role, so the token carries it.
    expect(claims.role).toBe('admin');
    expect(claims.roles).toEqual(['admin']);

    expect((await readInvitation(invitation.token)).state).toBe('accepted');
    const memberships = await membershipsIn(org.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].status).toBe('active');
  });

  it('lets an invitation_token settle the organization for a multi-org user', async () => {
    const user = await createUser('invited-multi@test.com');
    joinOrg(user.id, 'Existing One');
    joinOrg(user.id, 'Existing Two');
    const invitedOrg = createOrg('Third Corp');
    const invitation = await invite('invited-multi@test.com', invitedOrg.id);

    // Without the invitation this user would get organization_selection_required; the invitation
    // names an organization, so there is nothing left to choose.
    const res = await signInWithMagicAuth('invited-multi@test.com', invitation.token);
    expect(res.status).toBe(200);
    expect((await json(res)).organization_id).toBe(invitedOrg.id);
  });

  it('reactivates a deactivated membership on a fresh invitation', async () => {
    const user = await createUser('returning@test.com');
    const org = joinOrg(user.id, 'Boomerang Corp', { status: 'inactive' });
    const invitation = await invite('returning@test.com', org.id, 'admin');

    const res = await signInWithMagicAuth('returning@test.com', invitation.token);
    expect(res.status).toBe(200);
    expect((await json(res)).organization_id).toBe(org.id);

    // Reused, not duplicated.
    const memberships = await membershipsIn(org.id);
    expect(memberships).toHaveLength(1);
    expect(memberships[0].status).toBe('active');
    expect(memberships[0].role.slug).toBe('admin');
  });

  it('rejects an invitation issued for a different email', async () => {
    await createUser('recipient@test.com');
    await createUser('interloper@test.com');
    const org = createOrg('Not Yours Corp');
    const invitation = await invite('recipient@test.com', org.id);

    const res = await signInWithMagicAuth('interloper@test.com', invitation.token);
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('invitation_cannot_be_used_for_email');
    expect((await readInvitation(invitation.token)).state).toBe('pending');
    expect(await membershipsIn(org.id)).toHaveLength(0);
  });

  it('rejects a revoked or unknown invitation without consuming the one-time code', async () => {
    await createUser('revoked@test.com');
    const org = createOrg('Revoked Corp');
    const invitation = await invite('revoked@test.com', org.id);
    await req(`/user_management/invitations/${invitation.id}/revoke`, { method: 'POST' });

    const magicRes = await req('/user_management/magic_auth', {
      method: 'POST',
      body: JSON.stringify({ email: 'revoked@test.com' }),
    });
    const { code } = await json(magicRes);

    const exchange = (invitationToken?: string) =>
      app.request('/user_management/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:workos:oauth:grant-type:magic-auth:code',
          code,
          email: 'revoked@test.com',
          invitation_token: invitationToken,
        }),
      });

    const revokedRes = await exchange(invitation.token);
    expect(revokedRes.status).toBe(400);
    expect((await json(revokedRes)).code).toBe('invitation_invalid');

    const unknownRes = await exchange('inv_tok_does_not_exist');
    expect(unknownRes.status).toBe(400);
    expect((await json(unknownRes)).code).toBe('invitation_invalid');

    // The invitation is checked before the grant runs, so the magic auth code survives both
    // rejections and the user can still sign in.
    const retry = await exchange();
    expect(retry.status).toBe(200);
    expect((await json(retry)).organization_id).toBeNull();
  });

  it('ignores invitation_token on a grant that does not accept one', async () => {
    await createUser('refresh-invite@test.com');
    const org = createOrg('Ignored Corp');
    const invitation = await invite('refresh-invite@test.com', org.id);

    const signIn = await signInWithMagicAuth('refresh-invite@test.com');
    const { refresh_token } = await json(signIn);

    const refreshed = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token, invitation_token: invitation.token }),
    });
    expect(refreshed.status).toBe(200);
    expect((await json(refreshed)).organization_id).toBeNull();
    // refresh_token has no invitation_token in its schema, so production would never accept it.
    expect((await readInvitation(invitation.token)).state).toBe('pending');
  });

  it('holds an invitation until the second factor clears', async () => {
    const created = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'mfa-invite@test.com', password: 'pw', email_verified: true }),
    });
    const user = await json(created);
    const org = createOrg('Second Factor Corp');
    const invitation = await invite('mfa-invite@test.com', org.id);

    const ws = getWorkOSStore(store);
    ws.authFactors.insert({
      object: 'authentication_factor',
      user_id: user.id,
      type: 'totp',
      totp: { issuer: 'Test', user: user.email, uri: 'otpauth://...' },
    });

    const passwordRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        email: 'mfa-invite@test.com',
        password: 'pw',
        invitation_token: invitation.token,
      }),
    });
    expect(passwordRes.status).toBe(403);
    const challengeBody = await json(passwordRes);
    expect(challengeBody.code).toBe('mfa_challenge');
    // Nothing is accepted while the login is still unproven.
    expect((await readInvitation(invitation.token)).state).toBe('pending');

    const mfaRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:mfa-totp',
        code: ws.authChallenges.get(challengeBody.authentication_challenge.id)!.code,
        pending_authentication_token: challengeBody.pending_authentication_token,
        authentication_challenge_id: challengeBody.authentication_challenge.id,
      }),
    });
    expect(mfaRes.status).toBe(200);
    expect((await json(mfaRes)).organization_id).toBe(org.id);
    expect((await readInvitation(invitation.token)).state).toBe('accepted');
  });

  it('reports the same error when a deferred invitation dies mid-challenge', async () => {
    const created = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'mfa-revoked@test.com', password: 'pw', email_verified: true }),
    });
    const user = await json(created);
    const org = createOrg('Vanishing Corp');
    const invitation = await invite('mfa-revoked@test.com', org.id);

    const ws = getWorkOSStore(store);
    ws.authFactors.insert({
      object: 'authentication_factor',
      user_id: user.id,
      type: 'totp',
      totp: { issuer: 'Test', user: user.email, uri: 'otpauth://...' },
    });

    const passwordRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        email: 'mfa-revoked@test.com',
        password: 'pw',
        invitation_token: invitation.token,
      }),
    });
    const challengeBody = await json(passwordRes);
    const challengeCode = ws.authChallenges.get(challengeBody.authentication_challenge.id)!.code;

    // The invitation is withdrawn while the user is still entering their code.
    await req(`/user_management/invitations/${invitation.id}/revoke`, { method: 'POST' });

    const completeMfa = () =>
      app.request('/user_management/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:workos:oauth:grant-type:mfa-totp',
          code: challengeCode,
          pending_authentication_token: challengeBody.pending_authentication_token,
          authentication_challenge_id: challengeBody.authentication_challenge.id,
        }),
      });

    const first = await completeMfa();
    expect(first.status).toBe(400);
    expect((await json(first)).code).toBe('invitation_invalid');

    // The challenge and pending token are revalidated before they are consumed, so a retry reports
    // the same cause rather than decaying into invalid_pending_authentication_token.
    const second = await completeMfa();
    expect(second.status).toBe(400);
    expect((await json(second)).code).toBe('invitation_invalid');

    expect(ws.sessions.findBy('user_id', user.id)).toHaveLength(0);
  });

  it('defers an organization-less invitation until selection completes', async () => {
    const user = await createUser('org-less-invite@test.com');
    joinOrg(user.id, 'Alpha Existing');
    const beta = joinOrg(user.id, 'Beta Existing');
    // An invitation naming no organization cannot settle the choice for a multi-org user.
    const invitation = await invite('org-less-invite@test.com', null);

    const res = await signInWithMagicAuth('org-less-invite@test.com', invitation.token);
    expect(res.status).toBe(403);
    const body = await json(res);
    expect(body.code).toBe('organization_selection_required');
    // Not spent on a response that issued no session.
    expect((await readInvitation(invitation.token)).state).toBe('pending');

    const selected = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:organization-selection',
        pending_authentication_token: body.pending_authentication_token,
        organization_id: beta.id,
      }),
    });
    expect(selected.status).toBe(200);
    expect((await json(selected)).organization_id).toBe(beta.id);
    expect((await readInvitation(invitation.token)).state).toBe('accepted');
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

    // Create pending auth. MFA is a second factor; the pending token records the *primary*
    // method (here 'Password') so the completed session and response report that, not 'MFA'.
    const pendingToken = 'pending_mfa_token';
    store.setData(`pending_auth:${pendingToken}`, {
      user_id: user.id,
      organization_id: null,
      auth_method: 'Password',
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
    // The response reports the primary method the MFA challenge was issued over, not 'MFA'.
    expect(body.authentication_method).toBe('Password');
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

  /** Mirrors createOrg/joinOrg in the 'Auth routes' block above, which are out of scope here. */
  const createOrg = (name: string) =>
    getWorkOSStore(store).organizations.insert({
      object: 'organization',
      name,
      external_id: null,
      metadata: {},
      stripe_customer_id: null,
      allow_profiles_outside_organization: false,
      entitlements: [],
    });

  const joinOrg = (userId: string, name: string) => {
    const org = createOrg(name);
    getWorkOSStore(store).organizationMemberships.insert({
      object: 'organization_membership',
      organization_id: org.id,
      user_id: userId,
      role: { slug: 'member' },
      status: 'active',
      external_id: null,
      metadata: {},
    });
    return org;
  };

  const seedUser = (ws: ReturnType<typeof getWorkOSStore>, email: string, name: string | null = null) =>
    ws.users.insert({
      object: 'user',
      name,
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
      impersonator: null,
    });

  it('GET /user_management/authorize returns HTML login page', async () => {
    const ws = getWorkOSStore(store);
    ws.users.insert({
      object: 'user',
      name: null,
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

  it('GET /user_management/authorize offers the stored accounts as a picker', async () => {
    const ws = getWorkOSStore(store);
    seedUser(ws, 'alice@test.com', 'Alice Smith');
    seedUser(ws, 'bob@test.com');

    const res = await app.request('/user_management/authorize?redirect_uri=http://localhost:3000/callback');
    const html = await res.text();

    expect(html).toContain('<summary>Pick an account (2)</summary>');
    // A submit button per account, so picking one posts that email directly. Named where a
    // name is known, bare where it is not.
    expect(html).toContain('name="email" value="alice@test.com"');
    expect(html).toContain('Alice Smith');
    expect(html).toContain('name="email" value="bob@test.com"');
    // The free-text field is still there, so an unseeded address can still be typed.
    expect(html).toContain('name="email"');
    expect(html).toContain('type="email"');
  });

  it('GET /user_management/authorize lists accounts in email order', async () => {
    const ws = getWorkOSStore(store);
    // Inserted out of order, so store order and email order disagree.
    seedUser(ws, 'zoe@test.com', 'Zoe Last');
    seedUser(ws, 'alice@test.com', 'Alice First');
    seedUser(ws, 'mo@test.com', 'Mo Middle');

    const res = await app.request('/user_management/authorize?redirect_uri=http://localhost:3000/callback');
    const html = await res.text();

    const positions = ['alice@test.com', 'mo@test.com', 'zoe@test.com'].map((email) =>
      html.indexOf(`value="${email}"`),
    );
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('GET /user_management/authorize lists a user created after startup', async () => {
    const ws = getWorkOSStore(store);
    seedUser(ws, 'seeded@test.com', 'Seeded User');

    // A user created through the API mid-session, which is exactly the account someone testing a
    // sign-up then wants to sign in as.
    const created = await app.request('/user_management/users', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'later@test.com', first_name: 'Later', last_name: 'User' }),
    });
    expect(created.status).toBe(201);

    const res = await app.request('/user_management/authorize?redirect_uri=http://localhost:3000/callback');
    const html = await res.text();

    expect(html).toContain('<summary>Pick an account (2)</summary>');
    expect(html).toContain('name="email" value="later@test.com"');
  });

  it('GET /user_management/authorize omits the picker when the store is empty', async () => {
    const res = await app.request('/user_management/authorize?redirect_uri=http://localhost:3000/callback');
    const html = await res.text();

    expect(html).not.toContain('<details');
    expect(html).not.toContain('Pick an account');
  });

  it('POST /user_management/authorize asks which organization when a user has several', async () => {
    const ws = getWorkOSStore(store);
    const user = seedUser(ws, 'multi@test.com');
    joinOrg(user.id, 'Acme');
    joinOrg(user.id, 'Beta');

    const res = await app.request('/user_management/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ redirect_uri: 'http://localhost:3000/callback', email: 'multi@test.com' }),
    });

    // A page, not a redirect: production asks here rather than handing the client
    // organization_selection_required at the exchange, which a browser cannot act on.
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Select an organization');
    expect(html).toContain('name="organization_id"');
    expect(html).toContain('Acme');
    expect(html).toContain('Beta');
  });

  it('POST /user_management/authorize mints a code scoped to the chosen organization', async () => {
    const ws = getWorkOSStore(store);
    const user = seedUser(ws, 'multi2@test.com');
    const chosen = joinOrg(user.id, 'Chosen');

    const res = await app.request('/user_management/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        redirect_uri: 'http://localhost:3000/callback',
        email: 'multi2@test.com',
        organization_id: chosen.id,
      }),
    });

    expect(res.status).toBe(302);
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    expect(ws.authCodes.findOneBy('code', code)?.organization_id).toBe(chosen.id);
  });

  /** Mint an organization-scoped code the way the selection page does. */
  const mintScopedCode = async (email: string, organizationId: string) => {
    const res = await app.request('/user_management/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        redirect_uri: 'http://localhost:3000/callback',
        email,
        organization_id: organizationId,
      }),
    });
    return new URL(res.headers.get('location')!).searchParams.get('code')!;
  };

  const revokeMembership = async (userId: string, organizationId: string) => {
    const membership = getWorkOSStore(store)
      .organizationMemberships.findBy('user_id', userId)
      .find((m) => m.organization_id === organizationId)!;
    const res = await app.request(`/user_management/organization_memberships/${membership.id}/deactivate`, {
      method: 'PUT',
      headers,
    });
    expect(res.status).toBe(200);
  };

  const redeem = (code: string) =>
    app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });

  it('refuses a code whose organization membership was revoked before redemption', async () => {
    const ws = getWorkOSStore(store);
    const user = seedUser(ws, 'revoked@test.com');
    const org = joinOrg(user.id, 'Acme');

    const code = await mintScopedCode('revoked@test.com', org.id);
    await revokeMembership(user.id, org.id);

    const res = await redeem(code);

    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_grant');
  });

  it('refuses rather than silently signing the user into their other organization', async () => {
    const ws = getWorkOSStore(store);
    const user = seedUser(ws, 'switcheroo@test.com');
    const picked = joinOrg(user.id, 'Picked');
    const other = joinOrg(user.id, 'Other');

    const code = await mintScopedCode('switcheroo@test.com', picked.id);
    await revokeMembership(user.id, picked.id);

    // Exactly one active membership is left, so re-resolving would have found it and signed the
    // user into a tenant they never chose.
    const res = await redeem(code);

    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.error).toBe('invalid_grant');
    expect(JSON.stringify(body)).not.toContain(other.id);
  });

  it('POST /user_management/authorize refuses an organization the user is not in', async () => {
    const ws = getWorkOSStore(store);
    seedUser(ws, 'outsider@test.com');
    const other = createOrg('Someone Else');

    const res = await app.request('/user_management/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        redirect_uri: 'http://localhost:3000/callback',
        email: 'outsider@test.com',
        organization_id: other.id,
      }),
    });

    // Not a redirect: a code scoped to an organization with no membership behind it puts that
    // org_id on the token with no role or permissions, which is the wrong tenant for anything
    // authorizing on it.
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('invalid_request');
  });

  it('POST /user_management/authorize refuses an organization that does not exist', async () => {
    const ws = getWorkOSStore(store);
    seedUser(ws, 'nobody@test.com');

    const res = await app.request('/user_management/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        redirect_uri: 'http://localhost:3000/callback',
        email: 'nobody@test.com',
        organization_id: 'org_does_not_exist',
      }),
    });

    expect(res.status).toBe(400);
  });

  it('POST /user_management/authorize redirects straight through for a single-organization user', async () => {
    const ws = getWorkOSStore(store);
    seedUser(ws, 'single@test.com');

    const res = await app.request('/user_management/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ redirect_uri: 'http://localhost:3000/callback', email: 'single@test.com' }),
    });

    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('code=');
  });

  it('GET /user_management/authorize carries organization_id through the login page, skipping the selection page', async () => {
    const ws = getWorkOSStore(store);
    const user = seedUser(ws, 'preset@test.com');
    const chosen = joinOrg(user.id, 'Preset Org');
    joinOrg(user.id, 'Other Org');

    // A caller that already knows the organization pins it on the GET. It must travel through the
    // login page as a hidden field so the POST can mint a scoped code without stopping on the
    // selection page — even though this user belongs to several organizations.
    const page = await app.request(
      `/user_management/authorize?redirect_uri=http://localhost:3000/callback&login_hint=preset@test.com&organization_id=${chosen.id}`,
    );
    const html = await page.text();
    expect(html).toContain(`name="organization_id" value="${chosen.id}"`);

    const res = await app.request('/user_management/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        redirect_uri: 'http://localhost:3000/callback',
        email: 'preset@test.com',
        organization_id: chosen.id,
      }),
    });

    expect(res.status).toBe(302);
    const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
    expect(ws.authCodes.findOneBy('code', code)?.organization_id).toBe(chosen.id);
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
      name: null,
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
      name: null,
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
      body: JSON.stringify({ email, password, email_verified: true }),
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
    expect(res.status).toBe(400);

    const [event] = eventsNamed('authentication.password_failed');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({
      type: 'password',
      status: 'failed',
      email: 'evt-fail@test.com',
      error: { code: 'invalid_credentials', message: "Invalid credentials for 'evt-fail@test.com'." },
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
      error: { code: 'invalid_grant', message: "The code 'bogus' has expired or is invalid." },
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

  it('sign-in stamps last_sign_in_at without emitting a spurious user.updated', async () => {
    // Production's sign-in stamps last_sign_in_at via a dedicated, silent updateWithSignIn
    // path — a raw DB write that bypasses the event-emitting update() — so a login fires
    // session.created alone, not user.updated. See https://github.com/workos/emulate/issues/55.
    await registerUser('evt-no-user-updated@test.com', 'secret');

    await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'evt-no-user-updated@test.com', password: 'secret' }),
    });

    expect(eventsNamed('session.created')).toHaveLength(1);
    expect(eventsNamed('user.updated')).toHaveLength(0);
  });

  it('MFA session falls back to auth_method: unknown when the pending token records no mapped primary', async () => {
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

    // The pending token here records only 'MFA' (not a primary factor), so the session falls
    // back to the valid 'unknown' rather than an out-of-enum value like 'mfa'.
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

  it('token refresh rotates tokens without emitting login or session events', async () => {
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
    // Rotation still hands back fresh tokens.
    expect((await json(refreshRes)).refresh_token).toBeTruthy();

    // A rotation is not a fresh login, so it must add no authentication.* event...
    const authEventsAfterRefresh = getWorkOSStore(store)
      .events.all()
      .filter((e) => e.event.startsWith('authentication.')).length;
    expect(authEventsAfterRefresh).toBe(authEventsAfterLogin);
    // ...no spurious oauth_succeeded, which the OAuth authMethod would otherwise fire...
    expect(eventsNamed('authentication.oauth_succeeded')).toHaveLength(0);
    // ...and it reuses the existing session rather than minting a new one.
    expect(eventsNamed('session.created')).toHaveLength(1);
    expect(getWorkOSStore(store).sessions.all()).toHaveLength(1);
  });

  it('password login for an MFA-enrolled user challenges, then keys the session to the primary factor', async () => {
    const user = await registerUser('evt-mfa-flow@test.com', 'secret');
    const ws = getWorkOSStore(store);
    ws.authFactors.insert({
      object: 'authentication_factor',
      user_id: user.id,
      type: 'totp',
      totp: { issuer: 'Test', user: user.email, uri: 'otpauth://...' },
    });

    // First factor: password returns an mfa_challenge carrying a pending token + challenge,
    // and creates neither a session nor a login event.
    const challengeRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'evt-mfa-flow@test.com', password: 'secret' }),
    });
    expect(challengeRes.status).toBe(403);
    const challengeBody = await json(challengeRes);
    expect(challengeBody.code).toBe('mfa_challenge');
    expect(challengeBody.pending_authentication_token).toBeTruthy();
    expect(challengeBody.authentication_challenge.id).toBeTruthy();
    expect(eventsNamed('session.created')).toHaveLength(0);
    expect(eventsNamed('authentication.password_succeeded')).toHaveLength(0);

    // Second factor: completing mfa-totp issues the session (code read from the store, since
    // the spec excludes it from the challenge response).
    const challengeId = challengeBody.authentication_challenge.id as string;
    const code = ws.authChallenges.get(challengeId)!.code!;
    const mfaRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:mfa-totp',
        code,
        pending_authentication_token: challengeBody.pending_authentication_token,
        authentication_challenge_id: challengeId,
      }),
    });
    expect(mfaRes.status).toBe(200);

    // The event is mfa_succeeded, but the session records the primary factor (password).
    expect(eventsNamed('authentication.mfa_succeeded')).toHaveLength(1);
    const [session] = eventsNamed('session.created');
    expect(session.data).toMatchObject({ auth_method: 'password' });
  });
});
