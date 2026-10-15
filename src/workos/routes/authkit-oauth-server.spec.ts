/**
 * The AuthKit domain as an OAuth 2.1 authorization server: `/oauth2/authorize` on an application
 * with no `login_url`, and `/oauth2/token` for the codes and refresh tokens that leads to. The
 * `client_credentials` and Standalone Connect halves of the same endpoints are covered by
 * oauth.spec.ts and standalone-connect.spec.ts.
 */
import { createHash, randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { createServer } from '../../core/index.js';
import { createEmulator, type Emulator } from '../../index.js';
import { seedFromConfig, workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';

const baseUrl = 'http://localhost:4100';
const callback = 'http://localhost:33418/callback';
const json = (res: Response) => res.json() as Promise<any>;
const decode = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8')) as Record<string, any>;

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

function createTestApp() {
  const server = createServer(workosPlugin, {
    port: 0,
    baseUrl,
    apiKeys: { sk_test_default: { environment: 'test' } },
  });
  seedFromConfig(server.store, baseUrl, {
    users: [{ email: 'alice@acme.test', first_name: 'Alice' }, { email: 'bob@other.test' }],
    organizations: [{ name: 'Acme', memberships: [{ email: 'alice@acme.test' }] }],
    resourceIndicators: [{ uri: 'https://mcp.example.test' }],
  });
  return server;
}

describe('AuthKit OAuth server', () => {
  let server: ReturnType<typeof createTestApp>;
  let ws: ReturnType<typeof getWorkOSStore>;

  beforeEach(() => {
    server = createTestApp();
    ws = getWorkOSStore(server.store);
  });

  const request = (path: string, init?: RequestInit) => server.app.request(path, init);

  /** Register a client the way an MCP client does, returning what it would hold. */
  const register = async (extra: Record<string, unknown> = {}) => {
    const res = await request('/oauth2/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Test client',
        redirect_uris: [callback],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        ...extra,
      }),
    });
    expect(res.status).toBe(201);
    return (await json(res)) as { client_id: string; client_secret?: string };
  };

  const authorizeUrl = (params: Record<string, string>) =>
    `/oauth2/authorize?${new URLSearchParams({ response_type: 'code', redirect_uri: callback, ...params })}`;

  /**
   * Follow authorize through the hosted sign-in, without interactive mode, to the callback. Returns
   * the final redirect, which carries either a code or an error.
   */
  const signIn = async (params: Record<string, string>) => {
    const authorize = await request(authorizeUrl(params));
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get('location')!);
    if (location.pathname !== '/user_management/authorize') return { authorize, callback: location };
    const hosted = await request(`${location.pathname}${location.search}`);
    expect(hosted.status).toBe(302);
    return { authorize, callback: new URL(hosted.headers.get('location')!) };
  };

  const authorizeCode = async (client_id: string, extra: Record<string, string> = {}) => {
    const { verifier, challenge } = pkce();
    const { callback: url } = await signIn({
      client_id,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      login_hint: 'alice@acme.test',
      ...extra,
    });
    expect(url.searchParams.get('error')).toBeNull();
    expect(url.searchParams.get('state')).toBe('xyz');
    return { code: url.searchParams.get('code')!, verifier };
  };

  const token = (body: Record<string, string>, headers: Record<string, string> = {}) =>
    request('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams(body).toString(),
    });

  const exchange = async (
    client_id: string,
    extra: Record<string, string> = {},
    authorize: Record<string, string> = {},
  ) => {
    const { code, verifier } = await authorizeCode(client_id, authorize);
    return token({
      grant_type: 'authorization_code',
      client_id,
      code,
      redirect_uri: callback,
      code_verifier: verifier,
      ...extra,
    });
  };

  describe('authorize', () => {
    it('sends the browser to the hosted sign-in, which completes with a code and the state', async () => {
      const { client_id } = await register();
      const { challenge } = pkce();
      const authorize = await request(
        authorizeUrl({ client_id, code_challenge: challenge, code_challenge_method: 'S256', state: 's t/a?te' }),
      );
      expect(authorize.status).toBe(302);
      const signInUrl = new URL(authorize.headers.get('location')!);
      expect(signInUrl.pathname).toBe('/user_management/authorize');
      expect(signInUrl.searchParams.get('connect_request')).toMatch(/^connect_req_/);
      // The request itself is parked server-side; nothing a caller could tamper with rides the URL.
      expect(signInUrl.searchParams.has('redirect_uri')).toBe(false);
      expect(signInUrl.searchParams.has('code_challenge')).toBe(false);

      const hosted = await request(`${signInUrl.pathname}${signInUrl.search}`);
      expect(hosted.status).toBe(302);
      const done = new URL(hosted.headers.get('location')!);
      expect(`${done.origin}${done.pathname}`).toBe(callback);
      expect(done.searchParams.get('code')).toMatch(/^auth_code_/);
      expect(done.searchParams.get('state')).toBe('s t/a?te');
      // Spent with the code it produced.
      expect(
        server.store.getData(`connect_authorize:${signInUrl.searchParams.get('connect_request')}`),
      ).toBeUndefined();
    });

    it('answers an unknown client with a redirect to the error page, which is served', async () => {
      const res = await request(authorizeUrl({ client_id: 'client_nope' }));
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location')!);
      expect(location.pathname).toBe('/oauth2/error');
      expect(location.searchParams.get('error')).toBe('application_not_found');
      const page = await request(`${location.pathname}${location.search}`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      expect(await page.text()).toContain('Application not found');
    });

    it('sends failures to the error page until the callback is trusted, then to the callback, as production does', async () => {
      const { client_id } = await register();
      // Production's authorize handler never answers with an API error body. Before the client and
      // its callback are known, the browser goes to the AuthKit domain's error page.
      const errorPage = async (params: Record<string, string>, error: string) => {
        const res = await request(`/oauth2/authorize?${new URLSearchParams(params)}`);
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe(`${baseUrl}/oauth2/error?error=${error}`);
      };
      // A query without the two shallow parameters at all.
      await errorPage({ response_type: 'code', redirect_uri: callback }, 'invalid_query_params');
      await errorPage({ response_type: 'code', client_id }, 'invalid_query_params');
      // An empty client_id is a string that names no application.
      await errorPage({ response_type: 'code', client_id: '', redirect_uri: callback }, 'application_not_found');
      // A callback the client did not register, the empty one included.
      await errorPage({ response_type: 'code', client_id, redirect_uri: '' }, 'invalid_redirect_uri');
      await errorPage(
        { response_type: 'code', client_id, redirect_uri: 'http://localhost:33418/other' },
        'invalid_redirect_uri',
      );

      // From then on, the callback carries the error and the state, with no description.
      const onCallback = async (params: Record<string, string>, error: string) => {
        const res = await request(
          `/oauth2/authorize?${new URLSearchParams({ client_id, redirect_uri: callback, state: 'kept', ...params })}`,
        );
        expect(res.status).toBe(302);
        const url = new URL(res.headers.get('location')!);
        expect(`${url.origin}${url.pathname}`).toBe(callback);
        expect(url.searchParams.get('error')).toBe(error);
        expect(url.searchParams.get('state')).toBe('kept');
        return url;
      };
      expect(
        (await onCallback({ response_type: 'token' }, 'unsupported_response_type')).searchParams.has(
          'error_description',
        ),
      ).toBe(false);
      expect((await onCallback({}, 'invalid_request')).searchParams.has('error_description')).toBe(false);

      const m2m = ws.connectApplications.insert({
        object: 'connect_application',
        name: 'svc',
        description: null,
        application_type: 'm2m',
        organization_id: null,
        scopes: [],
        audience: null,
        redirect_uris: [],
        is_first_party: true,
        was_dynamically_registered: false,
        uses_pkce: false,
        login_url: null,
        client_id: 'client_m2m',
        logo_url: null,
      });
      expect(m2m.application_type).toBe('m2m');
      // An application the authorization-code grant is not enabled for: production's
      // `authorization_code_grant_disabled`, as unauthorized_client with this description.
      const res = await request(authorizeUrl({ client_id: 'client_m2m', state: 'kept' }));
      expect(res.status).toBe(302);
      const url = new URL(res.headers.get('location')!);
      expect(`${url.origin}${url.pathname}`).toBe(callback);
      expect(url.searchParams.get('error')).toBe('unauthorized_client');
      expect(url.searchParams.get('error_description')).toBe(
        'The client is not authorized to request an authorization code using this method',
      );
      expect(url.searchParams.get('state')).toBe('kept');
    });

    it('lets a public client through authorize without PKCE; the token endpoint is where it is refused', async () => {
      // Production's authorize handler requires nothing of a public client; its token endpoint
      // then finds no challenge to verify against and answers the bare invalid_grant.
      const { client_id } = await register();
      const { callback: url } = await signIn({ client_id, state: 'keep', login_hint: 'alice@acme.test' });
      expect(`${url.origin}${url.pathname}`).toBe(callback);
      const code = url.searchParams.get('code')!;
      expect(code).toMatch(/^auth_code_/);
      expect(url.searchParams.get('state')).toBe('keep');
      const res = await token({ grant_type: 'authorization_code', client_id, code, redirect_uri: callback });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ error: 'invalid_grant' });
      // Refused before the code is exchanged, so it is not spent.
      expect(ws.authCodes.findOneBy('code', code)).toBeDefined();
    });

    it('takes any challenge string at authorize and holds the verifier to it at the token endpoint', async () => {
      const { client_id, client_secret } = await register({ token_endpoint_auth_method: 'client_secret_basic' });
      const { callback: ok } = await signIn({ client_id, login_hint: 'alice@acme.test' });
      expect(ok.searchParams.get('code')).toMatch(/^auth_code_/);
      // Production does not validate the shape of a challenge; nothing can hash to this one, so
      // the code it produces can never be redeemed.
      const { callback: short } = await signIn({
        client_id,
        code_challenge: 'short',
        code_challenge_method: 'S256',
        login_hint: 'alice@acme.test',
      });
      const code = short.searchParams.get('code')!;
      expect(code).toMatch(/^auth_code_/);
      const res = await token({
        grant_type: 'authorization_code',
        client_id,
        client_secret: client_secret!,
        code,
        redirect_uri: callback,
        code_verifier: 'short',
      });
      expect(await json(res)).toEqual({ error: 'invalid_grant' });
    });

    it('supports only S256, ignores a method without a challenge, and refuses a challenge without a method', async () => {
      const { client_id } = await register();
      const { challenge } = pkce();
      // A method production's query schema does not know fails the parse: invalid_request, no description.
      const plain = await signIn({ client_id, code_challenge: challenge, code_challenge_method: 'plain', state: 'st' });
      expect(plain.callback.searchParams.get('error')).toBe('invalid_request');
      expect(plain.callback.searchParams.has('error_description')).toBe(false);
      expect(plain.callback.searchParams.get('state')).toBe('st');
      // A method with no challenge is simply a request without PKCE.
      const orphan = await signIn({ client_id, code_challenge_method: 'S256', login_hint: 'alice@acme.test' });
      expect(orphan.callback.searchParams.get('code')).toMatch(/^auth_code_/);
      // Production's `missing_code_challenge_method`, mapped to invalid_request with this description.
      const noMethod = await signIn({ client_id, code_challenge: challenge, state: 'kept' });
      expect(noMethod.callback.searchParams.get('error')).toBe('invalid_request');
      expect(noMethod.callback.searchParams.get('error_description')).toBe(
        'code_challenge_method is required when code_challenge is provided.',
      );
      expect(noMethod.callback.searchParams.get('state')).toBe('kept');
    });

    it('reports invalid_scope and invalid_target on the callback', async () => {
      const { client_id } = await register({ scope: 'openid profile' });
      const { challenge } = pkce();
      const base = { client_id, code_challenge: challenge, code_challenge_method: 'S256', state: 'st' };
      // The standard scopes are open to every client whatever it registered; a custom scope the
      // application was not assigned is production's invalid_scope, with no description.
      const standard = await signIn({ ...base, scope: 'openid email', login_hint: 'alice@acme.test' });
      expect(standard.callback.searchParams.get('code')).toMatch(/^auth_code_/);
      const scope = await signIn({ ...base, scope: 'openid mcp:tools' });
      expect(scope.callback.searchParams.get('error')).toBe('invalid_scope');
      expect(scope.callback.searchParams.has('error_description')).toBe(false);
      expect(scope.callback.searchParams.get('state')).toBe('st');
      // Production's descriptions for a value its resource URI parser refuses, and none for one
      // that parses but matches no registered resource.
      const target = await signIn({ ...base, resource: 'https://mcp.example.test/#frag' });
      expect(target.callback.searchParams.get('error')).toBe('invalid_target');
      expect(target.callback.searchParams.get('error_description')).toBe(
        'Invalid target: resource URIs cannot contain a URL fragment.',
      );
      const relative = await signIn({ ...base, resource: 'mcp/relative' });
      expect(relative.callback.searchParams.get('error')).toBe('invalid_target');
      expect(relative.callback.searchParams.get('error_description')).toBe(
        'Invalid target: resource URI is malformed.',
      );
      const unregistered = await signIn({ ...base, resource: 'https://not-registered.example.test' });
      expect(unregistered.callback.searchParams.get('error')).toBe('invalid_target');
      expect(unregistered.callback.searchParams.get('error_description')).toBeNull();
      expect(unregistered.callback.searchParams.get('state')).toBe('st');
    });

    it('ignores the resource parameter while the environment has registered no resources', async () => {
      for (const resource of ws.authkitOauthResources.all()) ws.authkitOauthResources.delete(resource.id);
      const { client_id } = await register();
      for (const resource of ['https://not-registered.example.test', 'mcp/relative', 'https://x.test/#frag']) {
        const { code } = await authorizeCode(client_id, { resource });
        expect(ws.authCodes.findOneBy('code', code)!.connect!.resource).toBeNull();
      }
    });

    it('ignores the resource of a client that was not dynamically registered', async () => {
      seedFromConfig(server.store, baseUrl, {
        organizations: [{ name: 'Seeded' }],
        connectApplications: [
          { name: 'Seeded', type: 'oauth', organization: 'Seeded', client_id: 'client_seeded', uses_pkce: true },
        ],
      });
      const { code } = await authorizeCode('client_seeded', { resource: 'https://not-registered.example.test' });
      expect(ws.authCodes.findOneBy('code', code)!.connect!.resource).toBeNull();
    });

    it('rejects a hosted sign-in whose request has expired or never existed', async () => {
      const { client_id } = await register();
      const { challenge } = pkce();
      const authorize = await request(
        authorizeUrl({ client_id, code_challenge: challenge, code_challenge_method: 'S256' }),
      );
      const signInUrl = new URL(authorize.headers.get('location')!);
      const key = `connect_authorize:${signInUrl.searchParams.get('connect_request')}`;
      const stored = server.store.getData<any>(key);
      server.store.setData(key, { ...stored, expires_at: new Date(Date.now() - 1000).toISOString() });
      const expired = await request(`${signInUrl.pathname}${signInUrl.search}`);
      expect(expired.status).toBe(400);
      expect((await json(expired)).error).toBe('invalid_request');
      const unknown = await request('/user_management/authorize?connect_request=connect_req_nope');
      expect(unknown.status).toBe(400);
    });

    it('signs in the user named by login_hint and honors organization_id', async () => {
      const { client_id } = await register();
      const { code } = await authorizeCode(client_id, { login_hint: 'bob@other.test' });
      expect(ws.authCodes.findOneBy('code', code)!.user_id).toBe(ws.users.findOneBy('email', 'bob@other.test')!.id);
      const acme = ws.organizations.findOneBy('name', 'Acme')!;
      const scoped = await authorizeCode(client_id, { organization_id: acme.id });
      expect(ws.authCodes.findOneBy('code', scoped.code)!.organization_id).toBe(acme.id);
      // Not a member: the same refusal /user_management/authorize gives.
      const { challenge } = pkce();
      const res = await request(
        authorizeUrl({
          client_id,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          login_hint: 'bob@other.test',
          organization_id: acme.id,
        }),
      );
      const followed = await request(
        new URL(res.headers.get('location')!).pathname + new URL(res.headers.get('location')!).search,
      );
      expect(followed.status).toBe(400);
    });
  });

  describe('token: authorization_code', () => {
    it('lets a public client redeem a code with its verifier alone', async () => {
      const { client_id } = await register();
      const res = await exchange(
        client_id,
        {},
        { scope: 'openid profile offline_access', resource: 'https://mcp.example.test' },
      );
      expect(res.status).toBe(200);
      const body = await json(res);
      // Production's authorization_code response: lowercase `bearer`, an `id_token`, no `scope`.
      expect(Object.keys(body).sort()).toEqual([
        'access_token',
        'expires_in',
        'id_token',
        'refresh_token',
        'token_type',
      ]);
      expect(body).toMatchObject({ token_type: 'bearer', expires_in: 3600 });
      expect(body.access_token.split('.')).toHaveLength(3);
      // Sorted, as production's formatScope sorts it.
      expect(server.jwt.verify(body.access_token).scope).toBe('offline_access openid profile');
      expect(body.refresh_token).toMatch(/^ref_/);
    });

    it('mints a Connect token: bare issuer, no email, the claims production carries', async () => {
      const { client_id } = await register();
      const alice = ws.users.findOneBy('email', 'alice@acme.test')!;
      const acme = ws.organizations.findOneBy('name', 'Acme')!;
      const body = await json(await exchange(client_id, {}, { scope: 'openid email' }));

      const claims = server.jwt.verify(body.access_token);
      expect(claims.iss).toBe(baseUrl);
      expect(claims.sub).toBe(alice.id);
      expect(claims.client_id).toBe(client_id);
      expect(claims.org_id).toBe(acme.id);
      expect(claims.scope).toBe('email openid');
      expect(claims.sid).toMatch(/^session_/);
      expect(claims.jti).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(claims.exp - claims.iat).toBe(3600);
      // OIDC auth_time, which production emits on every code exchange: when the sign-in happened.
      expect(claims.auth_time).toBe(
        Math.floor(new Date(ws.sessions.get(claims.sid as string)!.created_at).getTime() / 1000),
      );
      expect(claims.aud).toBe(client_id);
      for (const absent of ['email', 'role', 'permissions', 'entitlements']) expect(claims).not.toHaveProperty(absent);

      // The session the token names is a real, active one for that user.
      const session = ws.sessions.get(claims.sid as string)!;
      expect(session).toMatchObject({ user_id: alice.id, status: 'active', organization_id: acme.id });
    });

    it('omits org_id for a user with no organization', async () => {
      const { client_id } = await register();
      const { code, verifier } = await authorizeCode(client_id, { login_hint: 'bob@other.test' });
      const body = await json(
        await token({
          grant_type: 'authorization_code',
          client_id,
          code,
          redirect_uri: callback,
          code_verifier: verifier,
        }),
      );
      expect(server.jwt.verify(body.access_token)).not.toHaveProperty('org_id');
    });

    it('grants nothing when scope is omitted, as production parses an absent scope', async () => {
      // No standard scope reaches the consent, so the token has no `scope` claim, the response no
      // `scope` field, and the client (dynamically registered, not in OIDC mode) a refresh token.
      const { client_id } = await register({ scope: 'openid profile' });
      const body = await json(await exchange(client_id));
      expect(server.jwt.verify(body.access_token)).not.toHaveProperty('scope');
      expect(body).not.toHaveProperty('scope');
      expect(body.id_token.split('.')).toHaveLength(3);
      expect(body.refresh_token).toMatch(/^ref_/);
      const refreshed = await json(
        await token({ grant_type: 'refresh_token', client_id, refresh_token: body.refresh_token }),
      );
      expect(refreshed).not.toHaveProperty('scope');
      expect(server.jwt.verify(refreshed.access_token)).not.toHaveProperty('scope');
    });

    it('never spends the code on a PKCE failure, and answers the bare invalid_grant production does', async () => {
      // Production verifies the code_verifier before it exchanges the code, so a missing or wrong
      // verifier leaves the code for a retry; and the body is `{ error }` alone, since the
      // handler's "Invalid code verifier." is a log message, not an error_description.
      const { client_id } = await register();
      const { code, verifier } = await authorizeCode(client_id);
      const grant = { grant_type: 'authorization_code', client_id, code, redirect_uri: callback };

      const missing = await token(grant);
      expect(missing.status).toBe(400);
      expect(await json(missing)).toEqual({ error: 'invalid_grant' });
      expect(ws.authCodes.findOneBy('code', code)).toBeDefined();
      const wrong = await token({ ...grant, code_verifier: pkce().verifier });
      expect(await json(wrong)).toEqual({ error: 'invalid_grant' });
      expect(ws.authCodes.findOneBy('code', code)).toBeDefined();
      expect((await token({ ...grant, code_verifier: verifier })).status).toBe(200);
      expect(ws.authCodes.findOneBy('code', code)).toBeUndefined();
    });

    it('holds the verifier to the challenge alone, with no shape check, as production does', async () => {
      const { client_id } = await register();
      // Production hashes whatever verifier it is sent; RFC 7636 §4.1's 43-128 unreserved
      // characters are not enforced, so a verifier outside them redeems the code it hashes to.
      for (const verifier of [
        'short',
        'a'.repeat(129),
        `${'a'.repeat(42)}!`,
        'A'.repeat(43),
        'a-._~9'.repeat(21) + 'ab',
      ]) {
        const challenge = createHash('sha256').update(verifier).digest('base64url');
        const { callback: url } = await signIn({
          client_id,
          code_challenge: challenge,
          code_challenge_method: 'S256',
          login_hint: 'alice@acme.test',
        });
        const res = await token({
          grant_type: 'authorization_code',
          client_id,
          code: url.searchParams.get('code')!,
          redirect_uri: callback,
          code_verifier: verifier,
        });
        expect(res.status).toBe(200);
      }
    });

    it('marks token responses uncacheable (RFC 6749 §5.1)', async () => {
      const { client_id } = await register();
      const res = await exchange(client_id);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('pragma')).toBe('no-cache');
      const refreshed = await token({
        grant_type: 'refresh_token',
        client_id,
        refresh_token: (await json(res)).refresh_token,
      });
      expect(refreshed.headers.get('cache-control')).toBe('no-store');
      expect(refreshed.headers.get('pragma')).toBe('no-cache');
    });

    it('rejects a reused code', async () => {
      const { client_id } = await register();
      const { code, verifier } = await authorizeCode(client_id);
      const grant = {
        grant_type: 'authorization_code',
        client_id,
        code,
        redirect_uri: callback,
        code_verifier: verifier,
      };
      expect((await token(grant)).status).toBe(200);
      const again = await token(grant);
      expect(again.status).toBe(400);
      expect((await json(again)).error).toBe('invalid_grant');
    });

    it('rejects a wrong redirect_uri, another client, an expired code and an unknown code', async () => {
      const { client_id } = await register();
      const other = await register();
      const { code, verifier } = await authorizeCode(client_id);
      const grant = {
        grant_type: 'authorization_code',
        client_id,
        code,
        redirect_uri: callback,
        code_verifier: verifier,
      };

      for (const override of [
        { redirect_uri: 'http://localhost:33418/other' },
        { client_id: other.client_id },
        { code: 'auth_code_unknown' },
      ]) {
        const res = await token({ ...grant, ...override });
        expect(res.status).toBe(400);
        expect((await json(res)).error).toBe('invalid_grant');
      }
      const stored = ws.authCodes.findOneBy('code', code)!;
      ws.authCodes.update(stored.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
      expect((await json(await token(grant))).error).toBe('invalid_grant');
    });

    it('refuses a public client a code that carries no challenge', async () => {
      const { client_id } = await register();
      const { code } = await authorizeCode(client_id);
      const stored = ws.authCodes.findOneBy('code', code)!;
      ws.authCodes.update(stored.id, { code_challenge: null, code_challenge_method: null });
      const res = await token({ grant_type: 'authorization_code', client_id, code, redirect_uri: callback });
      expect((await json(res)).error).toBe('invalid_grant');
    });

    it('requires the secret of a confidential client, with production messages, and still checks PKCE', async () => {
      const { client_id, client_secret } = await register({ token_endpoint_auth_method: 'client_secret_basic' });
      const { code, verifier } = await authorizeCode(client_id);
      const grant = { grant_type: 'authorization_code', code, redirect_uri: callback, code_verifier: verifier };

      // The two messages of production's token-endpoint guards.
      const noSecret = await token({ ...grant, client_id });
      expect(noSecret.status).toBe(401);
      expect(noSecret.headers.get('www-authenticate')).toBe('Basic realm="AuthKit"');
      expect((await json(noSecret)).error_description).toBe('Missing client_secret.');
      const wrong = await token({ ...grant, client_id, client_secret: 'secret_wrong' });
      expect(wrong.status).toBe(401);
      expect(await json(wrong)).toEqual({ error: 'invalid_client', error_description: 'Application not found.' });
      const basic = Buffer.from(`${client_id}:${client_secret}`).toString('base64');
      const badVerifier = await token(
        { ...grant, code_verifier: pkce().verifier },
        { Authorization: `Basic ${basic}` },
      );
      expect((await json(badVerifier)).error).toBe('invalid_grant');

      // A bad verifier never spends the code, so the original one still redeems with Basic.
      const ok = await token(grant, { Authorization: `Basic ${basic}` });
      expect(ok.status).toBe(200);
      const stored = ws.clientSecrets.all().find((s) => s.value === client_secret)!;
      expect(stored.last_used_at).not.toBeNull();
    });

    it('accepts the secret in the body or as Basic whatever method the client registered', async () => {
      // Production stores only public/confidential and reads credentials from either transport:
      // a client registered for client_secret_basic may post its secret, and the reverse.
      for (const method of ['client_secret_post', 'client_secret_basic']) {
        const { client_id, client_secret } = await register({ token_endpoint_auth_method: method });
        const grant = { grant_type: 'authorization_code', redirect_uri: callback };
        const basic = Buffer.from(`${client_id}:${client_secret}`).toString('base64');
        const first = await authorizeCode(client_id);
        const viaBasic = await token(
          { ...grant, code: first.code, code_verifier: first.verifier },
          { Authorization: `Basic ${basic}` },
        );
        expect(viaBasic.status).toBe(200);
        const second = await authorizeCode(client_id);
        const viaPost = await token({
          ...grant,
          client_id,
          code: second.code,
          code_verifier: second.verifier,
          client_secret: client_secret!,
        });
        expect(viaPost.status).toBe(200);
      }
    });

    it("reads the credentials from the body alone when it names a client_id, as production's parseAuthorization does", async () => {
      // With a client_id in the body, the Authorization header is never consulted, so a secret
      // sent only there is a missing secret.
      const { client_id, client_secret } = await register({ token_endpoint_auth_method: 'client_secret_basic' });
      const { code, verifier } = await authorizeCode(client_id);
      const basic = Buffer.from(`${client_id}:${client_secret}`).toString('base64');
      const res = await token(
        { grant_type: 'authorization_code', client_id, code, redirect_uri: callback, code_verifier: verifier },
        { Authorization: `Basic ${basic}` },
      );
      expect(res.status).toBe(401);
      expect(await json(res)).toEqual({ error: 'invalid_client', error_description: 'Missing client_secret.' });
      // A Basic header that decodes to no client id at all is its own failure.
      const empty = await token(
        { grant_type: 'authorization_code', code, redirect_uri: callback },
        { Authorization: `Basic ${Buffer.from(`:${client_secret}`).toString('base64')}` },
      );
      expect(await json(empty)).toEqual({ error: 'invalid_client', error_description: 'Missing client_id.' });
    });

    it('refuses a public client that presents a secret, with the production message', async () => {
      const { client_id } = await register();
      const { code, verifier } = await authorizeCode(client_id);
      const grant = {
        grant_type: 'authorization_code',
        client_id,
        code,
        redirect_uri: callback,
        code_verifier: verifier,
      };
      // A secret that exists for no client is refused by the lookup first.
      const madeUp = await token({ ...grant, client_secret: 'secret_made_up' });
      expect(madeUp.status).toBe(401);
      expect((await json(madeUp)).error_description).toBe('Application not found.');
      // One an admin added to the public client is a real pair, which a public client may not use.
      const application = ws.connectApplications.findOneBy('client_id', client_id)!;
      ws.clientSecrets.insert({
        object: 'connect_application_secret',
        application_id: application.id,
        value: 'secret_added',
        secret_hint: 'dded',
        last_used_at: null,
      });
      const added = await token({ ...grant, client_secret: 'secret_added' });
      expect(added.status).toBe(401);
      expect(await json(added)).toEqual({ error: 'invalid_client', error_description: 'Unsupported client_secret.' });
    });

    it('answers a request with no client at all as production does', async () => {
      const res = await token({ grant_type: 'authorization_code', code: 'x', redirect_uri: callback });
      expect(res.status).toBe(401);
      expect(await json(res)).toEqual({ error: 'invalid_client', error_description: 'Missing authorization header.' });
    });

    it('answers an unknown client_id with invalid_client, secret or not', async () => {
      const res = await token({
        grant_type: 'authorization_code',
        client_id: 'client_nope',
        code: 'x',
        redirect_uri: callback,
      });
      expect(res.status).toBe(401);
      expect((await json(res)).error).toBe('invalid_client');
    });

    it('keeps the codes of the two token endpoints apart', async () => {
      const { client_id } = await register();
      const { code, verifier } = await authorizeCode(client_id);
      // A hosted-sign-in code is not redeemable by /user_management/authenticate…
      const viaAuthenticate = await request('/user_management/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', client_id, code, code_verifier: verifier }),
      });
      expect(viaAuthenticate.status).toBe(400);
      expect((await json(viaAuthenticate)).error).toBe('invalid_grant');
      // …and was not spent by the attempt.
      expect(
        (
          await token({
            grant_type: 'authorization_code',
            client_id,
            code,
            redirect_uri: callback,
            code_verifier: verifier,
          })
        ).status,
      ).toBe(200);

      // An AuthKit code from /user_management/authorize is not redeemable here.
      const authKit = await request(
        `/user_management/authorize?${new URLSearchParams({ redirect_uri: callback, client_id })}`,
      );
      const authKitCode = new URL(authKit.headers.get('location')!).searchParams.get('code')!;
      const res = await token({
        grant_type: 'authorization_code',
        client_id,
        code: authKitCode,
        redirect_uri: callback,
      });
      expect((await json(res)).error).toBe('invalid_grant');
    });

    it('does not let a public application redeem a Standalone Connect code without its secret', async () => {
      seedFromConfig(server.store, baseUrl, {
        connectApplications: [
          {
            name: 'Standalone',
            type: 'oauth',
            uses_pkce: true,
            client_id: 'client_standalone_pkce',
            client_secret: 'secret_standalone_pkce',
            login_url: 'http://localhost:3000/login',
            redirect_uris: [callback],
          },
        ],
      });
      const alice = ws.users.findOneBy('email', 'alice@acme.test')!;
      const code = ws.authCodes.insert({
        user_id: alice.id,
        organization_id: null,
        code: 'auth_code_standalone',
        redirect_uri: callback,
        client_id: 'client_standalone_pkce',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        auth_method: 'external_auth',
        step_up_method: null,
        code_challenge: null,
        code_challenge_method: null,
      });
      const grant = {
        grant_type: 'authorization_code',
        client_id: 'client_standalone_pkce',
        code: code.code,
        redirect_uri: callback,
      };
      // Standalone Connect has no PKCE, so a public client has nothing to prove itself with: no
      // secret is invalid_request, and a secret is refused of a public client as production does.
      expect((await token(grant)).status).toBe(400);
      const withSecret = await token({ ...grant, client_secret: 'secret_standalone_pkce' });
      expect(withSecret.status).toBe(401);
      expect((await json(withSecret)).error_description).toBe('Unsupported client_secret.');
    });

    it('refuses client_credentials to a public client without a secret, as an unauthorized_client', async () => {
      // Production's public-client guard: the grant is not among those a public client may use.
      const { client_id } = await register();
      const res = await token({ grant_type: 'client_credentials', client_id });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        error: 'unauthorized_client',
        error_description: 'Public clients are not authorized to use this grant type.',
      });
    });

    it("ignores a scope parameter on the code exchange, as production's grant body carries none", async () => {
      const { client_id } = await register();
      const narrowed = await json(await exchange(client_id, { scope: 'openid' }, { scope: 'openid profile' }));
      expect(server.jwt.verify(narrowed.access_token).scope).toBe('openid profile');
      const widened = await json(await exchange(client_id, { scope: 'openid email' }, { scope: 'openid profile' }));
      expect(server.jwt.verify(widened.access_token).scope).toBe('openid profile');
    });

    it('answers a body missing the grant type or its fields as production validates it', async () => {
      const { client_id } = await register();
      const invalidBody = { error: 'invalid_request', error_description: 'Invalid token request body.' };
      expect(await json(await token({ client_id }))).toEqual(invalidBody);
      expect(await json(await token({ grant_type: 'authorization_code', client_id, code: 'x' }))).toEqual(invalidBody);
      expect(await json(await token({ grant_type: 'refresh_token', client_id }))).toEqual(invalidBody);
      const unsupported = await token({ grant_type: 'password', client_id });
      expect(unsupported.status).toBe(400);
      expect(await json(unsupported)).toEqual({
        error: 'unsupported_grant_type',
        error_description: "Unsupported grant_type: 'password'.",
      });
    });
  });

  describe('resource indicators', () => {
    it('binds aud to a registered resource', async () => {
      const { client_id } = await register();
      const body = await json(await exchange(client_id, {}, { resource: 'https://mcp.example.test' }));
      expect(server.jwt.verify(body.access_token).aud).toBe('https://mcp.example.test');
    });

    it('falls back to the application audience, then the client_id, for an absent resource', async () => {
      const { client_id } = await register();
      const absent = await json(await exchange(client_id));
      expect(server.jwt.verify(absent.access_token).aud).toBe(client_id);

      const application = ws.connectApplications.findOneBy('client_id', client_id)!;
      ws.connectApplications.update(application.id, { audience: 'https://default-audience.example.test' });
      const withAudience = await json(await exchange(client_id));
      expect(server.jwt.verify(withAudience.access_token).aud).toBe('https://default-audience.example.test');
      // A registered resource still wins over the application's audience.
      const registered = await json(await exchange(client_id, {}, { resource: 'https://mcp.example.test' }));
      expect(server.jwt.verify(registered.access_token).aud).toBe('https://mcp.example.test');
    });

    it('binds a dynamically registered client that names no resource to the default one', async () => {
      // Production's authorize handler falls back to the environment's default resource for a
      // dynamically registered client, since some MCP clients omit the parameter entirely.
      const resource = ws.authkitOauthResources.findOneBy('uri', 'https://mcp.example.test')!;
      ws.authkitOauthResources.update(resource.id, { default: true });
      const { client_id } = await register();
      const { code } = await authorizeCode(client_id);
      expect(ws.authCodes.findOneBy('code', code)!.connect!.resource).toBe('https://mcp.example.test');
      const body = await json(await exchange(client_id));
      expect(server.jwt.verify(body.access_token).aud).toBe('https://mcp.example.test');
      // Bound to the default, the grant is held to it like any other.
      const other = await exchange(client_id, { resource: 'https://other.example.test' });
      expect((await json(other)).error).toBe('invalid_target');
    });

    it('lets the token request restate or omit a bound resource, and nothing else', async () => {
      const { client_id } = await register();
      const restated = await exchange(
        client_id,
        { resource: 'https://mcp.example.test' },
        { resource: 'https://mcp.example.test' },
      );
      expect(server.jwt.verify((await json(restated)).access_token).aud).toBe('https://mcp.example.test');

      const mismatch = await exchange(
        client_id,
        { resource: 'https://other.example.test' },
        { resource: 'https://mcp.example.test' },
      );
      expect(mismatch.status).toBe(400);
      expect((await json(mismatch)).error).toBe('invalid_target');
      const malformed = await exchange(client_id, { resource: 'not a uri' }, { resource: 'https://mcp.example.test' });
      expect((await json(malformed)).error).toBe('invalid_target');
    });

    it('lets a grant bound to no resource name a registered one at the token endpoint', async () => {
      // Production's resource locator: a consent without a resource plus a request naming one
      // resolves against the environment's registered resources.
      const { client_id } = await register();
      const late = await json(await exchange(client_id, { resource: 'https://mcp.example.test' }));
      expect(server.jwt.verify(late.access_token).aud).toBe('https://mcp.example.test');
      for (const resource of ['https://other.example.test', 'not a uri']) {
        const refused = await exchange(client_id, { resource });
        expect(refused.status).toBe(400);
        expect((await json(refused)).error).toBe('invalid_target');
      }
      const plain = await json(await exchange(client_id));
      expect(server.jwt.verify(plain.access_token).aud).toBe(client_id);

      // With no resources registered at all, the parameter is ignored rather than refused.
      for (const resource of ws.authkitOauthResources.all()) ws.authkitOauthResources.delete(resource.id);
      const ignored = await json(await exchange(client_id, { resource: 'https://other.example.test' }));
      expect(server.jwt.verify(ignored.access_token).aud).toBe(client_id);
    });

    it('matches a resource by normalized URL, as production compares resource URIs', async () => {
      // `https://mcp.example.test/` and `https://mcp.example.test` are one resource to production's
      // OauthResourceUri; the token carries the URI as registered.
      const { client_id } = await register();
      const { code } = await authorizeCode(client_id, { resource: 'https://mcp.example.test/' });
      expect(ws.authCodes.findOneBy('code', code)!.connect!.resource).toBe('https://mcp.example.test');
      const body = await json(
        await exchange(client_id, { resource: 'https://mcp.example.test/' }, { resource: 'https://mcp.example.test' }),
      );
      expect(server.jwt.verify(body.access_token).aud).toBe('https://mcp.example.test');
    });

    it('restates the authorized resource harmlessly at the token endpoint', async () => {
      const { client_id } = await register();
      const res = await exchange(
        client_id,
        { resource: 'https://mcp.example.test' },
        { resource: 'https://mcp.example.test' },
      );
      expect(server.jwt.verify((await json(res)).access_token).aud).toBe('https://mcp.example.test');
    });
  });

  describe('token: refresh_token', () => {
    const refresh = (client_id: string, refresh_token: string, extra: Record<string, string> = {}) =>
      token({ grant_type: 'refresh_token', client_id, refresh_token, ...extra });

    it('rotates the token within the same session and carries scope and resource across', async () => {
      const { client_id } = await register();
      const first = await json(
        await exchange(client_id, {}, { scope: 'openid profile offline_access', resource: 'https://mcp.example.test' }),
      );

      const res = await refresh(client_id, first.refresh_token);
      expect(res.status).toBe(200);
      const second = await json(res);
      // Production's refresh_token response: a rotated token, an `id_token` and the issued `scope`.
      expect(Object.keys(second).sort()).toEqual([
        'access_token',
        'expires_in',
        'id_token',
        'refresh_token',
        'scope',
        'token_type',
      ]);
      expect(second.token_type).toBe('bearer');
      expect(second.refresh_token).toMatch(/^ref_/);
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(second.scope).toBe('offline_access openid profile');

      const before = server.jwt.verify(first.access_token);
      const after = server.jwt.verify(second.access_token);
      expect(after.sid).toBe(before.sid);
      expect(after.sub).toBe(before.sub);
      expect(after.iss).toBe(baseUrl);
      expect(after.client_id).toBe(client_id);
      expect(after.aud).toBe('https://mcp.example.test');
      expect(after.org_id).toBe(before.org_id);
      expect(after.jti).not.toBe(before.jti);
      expect(ws.sessions.all().filter((s) => s.user_id === before.sub)).toHaveLength(1);

      // The old token is spent; the new one rotates again.
      const reused = await refresh(client_id, first.refresh_token);
      expect(reused.status).toBe(400);
      expect((await json(reused)).error).toBe('invalid_grant');
      expect((await refresh(client_id, second.refresh_token)).status).toBe(200);
    });

    it("keeps a confidential client's refresh token in place of rotating it, as OAuth 2.1 §6.1 lets production", async () => {
      const { client_id, client_secret } = await register({ token_endpoint_auth_method: 'client_secret_post' });
      const first = await json(
        await exchange(client_id, { client_secret: client_secret! }, { scope: 'offline_access' }),
      );
      const again = await json(await refresh(client_id, first.refresh_token, { client_secret: client_secret! }));
      expect(again.refresh_token).toBe(first.refresh_token);
      expect((await refresh(client_id, first.refresh_token, { client_secret: client_secret! })).status).toBe(200);
      expect(ws.refreshTokens.all().filter((t) => t.client_id === client_id)).toHaveLength(1);
    });

    it('narrows scope on refresh for that token alone; the grant itself is unchanged', async () => {
      // Production's RFC 6749 §6 narrowing filters the consent's scopes to the ones requested
      // and never alters the consent, so a later refresh may issue the full grant again; a
      // requested scope outside the grant is dropped, and only an empty result is invalid_scope,
      // with production's description.
      const { client_id } = await register();
      const first = await json(await exchange(client_id, {}, { scope: 'openid profile email offline_access' }));
      const narrowed = await json(await refresh(client_id, first.refresh_token, { scope: 'openid' }));
      expect(narrowed.scope).toBe('openid');
      expect(server.jwt.verify(narrowed.access_token).scope).toBe('openid');
      const full = await json(await refresh(client_id, narrowed.refresh_token, { scope: 'openid profile' }));
      expect(full.scope).toBe('openid profile');
      const partial = await json(await refresh(client_id, full.refresh_token, { scope: 'openid admin' }));
      expect(partial.scope).toBe('openid');
      const none = await refresh(client_id, partial.refresh_token, { scope: 'admin other' });
      expect(none.status).toBe(400);
      expect(await json(none)).toEqual({
        error: 'invalid_scope',
        error_description:
          "The following scopes are invalid, unknown, or not granted to this application: 'admin', 'other'.",
      });
    });

    it('does not spend the token on a request it refuses', async () => {
      const { client_id } = await register();
      const first = await json(await exchange(client_id, {}, { resource: 'https://mcp.example.test' }));
      expect((await refresh(client_id, first.refresh_token, { scope: 'admin' })).status).toBe(400);
      expect((await refresh(client_id, first.refresh_token, { resource: 'https://other.example.test' })).status).toBe(
        400,
      );
      expect((await refresh(client_id, first.refresh_token)).status).toBe(200);
    });

    it('refuses the next refresh once the bound resource is deleted, as the resource locator does', async () => {
      const { client_id } = await register();
      const first = await json(await exchange(client_id, {}, { resource: 'https://mcp.example.test' }));
      const resource = ws.authkitOauthResources.findOneBy('uri', 'https://mcp.example.test')!;
      ws.authkitOauthResources.delete(resource.id);
      const second = await refresh(client_id, first.refresh_token);
      expect(second.status).toBe(400);
      expect((await json(second)).error).toBe('invalid_target');
      // Refused, not spent.
      ws.authkitOauthResources.insert({
        object: 'authkit_oauth_resource',
        uri: 'https://mcp.example.test',
        default: false,
      });
      expect((await refresh(client_id, first.refresh_token)).status).toBe(200);
    });

    it('is bound to the client it was issued to', async () => {
      const { client_id } = await register();
      const other = await register();
      const first = await json(await exchange(client_id));
      const res = await refresh(other.client_id, first.refresh_token);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('invalid_grant');
      // Refused, not spent.
      expect((await refresh(client_id, first.refresh_token)).status).toBe(200);
    });

    it('rejects unknown, expired, and revoked-session refresh tokens', async () => {
      const { client_id } = await register();
      expect((await json(await refresh(client_id, 'ref_unknown'))).error).toBe('invalid_grant');
      expect((await json(await token({ grant_type: 'refresh_token', client_id }))).error).toBe('invalid_request');

      const first = await json(await exchange(client_id));
      const stored = ws.refreshTokens.findOneBy('token', first.refresh_token)!;
      ws.refreshTokens.update(stored.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
      const expired = await refresh(client_id, first.refresh_token);
      // Every refresh failure is production's bare invalid_grant: its messages are log-only.
      expect(await json(expired)).toEqual({ error: 'invalid_grant' });

      const second = await json(await exchange(client_id));
      const sid = server.jwt.verify(second.access_token).sid as string;
      ws.sessions.update(sid, { status: 'revoked', ended_at: new Date().toISOString() });
      expect((await json(await refresh(client_id, second.refresh_token))).error).toBe('invalid_grant');
    });

    it('sweeps the refresh tokens of a session that is gone, as the AuthKit grant does', async () => {
      const { client_id } = await register();
      const tokens = await json(await exchange(client_id));
      const sid = server.jwt.verify(tokens.access_token).sid as string;
      // Logout and revoke delete the session row outright.
      ws.sessions.delete(sid);
      expect((await json(await refresh(client_id, tokens.refresh_token))).error).toBe('invalid_grant');
      expect(ws.refreshTokens.findBy('session_id', sid)).toHaveLength(0);
    });

    it('is not accepted by, and does not accept, the AuthKit refresh grant', async () => {
      const { client_id } = await register();
      const first = await json(await exchange(client_id));
      const viaAuthenticate = await request('/user_management/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'refresh_token', client_id, refresh_token: first.refresh_token }),
      });
      expect((await json(viaAuthenticate)).error).toBe('invalid_grant');
      expect((await refresh(client_id, first.refresh_token)).status).toBe(200);

      // A refresh token AuthKit's own grant issued carries no Connect marker, so this endpoint refuses it.
      const alice = ws.users.findOneBy('email', 'alice@acme.test')!;
      const stray = ws.refreshTokens.insert({
        token: 'ref_authkit',
        user_id: alice.id,
        organization_id: null,
        session_id: 'session_x',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        client_id,
        exchanged_at: null,
        exchanged_for_id: null,
      });
      expect(stray.connect).toBeUndefined();
      // Production's `UnsupportedRefreshToken`: an unauthorized_client pointed at the right endpoint.
      const res = await refresh(client_id, 'ref_authkit');
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        error: 'unauthorized_client',
        error_description: `This refresh token should be exchanged at ${baseUrl}/user_management/authenticate`,
      });
    });
  });

  describe('surfaces that must not change', () => {
    it('still serves client_credentials for a seeded m2m application', async () => {
      seedFromConfig(server.store, baseUrl, {
        organizations: [{ name: 'Svc' }],
        connectApplications: [
          {
            name: 'Svc',
            type: 'm2m',
            organization: 'Svc',
            client_id: 'client_svc',
            client_secret: 'secret_svc',
            scopes: ['a'],
          },
        ],
      });
      const res = await token({
        grant_type: 'client_credentials',
        client_id: 'client_svc',
        client_secret: 'secret_svc',
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).not.toHaveProperty('refresh_token');
      expect(server.jwt.verify(body.access_token)).toMatchObject({ sub: 'client_svc', aud: 'client_svc', scope: 'a' });
    });

    it("leaves AuthKit's own per-client issuer and authorization_code grant unchanged", async () => {
      const res = await request(
        `/user_management/authorize?${new URLSearchParams({ redirect_uri: callback, client_id: 'client_authkit', login_hint: 'alice@acme.test' })}`,
      );
      const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
      const auth = await json(
        await request('/user_management/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ grant_type: 'authorization_code', client_id: 'client_authkit', code }),
        }),
      );
      expect(server.jwt.verify(auth.access_token).iss).toBe(`${baseUrl}/user_management/client_authkit`);
    });
  });
});

describe('AuthKit OAuth server, interactive hosted sign-in', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  it('shows the AuthKit sign-in page and finishes the request from what authorize validated', async () => {
    emulator = await createEmulator({
      port: 0,
      interactiveAuth: true,
      seed: { users: [{ email: 'alice@acme.test' }] },
    });
    const reg = (await (
      await fetch(`${emulator.url}/oauth2/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Test client',
          redirect_uris: [callback],
          token_endpoint_auth_method: 'none',
        }),
      })
    ).json()) as { client_id: string };
    const { verifier, challenge } = pkce();

    const authorize = await fetch(
      `${emulator.url}/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: reg.client_id,
        redirect_uri: callback,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: 'st',
        resource: 'https://mcp.example.test',
      })}`,
      { redirect: 'manual' },
    );
    expect(authorize.status).toBe(302);
    const page = await fetch(authorize.headers.get('location')!, { redirect: 'manual' });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    const html = await page.text();
    expect(html).toContain('Sign In');
    expect(html).toContain('alice@acme.test');
    const requestId = new URL(authorize.headers.get('location')!).searchParams.get('connect_request')!;
    expect(html).toContain(`name="connect_request" value="${requestId}"`);

    // A submit that tries to swap the redirect, client or challenge gets the validated ones.
    const submit = await fetch(`${emulator.url}/user_management/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        connect_request: requestId,
        email: 'alice@acme.test',
        redirect_uri: 'http://localhost:9999/evil',
        client_id: 'client_evil',
        code_challenge: 'x'.repeat(43),
        state: 'evil',
      }),
    });
    expect(submit.status).toBe(302);
    const done = new URL(submit.headers.get('location')!);
    expect(`${done.origin}${done.pathname}`).toBe(callback);
    expect(done.searchParams.get('state')).toBe('st');

    const res = await fetch(`${emulator.url}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: reg.client_id,
        code: done.searchParams.get('code')!,
        redirect_uri: callback,
        code_verifier: verifier,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };
    expect(decode(body.access_token)).toMatchObject({ client_id: reg.client_id, iss: emulator.url });

    // The request was spent by the code it minted: replaying the submit finds nothing.
    const replay = await fetch(`${emulator.url}/user_management/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ connect_request: requestId, email: 'alice@acme.test' }),
    });
    expect(replay.status).toBe(400);
  });
});

describe('AuthKit OAuth server, registered grant types and revoked grants', () => {
  let server: ReturnType<typeof createTestApp>;
  let ws: ReturnType<typeof getWorkOSStore>;

  beforeEach(() => {
    server = createTestApp();
    ws = getWorkOSStore(server.store);
  });

  const register = async (body: Record<string, unknown>) =>
    (await (
      await server.app.request('/oauth2/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Test client',
          redirect_uris: [callback],
          token_endpoint_auth_method: 'none',
          ...body,
        }),
      })
    ).json()) as { client_id: string };

  const codeFor = async (client_id: string, login_hint = 'alice@acme.test', extra: Record<string, string> = {}) => {
    const { verifier, challenge } = pkce();
    const authorize = await server.app.request(
      `/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id,
        redirect_uri: callback,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        login_hint,
        ...extra,
      })}`,
    );
    const hosted = new URL(authorize.headers.get('location')!);
    const done = await server.app.request(`${hosted.pathname}${hosted.search}`);
    return { code: new URL(done.headers.get('location')!).searchParams.get('code')!, verifier };
  };

  const redeem = (client_id: string, code: string, verifier: string) =>
    server.app.request('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id,
        code,
        redirect_uri: callback,
        code_verifier: verifier,
      }).toString(),
    });

  it('issues a refresh token by the granted scopes, never by the registered grant_types', async () => {
    // Production's shouldIssueRefreshToken: `offline_access` always earns one; without it a
    // dynamically registered client gets one exactly when it did not ask for `openid`.
    const { client_id } = await register({ grant_types: ['authorization_code'] });
    const cases: [string, boolean][] = [
      ['openid profile offline_access', true],
      ['offline_access', true],
      ['openid profile', false],
      ['openid', false],
      ['profile email', true],
      ['email', true],
    ];
    for (const [scope, expected] of cases) {
      const { code, verifier } = await codeFor(client_id, 'alice@acme.test', { scope });
      const body = await json(await redeem(client_id, code, verifier));
      expect(body.access_token).toBeTruthy();
      expect(scope + (body.refresh_token ? ' -> refresh' : ' -> none')).toBe(
        scope + (expected ? ' -> refresh' : ' -> none'),
      );
    }
    // The grant it was not registered for is still served: production reads grant_types nowhere here.
    const { code, verifier } = await codeFor(client_id, 'alice@acme.test', { scope: 'offline_access' });
    const tokens = await json(await redeem(client_id, code, verifier));
    const refreshed = await server.app.request('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id,
        refresh_token: tokens.refresh_token,
      }).toString(),
    });
    expect(refreshed.status).toBe(200);
  });

  it('gives a client that was not dynamically registered a refresh token only for offline_access', async () => {
    seedFromConfig(server.store, baseUrl, {
      organizations: [{ name: 'Seeded' }],
      connectApplications: [
        { name: 'Seeded', type: 'oauth', organization: 'Seeded', client_id: 'client_seeded', uses_pkce: true },
      ],
    });
    for (const [scope, expected] of [
      ['profile email', false],
      ['openid', false],
      ['openid offline_access', true],
    ] as [string, boolean][]) {
      const { code, verifier } = await codeFor('client_seeded', 'alice@acme.test', { scope });
      const body = await json(await redeem('client_seeded', code, verifier));
      expect(body.access_token).toBeTruthy();
      expect(scope + (body.refresh_token ? ' -> refresh' : ' -> none')).toBe(
        scope + (expected ? ' -> refresh' : ' -> none'),
      );
    }
  });

  it('refuses to register a client for refresh_token alone', async () => {
    const res = await server.app.request('/oauth2/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Test client', redirect_uris: [callback], grant_types: ['refresh_token'] }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_client_metadata');
  });

  const apiHeaders = { Authorization: 'Bearer sk_test_default', 'Content-Type': 'application/json' };
  const both = ['authorization_code', 'refresh_token'];
  const refresh = (client_id: string, refresh_token: string, extra: Record<string, string> = {}) =>
    server.app.request('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id, refresh_token, ...extra }).toString(),
    });
  const setScopes = async (client_id: string, scopes: string[]) => {
    const app = ws.connectApplications.findOneBy('client_id', client_id)!;
    const res = await server.app.request(`/connect/applications/${app.id}`, {
      method: 'PUT',
      headers: apiHeaders,
      body: JSON.stringify({ scopes }),
    });
    expect(res.status).toBe(200);
  };

  it('refuses a refresh for an organization the user has since left', async () => {
    for (const leave of ['deactivate', 'delete'] as const) {
      const { client_id } = await register({ grant_types: both });
      const acme = ws.organizations.findOneBy('name', 'Acme')!;
      const { code, verifier } = await codeFor(client_id, 'alice@acme.test', { organization_id: acme.id });
      const tokens = await json(await redeem(client_id, code, verifier));
      expect(server.jwt.verify(tokens.access_token).org_id).toBe(acme.id);

      const membership = ws.organizationMemberships.findBy(
        'user_id',
        ws.users.findOneBy('email', 'alice@acme.test')!.id,
      )[0];
      if (leave === 'delete') ws.organizationMemberships.delete(membership.id);
      else ws.organizationMemberships.update(membership.id, { status: 'inactive' });

      const res = await refresh(client_id, tokens.refresh_token);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('invalid_grant');
      if (leave === 'deactivate') ws.organizationMemberships.update(membership.id, { status: 'active' });
    }
  });

  /** A seeded (not dynamically registered) public OAuth application with custom scopes of its own. */
  const seedCustomScopes = (scopes: string[]) =>
    seedFromConfig(server.store, baseUrl, {
      organizations: [{ name: 'Seeded' }],
      connectApplications: [
        { name: 'Seeded', type: 'oauth', organization: 'Seeded', client_id: 'client_custom', uses_pkce: true, scopes },
      ],
    });

  it('drops a custom scope removed from the application at exchange and at refresh, and keeps the standard ones', async () => {
    // Production reads a consent's scopes back as its standard scopes plus whichever of its
    // permission scopes still exist, so only a custom scope can disappear from a grant.
    seedCustomScopes(['mcp:tools', 'mcp:files']);
    const scope = 'offline_access openid mcp:tools mcp:files';
    const first = await codeFor('client_custom', 'alice@acme.test', { scope });
    const tokens = await json(await redeem('client_custom', first.code, first.verifier));
    expect(server.jwt.verify(tokens.access_token).scope).toBe('mcp:files mcp:tools offline_access openid');

    await setScopes('client_custom', ['mcp:files']);
    const refreshed = await json(await refresh('client_custom', tokens.refresh_token));
    expect(refreshed.scope).toBe('mcp:files offline_access openid');
    expect(server.jwt.verify(refreshed.access_token).scope).toBe('mcp:files offline_access openid');

    // At exchange: a code authorized before the removal.
    await setScopes('client_custom', ['mcp:tools', 'mcp:files']);
    const second = await codeFor('client_custom', 'alice@acme.test', { scope: 'openid mcp:tools mcp:files' });
    await setScopes('client_custom', []);
    const narrowed = await json(await redeem('client_custom', second.code, second.verifier));
    expect(server.jwt.verify(narrowed.access_token).scope).toBe('openid');
  });

  it('issues a token with no scope when every custom scope of a grant is gone, rather than refusing', async () => {
    seedCustomScopes(['mcp:tools']);
    const pending = await codeFor('client_custom', 'alice@acme.test', { scope: 'mcp:tools' });
    await setScopes('client_custom', []);
    const res = await redeem('client_custom', pending.code, pending.verifier);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(server.jwt.verify(body.access_token)).not.toHaveProperty('scope');
    // Not dynamically registered and no offline_access: no refresh token either.
    expect(body).not.toHaveProperty('refresh_token');
  });

  it("standard scopes are not the application's scopes: clearing a dynamic client's scopes changes nothing", async () => {
    // Production serves an application's `scopes` from its assigned permissions; a dynamically
    // registered client has none, and the standard set is open to it regardless.
    const { client_id } = await register({ grant_types: both, scope: 'openid profile' });
    expect(ws.connectApplications.findOneBy('client_id', client_id)!.scopes).toEqual([]);
    const first = await codeFor(client_id, 'alice@acme.test', { scope: 'email offline_access openid profile' });
    const tokens = await json(await redeem(client_id, first.code, first.verifier));
    expect(server.jwt.verify(tokens.access_token).scope).toBe('email offline_access openid profile');

    const cleared = await server.app.request(`/connect/applications/${client_id}`, {
      method: 'PUT',
      headers: apiHeaders,
      body: JSON.stringify({ scopes: [] }),
    });
    expect(cleared.status).toBe(200);
    expect((await json(cleared)).scopes).toEqual([]);

    const refreshed = await json(await refresh(client_id, tokens.refresh_token));
    expect(refreshed.scope).toBe('email offline_access openid profile');
    const again = await codeFor(client_id, 'alice@acme.test', { scope: 'openid' });
    expect(
      server.jwt.verify((await json(await redeem(client_id, again.code, again.verifier))).access_token).scope,
    ).toBe('openid');
    // And an omitted scope is a grant of nothing, not a refusal.
    const none = await codeFor(client_id);
    expect(none.code).toMatch(/^auth_code_/);
  });

  it('refuses a refresh once the session has expired', async () => {
    const { client_id } = await register({ grant_types: both });
    const { code, verifier } = await codeFor(client_id);
    const tokens = await json(await redeem(client_id, code, verifier));
    const sid = server.jwt.verify(tokens.access_token).sid as string;
    ws.sessions.update(sid, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const res = await refresh(client_id, tokens.refresh_token);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_grant');
  });

  it('never lets a refresh token outlive its session', async () => {
    const { client_id } = await register({ grant_types: both });
    const { code, verifier } = await codeFor(client_id);
    const tokens = await json(await redeem(client_id, code, verifier));
    const sid = server.jwt.verify(tokens.access_token).sid as string;
    // The first token is issued with the session's own lifetime, so it is never longer.
    const session = ws.sessions.get(sid)!;
    expect(ws.refreshTokens.findOneBy('token', tokens.refresh_token)!.expires_at <= session.expires_at).toBe(true);

    const soon = new Date(Date.now() + 3600_000).toISOString();
    ws.sessions.update(sid, { expires_at: soon });
    const next = await json(await refresh(client_id, tokens.refresh_token));
    expect(ws.refreshTokens.findOneBy('token', next.refresh_token)!.expires_at).toBe(soon);
  });

  it('deleting the application removes its refresh tokens and parked authorize requests', async () => {
    const { client_id } = await register({ grant_types: both });
    const other = await register({ grant_types: both });
    const { code, verifier } = await codeFor(client_id);
    const tokens = await json(await redeem(client_id, code, verifier));
    const otherCode = await codeFor(other.client_id);
    const otherTokens = await json(await redeem(other.client_id, otherCode.code, otherCode.verifier));
    // A request parked by authorize and never finished, for each client.
    for (const id of [client_id, other.client_id]) {
      const { challenge } = pkce();
      await server.app.request(
        `/oauth2/authorize?${new URLSearchParams({
          response_type: 'code',
          client_id: id,
          redirect_uri: callback,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        })}`,
      );
    }
    const parked = (id: string) => {
      let n = 0;
      server.store.deleteDataByPrefix('connect_authorize:', (v: any) => {
        if (v.client_id === id) n++;
        return false;
      });
      return n;
    };
    expect(parked(client_id)).toBe(1);
    // An AuthKit refresh token that /user_management/authenticate stored under the same client_id.
    const authkit = ws.refreshTokens.insert({
      token: 'ref_authkit_same_client',
      user_id: ws.users.findOneBy('email', 'alice@acme.test')!.id,
      organization_id: null,
      session_id: 'session_authkit',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      client_id,
      exchanged_at: null,
      exchanged_for_id: null,
    });

    const app = ws.connectApplications.findOneBy('client_id', client_id)!;
    const del = await server.app.request(`/connect/applications/${app.id}`, { method: 'DELETE', headers: apiHeaders });
    expect(del.status).toBe(204);

    expect(ws.refreshTokens.findOneBy('token', tokens.refresh_token)).toBeUndefined();
    expect(parked(client_id)).toBe(0);
    expect((await json(await refresh(client_id, tokens.refresh_token))).error).toBe('invalid_client');
    // Another client's are untouched, and so is an AuthKit token that only shares the id.
    expect(ws.refreshTokens.findOneBy('token', otherTokens.refresh_token)).toBeDefined();
    expect(ws.refreshTokens.get(authkit.id)).toBeDefined();
    expect(parked(other.client_id)).toBe(1);
  });

  describe('id_token', () => {
    const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

    beforeEach(() => {
      const alice = ws.users.findOneBy('email', 'alice@acme.test')!;
      ws.users.update(alice.id, { name: 'Alice Smith', last_name: 'Smith', email_verified: true });
    });

    it('is issued at code exchange for the openid scope, signed under the JWKS key', async () => {
      const { client_id } = await register({ grant_types: both });
      const alice = ws.users.findOneBy('email', 'alice@acme.test')!;
      const first = await codeFor(client_id, 'alice@acme.test', { scope: 'openid', nonce: 'n-0S6_WzA2Mj' });
      const body = await json(await redeem(client_id, first.code, first.verifier));
      const header = JSON.parse(Buffer.from(body.id_token.split('.')[0], 'base64url').toString());
      expect(header.alg).toBe('RS256');
      expect(header.kid).toBe(server.jwt.getJWKS().keys[0].kid);
      // verify() checks the signature against the same key the JWKS publishes.
      const claims = server.jwt.verify(body.id_token);
      expect(claims).toMatchObject({ iss: baseUrl, sub: alice.id, aud: client_id, nonce: 'n-0S6_WzA2Mj' });
      expect(typeof claims.exp).toBe('number');
      expect(typeof claims.iat).toBe('number');
      // auth_time rides the access token, not the ID token, as production mints them.
      expect(claims).not.toHaveProperty('auth_time');
      // Only `openid` was granted: no email and no profile claims.
      for (const absent of ['email', 'email_verified', 'name', 'given_name', 'family_name']) {
        expect(claims).not.toHaveProperty(absent);
      }
    });

    it('carries email claims only with the email scope and profile claims only with profile', async () => {
      const { client_id } = await register({ grant_types: both });
      const email = await codeFor(client_id, 'alice@acme.test', { scope: 'openid email' });
      const withEmail = claimsOf((await json(await redeem(client_id, email.code, email.verifier))).id_token);
      expect(withEmail).toMatchObject({ email: 'alice@acme.test', email_verified: true });
      expect(withEmail).not.toHaveProperty('name');

      const profile = await codeFor(client_id, 'alice@acme.test', { scope: 'openid profile' });
      const withProfile = claimsOf((await json(await redeem(client_id, profile.code, profile.verifier))).id_token);
      expect(withProfile).toMatchObject({ name: 'Alice Smith', given_name: 'Alice', family_name: 'Smith' });
      expect(withProfile).not.toHaveProperty('email');
      expect(withProfile).not.toHaveProperty('nonce');

      // Production composes `name` from the two parts, so it is an empty string for a user with
      // neither, while the parts themselves are omitted.
      const bob = await codeFor(client_id, 'bob@other.test', { scope: 'openid profile' });
      const bobClaims = claimsOf((await json(await redeem(client_id, bob.code, bob.verifier))).id_token);
      expect(bobClaims.name).toBe('');
      for (const absent of ['given_name', 'family_name']) expect(bobClaims).not.toHaveProperty(absent);
    });

    it('is issued without openid too, and on refresh, as production mints it unconditionally', async () => {
      const { client_id } = await register({ grant_types: both });
      const alice = ws.users.findOneBy('email', 'alice@acme.test')!;
      const plain = await codeFor(client_id, 'alice@acme.test', { scope: 'profile email' });
      const tokens = await json(await redeem(client_id, plain.code, plain.verifier));
      const claims = server.jwt.verify(tokens.id_token);
      expect(claims).toMatchObject({ iss: baseUrl, sub: alice.id, aud: client_id, email: 'alice@acme.test' });

      const refreshed = await json(await refresh(client_id, tokens.refresh_token));
      const again = server.jwt.verify(refreshed.id_token);
      expect(again).toMatchObject({ iss: baseUrl, sub: alice.id, aud: client_id, email: 'alice@acme.test' });
      expect(again).not.toHaveProperty('nonce');
    });
  });

  it('refuses a code whose membership was revoked between authorize and token', async () => {
    const { client_id } = await register({ grant_types: ['authorization_code', 'refresh_token'] });
    const acme = ws.organizations.findOneBy('name', 'Acme')!;
    const { code, verifier } = await codeFor(client_id, 'alice@acme.test', { organization_id: acme.id });
    const membership = ws.organizationMemberships.findBy(
      'user_id',
      ws.users.findOneBy('email', 'alice@acme.test')!.id,
    )[0];
    ws.organizationMemberships.delete(membership.id);
    const res = await redeem(client_id, code, verifier);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('invalid_grant');
  });

  it('refuses a code whose user was deleted between authorize and token, and a refresh for one', async () => {
    const { client_id } = await register({ grant_types: ['authorization_code', 'refresh_token'] });
    const first = await codeFor(client_id, 'bob@other.test');
    ws.users.delete(ws.users.findOneBy('email', 'bob@other.test')!.id);
    expect((await json(await redeem(client_id, first.code, first.verifier))).error).toBe('invalid_grant');

    const second = await codeFor(client_id, 'alice@acme.test');
    const tokens = await json(await redeem(client_id, second.code, second.verifier));
    ws.users.delete(ws.users.findOneBy('email', 'alice@acme.test')!.id);
    const refresh = await server.app.request('/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id,
        refresh_token: tokens.refresh_token,
      }).toString(),
    });
    expect((await json(refresh)).error).toBe('invalid_grant');
  });
});

describe('AuthKit OAuth server, multi-step interactive sign-in', () => {
  let emulator: Emulator;

  beforeEach(async () => {
    emulator = await createEmulator({
      port: 0,
      interactiveAuth: { password: true },
      seed: {
        resourceIndicators: [{ uri: 'https://mcp.example.test' }],
        users: [
          { email: 'plain@acme.test' },
          { email: 'pw@acme.test', password: 'correct-horse', email_verified: true },
          { email: 'multi@acme.test', password: 'correct-horse', email_verified: true },
          // Every gate at once: unverified mailbox, second factor, two organizations.
          { email: 'gated@acme.test', password: 'correct-horse', totp: true },
        ],
        organizations: [
          { name: 'Alpha', memberships: [{ email: 'multi@acme.test' }, { email: 'gated@acme.test' }] },
          { name: 'Beta', memberships: [{ email: 'multi@acme.test' }, { email: 'gated@acme.test' }] },
        ],
      },
    });
  });

  afterEach(async () => {
    await emulator.close();
  });

  const ews = () => getWorkOSStore(emulator.store);
  const hiddenFields = (html: string) =>
    Object.fromEntries(
      [...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]),
    );

  /** Register a public client and start authorize; resolves to the first hosted page and the PKCE verifier. */
  async function begin() {
    const reg = (await (
      await fetch(`${emulator.url}/oauth2/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: 'Test client',
          redirect_uris: [callback],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      })
    ).json()) as { client_id: string };
    const { verifier, challenge } = pkce();
    const authorize = await fetch(
      `${emulator.url}/oauth2/authorize?${new URLSearchParams({
        response_type: 'code',
        client_id: reg.client_id,
        redirect_uri: callback,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        resource: 'https://mcp.example.test',
      })}`,
      { redirect: 'manual' },
    );
    const page = await fetch(authorize.headers.get('location')!, { redirect: 'manual' });
    expect(page.status).toBe(200);
    return { client_id: reg.client_id, verifier, html: await page.text() };
  }

  const submit = (fields: Record<string, string>) =>
    fetch(`${emulator.url}/user_management/authorize`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
    });

  const exchange = async (client_id: string, verifier: string, callbackUrl: string) => {
    const done = new URL(callbackUrl);
    expect(`${done.origin}${done.pathname}`).toBe(callback);
    const res = await fetch(`${emulator.url}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id,
        code: done.searchParams.get('code')!,
        redirect_uri: callback,
        code_verifier: verifier,
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { access_token: string; refresh_token: string };
  };

  it('carries connect_request through the password page to a working exchange', async () => {
    const { client_id, verifier, html } = await begin();
    const carried = hiddenFields(html);
    expect(carried.connect_request).toMatch(/^connect_req_/);

    const passwordPage = await submit({ ...carried, email: 'pw@acme.test' });
    expect(passwordPage.status).toBe(200);
    const passwordHtml = await passwordPage.text();
    expect(passwordHtml).toContain('name="password"');
    expect(hiddenFields(passwordHtml).connect_request).toBe(carried.connect_request);

    const wrong = await submit({ ...hiddenFields(passwordHtml), password: 'nope' });
    expect(wrong.status).toBe(401);
    const ok = await submit({ ...hiddenFields(passwordHtml), password: 'correct-horse' });
    expect(ok.status).toBe(302);
    const tokens = await exchange(client_id, verifier, ok.headers.get('location')!);
    expect(decode(tokens.access_token)).toMatchObject({
      client_id,
      aud: 'https://mcp.example.test',
      sub: ews().users.findOneBy('email', 'pw@acme.test')!.id,
    });
    expect(ews().sessions.all().at(-1)!.auth_method).toBe('password');
  });

  it('carries connect_request through organization selection, and binds the chosen organization', async () => {
    const { client_id, verifier, html } = await begin();
    const passwordHtml = await (await submit({ ...hiddenFields(html), email: 'multi@acme.test' })).text();
    const orgPage = await submit({ ...hiddenFields(passwordHtml), password: 'correct-horse' });
    expect(orgPage.status).toBe(200);
    const orgHtml = await orgPage.text();
    expect(orgHtml).toContain('Select an organization');
    const fields = hiddenFields(orgHtml);
    expect(fields.connect_request).toBeTruthy();
    const orgId = orgHtml.match(/name="organization_id" value="([^"]+)"/)![1];

    const done = await submit({ ...fields, organization_id: orgId });
    expect(done.status).toBe(302);
    const tokens = await exchange(client_id, verifier, done.headers.get('location')!);
    expect(decode(tokens.access_token).org_id).toBe(orgId);
    // The refresh carries the organization across.
    const refreshed = await fetch(`${emulator.url}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id, refresh_token: tokens.refresh_token }),
    });
    expect(decode(((await refreshed.json()) as any).access_token).org_id).toBe(orgId);
  });

  it('carries connect_request through email verification and a second factor, then organization selection', async () => {
    const { client_id, verifier, html } = await begin();
    let page = await (await submit({ ...hiddenFields(html), email: 'gated@acme.test' })).text();
    page = await (await submit({ ...hiddenFields(page), password: 'correct-horse' })).text();
    expect(page).toContain('Verify your email');
    const login = () =>
      emulator.store.getData<{ email_verification_id: string | null; challenge_id: string | null }>(
        `interactive_login:${hiddenFields(page).pending_authentication_token}`,
      )!;
    const emailCode = ews().emailVerifications.get(login().email_verification_id!)!.code;
    page = await (await submit({ ...hiddenFields(page), code: emailCode })).text();
    expect(page).toContain('one-time code');
    const totp = ews().authChallenges.get(login().challenge_id!)!.code!;
    page = await (await submit({ ...hiddenFields(page), code: totp })).text();
    expect(page).toContain('Select an organization');
    const orgId = page.match(/name="organization_id" value="([^"]+)"/)![1];
    expect(hiddenFields(page).connect_request).toBeTruthy();

    const done = await submit({ ...hiddenFields(page), organization_id: orgId });
    expect(done.status).toBe(302);
    const tokens = await exchange(client_id, verifier, done.headers.get('location')!);
    expect(decode(tokens.access_token).org_id).toBe(orgId);
    // The gate that cleared last is what the session and event report, as for the API grants.
    expect(ews().users.findOneBy('email', 'gated@acme.test')!.email_verified).toBe(true);
  });

  it('sends a submit that skips the password page back to it', async () => {
    const first = await begin();
    const skipped = await submit({ ...hiddenFields(first.html), email: 'pw@acme.test' });
    expect(skipped.status).toBe(200);
    expect(await skipped.text()).toContain('name="password"');
  });
});
