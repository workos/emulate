import type { Context } from 'hono';
import { type RouteContext, OauthApiError, WorkOSApiError, generateId, generateUlid } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  activeOrganizationsFor,
  assertAllowedRedirectUri,
  emitAuthenticationEvent,
  expiresIn,
  isExpired,
  startLoginSession,
} from '../helpers.js';
import {
  allowedScopes,
  findRegisteredResource,
  formatScope,
  grantableScopes,
  isPublicClient,
  isValidResourceUri,
  parseScopeParam,
  pkceMatches,
  resolveAudience,
  resolveAuthorizeResource,
  resourceUrisEqual,
  shouldIssueRefreshToken,
} from '../authkit-oauth.js';
import { createConnectAuthorizeRequest } from '../connect-authorize-request.js';
import { STORE_KEYS } from '../constants.js';
import { renderOAuthErrorPage } from '../login-page.js';
import type { EventBus } from '../event-bus.js';
import type { WorkOSConnectApplication, WorkOSSession, WorkOSUser } from '../entities.js';

/**
 * Connect token exchange (OAuth 2.0 `client_credentials` and `authorization_code`).
 *
 * This endpoint is deliberately hand-authored: it is absent from the WorkOS OpenAPI
 * spec at every version (the spec's `/sso/token` only documents `authorization_code`),
 * so it cannot be generated. It mirrors how `/user_management/authenticate` already
 * implements grant types beyond what the spec describes — runtime OAuth behavior, not
 * a spec-described resource.
 *
 * A service exchanges its seeded `client_id` + `client_secret` (a Connect Application
 * of type `m2m`, see the `connectApplications` seed block) for a signed JWT. The token
 * is signed with the same key the emulator exposes at `/sso/jwks/:client_id` and
 * `/oauth2/jwks`, so a consumer validating with JWKS (e.g. `jose`, checking `iss`/`aud`)
 * verifies it without any emulator-specific shims.
 *
 * The claim set mirrors a production M2M token exactly, because the SDKs parse it:
 * granted scopes ride in a space-delimited `scope` string (RFC 8693 §4.2 — the Node
 * SDK reads `payload.scope`), and every token carries a `jti`, without which the SDKs'
 * M2M claim guard rejects an otherwise-valid token. Neither is emulator-flavored: a
 * scopes *array*, or an omitted `jti`, would pass locally and fail in production.
 *
 * Failures throw `OauthApiError`, the same RFC 6749 §5.2 renderer `/sso/token` and the
 * OAuth-shaped authenticate grants use. Production's token endpoint renders a description only
 * where it gives one: client-authentication and scope failures carry one, while every code and
 * refresh-token failure is the bare `{"error": "invalid_grant"}` (the strings its handlers attach
 * to those are log messages, not `error_description`), which is what this endpoint answers too.
 *
 * The same endpoints are the AuthKit domain's OAuth 2.1 authorization server for MCP clients:
 * an application with no `login_url` signs its users in on AuthKit's hosted page (the one
 * `/user_management/authorize` serves), a public client proves itself by PKCE alone, and the
 * token response carries a rotating refresh token. `iss` on those tokens is the bare AuthKit
 * domain rather than the per-client `/user_management/{client_id}` issuer that
 * `/user_management/authenticate` tokens carry (a requirement taken from an observed production
 * AuthKit domain's Connect tokens).
 *
 * Client authentication is production's two token-endpoint guards (`ApplicationCredentialsGuard`
 * and `ApplicationCredentialsOrPublicClientGuard`, with `parseAuthorization` reading the
 * credentials): the body's `client_id` wins outright when present, else the Basic header is
 * decoded; a client is only ever public or confidential, whatever `token_endpoint_auth_method` it
 * registered; and the failures are `401 invalid_client` with `WWW-Authenticate: Basic
 * realm="AuthKit"` and the guards' own descriptions. The guards run before the body is validated,
 * so an unknown client is refused the same way whatever grant it names.
 */

const TOKEN_TTL_SECONDS = 3600;

/** The grant types this endpoint serves. Production also serves device_code and jwt-bearer, which the emulator does not. */
const SUPPORTED_GRANT_TYPES = ['authorization_code', 'client_credentials', 'refresh_token'];

interface TokenParams {
  grantType?: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  code?: string;
  redirectUri?: string;
  codeVerifier?: string;
  refreshToken?: string;
  /** RFC 8707 `resource`. Only the first is read; a repeated parameter is not supported. */
  resource?: string;
}

const invalidClient = (description: string) =>
  new OauthApiError(401, 'invalid_client', description, { 'WWW-Authenticate': 'Basic realm="AuthKit"' });

/**
 * Read the grant params and the client credentials from the request. Supports both the
 * form-encoded body services typically send and a JSON body.
 *
 * Credentials are read the way production's `parseAuthorization` reads them: when the body
 * carries a `client_id`, the body is the whole story (a `client_secret` is read from it or not at
 * all, and the Authorization header is never consulted); otherwise the Basic header is required,
 * decoded as base64 and split on the first `:` with no further decoding, and an empty client id
 * there is its own failure.
 */
async function readTokenParams(c: Context): Promise<TokenParams> {
  const contentType = c.req.header('content-type') ?? '';

  let raw: Record<string, unknown> = {};
  if (contentType.includes('application/json')) {
    try {
      const body = await c.req.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) raw = body as Record<string, unknown>;
    } catch {
      // fall through to empty params; the missing grant_type yields a clear error below
    }
  } else {
    const form = await c.req.parseBody();
    raw = form as Record<string, unknown>;
  }

  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  let clientId: string;
  let clientSecret: string | undefined;
  if (typeof raw.client_id === 'string') {
    clientId = raw.client_id;
    clientSecret = str(raw.client_secret);
  } else {
    const authHeader = c.req.header('authorization');
    if (!authHeader) throw invalidClient('Missing authorization header.');
    const decoded = Buffer.from(authHeader.match(/basic (.*)/i)?.[1] ?? '', 'base64').toString('utf-8');
    const [id, secret] = decoded.split(':');
    if (!id) throw invalidClient('Missing client_id.');
    clientId = id;
    clientSecret = secret;
  }

  return {
    grantType: str(raw.grant_type),
    clientId,
    clientSecret,
    scope: str(raw.scope),
    code: str(raw.code),
    redirectUri: str(raw.redirect_uri),
    codeVerifier: str(raw.code_verifier),
    refreshToken: str(raw.refresh_token),
    resource: str(raw.resource),
  };
}

export function oauthRoutes(ctx: RouteContext): void {
  const { app, store, jwt } = ctx;
  const ws = getWorkOSStore(store);

  /**
   * An authorize failure on the client's callback, RFC 6749 §4.1.2.1: `error`, `error_description`
   * only when production gives one, and the caller's `state` echoed back. Used once the callback
   * is trusted; before that point the failure goes to the AuthKit domain's own error page.
   */
  const redirectError = (
    c: Context,
    redirectUri: string,
    state: string | undefined,
    error: string,
    description?: string,
  ) => {
    const redirect = new URL(redirectUri);
    redirect.searchParams.set('error', error);
    if (description) redirect.searchParams.set('error_description', description);
    if (state !== undefined) redirect.searchParams.set('state', state);
    return c.redirect(redirect.toString(), 302);
  };

  /**
   * An authorize failure production shows on the AuthKit domain's `/oauth2/error` page, because
   * the `client_id` or `redirect_uri` has not been validated and there is nowhere safe to send the
   * browser. Built from baseUrl, like every other link the emulator mints.
   */
  const errorPage = (c: Context, error: string) => c.redirect(`${ctx.baseUrl}/oauth2/error?error=${error}`, 302);

  // The OAuth browser entry point. Standalone Connect (an application with a `login_url`) and the
  // AuthKit-domain authorization server share it, and the application decides which one runs.
  // Like /oauth2/token, this route is hand-authored because the public spec only describes the
  // server-side completion of the first and none of the second.
  //
  // Failures follow production's authorize handler, which never answers with an API error body.
  // Until the client and its callback are known they go to the error page: a query missing either
  // parameter is `invalid_query_params`, an unknown client `application_not_found`, and a callback
  // the client did not register `invalid_redirect_uri`. From then on they go to the callback.
  app.get('/oauth2/authorize', (c) => {
    const { client_id: clientId, redirect_uri: redirectUri, response_type: responseType, state } = c.req.query();
    if (clientId === undefined || redirectUri === undefined) return errorPage(c, 'invalid_query_params');
    const application = ws.connectApplications.findOneBy('client_id', clientId);
    if (!application) return errorPage(c, 'application_not_found');
    // Registered callbacks are matched exactly; a seeded application that registered none accepts
    // any callback the redirect-host policy allows. Either way a refused callback is the error
    // page's `invalid_redirect_uri`, as production's redirect URI locator answers.
    if (application.redirect_uris.length > 0 && !application.redirect_uris.includes(redirectUri)) {
      return errorPage(c, 'invalid_redirect_uri');
    }
    try {
      assertAllowedRedirectUri(redirectUri, store);
    } catch (error) {
      if (error instanceof WorkOSApiError) return errorPage(c, 'invalid_redirect_uri');
      throw error;
    }

    const fail = (error: string, description?: string) => redirectError(c, redirectUri, state, error, description);

    // Production parses the full query once the callback is trusted: a `response_type` other than
    // `code` is unsupported_response_type, and any other shape failure (no response_type, or a
    // code_challenge_method it does not know) is invalid_request, neither with a description.
    if (responseType !== undefined && responseType !== 'code') return fail('unsupported_response_type');
    const codeChallenge = c.req.query('code_challenge');
    const codeChallengeMethod = c.req.query('code_challenge_method');
    if (responseType === undefined || (codeChallengeMethod !== undefined && codeChallengeMethod !== 'S256')) {
      return fail('invalid_request');
    }
    if (application.application_type !== 'oauth') {
      return fail(
        'unauthorized_client',
        'The client is not authorized to request an authorization code using this method',
      );
    }

    if (application.login_url) {
      assertAllowedRedirectUri(application.login_url, store);
      const login = new URL(application.login_url);
      const session = ws.externalAuthSessions.insert({
        client_id: clientId,
        redirect_uri: redirectUri,
        state: state ?? null,
        expires_at: expiresIn(10),
        completed_at: null,
        redeemed_at: null,
        user_id: null,
      });
      login.searchParams.set('external_auth_id', session.id);
      return c.redirect(login.toString(), 302);
    }

    // No login_url: the user signs in on AuthKit's hosted page. Validate everything a client could
    // get wrong now, while a redirect_uri exists to report it on, then park the request and send
    // the browser to the sign-in page `/user_management/authorize` serves, which finishes it.

    // PKCE (RFC 7636), as production's authorize handler takes it: a challenge must name its
    // method (S256 is the only one it knows, so a method without a challenge is simply ignored),
    // and nothing else is checked here. Whether a public client sent one at all is the token
    // endpoint's question, where the verifier is checked.
    if (codeChallenge !== undefined && codeChallengeMethod === undefined) {
      return fail('invalid_request', 'code_challenge_method is required when code_challenge is provided.');
    }

    // Scopes, as production's scope parser takes them: the standard set is open to every OAuth
    // application and a custom scope must be one of the application's own; anything else is
    // invalid_scope, with no description. An omitted `scope` grants nothing, rather than
    // everything the application could have been asked for.
    const scopes = parseScopeParam(c.req.query('scope'));
    const allowed = allowedScopes(application);
    if (scopes.some((s) => !allowed.includes(s))) return fail('invalid_scope');

    // RFC 8707. Validated against the environment's registered resources, and defaulted, the way
    // production does it; see resolveAuthorizeResource. What is stored is what the grant is bound
    // to, and what its tokens carry as `aud`.
    const resource = resolveAuthorizeResource(ws, application, c.req.query('resource') ?? null);
    if (!resource.ok) return fail('invalid_target', resource.description);

    const requestId = createConnectAuthorizeRequest(store, {
      client_id: clientId,
      redirect_uri: redirectUri,
      state: state ?? null,
      code_challenge: codeChallenge ?? null,
      code_challenge_method: codeChallenge === undefined ? null : 'S256',
      scope: scopes,
      resource: resource.resource,
      nonce: c.req.query('nonce') ?? null,
    });

    const signIn = new URL(`${ctx.baseUrl}/user_management/authorize`);
    signIn.searchParams.set('connect_request', requestId);
    // The two hints the sign-in page understands; neither widens what the request was validated for.
    for (const hint of ['login_hint', 'organization_id']) {
      const value = c.req.query(hint);
      if (value) signIn.searchParams.set(hint, value);
    }
    return c.redirect(signIn.toString(), 302);
  });

  // Where /oauth2/authorize sends a browser it cannot serve: 200 text/html, reflecting the
  // `error_description` it is given (observed against a production AuthKit domain, 2026-09-30).
  // Reflected text is escaped by the page renderer.
  app.get('/oauth2/error', (c) =>
    c.html(
      renderOAuthErrorPage({
        error: c.req.query('error') ?? 'invalid_request',
        description: c.req.query('error_description'),
      }),
    ),
  );

  /** A session for a user who has just signed in through the hosted page, as a fresh authenticate grant creates one. */
  const startSession = (
    c: Context,
    user: WorkOSUser,
    organizationId: string | null,
    authCode: { auth_method: string | null; step_up_method: string | null },
  ) => {
    // What the interactive gates left on the code decides the method, as in the authenticate
    // grant: the gate's method for the event, the primary method for the session it records.
    const authMethod = authCode.step_up_method ?? authCode.auth_method ?? 'OAuth';
    const sessionAuthMethod = authCode.step_up_method && authCode.auth_method ? authCode.auth_method : authMethod;
    const ipAddress = c.req.header('x-forwarded-for') ?? null;
    const userAgent = c.req.header('user-agent') ?? null;
    const session = startLoginSession(ws, {
      user,
      organizationId,
      ipAddress,
      userAgent,
      authMethod: sessionAuthMethod,
    });
    emitAuthenticationEvent({
      eventBus: store.getData<EventBus>(STORE_KEYS.eventBus),
      method: authMethod,
      status: 'succeeded',
      userId: user.id,
      email: user.email,
      ipAddress,
      userAgent,
    });
    return session;
  };

  /** The earlier of two ISO timestamps. */
  const cappedAt = (a: string, b: string) => (a < b ? a : b);

  /** OIDC `auth_time`: when the user authenticated interactively, which for a hosted sign-in is when its session began. */
  const authTime = (session: WorkOSSession) => Math.floor(new Date(session.created_at).getTime() / 1000);

  /**
   * The Connect access token for a user signed in through the hosted page, with the claims
   * production's consent token service mints: `iss` the bare AuthKit domain, `aud` the bound
   * resource (see resolveAudience for the fallback), `sub`, `sid`, `jti`, `client_id`, `org_id`
   * when the session has one, `auth_time`, and a sorted `scope` that is absent rather than empty.
   * Production can add the environment's JWT template claims on top; the emulator does not.
   */
  const mintAccessToken = (
    application: WorkOSConnectApplication,
    session: WorkOSSession,
    scope: readonly string[],
    resource: string | null,
  ): string =>
    jwt.sign(
      {
        sub: session.user_id,
        sid: session.id,
        jti: generateUlid(),
        org_id: session.organization_id ?? undefined,
        client_id: application.client_id,
        auth_time: authTime(session),
        scope: formatScope(scope),
        aud: resolveAudience(application, resource),
      },
      { expiresIn: TOKEN_TTL_SECONDS },
    );

  /**
   * A refresh token on the session. It carries the grant as consented (its scopes and the resource
   * it was bound to at authorize), not what one token request narrowed it to, because production's
   * refresh token points at the consent and a narrowing never alters the consent.
   */
  const mintRefreshToken = (
    application: WorkOSConnectApplication,
    session: WorkOSSession,
    grant: { scope: string[]; resource: string | null },
  ): string =>
    ws.refreshTokens.insert({
      token: generateId('ref'),
      user_id: session.user_id,
      organization_id: session.organization_id,
      session_id: session.id,
      // Never outlives the session it belongs to, so rotation cannot extend a sign-in.
      expires_at: cappedAt(expiresIn(30 * 24 * 60), session.expires_at),
      client_id: application.client_id,
      connect: { scope: grant.scope, resource: grant.resource },
      exchanged_at: null,
      exchanged_for_id: null,
    }).token;

  /**
   * The `id_token` production mints with every code exchange and every refresh, whatever the scope
   * (its token service mints one unconditionally; only the claims inside follow the scopes). RS256
   * under the key at `/oauth2/jwks`; `iss` is the bare issuer and `aud` the client_id. The claims
   * are production's: with `profile`, `name` composed from the user's first and last names (so an
   * empty string when there are none) and `given_name`/`family_name` where each exists; with
   * `email`, `email` and `email_verified`; and `nonce` when the authorize request carried one,
   * which a refresh never does.
   */
  const issueIdToken = (
    application: WorkOSConnectApplication,
    user: WorkOSUser,
    scope: readonly string[],
    nonce: string | null,
  ): string => {
    const claims: Record<string, unknown> = {};
    if (scope.includes('profile')) {
      const given = user.first_name ?? undefined;
      const family = user.last_name ?? undefined;
      claims.name = [given, family].filter(Boolean).join(' ');
      if (given) claims.given_name = given;
      if (family) claims.family_name = family;
    }
    if (scope.includes('email')) {
      claims.email = user.email;
      claims.email_verified = user.email_verified;
    }
    if (nonce) claims.nonce = nonce;
    return jwt.sign({ sub: user.id, aud: application.client_id }, { expiresIn: TOKEN_TTL_SECONDS, claims });
  };

  /**
   * RFC 6749 §3.3 narrowing on the `client_credentials` grant: a request may ask for a subset of
   * the application's scopes, and naming one it does not have is invalid_scope with production's
   * description.
   */
  const narrowM2mScope = (application: WorkOSConnectApplication, requested: string | undefined): string[] => {
    const available = Array.isArray(application.scopes) ? application.scopes : [];
    const scopes = parseScopeParam(requested);
    if (scopes.length === 0) return available;
    const unknown = scopes.filter((s) => !available.includes(s));
    if (unknown.length > 0) throw invalidScope(unknown);
    return scopes;
  };

  const invalidScope = (scopes: readonly string[]) =>
    new OauthApiError(
      400,
      'invalid_scope',
      `The following scopes are invalid, unknown, or not granted to this application: ${scopes.map((s) => `'${s}'`).join(', ')}.`,
    );

  /**
   * RFC 8707 `resource` on the token request, resolved as production's resource locator does it
   * (`forRequestedResource`). A grant bound to a resource stays bound to it: the request may
   * restate or omit it, anything else is `invalid_target`, and so is a bound resource that has since
   * been deleted. A grant bound to none may name a registered resource here and have the token
   * minted for it; an unregistered or malformed one is `invalid_target`, unless the environment has
   * registered no resources at all, in which case the parameter is ignored for backwards
   * compatibility. Production's `invalid_target` carries no description.
   */
  const bindResource = (bound: string | null, requested: string | undefined): string | null => {
    const invalidTarget = () => new OauthApiError(400, 'invalid_target');
    if (bound !== null) {
      const registered = findRegisteredResource(ws, bound);
      if (!registered) throw invalidTarget();
      if (requested === undefined) return registered.uri;
      if (!isValidResourceUri(requested) || !resourceUrisEqual(requested, registered.uri)) throw invalidTarget();
      return registered.uri;
    }
    if (requested === undefined || ws.authkitOauthResources.all().length === 0) return null;
    if (!isValidResourceUri(requested)) throw invalidTarget();
    const match = findRegisteredResource(ws, requested);
    if (!match) throw invalidTarget();
    return match.uri;
  };

  app.post('/oauth2/token', async (c) => {
    const { grantType, clientId, clientSecret, scope, code, redirectUri, codeVerifier, refreshToken, resource } =
      await readTokenParams(c);

    // Client authentication first, the body second, as production's guards run before its body
    // validation: an unknown client is refused the same way whatever grant it names.
    const application = ws.connectApplications.findOneBy('client_id', clientId);
    if (!application) throw invalidClient('Application not found.');

    // With a secret, the client_id/secret pair must exist (production looks the application up by
    // both, so a wrong secret reads as no application) and the client must be confidential: an
    // admin-added secret does not turn a public registration into one. Without a secret, the
    // client must be public, and a public client, which proves itself by PKCE, may use only the
    // grants a user sign-in produces.
    let matchedSecret: { id: string } | undefined;
    if (clientSecret) {
      matchedSecret = ws.clientSecrets.findBy('application_id', application.id).find((s) => s.value === clientSecret);
      if (!matchedSecret) throw invalidClient('Application not found.');
      if (isPublicClient(application)) throw invalidClient('Unsupported client_secret.');
    } else {
      if (!isPublicClient(application)) throw invalidClient('Missing client_secret.');
      if (grantType === 'client_credentials') {
        throw new OauthApiError(
          400,
          'unauthorized_client',
          'Public clients are not authorized to use this grant type.',
        );
      }
    }

    // Production's body validation: a grant type it knows but this surface does not serve, or one
    // nobody knows, is unsupported_grant_type; a body missing the grant type or the grant's own
    // required fields is invalid_request.
    const invalidBody = () => new OauthApiError(400, 'invalid_request', 'Invalid token request body.');
    if (grantType !== undefined && !SUPPORTED_GRANT_TYPES.includes(grantType)) {
      throw new OauthApiError(400, 'unsupported_grant_type', `Unsupported grant_type: '${grantType}'.`);
    }
    if (grantType === undefined) throw invalidBody();

    let response: Record<string, unknown>;

    if (grantType === 'refresh_token') {
      if (!refreshToken) throw invalidBody();
      // Every refresh failure is production's bare invalid_grant, except a token this endpoint did
      // not issue: an AuthKit session's refresh token is an `unauthorized_client` pointed at the
      // endpoint that did.
      const invalidGrant = () => new OauthApiError(400, 'invalid_grant');
      const stored = ws.refreshTokens.findOneBy('token', refreshToken);
      if (!stored) throw invalidGrant();
      if (!stored.connect) {
        throw new OauthApiError(
          400,
          'unauthorized_client',
          `This refresh token should be exchanged at ${ctx.baseUrl}/user_management/authenticate`,
        );
      }
      // Bound to the client it was issued to, so one application cannot redeem another's.
      if (stored.client_id !== clientId) throw invalidGrant();
      if (isExpired(stored.expires_at)) {
        ws.refreshTokens.delete(stored.id);
        throw invalidGrant();
      }
      // Unlike authenticate, a revoked session ends its refresh tokens too: signing a person out
      // of an MCP client has to stop that client minting tokens for them.
      const session = ws.sessions.get(stored.session_id);
      const user = ws.users.get(stored.user_id);
      if (!user || !session || session.status !== 'active' || isExpired(session.expires_at)) throw invalidGrant();
      // The organization the token was scoped to must still be one the user belongs to. Minting
      // with the stale `org_id` would hand a removed member access to a tenant they have left.
      if (
        stored.organization_id &&
        !activeOrganizationsFor(ws, stored.user_id).some((o) => o.id === stored.organization_id)
      ) {
        throw invalidGrant();
      }

      // Validated before the token is spent, so a bad `scope` or `resource` costs nothing. The
      // scope is production's RFC 6749 §6 narrowing: the consent's scopes that still exist,
      // filtered to the ones requested, and invalid_scope only when that leaves nothing. The
      // narrowing is for this token alone; the grant itself is unchanged.
      const granted = grantableScopes(application, stored.connect.scope);
      const requested = parseScopeParam(scope);
      const issued = requested.length > 0 ? granted.filter((s) => requested.includes(s)) : granted;
      if (requested.length > 0 && issued.length === 0) throw invalidScope(requested);
      const bound = bindResource(stored.connect.resource, resource);

      // OAuth 2.1 §6.1 as production applies it: a public client's refresh token is rotated, the
      // presented one spent for a fresh one on the same session; a confidential client keeps the
      // token it presented.
      let refreshTokenOut = stored.token;
      if (isPublicClient(application)) {
        ws.refreshTokens.delete(stored.id);
        refreshTokenOut = mintRefreshToken(application, session, stored.connect);
      }
      response = {
        access_token: mintAccessToken(application, session, issued, bound),
        expires_in: TOKEN_TTL_SECONDS,
        id_token: issueIdToken(application, user, granted, null),
        refresh_token: refreshTokenOut,
        scope: formatScope(issued),
        token_type: 'bearer',
      };
    } else if (grantType === 'authorization_code') {
      if (!code || !redirectUri) throw invalidBody();
      // Production's authorization-code grant is enabled only for OAuth applications; an M2M
      // application asking for it is refused as a client, without the Basic challenge.
      if (application.application_type !== 'oauth') throw new OauthApiError(401, 'invalid_client');

      // Every failure of the code itself is production's bare invalid_grant, and none of them
      // spends the code: the verifier is checked before the code is exchanged, so a wrong one
      // leaves the code for a retry.
      const invalidGrant = () => new OauthApiError(400, 'invalid_grant');

      // Bind the code to this flow and client before anything else. Codes from Standalone Connect
      // (external_auth) and from the hosted sign-in (connect) are redeemable here; an AuthKit code
      // from /user_management/authorize is /authenticate's, not this endpoint's.
      const authCode = ws.authCodes.findOneBy('code', code);
      if (
        !authCode ||
        (authCode.auth_method !== 'external_auth' && !authCode.connect) ||
        authCode.client_id !== clientId
      ) {
        throw invalidGrant();
      }

      if (!authCode.connect && !matchedSecret) {
        // Standalone Connect has no PKCE: the secret is the whole client authentication there.
        throw new OauthApiError(400, 'invalid_request', 'client_id and client_secret are required.');
      }

      if (authCode.connect) {
        // PKCE (RFC 7636 §4.6), as production's `verifyApplication` runs it before the exchange: a
        // code that carries a challenge is redeemed only with its verifier, whoever the client is;
        // a code without one is fine for a client that authenticated with a secret, and the end
        // of the road for a public client, whose verifier would have been its whole proof.
        if (authCode.code_challenge) {
          if (!pkceMatches(codeVerifier, authCode.code_challenge)) throw invalidGrant();
        } else if (!matchedSecret) {
          throw invalidGrant();
        }
      }

      if (isExpired(authCode.expires_at) || authCode.redirect_uri !== redirectUri || !ws.users.get(authCode.user_id)) {
        throw invalidGrant();
      }

      if (authCode.connect) {
        // What the grant still covers: production's authorization-code request carries no `scope`,
        // so there is no narrowing here, only the consent's scopes that still exist.
        const granted = grantableScopes(application, authCode.connect.scope);
        const bound = bindResource(authCode.connect.resource, resource);
        const user = ws.users.get(authCode.user_id)!;

        // Same organization rule as the authenticate grant: the code's own organization when the
        // sign-in chose one and the membership still stands, else the user's only one. A user in
        // several who chose none gets an unscoped token — there is no page to ask on this hop.
        let organizationId = authCode.organization_id;
        const organizations = activeOrganizationsFor(ws, user.id);
        if (organizationId && !organizations.some((o) => o.id === organizationId)) throw invalidGrant();
        if (!organizationId && organizations.length === 1) organizationId = organizations[0].id;

        ws.authCodes.delete(authCode.id);
        const session = startSession(c, user, organizationId, authCode);
        // The field set production's authorization_code grant answers with: no `scope`, an
        // `id_token` whatever was granted, and a refresh token only by the rule in
        // shouldIssueRefreshToken, judged on the scopes the grant was authorized for.
        response = {
          access_token: mintAccessToken(application, session, granted, bound),
          expires_in: TOKEN_TTL_SECONDS,
          id_token: issueIdToken(application, user, granted, authCode.connect.nonce ?? null),
          token_type: 'bearer',
        };
        if (shouldIssueRefreshToken(application, authCode.connect.scope)) {
          response.refresh_token = mintRefreshToken(application, session, authCode.connect);
        }
      } else {
        // Minimal Standalone Connect exchange: no refresh token, id_token, or PKCE.
        const granted = narrowM2mScope(application, scope);
        response = {
          access_token: jwt.sign(
            {
              sub: authCode.user_id,
              aud: application.audience ?? application.client_id,
              jti: generateUlid(),
              org_id: application.organization_id ?? undefined,
              scope: granted.join(' '),
            },
            { expiresIn: TOKEN_TTL_SECONDS },
          ),
          token_type: 'bearer',
          expires_in: TOKEN_TTL_SECONDS,
          scope: granted.join(' '),
        };
        ws.authCodes.delete(authCode.id);
      }
    } else {
      // Production's client_credentials grant is enabled only for M2M applications; an OAuth
      // application asking for it is refused as a client, without the Basic challenge.
      if (application.application_type !== 'm2m') throw new OauthApiError(401, 'invalid_client');

      // Grant the requested scopes, defaulting to all of the application's scopes. A
      // request may narrow to a subset (space-delimited, per RFC 6749 §3.3); requesting
      // a scope the application does not have is rejected so authz logic can be tested.
      // Guard against a malformed (non-array) stored scopes value so a request never
      // substring-matches a scope string or hits a .join on a non-array.
      const granted = narrowM2mScope(application, scope);
      const scopeClaim = formatScope(granted);

      // Both the audience and tenant come from the stored application, never the caller,
      // so a client can't mint a token for an arbitrary aud or an org it isn't tied to.
      // aud defaults to the client_id; pin `audience` on the app to match production.
      // Production's client_credentials grant leaves `scope` off the response when none was issued.
      response = {
        access_token: jwt.sign(
          {
            sub: application.client_id,
            aud: application.audience ?? application.client_id,
            jti: generateUlid(),
            org_id: application.organization_id ?? undefined,
            scope: scopeClaim,
          },
          { expiresIn: TOKEN_TTL_SECONDS },
        ),
        expires_in: TOKEN_TTL_SECONDS,
        token_type: 'bearer',
        ...(scopeClaim !== undefined ? { scope: scopeClaim } : {}),
      };
    }

    // Stamped only once the exchange has actually produced a token — a secret presented on a
    // request that then fails on grant type, code or scope was never used to get one. Silent,
    // because presenting a secret is not an edit to it, so `updated_at` stays put.
    if (matchedSecret) ws.clientSecrets.updateSilent(matchedSecret.id, { last_used_at: new Date().toISOString() });

    // RFC 6749 §5.1: a response carrying tokens is not to be cached.
    return c.json(response, 200, { 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  });

  // The M2M authorization server's JWKS. Same signing key as /sso/jwks/:client_id, so a
  // service pointed at the authoritative server's well-known JWKS validates M2M tokens.
  app.get('/oauth2/jwks', (c) => c.json(jwt.getJWKS()));
}
