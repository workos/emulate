import type { Context } from 'hono';
import {
  type RouteContext,
  OauthApiError,
  NestNotFoundError,
  WorkOSApiError,
  parseJsonBody,
  parseListParams,
  validationError,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  assertAllowedRedirectUri,
  formatAuthkitOauthResource,
  formatListResponse,
  generateClientId,
  generateVerificationToken,
} from '../helpers.js';
import {
  AUTHKIT_APPLICATION_TYPES,
  AUTHKIT_CODE_CHALLENGE_METHODS,
  AUTHKIT_OAUTH_SCOPES,
  AUTHKIT_TOKEN_ENDPOINT_AUTH_METHODS,
  findRegisteredResource,
  isStandardScope,
  isValidResourceUri,
} from '../authkit-oauth.js';

/**
 * The AuthKit domain as an OAuth 2.1 authorization server, for MCP clients: discovery, dynamic
 * client registration (RFC 7591) and the environment's resource indicators (RFC 8707). The
 * authorize and token endpoints they lead to are in `oauth.ts`.
 *
 * Hand-authored except for the resource-indicator routes: the spec describes those under
 * `/user_management/authkit_oauth_resources`, and nothing else here, because the rest is the
 * AuthKit domain's own OAuth surface rather than the API.
 */

const REGISTRATION_GRANT_TYPES = ['authorization_code', 'refresh_token'];

export function authkitOauthRoutes(ctx: RouteContext): void {
  const { app, store, jwt } = ctx;
  const ws = getWorkOSStore(store);

  /**
   * The two discovery documents a production AuthKit domain serves at its root, unauthenticated.
   * They mirror production's field sets, minus what the emulator does not implement: a device
   * authorization endpoint, token introspection, the OIDC userinfo endpoint and Client ID
   * Metadata Documents are all advertised by production and all omitted here. Advertising an
   * endpoint that answers 404 would make a client that trusts discovery fail somewhere less obvious
   * than a missing key, so an absent field is the honest answer until the endpoint exists.
   *
   * Built the way the per-client OIDC document in `sso.ts` is, and for the same reasons: endpoint
   * URLs come from the origin the caller reached the emulator on (over host.docker.internal or a
   * LAN address a base-URL document would advertise a host that caller cannot reach), while
   * `issuer` is the configured bare issuer, because it has to equal the `iss` the emulator mints.
   * That is the whole point of the pair: a client compares the two.
   *
   * There is deliberately no path-inserted form (RFC 8414 §3, `/.well-known/…/{path}`). It serves
   * an issuer that has a path component, and this issuer, like production's, has none.
   */
  const discoveryBase = (origin: string) => ({
    issuer: jwt.issuer,
    authorization_endpoint: `${origin}/oauth2/authorize`,
    jwks_uri: `${origin}/oauth2/jwks`,
    response_types_supported: ['code'],
    scopes_supported: [...AUTHKIT_OAUTH_SCOPES],
    token_endpoint: `${origin}/oauth2/token`,
  });

  app.get('/.well-known/oauth-authorization-server', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      ...discoveryBase(origin),
      code_challenge_methods_supported: [...AUTHKIT_CODE_CHALLENGE_METHODS],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      registration_endpoint: `${origin}/oauth2/register`,
      response_modes_supported: ['query'],
      token_endpoint_auth_methods_supported: [...AUTHKIT_TOKEN_ENDPOINT_AUTH_METHODS],
    });
  });

  // OIDC Discovery for the same domain. Production lists `client_credentials` here and not in the
  // OAuth metadata above, which is kept. `id_token_signing_alg_values_supported` and
  // `subject_types_supported` are the fields OIDC Discovery 1.0 §3 requires, and strict OIDC
  // clients need them. The emulator signs RS256 with one subject per user, and `/oauth2/token`
  // issues an `id_token` at code exchange when `openid` is granted.
  app.get('/.well-known/openid-configuration', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
      ...discoveryBase(origin),
      grant_types_supported: ['authorization_code', 'client_credentials', 'refresh_token'],
      id_token_signing_alg_values_supported: ['RS256'],
      subject_types_supported: ['public'],
      // Production lists the same three, in this order, here.
      token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    });
  });

  /**
   * Dynamic client registration, RFC 7591. Unauthenticated, as it has to be: an MCP client
   * registers before it holds anything. It creates a real Connect `oauth` application — third
   * party, `was_dynamically_registered` — so the client shows up in `GET /connect/applications?
   * registration_types=dynamic` and is authorized, tokenized and revoked like any other.
   *
   * `token_endpoint_auth_method: none` makes a public client (PKCE-only, no secret); anything
   * else a confidential one with a generated secret. Omitted, it defaults as production defaults
   * it: `none` for a `native` application (a public client, SEP-837), else `client_secret_basic`
   * as RFC 7591 §2 says. `client_name` is required, as it is of production's registration DTO.
   * Errors are RFC 7591 §3.2.2's `invalid_redirect_uri` and `invalid_client_metadata`, not the
   * API's `{message, code}`.
   *
   * Scopes follow production's registration: a requested scope the client could not be granted
   * is dropped rather than failing the registration, and the effective set is reported back so
   * the client learns it here and not at `/oauth2/authorize`. A dynamically registered client's
   * grantable scopes are the standard set plus the environment's dynamic-registration
   * permissions, which the emulator does not model, so here they are the standard set. Nothing is
   * stored on the application's own `scopes`: production serves those from an application's
   * assigned permissions, and a dynamically registered application has none of its own.
   *
   * The response carries production's field set: the resolved values of every field it defaults
   * (`application_type`, `grant_types`, `response_types`, `token_endpoint_auth_method`), and
   * `scope` only when the registration asked for one.
   */
  app.post('/oauth2/register', async (c: Context) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new OauthApiError(400, 'invalid_client_metadata', 'The request body must be a JSON object.');
    }
    const metadata = body as Record<string, unknown>;

    const redirectUris = metadata.redirect_uris;
    if (
      !Array.isArray(redirectUris) ||
      redirectUris.length === 0 ||
      !redirectUris.every((u) => typeof u === 'string' && u.length > 0)
    ) {
      throw new OauthApiError(400, 'invalid_redirect_uri', 'redirect_uris must be a non-empty array of URIs.');
    }
    for (const uri of redirectUris as string[]) {
      // The same host and scheme policy every other redirect goes through; only the error's
      // envelope differs, since RFC 7591 has its own.
      try {
        assertAllowedRedirectUri(uri, store);
      } catch (error) {
        if (error instanceof WorkOSApiError) throw new OauthApiError(400, 'invalid_redirect_uri', error.message);
        throw error;
      }
    }

    if (typeof metadata.client_name !== 'string') {
      throw new OauthApiError(400, 'invalid_client_metadata', 'client_name is required.');
    }
    const clientName = metadata.client_name;

    // RFC 7591 §2: `web` unless the client says `native`.
    const applicationType = metadata.application_type ?? 'web';
    if (!(AUTHKIT_APPLICATION_TYPES as readonly unknown[]).includes(applicationType)) {
      throw new OauthApiError(
        400,
        'invalid_client_metadata',
        `application_type must be one of: ${AUTHKIT_APPLICATION_TYPES.join(', ')}.`,
      );
    }

    const method =
      metadata.token_endpoint_auth_method ?? (applicationType === 'native' ? 'none' : 'client_secret_basic');
    if (typeof method !== 'string' || !(AUTHKIT_TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(method)) {
      throw new OauthApiError(
        400,
        'invalid_client_metadata',
        `token_endpoint_auth_method must be one of: ${AUTHKIT_TOKEN_ENDPOINT_AUTH_METHODS.join(', ')}.`,
      );
    }

    const grantTypes = metadata.grant_types ?? ['authorization_code'];
    if (
      !Array.isArray(grantTypes) ||
      grantTypes.length === 0 ||
      !grantTypes.every((g) => typeof g === 'string' && REGISTRATION_GRANT_TYPES.includes(g))
    ) {
      throw new OauthApiError(
        400,
        'invalid_client_metadata',
        `grant_types must be a subset of: ${REGISTRATION_GRANT_TYPES.join(', ')}.`,
      );
    }
    // Only `code` is supported, so that is all a registration may name, and what is stored and
    // returned is exactly what was registered. An empty list is refused rather than read as a default.
    const responseTypes = metadata.response_types ?? ['code'];
    if (!Array.isArray(responseTypes) || responseTypes.length === 0 || !responseTypes.every((r) => r === 'code')) {
      throw new OauthApiError(400, 'invalid_client_metadata', 'response_types must be a non-empty array of "code".');
    }
    // RFC 7591 §2.1: the `code` response type needs the `authorization_code` grant, so a refresh-only
    // client describes something that cannot exist. `refresh_token` stays optional.
    if (!grantTypes.includes('authorization_code')) {
      throw new OauthApiError(
        400,
        'invalid_client_metadata',
        'grant_types must include authorization_code when response_types includes code.',
      );
    }

    // Production's `grantableForDynamicRegistration`: of the scopes requested (de-duplicated, in
    // the order given), keep the ones the client may ask for and report them; the rest are dropped
    // silently. Echoed only when a scope was asked for.
    if (metadata.scope !== undefined && metadata.scope !== null && typeof metadata.scope !== 'string') {
      throw new OauthApiError(400, 'invalid_client_metadata', 'scope must be a space-delimited string.');
    }
    const scopeRequested = typeof metadata.scope === 'string' && metadata.scope.length > 0;
    const grantableScope = scopeRequested
      ? [...new Set((metadata.scope as string).split(/\s+/).filter(Boolean))].filter(isStandardScope)
      : [];

    // RFC 7591 §2 URL-valued metadata. It is only ever displayed, but a `javascript:` or `data:` value
    // there is exactly what a consent screen must not render, so only http(s) is accepted.
    for (const field of ['logo_uri', 'client_uri', 'policy_uri', 'tos_uri']) {
      const value = metadata[field];
      if (value === undefined) continue;
      let protocol: string | undefined;
      try {
        protocol = typeof value === 'string' ? new URL(value).protocol : undefined;
      } catch {
        protocol = undefined;
      }
      if (protocol !== 'http:' && protocol !== 'https:') {
        throw new OauthApiError(400, 'invalid_client_metadata', `${field} must be an http(s) URL.`);
      }
    }

    const isPublic = method === 'none';
    const application = ws.connectApplications.insert({
      object: 'connect_application',
      name: clientName,
      description: null,
      application_type: 'oauth',
      organization_id: null,
      // No custom scopes: see the note on scopes above. The standard set is open to it regardless.
      scopes: [],
      audience: null,
      redirect_uris: redirectUris as string[],
      is_first_party: false,
      was_dynamically_registered: true,
      uses_pkce: isPublic,
      // Registered metadata, stored as production stores it. Neither is read at /oauth2/token: a
      // refresh token is issued by the granted scopes (see shouldIssueRefreshToken), and a client
      // may send its secret in the body or as Basic whichever method it registered.
      grant_types: grantTypes as string[],
      response_types: responseTypes as string[],
      token_endpoint_auth_method: method as (typeof AUTHKIT_TOKEN_ENDPOINT_AUTH_METHODS)[number],
      login_url: null,
      client_id: generateClientId(),
      logo_url: typeof metadata.logo_uri === 'string' ? metadata.logo_uri : null,
    });

    let clientSecret: string | undefined;
    if (!isPublic) {
      clientSecret = `secret_${generateVerificationToken()}`;
      ws.clientSecrets.insert({
        object: 'connect_application_secret',
        application_id: application.id,
        value: clientSecret,
        secret_hint: clientSecret.slice(-4),
        last_used_at: null,
      });
    }

    // RFC 7591 §3.2.1: a response carrying a secret must not be cached, and says when the secret
    // expires — 0, since the emulator's never do.
    c.header('Cache-Control', 'no-store');
    return c.json(
      {
        client_id: application.client_id,
        client_id_issued_at: Math.floor(new Date(application.created_at).getTime() / 1000),
        application_type: applicationType,
        client_name: application.name,
        grant_types: grantTypes,
        redirect_uris: application.redirect_uris,
        response_types: responseTypes,
        token_endpoint_auth_method: method,
        ...(scopeRequested ? { scope: grantableScope.join(' ') } : {}),
        ...(clientSecret !== undefined ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      },
      201,
    );
  });

  // MCP resource indicators, the resource-server URIs a token's `aud` may be bound to (RFC 8707).
  // The spec documents no update route, so `default` is settable only here, at creation.
  app.post('/user_management/authkit_oauth_resources', async (c) => {
    const body = await parseJsonBody(c);
    const uri = body.uri;
    if (typeof uri !== 'string' || !uri) {
      throw validationError('uri is required', [{ field: 'uri', code: 'required' }]);
    }
    if (body.default !== undefined && typeof body.default !== 'boolean') {
      throw validationError('default must be a boolean', [{ field: 'default', code: 'invalid' }]);
    }
    // Wildcard patterns exist in production "where enabled for the environment"; the emulator has
    // no such switch, so a `*` is refused rather than stored as a literal that would match nothing.
    if (uri.includes('*') || !isValidResourceUri(uri)) {
      throw validationError('uri must be an absolute URI without a fragment or wildcard', [
        { field: 'uri', code: 'invalid' },
      ]);
    }
    // Compared the way every matcher downstream compares, by normalized URL, as production's
    // duplicate check does: 'https://a.test' and 'https://a.test/' are one resource.
    if (findRegisteredResource(ws, uri)) {
      throw new WorkOSApiError(422, `AuthKit OAuth resource '${uri}' already exists.`, 'unprocessable_entity');
    }

    const makeDefault = body.default === true;
    // "Clearing any previous default", so at most one resource holds the flag.
    if (makeDefault) {
      for (const other of ws.authkitOauthResources.all()) {
        if (other.default) ws.authkitOauthResources.update(other.id, { default: false });
      }
    }
    const resource = ws.authkitOauthResources.insert({ object: 'authkit_oauth_resource', uri, default: makeDefault });
    return c.json(formatAuthkitOauthResource(resource), 201);
  });

  app.get('/user_management/authkit_oauth_resources', (c) => {
    const params = parseListParams(new URL(c.req.url));
    return c.json(formatListResponse(ws.authkitOauthResources.list(params), formatAuthkitOauthResource));
  });

  app.delete('/user_management/authkit_oauth_resources/:id', (c) => {
    const id = c.req.param('id');
    // A bare Nest NotFoundException with a string message in production
    // (api authkit-oauth-resources controller), so `error` rather than `code`.
    if (!ws.authkitOauthResources.get(id)) {
      throw new NestNotFoundError(`AuthKit OAuth resource not found: '${id}'.`, 'Not Found');
    }
    ws.authkitOauthResources.delete(id);
    return c.body(null, 204);
  });
}
