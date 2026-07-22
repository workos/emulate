import {
  createServer,
  type ApiKeyMap,
  addErrorHook,
  removeErrorHook,
  getErrorHooks,
  type ErrorHook,
  type ErrorHookInput,
  type Store,
} from './core/index.js';
import { workosPlugin, seedFromConfig, type WorkOSSeedConfig } from './workos/index.js';
import { STORE_KEYS } from './workos/constants.js';
import { serve } from '@hono/node-server';
import { parseJsonBody } from './core/index.js';

export interface ErrorHookSeedConfig {
  method: string;
  path: string;
  status: number;
  body?: {
    message?: string;
    code?: string;
    errors?: Array<{ field: string; code: string; message?: string }>;
  };
  count?: number;
}

export interface EmulatorSeedConfig {
  apiKeys?: WorkOSSeedConfig['apiKeys'];
  organizations?: WorkOSSeedConfig['organizations'];
  users?: WorkOSSeedConfig['users'];
  connections?: WorkOSSeedConfig['connections'];
  invitations?: WorkOSSeedConfig['invitations'];
  roles?: WorkOSSeedConfig['roles'];
  permissions?: WorkOSSeedConfig['permissions'];
  webhookEndpoints?: WorkOSSeedConfig['webhookEndpoints'];
  connectApplications?: WorkOSSeedConfig['connectApplications'];
  errorHooks?: ErrorHookSeedConfig[];
}

export interface EmulatorOptions {
  port?: number;
  /**
   * Network interface to bind to. Defaults to `localhost`, which keeps the
   * emulator's unauthenticated endpoints reachable only from the local
   * machine. Set to `0.0.0.0` (or a specific interface) to intentionally
   * expose the emulator to other hosts on the network.
   */
  hostname?: string;
  seed?: EmulatorSeedConfig;
  interactiveAuth?: boolean;
  webhookRetryConfig?: {
    maxRetries?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffMultiplier?: number;
  };
  webhookDebugMode?: boolean;
}

export interface Emulator {
  url: string;
  port: number;
  apiKey: string;
  store: Store;
  close(): Promise<void>;
  reset(): void;
  addErrorHook(hook: ErrorHookInput): ErrorHook;
  removeErrorHook(id: string): boolean;
  listErrorHooks(): ErrorHook[];
}

export async function createEmulator(options: EmulatorOptions = {}): Promise<Emulator> {
  const port = options.port ?? 4100;
  // Falsy (including an empty string) falls back to the loopback default rather than
  // binding all interfaces, so a stray `--host=` can't silently re-expose the server.
  const hostname = options.hostname || '127.0.0.1';
  const baseUrl = `http://localhost:${port}`;

  // `apiKeys` may be the legacy auth allow-list map or an array of API key resources.
  // - map form: use it as the allow-list.
  // - array form: start empty; seedFromConfig adds those keys into this same map. We must
  //   NOT seed the well-known `sk_test_default` here, or it would authenticate protected
  //   routes (and surface as `emulator.apiKey`) even when the user pinned their own keys.
  // - neither: fall back to the default convenience key.
  const seedApiKeys = options.seed?.apiKeys;
  const apiKeys: ApiKeyMap = Array.isArray(seedApiKeys)
    ? {}
    : (seedApiKeys ?? { sk_test_default: { environment: 'test' } });
  // The initial allow-list, before array-form keys are seeded into it. reset() restores
  // the captured `apiKeys` object to this state (see below).
  const initialApiKeys: ApiKeyMap = { ...apiKeys };

  const { app, store, jwt } = createServer(workosPlugin, {
    port,
    baseUrl,
    apiKeys,
  });

  if (options.interactiveAuth) {
    store.setData(STORE_KEYS.interactiveAuth, true);
  }

  if (options.webhookRetryConfig) {
    store.setData('webhookRetryConfig', options.webhookRetryConfig);
  }

  if (options.webhookDebugMode) {
    store.setData('webhookDebugMode', true);
  }

  // Health check endpoint
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Error hooks management endpoints
  app.get('/_emulate/hooks', (c) => c.json(getErrorHooks(store)));

  app.post('/_emulate/hooks', async (c) => {
    const body = await parseJsonBody(c);
    const method = body.method as string | undefined;
    const path = body.path as string | undefined;
    const status = body.status as number | undefined;
    if (!method || !path || !status) {
      return c.json({ message: 'method, path, and status are required', code: 'bad_request' }, 400);
    }
    const hook = addErrorHook(store, {
      method,
      path,
      status,
      body: body.body as ErrorHookInput['body'],
      count: body.count as number | undefined,
    });
    return c.json(hook, 201);
  });

  app.delete('/_emulate/hooks/:id', (c) => {
    const removed = removeErrorHook(store, c.req.param('id'));
    if (!removed) return c.json({ message: 'Hook not found', code: 'not_found' }, 404);
    return c.body(null, 204);
  });

  const seedErrorHooks = () => {
    if (options.seed?.errorHooks) {
      for (const hook of options.seed.errorHooks) {
        addErrorHook(store, hook);
      }
    }
  };

  const seedFn = () => {
    workosPlugin.seed?.(store, baseUrl);
    if (options.seed) {
      seedFromConfig(store, baseUrl, options.seed);
    }
    seedErrorHooks();
  };

  seedFn();

  // Passing an explicit `hostname` makes `listen()` asynchronous, so we await the
  // listening callback (important for port: 0) and reject if the bind fails.
  const listen = (hn: string, p: number): Promise<ReturnType<typeof serve>> =>
    new Promise((resolve, reject) => {
      const server = serve({ fetch: app.fetch, port: p, hostname: hn }, () => resolve(server));
      server.once('error', reject);
    });

  const httpServer = await listen(hostname, port);

  // Resolve actual port (important for port: 0)
  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://localhost:${actualPort}`;

  // The advertised URL is `localhost`, which dual-stack hosts may resolve to either
  // `127.0.0.1` or `::1`. Binding a single loopback family would leave the URL
  // unreachable on the other. When using the default loopback (no explicit hostname),
  // also listen on IPv6 loopback so `localhost` works regardless of resolution order,
  // without exposing the server beyond loopback. Best-effort: ignore failures (e.g. no
  // IPv6 support, or the port already taken on `::1`).
  const secondaryServer =
    !options.hostname && hostname === '127.0.0.1' ? await listen('::1', actualPort).catch(() => undefined) : undefined;

  // Update JWT issuer to reflect the actual bound URL (matters when port: 0)
  jwt.issuer = url;

  const primaryApiKey = Object.keys(apiKeys)[0];

  return {
    url,
    port: actualPort,
    apiKey: primaryApiKey,
    store,
    reset() {
      console.warn(
        '⚠️  EventBus reset limitation: Route-level authentication events (authentication.*_succeeded/failed) will not work after reset(). ' +
          'Resource lifecycle events (user.created, organization.created, etc.) will still work. ' +
          'If you need authentication events after reset, create a new emulator instance instead.',
      );
      store.reset();
      // store.reset() drops the apiKeyMap data entry, but the auth middleware still holds
      // the original `apiKeys` object by reference. Restore that same object in place (to
      // its pre-seed state) and re-register it, so re-seeded array-form keys land in the
      // map the middleware reads — keeping real-request auth and /api_keys/validations in
      // sync rather than splitting across two divergent maps.
      for (const key of Object.keys(apiKeys)) delete apiKeys[key];
      Object.assign(apiKeys, initialApiKeys);
      store.setData(STORE_KEYS.apiKeyMap, apiKeys);
      seedFn();
      // Note: EventBus is not re-registered after reset because Hono's router
      // cannot be modified after it's built. Route-level authentication events
      // will not work after reset. This is acceptable for test scenarios where
      // reset is primarily used, but not for production use.
    },
    close(): Promise<void> {
      const closeOne = (server: ReturnType<typeof serve>) =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        });
      const servers = secondaryServer ? [httpServer, secondaryServer] : [httpServer];
      return Promise.all(servers.map(closeOne)).then(() => undefined);
    },
    addErrorHook(hook: ErrorHookInput): ErrorHook {
      return addErrorHook(store, hook);
    },
    removeErrorHook(id: string): boolean {
      return removeErrorHook(store, id);
    },
    listErrorHooks(): ErrorHook[] {
      return getErrorHooks(store);
    },
  };
}
