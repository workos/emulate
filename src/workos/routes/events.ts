import { type RouteContext, WorkOSApiError, parseArrayParam, parseListParams } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { EVENTS } from '../constants.js';
import { formatEvent, formatListResponse } from '../helpers.js';
import type { WorkOSEvent } from '../entities.js';

/** Every event name the spec defines — what production's `EventNamesZod` admits on `GET /events`. */
const KNOWN_EVENT_NAMES = new Set<string>(Object.values(EVENTS));

/**
 * Names production retired from `EventNamesZod` but still accepts and silently drops
 * (`DeprecatedEventNamesZod` in api-services `events/types/event-payload-zod.ts`), so a poller
 * that never updated its filter list keeps working. The spec does not carry them.
 */
const DEPRECATED_EVENT_NAMES = new Set<string>(['dsync.deactivated']);

function invalidEventsRequest(message: string): WorkOSApiError {
  return new WorkOSApiError(400, message, 'invalid_events_request');
}

export function eventRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.get('/events', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const organizationId = url.searchParams.get('organization_id');
    const rangeStart = url.searchParams.get('range_start');
    const rangeEnd = url.searchParams.get('range_end');

    // Production's `EventsController.list` rejects the pair before it reads anything else; an
    // empty `after=` still counts as given, since the DTO only treats null/undefined as absent.
    if (rangeStart !== null && url.searchParams.get('after') !== null) {
      throw invalidEventsRequest('Only one of range_start and after may be provided.');
    }

    const eventTypes = parseEventTypes(url);

    const result = ws.events.list({
      ...params,
      filter: (event) => eventTypes.includes(event.event) && eventInScope(event, organizationId, rangeStart, rangeEnd),
    });

    return c.json(formatListResponse(result, formatEvent));
  });
}

/**
 * The `events` filter is required, as in production: there is no "all events" listing.
 * The spec says `style: form, explode: false` (`events=a,b`), which is what workos-python,
 * -kotlin, -elixir and -rust send. The other SDKs send the forms parseArrayParam also takes.
 */
function parseEventTypes(url: URL): string[] {
  const missing = 'One or more event names (e.g. dsync.user.created) must be provided using the events parameter.';
  const given = [...url.searchParams.keys()].some((key) => key === 'events' || key.startsWith('events['));
  if (!given) throw invalidEventsRequest(missing);

  const eventTypes = parseArrayParam(url, 'events').filter((name) => !DEPRECATED_EVENT_NAMES.has(name));
  const unknown = eventTypes.find((name) => !KNOWN_EVENT_NAMES.has(name));
  if (unknown !== undefined) {
    throw invalidEventsRequest(`Invalid name parameter, received: '${unknown}'. You must pass in valid event names`);
  }
  if (eventTypes.length === 0) throw invalidEventsRequest(missing);
  return eventTypes;
}

function eventInScope(
  event: WorkOSEvent,
  organizationId: string | null,
  rangeStart: string | null,
  rangeEnd: string | null,
): boolean {
  if (organizationId && event.organization_id !== organizationId) return false;

  const createdAt = Date.parse(event.created_at);
  if (rangeStart) {
    const start = Date.parse(rangeStart);
    if (!Number.isNaN(createdAt) && !Number.isNaN(start) && createdAt < start) return false;
  }
  if (rangeEnd) {
    const end = Date.parse(rangeEnd);
    if (!Number.isNaN(createdAt) && !Number.isNaN(end) && createdAt > end) return false;
  }

  return true;
}
