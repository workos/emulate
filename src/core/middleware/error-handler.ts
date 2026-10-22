import type { Context, ErrorHandler, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class WorkOSApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
    public errors?: Array<{ field?: string; code: string; message?: string }>,
  ) {
    super(message);
    this.name = 'WorkOSApiError';
  }
}

/**
 * A failure of an RFC 6749 grant, rendered OAuth-style as `{error, error_description}` —
 * production only uses this shape for the standard grants; the `urn:workos:` grants keep
 * the plain `{code, message}` shape. Reuses `code`/`message` storage so event payloads
 * (which always carry `{code, message}`) need no special casing.
 */
export class OauthApiError extends WorkOSApiError {
  /** Response headers the failure carries, e.g. the `WWW-Authenticate` a 401 invalid_client needs (RFC 6749 §5.2). */
  readonly headers?: Record<string, string>;

  /**
   * `description` is optional because production's OAuth2 exception renders `error_description`
   * only when one was given: its code and refresh-token failures are the bare `{ error }`.
   */
  constructor(status: number, error: string, description?: string, headers?: Record<string, string>) {
    super(status, description ?? '', error);
    this.name = 'OauthApiError';
    this.headers = headers;
  }
}

/**
 * A lookup that found nothing, rendered as production's `EntityNotFoundException`
 * (api-services `common/exceptions/entity-not-found/entity-not-found-exception.ts`):
 * `{message: "<Type> not found: '<id>'.", code: 'entity_not_found', entity_id: '<id>'}`.
 *
 * Production always has an id to name, so `entityId` is optional only for the handful of sites
 * that resolved by something the response cannot quote; those render no `entity_id` rather than
 * an invented one. `message` and `extra` exist for the few production sites that depart from the
 * template (an agent session's wording, an `entity_type` field) and are otherwise left alone.
 */
export class EntityNotFoundError extends WorkOSApiError {
  readonly extra?: Record<string, unknown>;

  constructor(
    readonly entityType: string,
    readonly entityId?: string,
    opts: { message?: string; extra?: Record<string, unknown> } = {},
  ) {
    super(
      404,
      opts.message ?? (entityId === undefined ? `${entityType} not found` : `${entityType} not found: '${entityId}'.`),
      'entity_not_found',
    );
    this.name = 'EntityNotFoundError';
    this.extra = opts.extra;
  }
}

/**
 * A 404 production raises as a bare Nest `NotFoundException` rather than an entity one. Nest
 * renders `{message}` — plus `error: 'Not Found'` when the message was passed as a string — and
 * no `code` at all (`HttpException.createBody`; the API's `CustomExceptionFilter` only strips
 * `statusCode`). The `code` stored here is bookkeeping for `instanceof WorkOSApiError` callers;
 * it is never rendered.
 */
export class NestNotFoundError extends WorkOSApiError {
  constructor(
    message = 'Not Found',
    readonly error?: 'Not Found',
  ) {
    super(404, message, 'not_found');
    this.name = 'NestNotFoundError';
  }
}

/**
 * The same code-less Nest rendering as `NestNotFoundError`, for the other statuses. Nest raises
 * these two ways: an exception built from a plain string (`new UnprocessableEntityException('…')`),
 * whose body is `{ message, error: 'Unprocessable Entity' }`, and one built from a code-less
 * object, like the validation pipe's `{ message: 'Validation failed', errors }`. `code` is still
 * kept in-process — error hooks and event payloads read `{ code, message }` — but is not rendered.
 */
export class PlainApiError extends WorkOSApiError {
  /** Nest's status text, rendered as `error` when production raised the exception from a string. */
  readonly error?: string;

  constructor(
    status: number,
    message: string,
    code: string,
    opts?: { error?: string; errors?: WorkOSApiError['errors'] },
  ) {
    super(status, message, code, opts?.errors);
    this.name = 'PlainApiError';
    this.error = opts?.error;
  }
}

export function createApiErrorHandler(): ErrorHandler {
  return (err, c) => {
    if (err instanceof OauthApiError) {
      return c.json(
        { error: err.code, ...(err.message ? { error_description: err.message } : {}) },
        err.status as ContentfulStatusCode,
        err.headers,
      );
    }
    if (err instanceof NestNotFoundError) {
      return c.json({ message: err.message, ...(err.error ? { error: err.error } : {}) }, 404);
    }
    if (err instanceof PlainApiError) {
      const body: Record<string, unknown> = { message: err.message };
      if (err.error) body.error = err.error;
      if (err.errors) body.errors = err.errors;
      return c.json(body, err.status as ContentfulStatusCode);
    }
    if (err instanceof WorkOSApiError) {
      const body: Record<string, unknown> = {
        message: err.message,
        code: err.code,
      };
      if (err instanceof EntityNotFoundError) {
        if (err.entityId !== undefined) body.entity_id = err.entityId;
        Object.assign(body, err.extra);
      }
      if (err.errors) {
        body.errors = err.errors;
      }
      return c.json(body, err.status as ContentfulStatusCode);
    }

    const status = errorStatus(err);
    return c.json(
      {
        message: 'Internal Server Error',
        code: 'server_error',
      },
      status as ContentfulStatusCode,
    );
  };
}

export function requestIdMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const requestId = c.req.header('X-Request-ID') ?? `req_${crypto.randomUUID()}`;
    c.set('requestId', requestId);
    c.header('X-Request-ID', requestId);
    await next();
  };
}

/**
 * `entityType` is the name production's exception class passes (`'Organization'`, `'API Key'`,
 * `'UserOrganizationMembership'`, …) and `entityId` whatever the route looked up by: an id, a
 * slug, a token, an email. Pass the id whenever the lookup had one.
 */
export function notFound(entityType: string, entityId?: string): EntityNotFoundError {
  return new EntityNotFoundError(entityType, entityId);
}

export function validationError(message: string, errors?: WorkOSApiError['errors']): WorkOSApiError {
  return new WorkOSApiError(422, message, 'unprocessable_entity', errors);
}

/** Production's `UnprocessableEntityException('<message>')`: 422 `{ message, error: 'Unprocessable Entity' }`, no `code`. */
export function unprocessableEntity(message: string): PlainApiError {
  return new PlainApiError(422, message, 'unprocessable_entity', { error: 'Unprocessable Entity' });
}

/**
 * Production's validation pipe: 422 `{ message: 'Validation failed', errors: [{ field, code }] }`
 * with no top-level `code`; each entry's `code` is the failed constraint's message.
 */
export function validationFailed(errors: Array<{ field: string; code: string }>): PlainApiError {
  return new PlainApiError(422, 'Validation failed', 'unprocessable_entity', { errors });
}

export function unauthorized(): WorkOSApiError {
  return new WorkOSApiError(401, 'Unauthorized', 'unauthorized');
}

export function forbidden(): WorkOSApiError {
  return new WorkOSApiError(403, 'Forbidden', 'forbidden');
}

export async function parseJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    throw new WorkOSApiError(400, 'Problems parsing JSON', 'invalid_request_body');
  }
}

// Parses an OAuth request body whether the client sent JSON or
// application/x-www-form-urlencoded. RFC 6749 §3.2 / RFC 8628 require the form encoding, and
// WorkOS production accepts both on /user_management/authenticate for every grant (Nest's
// default urlencoded parser is active there) and on /user_management/authorize/device. Dispatch
// on Content-Type -- JSON goes through parseJsonBody, form-encoded through c.req.parseBody --
// and return the same Record<string, unknown> the handlers index into.
export async function parseOAuthBody(c: Context): Promise<Record<string, unknown>> {
  const contentType = (c.req.header('content-type') ?? '').toLowerCase();
  if (contentType.includes('application/json')) {
    return parseJsonBody(c);
  }
  try {
    const body = await c.req.parseBody();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      return body as Record<string, unknown>;
    }
    return {};
  } catch {
    throw new WorkOSApiError(400, 'Problems parsing body', 'invalid_request_body');
  }
}

function errorStatus(err: unknown): number {
  if (err && typeof err === 'object' && 'status' in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === 'number' && Number.isFinite(s)) return s;
  }
  return 500;
}
