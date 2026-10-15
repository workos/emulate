import { createHash, timingSafeEqual } from 'node:crypto';
import type { WorkOSStore } from './store.js';
import type { WorkOSConnectApplication } from './entities.js';

/**
 * The AuthKit domain acting as an OAuth 2.1 authorization server for MCP clients: what
 * `/oauth2/authorize`, `/oauth2/token` and `/oauth2/register` share with the discovery documents.
 * Kept out of the route files because the documents advertise exactly what the routes enforce, and
 * one list is what keeps the two from drifting.
 */

/**
 * The standard scopes a production AuthKit domain advertises. Production's scope parser accepts
 * every one of them from any application that is not machine-to-machine, whatever permissions the
 * application was assigned; only a non-standard scope has to be one of the application's own.
 */
export const AUTHKIT_OAUTH_SCOPES = ['email', 'offline_access', 'openid', 'profile'] as const;

/** Only S256: production advertises no other, and OAuth 2.1 drops `plain`. */
export const AUTHKIT_CODE_CHALLENGE_METHODS = ['S256'] as const;

/** `none` is a public client, which `/oauth2/register` maps to a PKCE-only application. */
export const AUTHKIT_TOKEN_ENDPOINT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;

/** RFC 7591 `application_type`, the two values production's registration accepts. */
export const AUTHKIT_APPLICATION_TYPES = ['web', 'native'] as const;

export const isStandardScope = (scope: string): boolean => (AUTHKIT_OAUTH_SCOPES as readonly string[]).includes(scope);

/**
 * Whether the application is a public client: one that cannot keep a secret, so PKCE is its only
 * proof. `uses_pkce` is the field WorkOS gives an application for exactly this (production
 * serializes it from `clientConfidentiality === 'public'`), and `/oauth2/register` sets it for
 * `token_endpoint_auth_method: none`.
 */
export function isPublicClient(application: WorkOSConnectApplication): boolean {
  return application.application_type === 'oauth' && application.uses_pkce;
}

/**
 * RFC 7636 §4.6 for S256, as production's `validateCodeChallenge` does it: hash whatever verifier
 * was sent and compare, with no check on the verifier's length or alphabet. Constant-time, because
 * the verifier is a secret until the exchange.
 */
export function pkceMatches(codeVerifier: string | undefined, codeChallenge: string): boolean {
  if (!codeVerifier) return false;
  const computed = Buffer.from(createHash('sha256').update(codeVerifier).digest('base64url'));
  const expected = Buffer.from(codeChallenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/**
 * The scopes an OAuth application may be asked for at `/oauth2/authorize`: the standard set, which
 * production allows every non-M2M application, plus the application's own (custom) scopes. The
 * emulator has no environment-level permissions for dynamically registered clients, so for those
 * the custom half is empty.
 */
export function allowedScopes(application: WorkOSConnectApplication): string[] {
  const custom = Array.isArray(application.scopes) ? application.scopes : [];
  return [...AUTHKIT_OAUTH_SCOPES, ...custom.filter((s) => !isStandardScope(s))];
}

/**
 * The scopes of a grant that can still be issued. Production reads a consent's scopes back as its
 * standard scopes (stored on the consent itself) plus whichever of its permission scopes still
 * exist, so a custom scope removed from the application drops out of every later token while the
 * standard ones stay. Nothing is refused for being empty: a consent granted no scope yields a
 * token with no `scope` claim.
 */
export function grantableScopes(application: WorkOSConnectApplication, granted: readonly string[]): string[] {
  const custom = Array.isArray(application.scopes) ? application.scopes : [];
  return granted.filter((s) => isStandardScope(s) || custom.includes(s));
}

/**
 * The `scope` string production puts on a token and in a token response: sorted, de-duplicated,
 * space-delimited, and `undefined` rather than empty when there is none, so the claim and the
 * response field are both absent instead of `""`.
 */
export function formatScope(scopes: readonly string[]): string | undefined {
  return [...new Set(scopes)].sort((a, b) => a.localeCompare(b)).join(' ') || undefined;
}

/** A space-delimited `scope` parameter as production parses it: split on whitespace, de-duplicated, empty when absent. */
export function parseScopeParam(value: string | undefined): string[] {
  return value ? [...new Set(value.split(/\s+/).filter(Boolean))] : [];
}

/**
 * Why production's resource URI parser refuses a value, or `null` when it does not. RFC 8707 §2:
 * an absolute URI with no fragment. The two reasons carry production's own descriptions.
 */
export function resourceUriError(value: string): 'MalformedUri' | 'UriContainsFragment' | null {
  const trimmed = value.trim();
  try {
    new URL(trimmed);
  } catch {
    return 'MalformedUri';
  }
  return trimmed.includes('#') ? 'UriContainsFragment' : null;
}

export function isValidResourceUri(value: string): boolean {
  return resourceUriError(value) === null;
}

/**
 * Whether two resource URIs identify the same resource, the way production's `OauthResourceUri`
 * compares them: by normalized `href`, so `https://a.test` and `https://a.test/` are one resource.
 */
export function resourceUrisEqual(a: string, b: string): boolean {
  try {
    return new URL(a.trim()).href === new URL(b.trim()).href;
  } catch {
    return false;
  }
}

/** The registered resource identifying `uri`, if any. Wildcard patterns are refused at registration, so matching is exact. */
export function findRegisteredResource(ws: WorkOSStore, uri: string) {
  return ws.authkitOauthResources.all().find((r) => resourceUrisEqual(r.uri, uri));
}

/**
 * The `aud` of a Connect access token: the resource the grant is bound to when there is one.
 * Production otherwise uses the environment's own client id (`environment.clientId`), which the
 * emulator has no equivalent of, since the AuthKit client id is whatever each caller supplies. The
 * emulator falls back to the application's `audience` and then its `client_id`, which is what this
 * surface minted before resource indicators existed. That fallback is the one documented deviation
 * on this claim.
 */
export function resolveAudience(application: WorkOSConnectApplication, resource: string | null): string {
  return resource ?? application.audience ?? application.client_id;
}

export type AuthorizeResourceResult =
  | { ok: true; resource: string | null }
  | { ok: false; description: string | undefined };

/**
 * The RFC 8707 `resource` of an `/oauth2/authorize` request, resolved the way production's
 * authorize handler does it (`validateResource` and the default-resource fallback that follows it):
 *
 * - A dynamically registered client's `resource` is validated only once the environment has
 *   registered resources. Then a malformed or fragment-bearing value, or one matching no registered
 *   resource, is `invalid_target` on the callback, with a description only for the malformed case.
 *   With no resources registered the parameter is ignored, for backwards compatibility.
 * - Any other client's `resource` is ignored: production gates resource indicators for those
 *   behind the `connect-resource-indicators-for-all-clients` environment flag, so the flag-off path
 *   is the one reproduced.
 * - A dynamically registered client that ends up bound to nothing (it omitted `resource`, or
 *   nothing is registered) is bound to the resource flagged `default`, when one exists, so its
 *   tokens still carry a resource audience. Some MCP clients omit the parameter entirely.
 *
 * What is bound is the registered URI as registered, which is also what the token carries.
 */
export function resolveAuthorizeResource(
  ws: WorkOSStore,
  application: WorkOSConnectApplication,
  resource: string | null,
): AuthorizeResourceResult {
  if (!application.was_dynamically_registered) return { ok: true, resource: null };
  const registered = ws.authkitOauthResources.all();
  let bound: string | null = null;
  if (resource !== null && registered.length > 0) {
    const reason = resourceUriError(resource);
    if (reason !== null) {
      return {
        ok: false,
        description:
          reason === 'UriContainsFragment'
            ? 'Invalid target: resource URIs cannot contain a URL fragment.'
            : 'Invalid target: resource URI is malformed.',
      };
    }
    const match = findRegisteredResource(ws, resource);
    if (!match) return { ok: false, description: undefined };
    bound = match.uri;
  }
  if (bound === null) bound = registered.find((r) => r.default)?.uri ?? null;
  return { ok: true, resource: bound };
}

/**
 * Whether a code exchange is answered with a refresh token, as production decides it
 * (`shouldIssueRefreshToken` in the application consent tokens service): always when the grant
 * carries `offline_access`; otherwise a dynamically registered client, which today means an MCP
 * client, gets one exactly when it did not ask for `openid`, since outside OIDC mode issuing one
 * is at the server's discretion and some connectors never send a scope yet fail without one; any
 * other client gets none. The `grant_types` a client registered play no part.
 */
export function shouldIssueRefreshToken(application: WorkOSConnectApplication, scopes: readonly string[]): boolean {
  if (scopes.includes('offline_access')) return true;
  if (application.was_dynamically_registered) return !scopes.includes('openid');
  return false;
}
