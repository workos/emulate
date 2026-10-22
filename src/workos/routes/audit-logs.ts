import { createHash } from 'node:crypto';
import {
  type RouteContext,
  WorkOSApiError,
  generateUlid,
  notFound,
  parseJsonBody,
  validationError,
  parseListParams,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatAuditLogAction, formatAuditLogExport, formatListResponse } from '../helpers.js';
import { STORE_KEY_PREFIXES } from '../constants.js';
import type { WorkOSAuditLogEventActor, WorkOSAuditLogEventContext, WorkOSAuditLogEventTarget } from '../entities.js';

/** Production's `DEFAULT_EVENT_VERSION` (packages/api/src/audit-log-events/constants.ts). */
const DEFAULT_EVENT_VERSION = 1;

/**
 * Production's `partitioned_audit_log_events` table is range-partitioned by `occurred_at` from
 * 2018-10-01, with partitions created only a little ahead of time, so an event outside that
 * window is refused up front rather than acknowledged and then lost
 * (packages/api/src/audit-log-validation-runner/audit-log-validation-runner.ts).
 */
const MIN_OCCURRED_AT = new Date('2018-10-01T00:00:00.000Z');
const MAX_OCCURRED_AT_FUTURE_MS = 24 * 60 * 60 * 1000;

/**
 * validator.js's `isISO8601` pattern, which class-validator's `@IsDateString()` applies without
 * its strict option, so `occurred_at` passes and fails exactly where production's DTO does. It
 * checks shape only — a week date like `2026-W05` matches — and the `Date` parse in the range
 * check below then makes of the value whatever production's does.
 */
const ISO_8601 =
  /^([+-]?\d{4}(?!\d{2}\b))((-?)((0[1-9]|1[0-2])(\3([12]\d|0[1-9]|3[01]))?|W([0-4]\d|5[0-3])(\3[1-7])?|(00[1-9]|0[1-9]\d|[12]\d{2}|3([0-5]\d|6[1-6])))([T\s]((([01]\d|2[0-3])((:?)[0-5]\d)?|24:?00)([.,]\d+(?!:))?)?(\17[0-5]\d([.,]\d+)?)?([zZ]|([+-])([01]\d|2[0-3]):?([0-5]\d)?)?)?)?$/;

interface FieldError {
  field: string;
  code: string;
}

/** The `event` body once `validateIngestionBody` has passed it. */
interface IngestionEvent {
  action: string;
  occurred_at: string;
  actor: WorkOSAuditLogEventActor;
  targets: WorkOSAuditLogEventTarget[];
  context: WorkOSAuditLogEventContext;
  metadata?: Record<string, unknown> | null;
  version?: number | null;
}

/** class-validator's `isObject`: any non-array object, which is all `@IsObject()` asks. */
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && !Array.isArray(value);
}

/**
 * Production validates the body as `AuditLogEventIngestionDto`
 * (packages/api/src/audit-log-events/dto/audit-log-event-ingestion.dto.ts) through its
 * class-validator pipe, which reports the first failing constraint of every property: the
 * property's dotted path as `field` and class-validator's default message, built from the leaf
 * property name, as `code`. Each check here is one decorator on that DTO, in declaration order,
 * so the list comes out in production's order. `@IsOptional()` properties skip every check when
 * null or absent, as the decorator does.
 */
function validateIngestionBody(body: Record<string, unknown>): FieldError[] {
  const errors: FieldError[] = [];
  const fail = (field: string, rule: string) => {
    errors.push({ field, code: `${field.slice(field.lastIndexOf('.') + 1)} ${rule}` });
  };
  const optionalString = (field: string, value: unknown) => {
    if (value != null && typeof value !== 'string') fail(field, 'must be a string');
  };
  const optionalObject = (field: string, value: unknown) => {
    if (value != null && !isObject(value)) fail(field, 'must be an object');
  };
  // `AuditLogEventActorDto` and `AuditLogEventTargetDto` declare the same four properties.
  const party = (field: string, value: Record<string, unknown>) => {
    if (typeof value.id !== 'string') fail(`${field}.id`, 'must be a string');
    if (typeof value.type !== 'string') fail(`${field}.type`, 'must be a string');
    optionalString(`${field}.name`, value.name);
    optionalObject(`${field}.metadata`, value.metadata);
  };

  if (typeof body.organization_id !== 'string') fail('organization_id', 'must be a string');

  const event = body.event;
  if (!isObject(event)) {
    fail('event', 'must be an object');
    return errors;
  }
  if (typeof event.action !== 'string') fail('event.action', 'must be a string');
  if (typeof event.occurred_at !== 'string' || !ISO_8601.test(event.occurred_at)) {
    fail('event.occurred_at', 'must be a valid ISO 8601 date string');
  }
  if (isObject(event.actor)) {
    party('event.actor', event.actor);
  } else {
    fail('event.actor', 'must be an object');
  }
  if (Array.isArray(event.targets)) {
    event.targets.forEach((target: unknown, index) => {
      if (isObject(target)) {
        party(`event.targets.${index}`, target);
      } else {
        // What `@ValidateNested({ each: true })` says of an element that is not an object.
        errors.push({
          field: `event.targets.${index}`,
          code: 'nested property targets must be either object or array',
        });
      }
    });
  } else {
    fail('event.targets', 'must be an array');
  }
  if (isObject(event.context)) {
    if (typeof event.context.location !== 'string') fail('event.context.location', 'must be a string');
    optionalString('event.context.user_agent', event.context.user_agent);
  } else {
    fail('event.context', 'must be an object');
  }
  optionalObject('event.metadata', event.metadata);
  if (event.version != null && !Number.isInteger(event.version)) {
    fail('event.version', 'must be an integer number');
  }
  return errors;
}

/** Key-order-independent form, so a retried request hashes the same however its JSON was built. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function auditLogRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  // List actions
  app.get('/audit_logs/actions', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const result = ws.auditLogActions.list({ ...params });
    return c.json(formatListResponse(result, formatAuditLogAction));
  });

  // Create/update action schema
  app.post('/audit_logs/actions/:actionName/schemas', async (c) => {
    const actionName = c.req.param('actionName');
    const body = await parseJsonBody(c);

    // Upsert: find existing action or create new one
    let action = ws.auditLogActions.findOneBy('name', actionName);
    if (action) {
      // Store schema in store data keyed by action name
      store.setData(`${STORE_KEY_PREFIXES.auditSchema}${actionName}`, body);
      return c.json(formatAuditLogAction(action));
    }

    action = ws.auditLogActions.insert({
      object: 'audit_log_action',
      name: actionName,
      description: null,
      condition: null,
    });
    store.setData(`${STORE_KEY_PREFIXES.auditSchema}${actionName}`, body);
    return c.json(formatAuditLogAction(action), 201);
  });

  /**
   * Create audit log event. Production's `AuditLogEventsController.create` takes
   * `{organization_id, event}`, answers `200 {success: true}`, and in this order: 422s a body the
   * DTO rejects, 404s an organization it does not have, 400s an event its validation runner
   * refuses, then stores the event under an idempotency key. The runner also checks the event
   * against the schema registered for its action — target types, metadata keys — and 400s an
   * action with none; the emulator keeps no registry, so that step is the one not mirrored.
   */
  app.post('/audit_logs/events', async (c) => {
    const body = await parseJsonBody(c);
    const errors = validateIngestionBody(body);
    if (errors.length > 0) {
      // Production's validation pipe renders this body itself, with no top-level `code`
      // (packages/api/src/common/pipes/validation.pipe.ts), unlike the emulator's other 422s.
      return c.json({ message: 'Validation failed', errors }, 422);
    }
    const organizationId = body.organization_id as string;
    const event = body.event as IngestionEvent;

    if (!ws.organizations.get(organizationId)) throw notFound('Organization', organizationId);

    // Production resolves the version before anything else looks at the event, so an explicit
    // `version: 1` and an omitted one are the same event: same hash, same idempotency key.
    const version = event.version ?? DEFAULT_EVENT_VERSION;
    const occurredAt = new Date(event.occurred_at);
    const maxOccurredAt = new Date(Date.now() + MAX_OCCURRED_AT_FUTURE_MS);
    if (Number.isNaN(occurredAt.getTime()) || occurredAt < MIN_OCCURRED_AT || occurredAt > maxOccurredAt) {
      throw new WorkOSApiError(
        400,
        `Invalid Audit Log event: 'occurred_at' must be between '${MIN_OCCURRED_AT.toISOString()}' and '${maxOccurredAt.toISOString()}'. Received '${event.occurred_at}'`,
        'invalid_audit_log',
      );
    }

    // Production keys the stored row by `<Idempotency-Key>.<hash of the event>`, an autogenerated
    // ULID standing in for a missing header, and ignores an insert that collides: a retried
    // request stores nothing new, while the same key on a different body is a different event.
    const hash = createHash('sha256')
      .update(JSON.stringify(canonicalize({ ...event, version })))
      .digest('hex');
    const idempotencyKey = `${c.req.header('Idempotency-Key') || `autogenerated-${generateUlid()}`}.${hash}`;
    const duplicate = ws.auditLogEvents
      .findBy('idempotency_key', idempotencyKey)
      .some((existing) => existing.organization_id === organizationId);
    if (!duplicate) {
      ws.auditLogEvents.insert({
        object: 'audit_log_event',
        organization_id: organizationId,
        action: event.action,
        occurred_at: event.occurred_at,
        actor: event.actor,
        targets: event.targets,
        context: event.context,
        metadata: event.metadata,
        version,
        idempotency_key: idempotencyKey,
      });
    }

    return c.json({ success: true });
  });

  // Create export (auto-transition to ready)
  app.post('/audit_logs/exports', async (c) => {
    const body = await parseJsonBody(c);
    const organizationId = body.organization_id as string | undefined;
    if (!organizationId) {
      throw validationError('organization_id is required', [{ field: 'organization_id', code: 'required' }]);
    }

    const exp = ws.auditLogExports.insert({
      object: 'audit_log_export',
      organization_id: organizationId,
      state: 'ready',
      url: `https://emulator.workos.test/exports/audit_log_export_mock.csv`,
      filters: (body.filters as Record<string, unknown>) ?? {},
    });

    return c.json(formatAuditLogExport(exp), 201);
  });

  // Get export
  app.get('/audit_logs/exports/:id', (c) => {
    const exp = ws.auditLogExports.get(c.req.param('id'));
    if (!exp) throw notFound('Audit Log Export', c.req.param('id'));
    return c.json(formatAuditLogExport(exp));
  });

  // Get org audit log configuration
  app.get('/organizations/:id/audit_log_configuration', (c) => {
    const orgId = c.req.param('id');
    return c.json({
      object: 'audit_log_configuration',
      organization_id: orgId,
      enabled: true,
      retention_days: 365,
    });
  });

  // Get org audit logs retention
  app.get('/organizations/:id/audit_logs_retention', (c) => {
    const orgId = c.req.param('id');
    return c.json({
      object: 'audit_logs_retention',
      organization_id: orgId,
      retention_days: 365,
    });
  });
}
