import type { Context, Next } from 'hono';
import { unauthorized } from './error-handler.js';

export interface WorkOSAuthContext {
  environment: string;
  apiKey: string;
}

export type WorkOSAppEnv = {
  Variables: {
    auth?: WorkOSAuthContext;
    requestId?: string;
  };
};

export interface ApiKeyEntry {
  environment: string;
  /** Expiry timestamp (ISO 8601). Omitted/null means the key never expires. */
  expiresAt?: string | null;
}

export type ApiKeyMap = Record<string, ApiKeyEntry>;

/** A key is expired when it has an expiry timestamp in the past. */
export function isApiKeyEntryExpired(entry: ApiKeyEntry): boolean {
  return !!entry.expiresAt && new Date(entry.expiresAt).getTime() < Date.now();
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
