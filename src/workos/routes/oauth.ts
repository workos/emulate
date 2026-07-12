import type { Context } from 'hono';
import { type RouteContext } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';

/**
 * M2M token exchange (OAuth 2.0 `client_credentials`).
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
 * verifies it without any emulator-specific shims. Granted scopes ride in the `scp`
 * claim so scope-based authorization can be exercised locally.
 */

const TOKEN_TTL_SECONDS = 3600;

interface TokenParams {
  grantType?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
}

/** RFC 6749 §5.2 error body. */
function oauthError(c: Context, status: 400 | 401, error: string, description: string) {
  return c.json({ error, error_description: description }, status);
}

/**
 * Decode a Basic-auth credential component. RFC 6749 §2.3.1 form-urlencodes the
 * client_id/secret before base64, but many clients send them literally; a literal `%`
 * makes decodeURIComponent throw. Decode when valid, otherwise use the raw value so a
 * pinned secret containing `%` yields invalid_client rather than a 500.
 */
function formDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Read client credentials and grant params from the request. Supports both the
 * form-encoded body services typically send and a JSON body, plus HTTP Basic auth
 * for the client credentials (RFC 6749 §2.3.1) as a fallback when they are not in
 * the body. Body params take precedence over the Basic header.
 */
async function readTokenParams(c: Context): Promise<TokenParams> {
  const contentType = c.req.header('content-type') ?? '';

  let raw: Record<string, unknown> = {};
  if (contentType.includes('application/json')) {
    try {
      const body = await c.req.json();
      if (body && typeof body === 'object' && !Array.isArray(body)) raw = body as Record<string, unknown>;
    } catch {
      // fall through to empty params; missing grant_type yields a clear error below
    }
  } else {
    const form = await c.req.parseBody();
    raw = form as Record<string, unknown>;
  }

  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  let clientId = str(raw.client_id);
  let clientSecret = str(raw.client_secret);

  const authHeader = c.req.header('authorization');
  if ((!clientId || !clientSecret) && authHeader && /^basic\s/i.test(authHeader)) {
    const decoded = Buffer.from(authHeader.replace(/^basic\s+/i, '').trim(), 'base64').toString('utf-8');
    const sep = decoded.indexOf(':');
    if (sep >= 0) {
      clientId = clientId || formDecode(decoded.slice(0, sep));
      clientSecret = clientSecret || formDecode(decoded.slice(sep + 1));
    }
  }

  return {
    grantType: str(raw.grant_type),
    clientId,
    clientSecret,
    scope: str(raw.scope),
  };
}

export function oauthRoutes(ctx: RouteContext): void {
  const { app, store, jwt } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/oauth2/token', async (c) => {
    const { grantType, clientId, clientSecret, scope } = await readTokenParams(c);

    if (grantType !== 'client_credentials') {
      return oauthError(c, 400, 'unsupported_grant_type', `The grant type is not supported: ${grantType ?? '(none)'}`);
    }
    if (!clientId || !clientSecret) {
      return oauthError(c, 400, 'invalid_request', 'client_id and client_secret are required.');
    }

    const application = ws.connectApplications.findOneBy('client_id', clientId);
    const secretMatches =
      application && ws.clientSecrets.findBy('application_id', application.id).some((s) => s.value === clientSecret);
    if (!application || !secretMatches) {
      return oauthError(c, 401, 'invalid_client', 'Invalid client ID or secret.');
    }
    if (application.application_type !== 'm2m') {
      return oauthError(
        c,
        400,
        'unauthorized_client',
        'The client is not authorized to use the client_credentials grant type.',
      );
    }

    // Grant the requested scopes, defaulting to all of the application's scopes. A
    // request may narrow to a subset (space-delimited, per RFC 6749 §3.3); requesting
    // a scope the application does not have is rejected so authz logic can be tested.
    // Guard against a malformed (non-array) stored scopes value so a request never
    // substring-matches a scope string or hits a .join on a non-array.
    const appScopes = Array.isArray(application.scopes) ? application.scopes : [];
    let granted = appScopes;
    if (scope && scope.trim().length > 0) {
      const requested = scope.trim().split(/\s+/);
      const unknown = requested.filter((s) => !appScopes.includes(s));
      if (unknown.length > 0) {
        return oauthError(
          c,
          400,
          'invalid_scope',
          `The application is not granted the requested scope(s): ${unknown.join(', ')}.`,
        );
      }
      granted = requested;
    }

    // Both the audience and tenant come from the stored application, never the caller,
    // so a client can't mint a token for an arbitrary aud or an org it isn't tied to.
    // aud defaults to the client_id; pin `audience` on the app to match production.
    const accessToken = jwt.sign(
      {
        sub: clientId,
        aud: application.audience ?? clientId,
        org_id: application.organization_id ?? undefined,
        scp: granted,
      },
      { expiresIn: TOKEN_TTL_SECONDS },
    );

    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: TOKEN_TTL_SECONDS,
      scope: granted.join(' '),
    });
  });

  // The M2M authorization server's JWKS. Same signing key as /sso/jwks/:client_id, so a
  // service pointed at the authoritative server's well-known JWKS validates M2M tokens.
  app.get('/oauth2/jwks', (c) => c.json(jwt.getJWKS()));
}
