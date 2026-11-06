import { describe, it, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';
import { NOT_IMPLEMENTED_CODE } from './client-graphql.js';

const apiKeys: ApiKeyMap = { sk_test_graphql: { environment: 'test' } };
const apiHeaders = { Authorization: 'Bearer sk_test_graphql', 'Content-Type': 'application/json' };
const PASSWORD = 'correct-horse-battery';

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys: { ...apiKeys } });
}

// The documents `@workos-inc/widgets` 1.20.2 sends, verbatim from its generated SDK
// (dist/esm/api/client-graphql/generated.js), fragments and whitespace included: the emulator has
// to accept exactly what the package emits, not a tidied-up version of it.
const USER_FIELDS = `
    fragment UserFields on User {
  id
  email
  emailVerified
  firstName
  lastName
  profilePictureUrl
  mfaEnabled
  mfaLastUsedAt
  passwordSet
  passwordLastUsedAt
  createdAt
  updatedAt
}
    `;
const CONNECTED_ACCOUNT_FIELDS = `
    fragment ConnectedAccountFields on ConnectedAccount {
  id
  provider
  email
  firstName
  lastName
  profilePictureUrl
  lastLoginAt
}
    `;
const ME_DOCUMENT = `
    query Me {
  me {
    ...UserFields
    connectedAccounts {
      ...ConnectedAccountFields
    }
  }
}
    ${USER_FIELDS}
${CONNECTED_ACCOUNT_FIELDS}`;
const AUTHENTICATION_SETTINGS_DOCUMENT = `
    query AuthenticationSettings {
  authenticationSettings {
    mfaEnabled
    mfaRequired
    passkeyAuthEnabled
    passwordAuthEnabled
    passwordPolicy {
      minimumLength
      minimumStrength
      rejectsBreachedPasswords
      requiresLowercase
      requiresNumber
      requiresSymbol
      requiresUppercase
    }
  }
}
    `;

/** Production's answer to a request it could not authenticate, for the `Me` document above. */
const UNAUTHENTICATED_ME = {
  errors: [
    {
      message: 'Unauthenticated',
      locations: [{ line: 3, column: 3 }],
      path: ['me'],
      extensions: { code: 'UNAUTHENTICATED' },
    },
  ],
  data: null,
};

describe('Client GraphQL API', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let ws: WorkOSStore;
  let organizationId: string;
  let userId: string;

  const api = (path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: apiHeaders, body: JSON.stringify(body) });
  const json = (res: Response) => res.json() as Promise<any>;

  beforeEach(async () => {
    const testApp = createTestApp();
    app = testApp.app;
    ws = getWorkOSStore(testApp.store);

    organizationId = (await json(await api('/organizations', { name: 'Acme' }))).id;
    userId = (
      await json(
        await api('/user_management/users', {
          email: 'alice@acme.com',
          first_name: 'Alice',
          password: PASSWORD,
          email_verified: true,
        }),
      )
    ).id;
    await api('/user_management/organization_memberships', { organization_id: organizationId, user_id: userId });
  });

  afterEach(() => setSystemTime());

  /** A request the way `graphql-request` sends one from a widget: JSON body, widget headers, bearer token. */
  const graphql = (body: unknown, token?: string) =>
    app.request('/client/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'WorkOS-Widgets-Version': '1',
        'WorkOS-Widgets-Type': 'UserSecurity',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  const operation = (query: string, token?: string, extra: Record<string, unknown> = {}) =>
    graphql({ query, variables: {}, ...extra }, token);
  const widgetToken = async (body: Record<string, unknown>): Promise<string> =>
    (await json(await api('/widgets/token', body))).token;
  const signIn = async () =>
    json(
      await app.request('/user_management/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'password', email: 'alice@acme.com', password: PASSWORD }),
      }),
    );
  const me = async (token?: string) => json(await operation(ME_DOCUMENT, token, { operationName: 'Me' }));

  describe('Me', () => {
    it("answers the widgets' document for a user-only widget session", async () => {
      const res = await operation(ME_DOCUMENT, await widgetToken({ user_id: userId }), { operationName: 'Me' });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/^application\/json/);

      const body = await json(res);
      expect(Object.keys(body)).toEqual(['data']);
      expect(body.data.me).toEqual({
        id: userId,
        email: 'alice@acme.com',
        emailVerified: true,
        firstName: 'Alice',
        lastName: null,
        profilePictureUrl: null,
        mfaEnabled: false,
        mfaLastUsedAt: null,
        passwordSet: true,
        passwordLastUsedAt: null,
        createdAt: ws.users.get(userId)!.created_at,
        updatedAt: ws.users.get(userId)!.updated_at,
        connectedAccounts: [],
      });
    });

    it('is the same user for a session that also selected an organization', async () => {
      const token = await widgetToken({ organization_id: organizationId, user_id: userId });
      expect((await me(token)).data.me.id).toBe(userId);
    });

    it('reports MFA from a verified TOTP factor only', async () => {
      const insertFactor = (verifiedAt: string | null) =>
        ws.authFactors.insert({
          object: 'authentication_factor',
          user_id: userId,
          type: 'totp',
          last_verified_at: verifiedAt,
          totp: { issuer: 'Acme', user: 'alice@acme.com', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/acme' },
        });
      const token = await widgetToken({ user_id: userId });

      // An enrollment abandoned at the QR code is not MFA, as it is not to the password grant.
      insertFactor(null);
      expect((await me(token)).data.me).toMatchObject({ mfaEnabled: false, mfaLastUsedAt: null });

      const verifiedAt = '2026-11-01T10:00:00.000Z';
      insertFactor(verifiedAt);
      expect((await me(token)).data.me).toMatchObject({ mfaEnabled: true, mfaLastUsedAt: verifiedAt });
    });

    it('reports a password and its latest sign-in', async () => {
      const token = await widgetToken({ user_id: userId });
      expect((await me(token)).data.me).toMatchObject({ passwordSet: true, passwordLastUsedAt: null });

      await signIn();
      const session = ws.sessions.findBy('user_id', userId).find((s) => s.auth_method === 'password')!;
      expect((await me(token)).data.me.passwordLastUsedAt).toBe(session.created_at);

      // A user without a password has neither, whatever sessions they hold.
      const other = await json(await api('/user_management/users', { email: 'bob@acme.com' }));
      expect((await me(await widgetToken({ user_id: other.id }))).data.me).toMatchObject({
        passwordSet: false,
        passwordLastUsedAt: null,
      });
    });

    it("lists linked OAuth identities as connected accounts, in production's provider order", async () => {
      // Linked in the reverse of the order production lists them, and under the REST spelling of
      // GitHub's provider, which the GraphQL enum spells differently.
      const google = ws.identities.insert({
        object: 'identity',
        user_id: userId,
        provider: 'GoogleOAuth',
        idp_id: '108',
        type: 'OAuth',
      });
      const github = ws.identities.insert({
        object: 'identity',
        user_id: userId,
        provider: 'GitHubOAuth',
        idp_id: '42',
        type: 'OAuth',
      });
      // The Google login came through a connection, so its profile is on record; GitHub was seeded.
      const profile = ws.ssoProfiles.insert({
        object: 'profile',
        connection_id: 'conn_google',
        connection_type: 'GoogleOAuth',
        organization_id: organizationId,
        idp_id: google.idp_id,
        email: 'alice@gmail.com',
        first_name: 'Alice',
        last_name: 'Liddell',
        name: null,
        groups: [],
        raw_attributes: {},
      });

      const { data } = await me(await widgetToken({ user_id: userId }));
      expect(data.me.connectedAccounts).toEqual([
        {
          id: github.id,
          provider: 'GithubOAuth',
          email: null,
          firstName: null,
          lastName: null,
          profilePictureUrl: null,
          lastLoginAt: null,
        },
        {
          id: profile.id,
          provider: 'GoogleOAuth',
          email: 'alice@gmail.com',
          firstName: 'Alice',
          lastName: 'Liddell',
          profilePictureUrl: null,
          lastLoginAt: null,
        },
      ]);
    });

    it('is not found for an organization-only widget session, as production answers it', async () => {
      const token = await widgetToken({ organization_id: organizationId, scopes: ['widgets:sso:manage'] });
      const body = await me(token);
      expect(body.data).toBeNull();
      expect(body.errors).toHaveLength(1);
      expect(body.errors[0]).toMatchObject({
        message: expect.stringMatching(/^User not found: 'widget_session_[0-9A-Z]+'\.$/),
        path: ['me'],
        extensions: { code: 'NOT_FOUND' },
      });
    });
  });

  describe('AuthenticationSettings', () => {
    it("answers the widgets' document with the policy the emulator enforces", async () => {
      const res = await operation(AUTHENTICATION_SETTINGS_DOCUMENT, await widgetToken({ user_id: userId }), {
        operationName: 'AuthenticationSettings',
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({
        data: {
          authenticationSettings: {
            mfaEnabled: true,
            mfaRequired: false,
            passkeyAuthEnabled: false,
            passwordAuthEnabled: true,
            passwordPolicy: {
              minimumLength: 10,
              minimumStrength: 3,
              rejectsBreachedPasswords: false,
              requiresLowercase: false,
              requiresNumber: false,
              requiresSymbol: false,
              requiresUppercase: false,
            },
          },
        },
      });
    });

    it('requires a session with a user, as me does', async () => {
      const unauthenticated = await json(await operation(AUTHENTICATION_SETTINGS_DOCUMENT));
      expect(unauthenticated.errors[0]).toMatchObject({
        message: 'Unauthenticated',
        path: ['authenticationSettings'],
        extensions: { code: 'UNAUTHENTICATED' },
      });

      const token = await widgetToken({ organization_id: organizationId, scopes: ['widgets:sso:manage'] });
      const orgOnly = await json(await operation(AUTHENTICATION_SETTINGS_DOCUMENT, token));
      expect(orgOnly.errors[0].extensions).toEqual({ code: 'NOT_FOUND' });
    });
  });

  describe('tokens', () => {
    it('accepts an AuthKit access token until its session is revoked', async () => {
      const { access_token } = await signIn();
      expect((await me(access_token)).data.me.id).toBe(userId);

      const session = ws.sessions.findBy('user_id', userId)[0];
      await api('/user_management/sessions/revoke', { session_id: session.id });
      expect(await me(access_token)).toEqual(UNAUTHENTICATED_ME);
    });

    it('accepts a Client API token', async () => {
      const { token } = await json(await api('/client/token', { organization_id: organizationId, user_id: userId }));
      expect((await me(token)).data.me.id).toBe(userId);
    });

    it('stops accepting a widget token once the membership behind it is deactivated', async () => {
      const token = await widgetToken({ organization_id: organizationId, user_id: userId });
      expect((await me(token)).data.me.id).toBe(userId);

      const membership = ws.organizationMemberships.findBy('user_id', userId)[0];
      await app.request(`/user_management/organization_memberships/${membership.id}/deactivate`, {
        method: 'PUT',
        headers: apiHeaders,
      });
      expect(await me(token)).toEqual(UNAUTHENTICATED_ME);
    });

    it('answers every token problem inside a 200, as production does', async () => {
      // No token, a token that is not a JWT, an API key, and a token signed by someone else.
      for (const token of [undefined, 'not.a.jwt', 'sk_test_graphql', `${await widgetToken({ user_id: userId })}x`]) {
        const res = await operation(ME_DOCUMENT, token, { operationName: 'Me' });
        expect(res.status).toBe(200);
        expect(await json(res)).toEqual(UNAUTHENTICATED_ME);
      }

      // An expired one: the widget token lives an hour.
      const token = await widgetToken({ user_id: userId });
      setSystemTime(new Date(Date.now() + 3601 * 1000));
      expect(await me(token)).toEqual(UNAUTHENTICATED_ME);
    });

    it('does not take an API key the way the REST routes do', async () => {
      // The path is public at the API-key layer; the bearer is read as a Client API token only.
      const res = await app.request('/client/graphql', {
        method: 'POST',
        headers: apiHeaders,
        body: JSON.stringify({ query: ME_DOCUMENT, operationName: 'Me' }),
      });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual(UNAUTHENTICATED_ME);
    });
  });

  describe('request handling, as Apollo Server', () => {
    it('refuses a syntax error, an invalid document, and introspection with their codes', async () => {
      const parse = await graphql({ query: 'query { me { ' });
      expect(parse.status).toBe(400);
      expect(await json(parse)).toEqual({
        errors: [
          { message: 'Syntax Error: Expected Name, found <EOF>.', extensions: { code: 'GRAPHQL_PARSE_FAILED' } },
        ],
      });

      const invalid = await graphql({ query: 'query { me { id nope } }' });
      expect(invalid.status).toBe(400);
      expect(await json(invalid)).toEqual({
        errors: [
          { message: 'Cannot query field "nope" on type "User".', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } },
        ],
      });

      const introspection = await graphql({ query: '{ __schema { queryType { name } } }' });
      expect(introspection.status).toBe(403);
      expect(await json(introspection)).toEqual({
        errors: [{ message: 'Forbidden action. Cannot introspect schema.', extensions: { code: 'FORBIDDEN' } }],
        data: null,
      });
    });

    it('refuses what it cannot read as a GraphQL request, in plain text', async () => {
      const post = (body: string, headers: Record<string, string> = { 'Content-Type': 'application/json' }) =>
        app.request('/client/graphql', { method: 'POST', headers, body });

      const empty = await post('{}');
      expect(empty.status).toBe(400);
      expect(await empty.text()).toBe('POST body missing, invalid Content-Type, or JSON object has no keys.');
      expect((await post('{"query":"{ me { id } }"}', { 'Content-Type': 'application/xml' })).status).toBe(400);

      expect(await (await post('{"query":123}')).text()).toBe('GraphQL queries must be strings.');
      expect(await (await post('{"query":"{ me { id } }","variables":"oops"}')).text()).toBe(
        'Variables are invalid JSON.',
      );

      const csrf = await post('{"query":"{ me { id } }"}', { 'Content-Type': 'text/plain' });
      expect(csrf.status).toBe(400);
      expect(await csrf.text()).toMatch(/^This operation has been blocked as a potential Cross-Site Request Forgery/);

      const broken = await post('{not json');
      expect(broken.status).toBe(400);
      expect(await json(broken)).toEqual({ message: expect.any(String) });

      const put = await app.request('/client/graphql', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{"query":"{ me { id } }"}',
      });
      expect(put.status).toBe(405);
      expect(await put.text()).toBe('Apollo Server supports only GET/POST requests.');
    });

    it('needs a query, and an operation name when the document holds several', async () => {
      const missing = await graphql({ variables: {} });
      expect(missing.status).toBe(400);
      expect(await json(missing)).toEqual({
        errors: [
          {
            message: 'GraphQL operations must contain a non-empty `query` or a `persistedQuery` extension.',
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          },
        ],
      });

      const two = 'query A { clientApiStatus } query B { clientApiStatus }';
      const unnamed = await graphql({ query: two });
      expect(unnamed.status).toBe(400);
      expect(await json(unnamed)).toEqual({
        errors: [
          {
            message: 'Must provide operation name if query contains multiple operations.',
            extensions: { code: 'INTERNAL_SERVER_ERROR' },
          },
        ],
      });

      const unknown = await graphql({ query: two, operationName: 'Nope' });
      expect(unknown.status).toBe(400);
      expect(await json(unknown)).toEqual({
        errors: [{ message: 'Unknown operation named "Nope".', extensions: { code: 'INTERNAL_SERVER_ERROR' } }],
      });

      const token = await widgetToken({ user_id: userId });
      const named = await graphql(
        { query: `query A { me { id } } query B { me { email } }`, operationName: 'B' },
        token,
      );
      expect(await json(named)).toEqual({ data: { me: { email: 'alice@acme.com' } } });
    });

    it('serves a GET query that carries the CSRF header', async () => {
      const token = await widgetToken({ user_id: userId });
      const get = (query: string, headers: Record<string, string> = {}) =>
        app.request(`/client/graphql?query=${encodeURIComponent(query)}`, {
          headers: { Authorization: `Bearer ${token}`, ...headers },
        });

      const blocked = await get('{ me { id } }');
      expect(blocked.status).toBe(400);
      expect(await blocked.text()).toMatch(/Cross-Site Request Forgery/);

      const res = await get('{ me { id } }', { 'X-CSRF-Token': '1' });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ data: { me: { id: userId } } });

      const mutation = await get('mutation { revokeAllSessions { __typename } }', { 'X-CSRF-Token': '1' });
      expect(mutation.status).toBe(405);
      expect(await mutation.text()).toBe('GET requests only support query operations, not mutation operations.');
    });

    it('names an operation the schema defines but the emulator does not implement', async () => {
      const res = await graphql({ query: '{ clientApiStatus }' }, await widgetToken({ user_id: userId }));
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({
        errors: [
          {
            message: 'The emulator does not implement Query.clientApiStatus yet.',
            locations: [{ line: 1, column: 3 }],
            path: ['clientApiStatus'],
            extensions: { code: NOT_IMPLEMENTED_CODE },
          },
        ],
        data: null,
      });
    });

    it("answers a browser's preflight", async () => {
      const res = await app.request('/client/graphql', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3000',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,content-type,workos-widgets-type,workos-widgets-version',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    });
  });
});
