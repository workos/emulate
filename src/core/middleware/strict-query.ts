import type { MiddlewareHandler } from 'hono';
import { validationFailed, WorkOSApiError } from './error-handler.js';

/**
 * Which of production's two validation pipes guards the operation's query, and so how an unknown
 * parameter is reported. Both answer 422 with `message: 'Validation failed'`:
 *
 * - `validation` (`ValidationPipe`): `errors: [{ field, code: 'property <name> should not exist' }]`
 *   and no top-level `code`.
 * - `validation_with_error_code` (`ValidationWithErrorCodePipe`): `code:
 *   'invalid_request_parameters'` and `errors: [{ code: '<name>_not_supported', message:
 *   'property <name> should not exist' }]`.
 */
export type StrictQueryPipe = 'validation' | 'validation_with_error_code';

/** An operation whose query takes only the parameters it declares. */
export interface StrictQueryRule {
  method: string;
  /** The path as an OpenAPI template: `/organizations/{organizationId}/groups`. */
  path: string;
  allowed: readonly string[];
  pipe: StrictQueryPipe;
}

/**
 * The property a query key names once production has parsed the query. Production parses with
 * `qs` (Express's extended parser), so `name[]=`, `name[0]=` and `name[key]=` all name the
 * property `name`, a key that opens with a bracket names what the bracket holds, and a key that
 * is empty or `__proto__` names nothing.
 */
export function queryPropertyName(key: string): string | undefined {
  if (key === '') return undefined;
  const bracket = key.indexOf('[');
  let name = bracket === -1 ? key : key.slice(0, bracket);
  if (bracket === 0) {
    const close = key.indexOf(']');
    name = close === -1 ? key : key.slice(1, close) || '0';
  }
  return name === '__proto__' ? undefined : name;
}

/** The properties of a query that `allowed` does not list, each once, in the order they first appear. */
export function unknownQueryProperties(params: URLSearchParams, allowed: ReadonlySet<string>): string[] {
  const unknown = new Set<string>();
  for (const key of params.keys()) {
    const name = queryPropertyName(key);
    if (name !== undefined && !allowed.has(name)) unknown.add(name);
  }
  return [...unknown];
}

function unknownQueryPropertiesError(pipe: StrictQueryPipe, fields: string[]): WorkOSApiError {
  if (pipe === 'validation_with_error_code') {
    return new WorkOSApiError(
      422,
      'Validation failed',
      'invalid_request_parameters',
      fields.map((field) => ({ code: `${field}_not_supported`, message: `property ${field} should not exist` })),
    );
  }
  return validationFailed(fields.map((field) => ({ field, code: `property ${field} should not exist` })));
}

/**
 * Refuses a query parameter the operation does not declare, for the operations in `rules`, the
 * way production's query pipe does under `forbidNonWhitelisted`. Register it after authentication
 * and before the routes: production's guards run before its pipes and its pipes before the handler,
 * so a bad credential is still a 401, while an unknown parameter is a 422 even when the path names
 * something that does not exist. The values of the declared parameters are not checked here.
 */
export function strictQueryMiddleware(rules: readonly StrictQueryRule[]): MiddlewareHandler {
  const byMethod = new Map<string, Array<{ pattern: RegExp; allowed: ReadonlySet<string>; pipe: StrictQueryPipe }>>();
  for (const rule of rules) {
    const source = rule.path
      .split(/\{[^}]+\}/)
      .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[^/]+');
    const method = rule.method.toUpperCase();
    const compiled = byMethod.get(method) ?? [];
    compiled.push({ pattern: new RegExp(`^${source}$`), allowed: new Set(rule.allowed), pipe: rule.pipe });
    byMethod.set(method, compiled);
  }

  return async (c, next) => {
    const url = new URL(c.req.url);
    const rule = url.search ? byMethod.get(c.req.method)?.find(({ pattern }) => pattern.test(url.pathname)) : undefined;
    if (rule) {
      const unknown = unknownQueryProperties(url.searchParams, rule.allowed);
      if (unknown.length > 0) throw unknownQueryPropertiesError(rule.pipe, unknown);
    }
    await next();
  };
}
