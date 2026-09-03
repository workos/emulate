import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Store } from './store.js';
import { JWTManager, type SigningKeyOptions } from './jwt.js';
import { createApiErrorHandler, requestIdMiddleware } from './middleware/error-handler.js';
import { authMiddleware, widgetAuthMiddleware, type ApiKeyMap, type WorkOSAppEnv } from './middleware/auth.js';
import { errorHooksMiddleware } from './error-hooks.js';
import type { ServicePlugin, RouteContext } from './plugin.js';

export interface ServerOptions {
  port?: number;
  baseUrl?: string;
  apiKeys?: ApiKeyMap;
  /**
   * Base the `iss` claim is built from. Defaults to the emulator's own base URL. Pin it to the
   * URL your real WorkOS environment issues from, so a verifier that checks `iss` against a
   * constant accepts emulator tokens unchanged.
   *
   * Not the whole claim: an AuthKit access token carries `{issuer}/user_management/{client_id}`,
   * as production does. Only the M2M, SSO and widget tokens carry the bare value.
   */
  issuer?: string;
  /** Pinned RSA signing key, keeping the JWKS stable across restarts. */
  signingKey?: SigningKeyOptions;
}

export function createServer(plugin: ServicePlugin, options: ServerOptions = {}) {
  const port = options.port ?? 4100;
  const baseUrl = options.baseUrl ?? `http://localhost:${port}`;

  const app = new Hono<WorkOSAppEnv>();
  const store = new Store();
  const jwt = new JWTManager(options.issuer ?? baseUrl, options.signingKey);

  // Mutable so createEmulator can reassign it to the actual bound URL after listen() resolves
  // an ephemeral port (port: 0). Route handlers read `ctx.baseUrl` per-request rather than
  // destructuring it, so a post-bind reassignment takes effect for them.
  const ctx: RouteContext = { app, store, jwt, baseUrl };

  const apiKeys: ApiKeyMap = options.apiKeys ?? {
    sk_test_default: { environment: 'test' },
  };

  app.onError(createApiErrorHandler());
  app.use('*', cors());
  app.use('*', requestIdMiddleware());

  // JWKS endpoint (public, no auth)
  app.get('/sso/jwks/:client_id', (c) => {
    return c.json(jwt.getJWKS());
  });

  // Auth middleware — single catch-all instance
  const auth = authMiddleware(apiKeys);

  // The private surface the `@workos-inc/widgets` components call. A browser widget never holds
  // an API key; it authenticates with the JWT `POST /widgets/token` minted, so this prefix gets
  // its own authenticator rather than a place on the public list.
  const WIDGETS_PREFIX = '/_widgets/';
  const widgetAuth = widgetAuthMiddleware(jwt);

  const PUBLIC_PATHS = new Set([
    '/health',
    '/user_management/authorize',
    // Browser-facing device verification page; like the authorize login page it cannot carry a
    // bearer token, so it is public. The POST device-authorization endpoint still requires auth.
    '/user_management/authorize/device/verify',
    '/user_management/authenticate',
    '/user_management/sessions/logout',
  ]);

  // /oauth2/* is the M2M authorization server: the token endpoint authenticates by
  // client credentials and the JWKS is public, so neither needs an API key.
  const PUBLIC_PATH_PREFIXES = [
    '/sso/',
    '/oauth2/',
    '/user_management/sessions/jwks/',
    '/data-integrations/',
    '/_emulate/',
  ];

  // OIDC discovery is per AuthKit client, so the path carries an id and cannot be matched
  // exactly. Public upstream, since a client fetches it before it holds any credential. The
  // trailing slash is allowed through too: the route itself does not match it, and a 404 saying
  // the document is not there beats a 401 that reads as a credential the caller could fix.
  const OPENID_CONFIGURATION = /^\/user_management\/[^/]+\/\.well-known\/openid-configuration\/?$/;

  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;

    // Skip auth for public paths
    if (PUBLIC_PATHS.has(path)) return next();
    if (OPENID_CONFIGURATION.test(path)) return next();
    if (path.startsWith(WIDGETS_PREFIX)) return widgetAuth(c, next);
    for (const prefix of PUBLIC_PATH_PREFIXES) {
      if (path.startsWith(prefix)) {
        // data-integrations: only /authorize subpath is public
        if (prefix === '/data-integrations/' && !path.endsWith('/authorize')) break;
        return next();
      }
    }

    return auth(c, next);
  });

  // Rate limiting
  const rateLimitCounters = new Map<string, { remaining: number; resetAt: number }>();
  let lastPruneAt = Math.floor(Date.now() / 1000);

  app.use('*', async (c, next) => {
    const auth = c.get('auth');
    const key = auth?.apiKey ?? '__anonymous__';
    const now = Math.floor(Date.now() / 1000);

    if (now - lastPruneAt > 3600) {
      for (const [k, val] of rateLimitCounters) {
        if (val.resetAt <= now) rateLimitCounters.delete(k);
      }
      lastPruneAt = now;
    }

    let counter = rateLimitCounters.get(key);
    if (!counter || counter.resetAt <= now) {
      counter = { remaining: 1000, resetAt: now + 60 };
      rateLimitCounters.set(key, counter);
    }

    counter.remaining = Math.max(0, counter.remaining - 1);

    c.header('X-RateLimit-Limit', '1000');
    c.header('X-RateLimit-Remaining', String(counter.remaining));
    c.header('X-RateLimit-Reset', String(counter.resetAt));

    if (counter.remaining === 0) {
      c.header('Retry-After', String(counter.resetAt - now));
      return c.json(
        {
          message: 'Too Many Requests',
          code: 'rate_limit_exceeded',
        },
        429,
      );
    }

    await next();
  });

  // Error hooks — intercept matching requests and return configured errors
  app.use('*', errorHooksMiddleware(store));

  // Store API key map for route access
  store.setData('apiKeyMap', apiKeys);

  // Register plugin routes
  plugin.register(ctx);

  // Not found handler
  app.notFound((c) =>
    c.json(
      {
        message: 'Not Found',
        code: 'not_found',
      },
      404,
    ),
  );

  return { app, store, jwt, port, baseUrl, ctx };
}
