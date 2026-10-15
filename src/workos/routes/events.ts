import { type RouteContext, parseArrayParam, parseListParams } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatEvent, formatListResponse } from '../helpers.js';
import type { WorkOSEvent } from '../entities.js';

export function eventRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.get('/events', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    // The spec says `style: form, explode: false` (`events=a,b`), which is what workos-python,
    // -kotlin, -elixir and -rust send. The other SDKs send the forms parseArrayParam also takes.
    const eventTypes = parseArrayParam(url, 'events');
    const organizationId = url.searchParams.get('organization_id');
    const rangeStart = url.searchParams.get('range_start');
    const rangeEnd = url.searchParams.get('range_end');

    const result = ws.events.list({
      ...params,
      filter: (event) =>
        (eventTypes.length === 0 || eventTypes.includes(event.event)) &&
        eventInScope(event, organizationId, rangeStart, rangeEnd),
    });

    return c.json(formatListResponse(result, formatEvent));
  });
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
