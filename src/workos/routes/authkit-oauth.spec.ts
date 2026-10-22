/**
 * The AuthKit domain's discovery documents, dynamic client registration (RFC 7591) and the
 * resource-indicator API. The authorize/token behavior they lead to is in
 * authkit-oauth-server.spec.ts.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer } from '../../core/index.js';
import { seedFromConfig, workosPlugin } from '../index.js';
import { validateSeedConfig } from '../config-validator.js';
import { getWorkOSStore } from '../store.js';

const baseUrl = 'http://localhost:4100';
const apiHeaders = { Authorization: 'Bearer sk_test_default', 'Content-Type': 'application/json' };
const json = (res: Response) => res.json() as Promise<any>;

function createTestApp() {
  return createServer(workosPlugin, {
    port: 0,
    baseUrl,
    apiKeys: { sk_test_default: { environment: 'test' } },
  });
}

describe('AuthKit domain discovery', () => {
  let server: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    server = createTestApp();
  });

  it('serves the OAuth authorization server metadata without an API key', async () => {
    const res = await server.app.request('http://issuer.test:4100/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    // Endpoints from the origin the caller used, issuer from the configuration: see the route.
    expect(await json(res)).toEqual({
      authorization_endpoint: 'http://issuer.test:4100/oauth2/authorize',
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      issuer: baseUrl,
      jwks_uri: 'http://issuer.test:4100/oauth2/jwks',
      registration_endpoint: 'http://issuer.test:4100/oauth2/register',
      scopes_supported: ['email', 'offline_access', 'openid', 'profile'],
      response_modes_supported: ['query'],
      response_types_supported: ['code'],
      token_endpoint: 'http://issuer.test:4100/oauth2/token',
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    });
  });

  it('serves the OpenID configuration without an API key', async () => {
    const res = await server.app.request('http://issuer.test:4100/.well-known/openid-configuration');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      issuer: baseUrl,
      authorization_endpoint: 'http://issuer.test:4100/oauth2/authorize',
      grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
      id_token_signing_alg_values_supported: ['RS256'],
      jwks_uri: 'http://issuer.test:4100/oauth2/jwks',
      response_types_supported: ['code'],
      scopes_supported: ['email', 'offline_access', 'openid', 'profile'],
      subject_types_supported: ['public'],
      token_endpoint: 'http://issuer.test:4100/oauth2/token',
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    });
  });

  it('advertises no endpoint the emulator does not serve', async () => {
    for (const path of ['oauth-authorization-server', 'openid-configuration']) {
      const doc = await json(await server.app.request(`/.well-known/${path}`));
      for (const key of [
        'device_authorization_endpoint',
        'introspection_endpoint',
        'userinfo_endpoint',
        'client_id_metadata_document_supported',
      ]) {
        expect(doc).not.toHaveProperty(key);
      }
      expect(doc.grant_types_supported).not.toContain('urn:ietf:params:oauth:grant-type:device_code');
    }
  });

  it('advertises only endpoints with a route registered for exactly that method and path', async () => {
    // Registered routes, not responses: a 404 and a 401 look alike from outside, and a wildcard
    // middleware or catch-all would otherwise make any path seem served.
    const registered = new Set(
      server.app.routes.filter((r) => r.path !== '/*' && !r.path.includes('*')).map((r) => `${r.method} ${r.path}`),
    );
    const expected: Record<string, string> = {
      authorization_endpoint: 'GET',
      token_endpoint: 'POST',
      registration_endpoint: 'POST',
      jwks_uri: 'GET',
    };
    for (const path of ['oauth-authorization-server', 'openid-configuration']) {
      const doc = await json(await server.app.request(`/.well-known/${path}`));
      const endpointKeys = Object.keys(doc).filter((k) => k.endsWith('_endpoint') || k === 'jwks_uri');
      expect(endpointKeys.length).toBeGreaterThan(0);
      for (const key of endpointKeys) {
        // Every advertised URL key must be one this test knows how to check.
        expect(Object.keys(expected)).toContain(key);
        expect(registered.has(`${expected[key]} ${new URL(doc[key]).pathname}`)).toBe(true);
      }
    }
    expect((await server.app.request('/oauth2/jwks')).status).toBe(200);
  });

  it('does not serve an RFC 8414 path-inserted form', async () => {
    // The issuer has no path, so production has no such document; it must not be invented.
    const res = await server.app.request('/.well-known/oauth-authorization-server/user_management/client_x');
    expect(res.status).not.toBe(200);
  });

  it('uses a pinned issuer verbatim, without a trailing slash', async () => {
    const pinned = createServer(workosPlugin, { port: 0, baseUrl, issuer: 'https://auth.example.test/' });
    const doc = await json(await pinned.app.request('/.well-known/oauth-authorization-server'));
    expect(doc.issuer).toBe('https://auth.example.test');
  });
});

describe('Dynamic client registration', () => {
  let server: ReturnType<typeof createTestApp>;
  let ws: ReturnType<typeof getWorkOSStore>;

  beforeEach(() => {
    server = createTestApp();
    ws = getWorkOSStore(server.store);
  });

  // A JSON object body is given the required `client_name` unless the test names one (or sets it
  // to undefined, to leave it out).
  const register = (body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
    server.app.request('/oauth2/register', {
      method: 'POST',
      headers,
      body:
        typeof body === 'string'
          ? body
          : JSON.stringify(
              body && typeof body === 'object' && !Array.isArray(body) ? { client_name: 'Test client', ...body } : body,
            ),
    });
  const callback = 'http://localhost:33418/callback';

  it('registers a public client without an API key', async () => {
    const res = await register({
      client_name: 'Claude Code',
      redirect_uris: [callback],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid profile',
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.client_id).toMatch(/^client_/);
    expect(body).not.toHaveProperty('client_secret');
    expect(body).toMatchObject({
      client_name: 'Claude Code',
      redirect_uris: [callback],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid profile',
    });
    expect(typeof body.client_id_issued_at).toBe('number');

    const application = ws.connectApplications.findOneBy('client_id', body.client_id)!;
    expect(application).toMatchObject({
      application_type: 'oauth',
      is_first_party: false,
      was_dynamically_registered: true,
      uses_pkce: true,
      login_url: null,
      redirect_uris: [callback],
    });
    expect(ws.clientSecrets.findBy('application_id', application.id)).toHaveLength(0);
  });

  it('registers a confidential client with a generated secret', async () => {
    const res = await register({ redirect_uris: [callback], token_endpoint_auth_method: 'client_secret_post' });
    expect(res.status).toBe(201);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await json(res);
    expect(body.client_secret).toMatch(/^secret_/);
    expect(body.client_secret_expires_at).toBe(0);
    expect(body.token_endpoint_auth_method).toBe('client_secret_post');
    const application = ws.connectApplications.findOneBy('client_id', body.client_id)!;
    expect(application.uses_pkce).toBe(false);
    expect(ws.clientSecrets.findBy('application_id', application.id).map((s) => s.value)).toEqual([body.client_secret]);
  });

  it('defaults as production does: web, client_secret_basic, authorization_code, code, and no scope echoed', async () => {
    const body = await json(await register({ redirect_uris: [callback] }));
    expect(body.application_type).toBe('web');
    expect(body.token_endpoint_auth_method).toBe('client_secret_basic');
    expect(body.client_secret).toMatch(/^secret_/);
    expect(body.grant_types).toEqual(['authorization_code']);
    expect(body.response_types).toEqual(['code']);
    // No scope asked for: none echoed. The standard set is open to the client regardless, and
    // none of it is an application scope: production serves those from assigned permissions,
    // which a dynamically registered application has none of.
    expect(body).not.toHaveProperty('scope');
    expect(ws.connectApplications.findOneBy('client_id', body.client_id)!.scopes).toEqual([]);
    expect(Object.keys(body).sort()).toEqual([
      'application_type',
      'client_id',
      'client_id_issued_at',
      'client_name',
      'client_secret',
      'client_secret_expires_at',
      'grant_types',
      'redirect_uris',
      'response_types',
      'token_endpoint_auth_method',
    ]);
  });

  it('requires client_name, as production does', async () => {
    for (const client_name of [undefined, 42, null]) {
      const res = await register({ redirect_uris: [callback], client_name });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        error: 'invalid_client_metadata',
        error_description: 'client_name is required.',
      });
    }
    expect(ws.connectApplications.all()).toHaveLength(0);
  });

  it('defaults a native application to a public client, and echoes application_type', async () => {
    const native = await json(await register({ redirect_uris: [callback], application_type: 'native' }));
    expect(native.application_type).toBe('native');
    expect(native.token_endpoint_auth_method).toBe('none');
    expect(native).not.toHaveProperty('client_secret');
    expect(ws.connectApplications.findOneBy('client_id', native.client_id)!.uses_pkce).toBe(true);
    // An explicit method still wins.
    const confidential = await json(
      await register({
        redirect_uris: [callback],
        application_type: 'native',
        token_endpoint_auth_method: 'client_secret_post',
      }),
    );
    expect(confidential.token_endpoint_auth_method).toBe('client_secret_post');
    const bad = await register({ redirect_uris: [callback], application_type: 'desktop' });
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe('invalid_client_metadata');
  });

  it('shows dynamically registered applications only under registration_types=dynamic', async () => {
    const { client_id } = await json(await register({ redirect_uris: [callback], token_endpoint_auth_method: 'none' }));
    const list = async (query: string) =>
      (await json(await server.app.request(`/connect/applications${query}`, { headers: apiHeaders }))).data.map(
        (a: any) => a.client_id,
      );
    expect(await list('')).not.toContain(client_id);
    expect(await list('?registration_types=authenticated')).not.toContain(client_id);
    expect(await list('?registration_types=dynamic')).toEqual([client_id]);
    expect(await list('?registration_types=dynamic,authenticated')).toContain(client_id);

    const application = await json(
      await server.app.request(`/connect/applications/${client_id}`, { headers: apiHeaders }),
    );
    expect(application).toMatchObject({
      application_type: 'oauth',
      is_first_party: false,
      was_dynamically_registered: true,
      uses_pkce: true,
    });
  });

  it('rejects redirect_uris the redirect-host policy would refuse, as RFC 7591 errors', async () => {
    for (const uris of [
      ['https://evil.example/cb'],
      ['javascript:alert(1)'],
      ['not a url'],
      [callback, 'https://evil.example/cb'],
    ]) {
      const res = await register({ redirect_uris: uris });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('invalid_redirect_uri');
    }
    for (const uris of [undefined, [], 'http://localhost/cb', [42], ['']]) {
      const res = await register({ redirect_uris: uris });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('invalid_redirect_uri');
    }
    expect(ws.connectApplications.all()).toHaveLength(0);
  });

  it('drops scopes a dynamically registered client cannot be granted and echoes the effective scope', async () => {
    // Production's grantableForDynamicRegistration: a requested scope the client may not ask for
    // is dropped rather than failing the registration, and the effective set is reported in the
    // order requested, de-duplicated. The emulator has no environment-level permissions for
    // dynamic registration, so the grantable set is the standard scopes.
    const mixed = await register({ redirect_uris: [callback], scope: 'mcp:tools openid claudeai profile openid' });
    expect(mixed.status).toBe(201);
    expect((await json(mixed)).scope).toBe('openid profile');
    // Nothing grantable: registered all the same, with an empty effective scope.
    const none = await register({ redirect_uris: [callback], scope: 'claudeai' });
    expect(none.status).toBe(201);
    expect((await json(none)).scope).toBe('');
    // An empty string is no request for a scope, and is not echoed.
    const empty = await json(await register({ redirect_uris: [callback], scope: '' }));
    expect(empty).not.toHaveProperty('scope');
    expect(ws.connectApplications.all()).toHaveLength(3);
  });

  it('stores what the client registered for, as metadata the token endpoint does not enforce', async () => {
    const body = await json(
      await register({
        redirect_uris: [callback],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'],
      }),
    );
    expect(ws.connectApplications.findOneBy('client_id', body.client_id)).toMatchObject({
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'none',
    });
  });

  it('accepts http(s) display URLs and rejects any other scheme as invalid_client_metadata', async () => {
    const ok = await register({
      redirect_uris: [callback],
      logo_uri: 'https://client.example.test/logo.png',
      client_uri: 'http://client.example.test',
      policy_uri: 'https://client.example.test/policy',
      tos_uri: 'https://client.example.test/tos',
    });
    expect(ok.status).toBe(201);
    for (const field of ['logo_uri', 'client_uri', 'policy_uri', 'tos_uri']) {
      for (const value of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.test/a', 'not a url', 42]) {
        const res = await register({ redirect_uris: [callback], [field]: value });
        expect(res.status).toBe(400);
        const err = await json(res);
        expect(err.error).toBe('invalid_client_metadata');
        expect(err.error_description).toContain(field);
      }
    }
  });

  it('rejects a registration whose grant_types cannot produce the code response type it names', async () => {
    // RFC 7591 §2.1: `code` needs `authorization_code`. Refresh-only is such a client.
    for (const grant_types of [['refresh_token']]) {
      for (const response_types of [undefined, ['code']]) {
        const res = await register({ redirect_uris: [callback], grant_types, response_types });
        expect(res.status).toBe(400);
        expect((await json(res)).error).toBe('invalid_client_metadata');
      }
    }
    // refresh_token stays optional.
    const ok = await register({ redirect_uris: [callback], grant_types: ['authorization_code'] });
    expect(ok.status).toBe(201);
  });

  it('rejects an empty or unsupported response_types, and returns and stores exactly what was registered', async () => {
    for (const response_types of [[], ['token'], ['code', 'token'], 'code', 7]) {
      const res = await register({ redirect_uris: [callback], response_types });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('invalid_client_metadata');
    }
    const body = await json(await register({ redirect_uris: [callback], response_types: ['code'] }));
    expect(body.response_types).toEqual(['code']);
    expect(ws.connectApplications.findOneBy('client_id', body.client_id)!.response_types).toEqual(['code']);
    // Omitted means the RFC default, `code`, and that is what comes back.
    const defaulted = await json(await register({ redirect_uris: [callback] }));
    expect(defaulted.response_types).toEqual(['code']);
  });

  it('rejects metadata the emulator cannot honor as invalid_client_metadata', async () => {
    for (const extra of [
      { token_endpoint_auth_method: 'private_key_jwt' },
      { grant_types: ['client_credentials'] },
      { grant_types: ['urn:ietf:params:oauth:grant-type:device_code'] },
      { response_types: ['token'] },
      { scope: 42 },
    ]) {
      const res = await register({ redirect_uris: [callback], ...extra });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('invalid_client_metadata');
    }
    for (const body of ['not json', '[]', '"x"']) {
      const res = await register(body);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('invalid_client_metadata');
    }
    expect(ws.connectApplications.all()).toHaveLength(0);
  });
});

describe('OAuth error page', () => {
  const server = createTestApp();

  it('serves 200 text/html and reflects the error_description', async () => {
    const res = await server.app.request(
      `/oauth2/error?${new URLSearchParams({ error: 'access_denied', error_description: 'The user said no' })}`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('access_denied: The user said no');
  });

  it('serves the application_not_found explanation by default', async () => {
    const html = await (await server.app.request('/oauth2/error?error=application_not_found')).text();
    expect(html).toContain('Application not found');
    expect(html).toContain('not registered with this environment');
  });

  it('escapes hostile values in both parameters', async () => {
    const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
    const cases: Record<string, string>[] = [
      { error: 'application_not_found', error_description: hostile },
      { error: hostile, error_description: hostile },
      { error: hostile },
    ];
    for (const params of cases) {
      const html = await (await server.app.request(`/oauth2/error?${new URLSearchParams(params)}`)).text();
      expect(html).not.toContain('<script>alert(1)');
      expect(html).not.toContain('<img src=x');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      // Only the page's own script-free markup remains: no element the input could have opened.
      expect(html.match(/<script/g)).toBeNull();
    }
  });
});

describe('AuthKit OAuth resource indicators', () => {
  let server: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    server = createTestApp();
  });

  const create = (body: unknown) =>
    server.app.request('/user_management/authkit_oauth_resources', {
      method: 'POST',
      headers: apiHeaders,
      body: JSON.stringify(body),
    });

  it('creates, lists and deletes an indicator in the spec shape', async () => {
    const res = await create({ uri: 'https://api.example.test/mcp' });
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created).toMatchObject({
      object: 'authkit_oauth_resource',
      uri: 'https://api.example.test/mcp',
      default: false,
    });
    expect(created.id).toMatch(/^authkit_oauth_resource_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Object.keys(created).sort()).toEqual(['created_at', 'default', 'id', 'object', 'updated_at', 'uri']);

    const list = await json(
      await server.app.request('/user_management/authkit_oauth_resources', { headers: apiHeaders }),
    );
    expect(list.object).toBe('list');
    expect(list.data.map((r: any) => r.id)).toEqual([created.id]);

    const del = await server.app.request(`/user_management/authkit_oauth_resources/${created.id}`, {
      method: 'DELETE',
      headers: apiHeaders,
    });
    expect(del.status).toBe(204);
    const again = await server.app.request(`/user_management/authkit_oauth_resources/${created.id}`, {
      method: 'DELETE',
      headers: apiHeaders,
    });
    expect(again.status).toBe(404);
    // Production raises a bare Nest NotFoundException with a string message here, so the body
    // carries Nest's `error` and no `code`.
    expect(await json(again)).toEqual({
      message: `AuthKit OAuth resource not found: '${created.id}'.`,
      error: 'Not Found',
    });
  });

  it('refuses a duplicate with the spec message, and a malformed uri', async () => {
    await create({ uri: 'https://api.example.test' });
    const duplicate = await create({ uri: 'https://api.example.test' });
    expect(duplicate.status).toBe(422);
    expect((await json(duplicate)).message).toBe("AuthKit OAuth resource 'https://api.example.test' already exists.");

    for (const uri of ['relative/path', 'https://api.example.test/#frag', 'https://*.example.test', '']) {
      expect((await create({ uri })).status).toBe(422);
    }
    expect((await create({})).status).toBe(422);
    expect((await create({ uri: 'https://ok.example.test', default: 'yes' })).status).toBe(422);
  });

  it('lets one resource hold the default, clearing the previous holder', async () => {
    const first = await json(await create({ uri: 'https://a.example.test', default: true }));
    expect(first.default).toBe(true);
    const second = await json(await create({ uri: 'https://b.example.test', default: true }));
    const list = await json(
      await server.app.request('/user_management/authkit_oauth_resources', { headers: apiHeaders }),
    );
    expect(Object.fromEntries(list.data.map((r: any) => [r.uri, r.default]))).toEqual({
      'https://a.example.test': false,
      'https://b.example.test': true,
    });
    expect(second.default).toBe(true);
  });

  it('requires an API key', async () => {
    const res = await server.app.request('/user_management/authkit_oauth_resources');
    expect(res.status).toBe(401);
  });

  it('seeds indicators', () => {
    seedFromConfig(server.store, baseUrl, {
      resourceIndicators: [{ uri: 'https://mcp.example.test', default: true }, { uri: 'https://other.example.test' }],
    });
    expect(
      getWorkOSStore(server.store)
        .authkitOauthResources.all()
        .map((r) => [r.uri, r.default]),
    ).toEqual([
      ['https://mcp.example.test', true],
      ['https://other.example.test', false],
    ]);
  });

  it('validates the seed with path-based errors', () => {
    expect(validateSeedConfig({ resourceIndicators: [{ uri: 'https://ok.example.test' }] }).valid).toBe(true);
    const { valid, errors } = validateSeedConfig({
      resourceIndicators: [
        { uri: 'https://a.example.test', default: true },
        { uri: 'https://a.example.test' },
        { uri: 'https://b.example.test', default: true },
        { uri: 'nope' },
        { uri: 'https://c.example.test/#f' },
        { uri: 'https://*.example.test' },
        { uri: '' },
        { uri: 'https://d.example.test', default: 'yes' as unknown as boolean },
        null as unknown as { uri: string },
        // The same resource as [0] once normalized, so a duplicate the API would also refuse.
        { uri: 'https://A.example.test/' },
      ],
    });
    expect(valid).toBe(false);
    const byPath = Object.fromEntries(errors.map((e) => [e.path, e.message]));
    expect(byPath['resourceIndicators[1].uri']).toContain('unique');
    expect(byPath['resourceIndicators[2].default']).toContain('only one');
    expect(byPath['resourceIndicators[3].uri']).toContain('absolute URI');
    expect(byPath['resourceIndicators[4].uri']).toContain('absolute URI');
    expect(byPath['resourceIndicators[5].uri']).toContain('absolute URI');
    expect(byPath['resourceIndicators[6].uri']).toContain('required');
    expect(byPath['resourceIndicators[7].default']).toContain('boolean');
    expect(byPath['resourceIndicators[8]']).toContain('object');
    expect(byPath['resourceIndicators[9].uri']).toContain('unique');

    expect(validateSeedConfig({ resourceIndicators: {} as never }).errors[0].path).toBe('resourceIndicators');
  });
});
