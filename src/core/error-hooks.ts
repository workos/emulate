import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Store } from './store.js';

export interface ErrorHookBody {
  message?: string;
  code?: string;
  errors?: Array<{ field: string; code: string; message?: string }>;
}

export interface ErrorHook {
  id: string;
  method: string;
  path: string;
  status: number;
  body?: ErrorHookBody;
  count?: number;
  rateLimit?: {
    maxRequests: number;
    windowMs: number;
  };
}

export type ErrorHookInput = Omit<ErrorHook, 'id'>;

const STORE_KEY = 'errorHooks';
const RATE_LIMIT_STORE_KEY = 'errorHookRateLimits';

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

export function getErrorHooks(store: Store): ErrorHook[] {
  return store.getData<ErrorHook[]>(STORE_KEY) ?? [];
}

function getRateLimitStore(store: Store): Map<string, RateLimitEntry> {
  return store.getData<Map<string, RateLimitEntry>>(RATE_LIMIT_STORE_KEY) ?? new Map();
}

function setRateLimitStore(store: Store, rateLimits: Map<string, RateLimitEntry>): void {
  store.setData(RATE_LIMIT_STORE_KEY, rateLimits);
}

export function setErrorHooks(store: Store, hooks: ErrorHook[]): void {
  store.setData(STORE_KEY, hooks);
}

export function addErrorHook(store: Store, input: ErrorHookInput): ErrorHook {
  // Validate error hook input
  if (!input.method || typeof input.method !== 'string') {
    throw new Error('Error hook validation failed: method is required and must be a string');
  }
  if (!input.path || typeof input.path !== 'string') {
    throw new Error('Error hook validation failed: path is required and must be a string');
  }
  if (!input.status || typeof input.status !== 'number' || input.status < 100 || input.status > 599) {
    throw new Error('Error hook validation failed: status is required and must be a valid HTTP status code (100-599)');
  }
  if (input.body && typeof input.body !== 'object') {
    throw new Error('Error hook validation failed: body must be an object if provided');
  }
  if (input.count !== undefined && (typeof input.count !== 'number' || input.count < 0)) {
    throw new Error('Error hook validation failed: count must be a non-negative number if provided');
  }
  if (input.rateLimit) {
    if (typeof input.rateLimit !== 'object') {
      throw new Error('Error hook validation failed: rateLimit must be an object if provided');
    }
    if (typeof input.rateLimit.maxRequests !== 'number' || input.rateLimit.maxRequests <= 0) {
      throw new Error('Error hook validation failed: rateLimit.maxRequests must be a positive number');
    }
    if (typeof input.rateLimit.windowMs !== 'number' || input.rateLimit.windowMs <= 0) {
      throw new Error('Error hook validation failed: rateLimit.windowMs must be a positive number');
    }
  }

  const hooks = getErrorHooks(store);
  const hook: ErrorHook = {
    id: `hook_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    ...input,
  };
  hooks.push(hook);
  setErrorHooks(store, hooks);
  return hook;
}

export function removeErrorHook(store: Store, id: string): boolean {
  const hooks = getErrorHooks(store);
  const idx = hooks.findIndex((h) => h.id === id);
  if (idx === -1) return false;
  hooks.splice(idx, 1);
  setErrorHooks(store, hooks);
  return true;
}

function matchPath(pattern: string, requestPath: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -2);
    return requestPath === prefix || requestPath.startsWith(prefix + '/');
  }
  return pattern === requestPath;
}

function matchMethod(pattern: string, method: string): boolean {
  return pattern === '*' || pattern.toUpperCase() === method.toUpperCase();
}

function defaultBody(status: number): Record<string, unknown> {
  const bodies: Record<number, { message: string; code: string }> = {
    400: { message: 'Bad Request', code: 'bad_request' },
    401: { message: 'Unauthorized', code: 'unauthorized' },
    403: { message: 'Forbidden', code: 'forbidden' },
    404: { message: 'Not Found', code: 'not_found' },
    409: { message: 'Conflict', code: 'conflict' },
    422: { message: 'Unprocessable Entity', code: 'unprocessable_entity' },
    429: { message: 'Too Many Requests', code: 'rate_limit_exceeded' },
    500: { message: 'Internal Server Error', code: 'server_error' },
    503: { message: 'Service Unavailable', code: 'service_unavailable' },
  };
  return bodies[status] ?? { message: `Error ${status}`, code: 'error' };
}

export function errorHooksMiddleware(store: Store): MiddlewareHandler {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/_emulate/')) return next();

    const hooks = getErrorHooks(store);
    const rateLimits = getRateLimitStore(store);
    const now = Date.now();

    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i];
      if (matchMethod(hook.method, c.req.method) && matchPath(hook.path, path)) {
        // Check rate limiting if configured
        if (hook.rateLimit) {
          const key = `${hook.id}:${path}`;
          const entry = rateLimits.get(key);

          if (entry && now < entry.resetTime) {
            entry.count++;
            if (entry.count > hook.rateLimit.maxRequests) {
              // Rate limit exceeded, return 429
              return c.json(
                {
                  message: 'Rate limit exceeded',
                  code: 'rate_limit_exceeded',
                  retry_after: Math.ceil((entry.resetTime - now) / 1000),
                },
                429,
              );
            }
          } else {
            // Reset or create new entry
            rateLimits.set(key, {
              count: 1,
              resetTime: now + hook.rateLimit.windowMs,
            });
          }
          setRateLimitStore(store, rateLimits);
        }

        if (hook.count !== undefined) {
          hook.count--;
          if (hook.count <= 0) {
            hooks.splice(i, 1);
          }
          setErrorHooks(store, hooks);
        }

        const body = hook.body ?? defaultBody(hook.status);
        return c.json(body, hook.status as ContentfulStatusCode);
      }
    }

    await next();
  };
}
