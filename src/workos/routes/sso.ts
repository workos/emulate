import type { Context } from 'hono';
import {
  type ApiKeyMap,
  type RouteContext,
  parseJsonBody,
  WorkOSApiError,
  OauthApiError,
  NestNotFoundError,
  generateId,
  notFound,
  isApiKeyEntryExpired,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatSSOProfile,
  expiresIn,
  isExpired,
  assertAllowedRedirectUri,
  emitAuthenticationEvent,
  findUserByEmail,
  emailsMatch,
  linkOAuthIdentity,
  organizationSsoConnections,
} from '../helpers.js';
import type { WorkOSConnection, WorkOSConnectionType } from '../entities.js';
import type { EventBus } from '../event-bus.js';
import { STORE_KEY_PREFIXES, STORE_KEYS } from '../constants.js';
import { renderLoginPage } from '../login-page.js';

/**
 * The connection types that federate through OAuth rather than SAML. Their names are exactly the
 * spec's identity `provider` values, which is why a login through one can be recorded as a linked
 * identity and a SAML login cannot.
 */
const OAUTH_CONNECTION_TYPES = new Set<WorkOSConnectionType>([
  'AppleOAuth',
  'GitHubOAuth',
  'GoogleOAuth',
  'MicrosoftOAuth',
]);

/**
 * Lifetime of the access token `/sso/token` issues, in seconds. Production's
 * `AuthorizationCodeExchanger.exchangeAuthorizationCode`
 * (`api/src/authorization-codes/authorization-code-exchanger.ts`) mints the token with
 * `addMinutes(5)`, so `expires_in` is 300 — not the 600 the API reference's example shows. The
 * SDKs require the field (the Python SDK's `SSOTokenResponse` fails to parse a response without
 * it), so the emulator signs the token with this lifetime and reports the same number.
 */
const SSO_TOKEN_TTL_SECONDS = 300;

/**
 * Lifetime of the code `/sso/authorize` hands back, in minutes. Production's
 * `AuthorizationCodesService` (`api-services/src/authorization-codes/authorization-codes.service.ts`)
 * mints every SSO authorization code with `AUTHORIZATION_CODE_TTL_IN_MINUTES = 5`.
 */
const SSO_CODE_TTL_MINUTES = 5;

/**
 * The `error_uri` production attaches to every error it redirects back to the app with: its
 * `SsoErrorHandler.authorizationUrlErrorCodesReference`, the docs page for the authorization
 * URL's error codes.
 */
const SSO_ERROR_CODES_REFERENCE = 'https://workos.com/docs/reference/sso/get-authorization-url/error-codes';

interface SSOAuthorizeParams {
  redirectUri: string;
  state: string | null;
  connectionId: string | null;
  organizationId: string | null;
  domainHint: string | null;
  provider: string | null;
  email: string | null;
  clientId: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
}

/** The connection a selector resolved to, with the selector's own words for an error about it. */
interface ResolvedConnection {
  connection: WorkOSConnection | undefined;
  /** Production's description of the selector when the connection it names is inactive. */
  inactiveDescription: string;
}

export function ssoRoutes(ctx: RouteContext): void {
  const { app, store, jwt } = ctx;
  const ws = getWorkOSStore(store);

  /** Domains are case-insensitive; connections keep theirs as written. */
  const claimsDomain = (cn: WorkOSConnection, domain: string) =>
    cn.domains.some((d) => d.domain.trim().toLowerCase() === domain.trim().toLowerCase());

  /**
   * The one connection a selector names, or a refusal. The chosen connection supplies the
   * organization the profile and code are minted under, so picking whichever organization was
   * created first would authenticate the user into the wrong tenant. State is not a tiebreaker:
   * production resolves the selector first and only then looks at the state, which is how an
   * inactive connection gets reported as inactive rather than as missing.
   */
  function theOnly(candidates: WorkOSConnection[], selector: string): WorkOSConnection | undefined {
    if (candidates.length > 1) {
      throw new WorkOSApiError(
        400,
        `Multiple connections match ${selector}; select one with connection or organization`,
        'invalid_request',
      );
    }
    return candidates[0];
  }

  /**
   * workos-go sends social login as `provider=GoogleOAuth|MicrosoftOAuth`: the connection type,
   * not a connection id. Production holds one OAuth connection of each type per environment,
   * so the type alone names it. The emulator lets every organization hold one, so the spec's
   * `domain_hint` — Microsoft's tenant pre-fill — narrows the candidates when one of them
   * claims the domain, and is otherwise the hint the spec says it is rather than a selector
   * that 404s a provider it does not name.
   */
  function findProviderConnection(provider: string, domainHint: string | null): WorkOSConnection | undefined {
    const ofType = ws.connections.all().filter((cn) => cn.connection_type === provider);
    const hinted = domainHint ? ofType.filter((cn) => claimsDomain(cn, domainHint)) : [];
    return theOnly(hinted.length > 0 ? hinted : ofType, `provider ${provider}`);
  }

  /**
   * Which connection the request's selector names, in production's precedence. The
   * descriptions are production's own, from `SsoController.handleInitiateSsoError`'s
   * `InactiveConnection` case (`api/src/sso/sso.controller.ts`).
   */
  function resolveConnection(params: SSOAuthorizeParams): ResolvedConnection {
    const { connectionId, organizationId, domainHint, provider } = params;

    if (connectionId) {
      return {
        connection: ws.connections.get(connectionId),
        inactiveDescription: `The connection '${connectionId}' is inactive.`,
      };
    }
    if (organizationId) {
      // The organization's SSO connection — there is at most one — and, failing that, whatever
      // the seed bound to it, since the emulator lets an organization hold an OAuth connection.
      const held = ws.connections.findBy('organization_id', organizationId);
      return {
        connection: organizationSsoConnections(ws, organizationId)[0] ?? held[0],
        inactiveDescription: `The connection associated with the organization ID '${organizationId}' is inactive.`,
      };
    }
    if (provider) {
      return {
        connection: findProviderConnection(provider, domainHint),
        inactiveDescription: `The connection associated with the OAuth provider '${provider}' is inactive.`,
      };
    }
    if (domainHint) {
      return {
        connection: theOnly(
          ws.connections.all().filter((cn) => claimsDomain(cn, domainHint)),
          `domain_hint ${domainHint}`,
        ),
        inactiveDescription: `The connection associated with the domain '${domainHint}' is inactive.`,
      };
    }
    return { connection: undefined, inactiveDescription: '' };
  }

  /**
   * Production's answer to an authorization it cannot complete once the app's `redirect_uri`
   * is known: a redirect back to it carrying `error`, `error_description`, the `state` and an
   * `error_uri` (`fromErrorToQueryParameters`, `api/src/sso/sso-error-redirector.ts`). The app
   * sees the failure on its own callback, which is where an SDK's callback handler reads it.
   */
  function redirectWithError(
    c: Context,
    redirectUri: string,
    state: string | null,
    error: string,
    description: string,
  ) {
    const redirect = new URL(redirectUri);
    redirect.searchParams.set('error_description', description);
    redirect.searchParams.set('error', error);
    if (state) redirect.searchParams.set('state', state);
    redirect.searchParams.set('error_uri', SSO_ERROR_CODES_REFERENCE);
    return c.redirect(redirect.toString());
  }

  function resolveAndRedirect(c: Context, params: SSOAuthorizeParams) {
    const { redirectUri, state, email: loginHint, clientId, codeChallenge, codeChallengeMethod } = params;

    assertAllowedRedirectUri(redirectUri, store);

    const { connection, inactiveDescription } = resolveConnection(params);

    if (!connection) {
      throw new WorkOSApiError(404, 'No active connection found', 'connection_not_found');
    }

    // Production's `SsoInitiator.initiateConnectionSignIn` sends a `validating` connection to
    // the IdP exactly as it sends an active one — validating is what a connection is until its
    // first login proves the configuration — and refuses an `inactive` one by redirecting to
    // the app with `connection_unlinked`.
    if (connection.state === 'inactive') {
      return redirectWithError(c, redirectUri, state, 'connection_unlinked', inactiveDescription);
    }

    const email = loginHint ?? `user@${connection.domains[0]?.domain ?? 'example.com'}`;
    // The last exact-match lookup by email, matched on the connection at the same time rather
    // than after. `findOneBy` returns the first profile for the address whatever connection it
    // belongs to, so a second connection never matched its own profile and minted another on
    // every authorize. Case-insensitive for the reason the rest are: a login_hint differing only
    // in case is the same federated person.
    let profile = ws.ssoProfiles.all().find((p) => p.connection_id === connection.id && emailsMatch(p.email, email));
    if (!profile) {
      profile = ws.ssoProfiles.insert({
        object: 'profile',
        connection_id: connection.id,
        connection_type: connection.connection_type,
        organization_id: connection.organization_id,
        idp_id: `idp_${generateId('usr')}`,
        email,
        first_name: email.split('@')[0],
        last_name: null,
        // Production sets `name` only when the connection's attribute map has a `name` key, and
        // the emulator's stand-in IdP maps none — so null, never a value composed from the parts.
        name: null,
        groups: [],
        raw_attributes: { email },
      });
    }

    // The IdP has answered, as far as the emulator is concerned: this is where production's
    // SAML and OIDC response handlers (`saml-response-handler.ts`, `openid-connect.controller.ts`)
    // turn a `validating` connection `active` on the first response they accept, and the store
    // hook announces `connection.activated` for it, the same way the first real login does.
    if (connection.state === 'validating') {
      ws.connections.update(connection.id, { state: 'active' });
    }

    const authCode = ws.ssoAuthorizations.insert({
      code: generateId('sso_code'),
      connection_id: connection.id,
      organization_id: connection.organization_id,
      profile_id: profile.id,
      redirect_uri: redirectUri,
      state,
      client_id: clientId,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      expires_at: expiresIn(SSO_CODE_TTL_MINUTES),
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', authCode.code);
    if (state) redirect.searchParams.set('state', state);
    return c.redirect(redirect.toString());
  }

  /**
   * `client_id` is the first thing production reads from an authorization request: it is how
   * the environment is found, so a request without one (or with one that names no application)
   * fails before the `redirect_uri` is even looked at, and fails without redirecting anywhere —
   * `SsoInitiator.initiateSso` returns `InvalidClient`, which the controller sends to WorkOS's
   * own error page with `client_id_invalid` and "Missing or invalid client_id." (the
   * `response_type` the DTO also declares is not validated at runtime: the query is bound
   * without a pipe). The emulator has no error page and registers no AuthKit clients, so it
   * refuses an absent id with the same code and words, as a 400 like its `invalid_redirect_uri`,
   * and takes any id that is present.
   */
  function assertClientId(clientId: string | null | undefined): void {
    if (!clientId) {
      throw new WorkOSApiError(400, 'Missing or invalid client_id.', 'client_id_invalid');
    }
  }

  app.get('/sso/authorize', (c) => {
    const url = new URL(c.req.url);
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const connectionId = url.searchParams.get('connection');
    const organizationId = url.searchParams.get('organization');
    const domainHint = url.searchParams.get('domain_hint');
    const provider = url.searchParams.get('provider');
    const loginHint = url.searchParams.get('login_hint');
    // Set only when /user_management/authorize hands a connection- or organization-bound request
    // here: production's standalone SSO endpoint takes no PKCE, and the SSO SDKs send none.
    const codeChallenge = url.searchParams.get('code_challenge');
    const codeChallengeMethod = url.searchParams.get('code_challenge_method');

    assertClientId(clientId);

    if (!redirectUri) {
      throw new WorkOSApiError(400, 'Missing required parameter: redirect_uri', 'invalid_request');
    }

    // Checked before the interactive branch, which renders the redirect_uri into a hidden field
    // and defers every check to the POST. A host the emulator will not redirect to should fail
    // here, not after someone has filled the form in.
    assertAllowedRedirectUri(redirectUri, store);

    const interactive = store.getData<boolean>(STORE_KEYS.interactiveAuth);
    if (interactive) {
      const hiddenFields: Record<string, string> = { client_id: clientId as string, redirect_uri: redirectUri };
      if (state) hiddenFields.state = state;
      if (connectionId) hiddenFields.connection = connectionId;
      if (organizationId) hiddenFields.organization = organizationId;
      if (domainHint) hiddenFields.domain_hint = domainHint;
      if (provider) hiddenFields.provider = provider;
      if (codeChallenge) hiddenFields.code_challenge = codeChallenge;
      if (codeChallengeMethod) hiddenFields.code_challenge_method = codeChallengeMethod;

      return c.html(
        renderLoginPage({
          title: 'SSO Login',
          subtitle: 'Sign in with your corporate identity.',
          emailHint: loginHint ?? undefined,
          formAction: '/sso/authorize',
          hiddenFields,
        }),
      );
    }

    return resolveAndRedirect(c, {
      redirectUri,
      state,
      connectionId,
      organizationId,
      domainHint,
      provider,
      email: loginHint,
      clientId,
      codeChallenge,
      codeChallengeMethod,
    });
  });

  app.post('/sso/authorize', async (c) => {
    const form = await c.req.parseBody();
    assertClientId(form.client_id as string | undefined);
    const redirectUri = form.redirect_uri as string;
    if (!redirectUri) {
      throw new WorkOSApiError(400, 'Missing required parameter: redirect_uri', 'invalid_request');
    }

    return resolveAndRedirect(c, {
      redirectUri,
      state: (form.state as string) ?? null,
      connectionId: (form.connection as string) ?? null,
      organizationId: (form.organization as string) ?? null,
      domainHint: (form.domain_hint as string) ?? null,
      provider: (form.provider as string) ?? null,
      email: (form.email as string) ?? null,
      clientId: (form.client_id as string) ?? null,
      codeChallenge: (form.code_challenge as string) ?? null,
      codeChallengeMethod: (form.code_challenge_method as string) ?? null,
    });
  });

  app.post('/sso/token', async (c) => {
    const body = await parseJsonBody(c);
    const grantType = body.grant_type as string | undefined;
    const code = body.code as string;

    // The spec gives /sso/token only OAuth-shaped 400s — invalid_client, unauthorized_client,
    // invalid_grant, unsupported_grant_type — so every failure a caller can cause below is
    // rendered that way, including the missing-parameter cases the spec leaves out and RFC 6749
    // §5.2 names invalid_request. A plain envelope there would have made the failures a client
    // hits before it has a code the ones it cannot parse like the rest. What a caller cannot
    // cause is the profile-missing 500 further down, which stays plain and says why there.
    //
    // Absent and wrong are different failures: an omitted grant_type is a malformed request,
    // not a request for a grant this endpoint declines to support, and reporting it as
    // "not supported: undefined" describes neither.
    if (!grantType) {
      throw new OauthApiError(400, 'invalid_request', 'grant_type is required.');
    }
    if (grantType !== 'authorization_code') {
      throw new OauthApiError(400, 'unsupported_grant_type', `The grant type is not supported: ${grantType}`);
    }
    if (!code) {
      throw new OauthApiError(400, 'invalid_request', 'code is required.');
    }

    // The client's credentials, checked before the code the way production's `SSOTokenGuard`
    // (`api/src/auth/guards/sso-token.guard.ts`) runs before the handler. Both are required
    // there; the `client_secret` is an API key of the environment, looked up with
    // `keysService.findActiveByToken`, so here it is a key of the emulator's allow-list — the
    // same keys that authenticate `Authorization: Bearer` — and an unknown or expired one is
    // production's 400 `invalid_client` / "Invalid client secret.", with no event: nothing has
    // been authenticated yet. The `client_id` is only required to be present, as it is on every
    // other endpoint here — the emulator registers no AuthKit clients to check it against.
    const clientId = body.client_id;
    const clientSecret = body.client_secret;
    if (typeof clientId !== 'string' || clientId === '') {
      throw new OauthApiError(400, 'invalid_request', 'client_id is required.');
    }
    if (typeof clientSecret !== 'string' || clientSecret === '') {
      throw new OauthApiError(400, 'invalid_request', 'client_secret is required.');
    }
    // An own-property lookup, because the map is a plain object: `client_secret: "constructor"`
    // would otherwise find Object.prototype's and, having no expiry, pass as a live key.
    const apiKeys = store.getData<ApiKeyMap>(STORE_KEYS.apiKeyMap) ?? {};
    const apiKey = Object.hasOwn(apiKeys, clientSecret) ? apiKeys[clientSecret] : undefined;
    if (!apiKey || isApiKeyEntryExpired(apiKey)) {
      throw new OauthApiError(400, 'invalid_client', 'Invalid client secret.');
    }

    const auth = ws.ssoAuthorizations.findOneBy('code', code);
    if (!auth) {
      const error = new OauthApiError(400, 'invalid_grant', `The code '${code}' has expired or is invalid.`);
      emitAuthenticationEvent({
        eventBus: store.getData<EventBus>(STORE_KEYS.eventBus),
        method: 'SSO',
        status: 'failed',
        error: { code: error.code, message: error.message },
        ipAddress: c.req.header('x-forwarded-for') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
        sso: {
          organization_id: null,
          connection_id: null,
          session_id: null,
        },
      });
      throw error;
    }
    if (isExpired(auth.expires_at)) {
      ws.ssoAuthorizations.delete(auth.id);
      const expiredProfile = ws.ssoProfiles.get(auth.profile_id);
      const error = new OauthApiError(400, 'invalid_grant', `The code '${code}' has expired or is invalid.`);
      emitAuthenticationEvent({
        eventBus: store.getData<EventBus>(STORE_KEYS.eventBus),
        method: 'SSO',
        status: 'failed',
        email: expiredProfile?.email,
        userId: findUserByEmail(ws, expiredProfile?.email ?? '')?.id,
        error: { code: error.code, message: error.message },
        ipAddress: c.req.header('x-forwarded-for') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
        sso: {
          organization_id: auth.organization_id,
          connection_id: expiredProfile?.connection_id ?? null,
          session_id: null,
        },
      });
      throw error;
    }

    // A challenge on the record means /user_management/authorize started this authorization, and
    // the code is AuthKit's to redeem: production's standalone token endpoint takes no
    // `code_verifier`, so a code bound to one cannot be exchanged here at all. Refused without
    // being spent, as /user_management/authenticate refuses a Connect code, so the callback the
    // code was minted for can still redeem it.
    if (auth.code_challenge) {
      const boundProfile = ws.ssoProfiles.get(auth.profile_id);
      const error = new OauthApiError(400, 'invalid_grant', `The code '${code}' has expired or is invalid.`);
      emitAuthenticationEvent({
        eventBus: store.getData<EventBus>(STORE_KEYS.eventBus),
        method: 'SSO',
        status: 'failed',
        email: boundProfile?.email,
        userId: findUserByEmail(ws, boundProfile?.email ?? '')?.id,
        error: { code: error.code, message: error.message },
        ipAddress: c.req.header('x-forwarded-for') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
        sso: {
          organization_id: auth.organization_id,
          connection_id: auth.connection_id,
          session_id: null,
        },
      });
      throw error;
    }

    const profile = ws.ssoProfiles.get(auth.profile_id);
    // The deliberate exception to the OAuth-shaped rule above, and the reason it says every
    // *failure a caller can cause*: a stored authorization pointing at a profile that no longer
    // exists is emulator state gone wrong, not a request anyone can fix by sending something
    // else. RFC 6749 §5.2's code list covers client errors only — it has no entry to render this
    // as — so it stays plain, like every other 500 the emulator returns.
    if (!profile) {
      throw new WorkOSApiError(500, 'Profile not found', 'server_error');
    }

    ws.ssoAuthorizations.delete(auth.id);

    const accessToken = jwt.sign(
      {
        sub: profile.id,
        aud: clientId,
        org_id: auth.organization_id,
      },
      { expiresIn: SSO_TOKEN_TTL_SECONDS },
    );

    store.setData(`${STORE_KEY_PREFIXES.ssoToken}${accessToken}`, profile.id);

    // SSO is profile-based; a user-management user may not exist for this email. Resolved
    // case-insensitively, like every other lookup by email, so the event carries the id of an
    // account stored under a different case rather than reporting none.
    const authenticatedUser = findUserByEmail(ws, profile.email);

    // A completed login through an OAuth connection is what identity linking records, so this is
    // where the identity the users endpoint reports comes from. SAML connections are skipped: the
    // spec's identity `provider` enum is OAuth-only, and "currently only OAuth identities are
    // supported".
    if (authenticatedUser && OAUTH_CONNECTION_TYPES.has(profile.connection_type)) {
      linkOAuthIdentity(ws, authenticatedUser.id, profile.connection_type, profile.idp_id);
    }

    emitAuthenticationEvent({
      eventBus: store.getData<EventBus>(STORE_KEYS.eventBus),
      method: 'SSO',
      status: 'succeeded',
      email: profile.email,
      userId: authenticatedUser?.id ?? null,
      ipAddress: c.req.header('x-forwarded-for') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      sso: {
        organization_id: auth.organization_id ?? profile.organization_id,
        connection_id: profile.connection_id,
        session_id: null,
      },
    });

    return c.json({
      token_type: 'Bearer',
      access_token: accessToken,
      expires_in: SSO_TOKEN_TTL_SECONDS,
      profile: formatSSOProfile(profile),
    });
  });

  app.get('/sso/profile', (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      throw new WorkOSApiError(401, 'Unauthorized', 'unauthorized');
    }
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    // The token is checked before anything is looked up: its signature and its `exp`, which is
    // the `expires_in` /sso/token reported. Resolving a token through the store first and only
    // verifying the ones it did not know would leave an issued token usable after it expired.
    let payload: ReturnType<typeof jwt.verify>;
    try {
      payload = jwt.verify(token);
    } catch {
      throw new WorkOSApiError(401, 'Invalid access token', 'unauthorized');
    }

    const profileId = store.getData<string>(`${STORE_KEY_PREFIXES.ssoToken}${token}`);
    if (!profileId) {
      const profile = ws.ssoProfiles.get(payload.sub);
      if (profile) return c.json(formatSSOProfile(profile));
      throw new WorkOSApiError(401, 'Invalid access token', 'unauthorized');
    }

    const profile = ws.ssoProfiles.get(profileId);
    if (!profile) throw notFound('Profile', profileId);

    return c.json(formatSSOProfile(profile));
  });

  // The environment's JWKS. The spec only documents the per-client path, which is what the
  // SDKs fetch (`/sso/jwks/{clientId}`) when verifying a session or M2M access token — a
  // bare `/sso/jwks` does not match it in Hono, so both are registered. Every token the
  // emulator issues is signed with the one key, so the client is not used to select a key.
  const jwks = (c: Context) => c.json(jwt.getJWKS());
  app.get('/sso/jwks', jwks);
  app.get('/sso/jwks/:clientId', jwks);

  /**
   * OIDC discovery, which production serves per AuthKit client at
   * `/user_management/{client_id}/.well-known/openid-configuration`. Unauthenticated, as it is
   * upstream: a client fetches it before it holds anything.
   *
   * These five fields are the whole document production returns — `openidConfiguration` in
   * `api/src/userland-sessions/userland-sso.controller.ts`. Notably absent are
   * `subject_types_supported` and `id_token_signing_alg_values_supported`, which OIDC Discovery
   * 1.0 §3 marks REQUIRED. Their absence is fidelity, not oversight: adding them here would
   * make a client that needs them pass against the emulator and fail against WorkOS, which is
   * the one outcome an emulator must never produce.
   *
   * Endpoints are built from the requested origin rather than the configured base URL, because a
   * document is only useful to whoever fetched it. Reached over host.docker.internal or a LAN
   * address — both ordinary for the container image — a base-URL document would advertise
   * localhost, which is precisely the host that caller cannot reach. Production has no such
   * problem to solve: it builds them from a configured `API_URL`, the only name it answers on.
   *
   * `issuer` is the exception, and comes from `jwt.authKitIssuer` rather than the origin, because
   * it has to equal the `iss` the emulator mints — a client fetches this document precisely to
   * validate one against the other.
   *
   * A client id that could not be one is refused the way production refuses an unknown one,
   * verified against `api.workos.com`:
   * `{"message":"Application not found: '…'","code":"entity_not_found","entity_id":"…"}`.
   * Registered clients still cannot be told apart — no route under `/user_management` or `/sso`
   * consults the `connectApplications` registry, so an AuthKit client is never in it — so this
   * checks the one thing that needs no registry: that the id is shaped like a client id at all.
   * Serving anything else would reflect it straight back out as a `jwks_uri`.
   *
   * Deliberately no narrower than that. Production ids are ULIDs, but the emulator lets you pin
   * a readable one — `client_local_backend`, the README's own example — and `authorize`,
   * `authenticate` and
   * `/sso/jwks` all take any id and mint `iss` from it. A shape stricter than theirs would 404
   * the discovery document at the very issuer the emulator puts in its own tokens.
   */
  const CLIENT_ID_SHAPE = /^client_[A-Za-z0-9_-]+$/;

  app.get('/user_management/:clientId/.well-known/openid-configuration', (c) => {
    const clientId = c.req.param('clientId');
    if (!CLIENT_ID_SHAPE.test(clientId)) {
      return c.json(
        {
          message: `Application not found: '${clientId}'.`,
          code: 'entity_not_found',
          entity_id: clientId,
        },
        404,
      );
    }

    const origin = new URL(c.req.url).origin;
    return c.json({
      issuer: jwt.authKitIssuer(clientId),
      authorization_endpoint: `${origin}/user_management/authorize`,
      token_endpoint: `${origin}/user_management/authenticate`,
      response_types_supported: ['code'],
      jwks_uri: `${origin}/sso/jwks/${clientId}`,
    });
  });

  // SSO Single Logout — generate logout token
  app.post('/sso/logout/authorize', async (c) => {
    const body = await parseJsonBody(c);
    const profileId = body.profile_id as string;
    if (!profileId) {
      throw new WorkOSApiError(400, 'profile_id is required', 'invalid_request');
    }

    const profile = ws.ssoProfiles.get(profileId);
    // Production throws a bare `new NotFoundException()` here (api sso.controller.ts,
    // logout/authorize): the body is `{message: 'Not Found'}` and nothing else.
    if (!profile) throw new NestNotFoundError();

    const logoutToken = generateId('sso_logout');
    store.setData(`${STORE_KEY_PREFIXES.ssoLogout}${logoutToken}`, profile.id);

    return c.json({
      logout_token: logoutToken,
      logout_url: `${ctx.baseUrl}/sso/logout?token=${logoutToken}`,
    });
  });

  // SSO Single Logout — redirect (public, no auth)
  app.get('/sso/logout', (c) => {
    const url = new URL(c.req.url);
    // The redirect endpoint reads the token from `token`; only the Logout Authorize
    // response body names it `logout_token`.
    const logoutToken = url.searchParams.get('token');

    if (!logoutToken) {
      throw new WorkOSApiError(400, 'token is required', 'invalid_request');
    }

    const profileId = store.getData<string>(`${STORE_KEY_PREFIXES.ssoLogout}${logoutToken}`);
    if (!profileId) {
      throw new WorkOSApiError(400, 'Invalid logout token', 'invalid_logout_token');
    }

    store.setData(`${STORE_KEY_PREFIXES.ssoLogout}${logoutToken}`, undefined);
    return c.json({ success: true });
  });
}
