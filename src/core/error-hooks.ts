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
}

export type ErrorHookInput = Omit<ErrorHook, 'id'>;

const STORE_KEY = 'errorHooks';

export function getErrorHooks(store: Store): ErrorHook[] {
  return store.getData<ErrorHook[]>(STORE_KEY) ?? [];
}

export function setErrorHooks(store: Store, hooks: ErrorHook[]): void {
  store.setData(STORE_KEY, hooks);
}

export function addErrorHook(store: Store, input: ErrorHookInput): ErrorHook {
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
    for (let i = 0; i < hooks.length; i++) {
      const hook = hooks[i];
      if (matchMethod(hook.method, c.req.method) && matchPath(hook.path, path)) {
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
