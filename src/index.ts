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
  apiKeys?: Record<string, { environment: string }>;
  organizations?: WorkOSSeedConfig['organizations'];
  users?: WorkOSSeedConfig['users'];
  connections?: WorkOSSeedConfig['connections'];
  invitations?: WorkOSSeedConfig['invitations'];
  roles?: WorkOSSeedConfig['roles'];
  permissions?: WorkOSSeedConfig['permissions'];
  webhookEndpoints?: WorkOSSeedConfig['webhookEndpoints'];
  errorHooks?: ErrorHookSeedConfig[];
}

export interface EmulatorOptions {
  port?: number;
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
  const baseUrl = `http://localhost:${port}`;

  const apiKeys: ApiKeyMap = options.seed?.apiKeys ?? {
    sk_test_default: { environment: 'test' },
  };

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

  const httpServer = serve({ fetch: app.fetch, port });

  // Resolve actual port (important for port: 0)
  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://localhost:${actualPort}`;

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
        'If you need authentication events after reset, create a new emulator instance instead.'
      );
      store.reset();
      seedFn();
      // Note: EventBus is not re-registered after reset because Hono's router
      // cannot be modified after it's built. Route-level authentication events
      // will not work after reset. This is acceptable for test scenarios where
      // reset is primarily used, but not for production use.
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
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
