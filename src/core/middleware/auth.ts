import type { Context, Next } from 'hono';
import type { JWTManager, JWTPayload } from '../jwt.js';
import { unauthorized, WorkOSApiError } from './error-handler.js';

export interface WorkOSAuthContext {
  environment: string;
  apiKey: string;
}

/**
 * The verified widget session behind a `/_widgets/*` request. No `/_widgets` path carries an
 * organization id, so the token's `org_id` is the only source of the organization context.
 */
export interface WidgetAuthContext {
  organizationId: string;
  userId: string;
  /** The `permissions` claim — the widget scopes the token was minted with. */
  permissions: string[];
}

export type WorkOSAppEnv = {
  Variables: {
    auth?: WorkOSAuthContext;
    widgetAuth?: WidgetAuthContext;
    requestId?: string;
  };
};

export interface ApiKeyEntry {
  environment: string;
  /** Expiry timestamp (ISO 8601). Omitted/null means the key never expires. */
  expiresAt?: string | null;
}

export type ApiKeyMap = Record<string, ApiKeyEntry>;

/**
 * A key is expired when it has an expiry timestamp in the past. A malformed timestamp
 * (NaN) is treated as expired — fail closed, so a bad value can't authenticate forever.
 */
export function isApiKeyEntryExpired(entry: ApiKeyEntry): boolean {
  if (!entry.expiresAt) return false;
  const expiresAt = new Date(entry.expiresAt).getTime();
  return Number.isNaN(expiresAt) || expiresAt <= Date.now();
}

export function authMiddleware(apiKeys: ApiKeyMap) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) throw unauthorized();

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token.startsWith('sk_')) throw unauthorized();

    const keyInfo = apiKeys[token];
    // Reject unknown keys and keys whose expiry has passed (checked live, so a key that
    // expires after seeding stops authenticating once its timestamp elapses).
    if (!keyInfo || isApiKeyEntryExpired(keyInfo)) throw unauthorized();

    c.set('auth', { environment: keyInfo.environment, apiKey: token } satisfies WorkOSAuthContext);
    await next();
  };
}

/** The `aud` claim `POST /widgets/token` mints, and the only audience `/_widgets/*` accepts. */
export const WIDGET_TOKEN_AUDIENCE = 'widgets';

/**
 * Every widget-token failure is a 403, never a 401: the shipped `@workos-inc/widgets` client
 * treats 403 as "the token is the problem" — it refetches the token once, retries, and then
 * renders its expired-session or incorrect-permissions state — and treats every other error
 * status as a generic API failure. The private widgets spec documents 403 and no 401 for the
 * same reason. Business-logic errors on these routes must therefore never use 403.
 */
export function widgetForbidden(message: string): WorkOSApiError {
  return new WorkOSApiError(403, message, 'forbidden');
}

/**
 * Authenticate `/_widgets/*` with the JWT `POST /widgets/token` mints, instead of an API key.
 * The token is verified against the emulator's own signing key, must carry the widgets
 * audience, and must resolve an organization — the org scope every widget route works in.
 */
export function widgetAuthMiddleware(jwt: JWTManager) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) throw widgetForbidden('Widget token is required');

    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) throw widgetForbidden('Widget token is required');

    let payload: JWTPayload;
    try {
      payload = jwt.verify(token);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Invalid token';
      throw widgetForbidden(`Invalid widget token: ${detail}`);
    }

    if (payload.aud !== WIDGET_TOKEN_AUDIENCE) throw widgetForbidden('Token is not a widget token');
    if (typeof payload.org_id !== 'string' || !payload.org_id) {
      throw widgetForbidden('Widget token does not carry an organization');
    }

    c.set('widgetAuth', {
      organizationId: payload.org_id,
      userId: payload.sub,
      permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
    } satisfies WidgetAuthContext);
    await next();
  };
}
