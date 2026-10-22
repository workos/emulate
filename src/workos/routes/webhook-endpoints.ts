import { type RouteContext, WorkOSApiError, notFound, parseJsonBody, parseListParams } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { SUBSCRIBABLE_EVENTS } from '../constants.js';
import { formatWebhookEndpoint, formatListResponse, generateWebhookSecret } from '../helpers.js';
import type { WorkOSWebhookEndpoint } from '../entities.js';

/**
 * Mirrors `webhook-endpoints.controller.ts` in production: `POST` and `PATCH` share one
 * validation order — the DTO's field checks (422 `invalid_request_parameters`), then the
 * HTTPS rule on `endpoint_url` (422 `invalid_url`), then the event catalog (422
 * `invalid_request_parameters` with `unknown_event_type` items), then the URL uniqueness
 * (409 `duplicate_endpoint`). Fields the DTOs do not declare — `secret`, `enabled`,
 * `description`, `url` — are ignored, as the body pipe there runs without a whitelist.
 */

type ValidationItem = { code: string; message: string };

const STATUSES: readonly WorkOSWebhookEndpoint['status'][] = ['enabled', 'disabled'];

/** The names `CreateWebhookEndpointDto`/`UpdateWebhookEndpointDto` subscribe to — the catalog minus production's hidden events. */
const SUBSCRIBABLE = new Set<string>(SUBSCRIBABLE_EVENTS);

function invalidRequestParameters(errors: ValidationItem[]): WorkOSApiError {
  return new WorkOSApiError(422, 'Validation failed', 'invalid_request_parameters', errors);
}

const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * `endpoint_url` as its DTO validates it: `@IsNotEmptyWithErrorCode()` then
 * `@IsStringWithErrorCode()`, with only the first failing constraint reported.
 */
function validateEndpointUrl(value: unknown): ValidationItem | undefined {
  if (isEmpty(value)) {
    return { code: 'endpoint_url_string_required', message: 'Endpoint Url must be a non-empty string.' };
  }
  if (typeof value !== 'string') {
    return { code: 'endpoint_url_string_required', message: 'Endpoint Url must be a string.' };
  }
  return undefined;
}

/**
 * `events` as its DTO validates it: the per-element `@IsNotEmptyWithErrorCode({ each: true })`
 * and `@IsStringWithErrorCode({ each: true })` run on the value itself when it is not an
 * array (which is why a missing list reads "must be a non-empty string"), and
 * `@IsArrayNonEmptyWithErrorCode()` last.
 */
function validateEvents(value: unknown): ValidationItem | undefined {
  const elements = Array.isArray(value) ? value : [value];
  if (elements.some(isEmpty)) {
    return { code: 'events_string_required', message: 'Events must be a non-empty string.' };
  }
  if (elements.some((element) => typeof element !== 'string')) {
    return { code: 'events_string_required', message: 'Events must be a string.' };
  }
  if (!Array.isArray(value) || value.length === 0) {
    return { code: 'events_array_required', message: 'Events must be a non-empty array.' };
  }
  return undefined;
}

/** `status` as its DTO validates it: a plain `@IsIn`, so the pipe's fallback `<field>_required` code. */
function validateStatus(value: unknown): ValidationItem | undefined {
  if (STATUSES.includes(value as WorkOSWebhookEndpoint['status'])) return undefined;
  return { code: 'status_required', message: `status must be one of the following values: ${STATUSES.join(', ')}` };
}

/** `localhost`, `*.localhost`, `127.0.0.0/8` and `::1` — what a receiver on this machine answers on. */
function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    hostname === '[::1]'
  );
}

/**
 * The controller's `HttpsUrl` rule, with one deliberate emulator-only relaxation: a plain
 * `http://` URL is accepted when its host is a loopback address. Production has no local
 * receiver to reach; an emulator exists to deliver to one, and a test's receiver rarely has a
 * certificate. Every other host is held to HTTPS exactly as production holds it.
 */
function assertWebhookUrl(value: string): void {
  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch {
    parsed = undefined;
  }
  const allowed = parsed?.protocol === 'https:' || (parsed?.protocol === 'http:' && isLoopbackHost(parsed.hostname));
  if (!allowed) {
    throw new WorkOSApiError(422, 'The `endpoint_url` must be an HTTPS URL', 'invalid_url');
  }
}

function assertSubscribable(events: string[]): void {
  const errors = events
    .filter((event) => !SUBSCRIBABLE.has(event))
    .map((event) => ({ code: 'unknown_event_type', message: `\`${event}\` is not a supported event type` }));
  if (errors.length > 0) throw invalidRequestParameters(errors);
}

function duplicateEndpoint(endpointUrl: string): WorkOSApiError {
  return new WorkOSApiError(
    409,
    `A Webhook Endpoint with the endpoint url '${endpointUrl}' already exists.`,
    'duplicate_endpoint',
  );
}

export function webhookEndpointRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  const findOtherByUrl = (endpointUrl: string, exceptId?: string) =>
    ws.webhookEndpoints.findBy('endpoint_url', endpointUrl).find((ep) => ep.id !== exceptId);

  app.post('/webhook_endpoints', async (c) => {
    const body = await parseJsonBody(c);

    const errors = [validateEndpointUrl(body.endpoint_url), validateEvents(body.events)].filter(
      (error): error is ValidationItem => error !== undefined,
    );
    if (errors.length > 0) throw invalidRequestParameters(errors);

    const endpointUrl = body.endpoint_url as string;
    const events = body.events as string[];
    assertWebhookUrl(endpointUrl);
    assertSubscribable(events);
    if (findOtherByUrl(endpointUrl)) throw duplicateEndpoint(endpointUrl);

    const endpoint = ws.webhookEndpoints.insert({
      object: 'webhook_endpoint',
      endpoint_url: endpointUrl,
      secret: generateWebhookSecret(),
      status: 'enabled',
      events: [...new Set(events)],
    });

    return c.json(formatWebhookEndpoint(endpoint), 201);
  });

  app.get('/webhook_endpoints', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);

    const result = ws.webhookEndpoints.list(params);
    return c.json(formatListResponse(result, formatWebhookEndpoint));
  });

  app.get('/webhook_endpoints/:id', (c) => {
    const ep = ws.webhookEndpoints.get(c.req.param('id'));
    if (!ep) throw notFound('Webhook Endpoint', c.req.param('id'));
    return c.json(formatWebhookEndpoint(ep));
  });

  app.patch('/webhook_endpoints/:id', async (c) => {
    const body = await parseJsonBody(c);

    // The DTO pipe runs while Nest resolves the handler's arguments, before the handler looks
    // the endpoint up, so a malformed body is a 422 even for an id that does not exist. Every
    // field is optional, and `@ValidateIf(value !== undefined)` means an explicit `null` is
    // validated — and rejected — rather than treated as absent.
    const errors = [
      body.endpoint_url !== undefined ? validateEndpointUrl(body.endpoint_url) : undefined,
      body.status !== undefined ? validateStatus(body.status) : undefined,
      body.events !== undefined ? validateEvents(body.events) : undefined,
    ].filter((error): error is ValidationItem => error !== undefined);
    if (errors.length > 0) throw invalidRequestParameters(errors);

    const ep = ws.webhookEndpoints.get(c.req.param('id'));
    if (!ep) throw notFound('Webhook Endpoint', c.req.param('id'));

    const updates: Partial<WorkOSWebhookEndpoint> = {};
    if (body.endpoint_url !== undefined) {
      const endpointUrl = body.endpoint_url as string;
      assertWebhookUrl(endpointUrl);
      updates.endpoint_url = endpointUrl;
    }
    if (body.events !== undefined) {
      const events = body.events as string[];
      assertSubscribable(events);
      updates.events = [...new Set(events)];
    }
    if (body.status !== undefined) {
      updates.status = body.status as WorkOSWebhookEndpoint['status'];
    }
    if (updates.endpoint_url !== undefined && findOtherByUrl(updates.endpoint_url, ep.id)) {
      throw duplicateEndpoint(updates.endpoint_url);
    }

    const updated = ws.webhookEndpoints.update(ep.id, updates);
    return c.json(formatWebhookEndpoint(updated!));
  });

  app.delete('/webhook_endpoints/:id', (c) => {
    const ep = ws.webhookEndpoints.get(c.req.param('id'));
    if (!ep) throw notFound('Webhook Endpoint', c.req.param('id'));
    ws.webhookEndpoints.delete(ep.id);
    return c.body(null, 204);
  });
}
