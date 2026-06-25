/**
 * Core codegen logic for gen-events. Separated from the CLI entry point
 * so the transformation functions can be unit-tested independently.
 *
 * Extracts the webhook event catalog from a WorkOS OpenAPI spec:
 *   - subscribable event names (CreateWebhookEndpointDto.properties.events.items.enum)
 *   - per-event payload schemas (any object schema with properties.event.const)
 * and generates src/workos/generated/events.ts.
 */

import { toPascalCase } from './gen-routes-lib.js';

// ---------------------------------------------------------------------------
// Spec types (looser than gen-routes-lib: `type` may be a string or an array
// per JSON Schema 2020, and we walk arbitrary nesting)
// ---------------------------------------------------------------------------

export interface EventSchemaNode {
  type?: string | string[];
  const?: string;
  enum?: string[];
  properties?: Record<string, EventSchemaNode>;
  required?: string[];
  items?: EventSchemaNode;
  $ref?: string;
  [key: string]: unknown;
}

export interface ParsedEvent {
  /** Event name, e.g. "authentication.magic_auth_failed" */
  name: string;
  /** Required fields of the event's data payload */
  dataRequired: string[];
  /** Properties of the data payload schema (post-$ref resolution) */
  dataProperties: Record<string, EventSchemaNode>;
  /** const value of data.type, when present (authentication events) */
  dataType?: string;
  /** const value of data.status, when present */
  dataStatus?: string;
}

export interface ParsedEventCatalog {
  /** Names subscribable via webhook endpoints */
  subscribable: string[];
  /** Every event with a payload schema in the spec, sorted by name */
  events: ParsedEvent[];
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Convert an event name to a camelCase constant key: "dsync.group.user_added" → "dsyncGroupUserAdded" */
export function eventConstantKey(name: string): string {
  const pascal = toPascalCase(name.replace(/\./g, '_'));
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

function resolveRef(node: EventSchemaNode | undefined, spec: EventSchemaNode): EventSchemaNode | undefined {
  if (!node?.$ref) return node;
  const match = node.$ref.match(/^#\/components\/schemas\/(.+)$/);
  if (!match) return node;
  const schemas = (spec as { components?: { schemas?: Record<string, EventSchemaNode> } }).components?.schemas;
  return schemas?.[match[1]] ?? node;
}

export function parseEventCatalog(spec: EventSchemaNode): ParsedEventCatalog {
  // Subscribable names: CreateWebhookEndpointDto.properties.events.items.enum
  const schemas = (spec as { components?: { schemas?: Record<string, EventSchemaNode> } }).components?.schemas ?? {};
  const subscribable = schemas.CreateWebhookEndpointDto?.properties?.events?.items?.enum;
  if (!subscribable || subscribable.length === 0) {
    throw new Error('Could not find CreateWebhookEndpointDto.properties.events.items.enum in the spec');
  }

  // Payload schemas: walk the whole spec for object schemas shaped like an
  // event (properties.event.const + properties.data). Location-independent so
  // spec refactors don't break extraction.
  const byName = new Map<string, ParsedEvent>();
  const visited = new WeakSet<object>();

  const visit = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (visited.has(node)) return;
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    const schema = node as EventSchemaNode;
    const eventName = schema.properties?.event?.const;
    if (typeof eventName === 'string' && schema.properties?.data && !byName.has(eventName)) {
      const data = resolveRef(schema.properties.data, spec) ?? {};
      byName.set(eventName, {
        name: eventName,
        dataRequired: data.required ?? [],
        dataProperties: data.properties ?? {},
        dataType: data.properties?.type?.const,
        dataStatus: data.properties?.status?.const,
      });
    }

    for (const value of Object.values(schema)) visit(value);
  };
  visit(spec);

  return {
    subscribable: [...subscribable].sort(),
    events: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------
// AuthenticationEventData derivation
// ---------------------------------------------------------------------------

function isAuthOutcomeEvent(name: string): boolean {
  return name.startsWith('authentication.') && (name.endsWith('_succeeded') || name.endsWith('_failed'));
}

function schemaToTs(node: EventSchemaNode): string {
  if (node.const) return `'${node.const}'`;
  const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
  if (types.includes('object') || node.properties) {
    const props = node.properties ?? {};
    const required = new Set(node.required ?? []);
    const entries = Object.entries(props).map(
      ([key, value]) => `${key}${required.has(key) ? '' : '?'}: ${schemaToTs(value)}`,
    );
    return entries.length > 0 ? `{ ${entries.join('; ')} }` : 'Record<string, unknown>';
  }
  const mapped = types.map((t) => (t === 'null' ? 'null' : t === 'integer' ? 'number' : t));
  return mapped.length > 0 ? mapped.join(' | ') : 'unknown';
}

/**
 * Derive the AuthenticationEventData interface from the union of all
 * authentication.*_succeeded / *_failed data schemas. Fields with const
 * values become literal unions (status, type); fields missing from some
 * schemas become optional (error only exists on failed events).
 */
export function deriveAuthEventDataFields(
  events: ParsedEvent[],
): Array<{ name: string; tsType: string; optional: boolean }> {
  const authEvents = events.filter((e) => isAuthOutcomeEvent(e.name));
  if (authEvents.length === 0) return [];

  const fieldNames: string[] = [];
  for (const event of authEvents) {
    for (const name of Object.keys(event.dataProperties)) {
      if (!fieldNames.includes(name)) fieldNames.push(name);
    }
  }

  return fieldNames.map((name) => {
    const presentIn = authEvents.filter((e) => name in e.dataProperties);
    const optional = presentIn.length < authEvents.length;

    const consts = new Set<string>();
    const nonConstTypes = new Set<string>();
    for (const event of presentIn) {
      const node = event.dataProperties[name];
      if (node.const) {
        consts.add(`'${node.const}'`);
      } else {
        // Flatten union atoms so "string" + "string | null" dedup to "string | null"
        const ts = schemaToTs(node);
        for (const atom of ts.includes('{') ? [ts] : ts.split(' | ')) nonConstTypes.add(atom);
      }
    }
    const atoms = [...nonConstTypes].sort((a, b) => (a === 'null' ? 1 : b === 'null' ? -1 : a.localeCompare(b)));
    const tsType =
      consts.size > 0 && atoms.length === 0 ? [...consts].sort().join(' | ') : atoms.join(' | ') || 'unknown';
    return { name, tsType, optional };
  });
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

export function generateEventsFile(catalog: ParsedEventCatalog): string {
  const allNames = [...new Set([...catalog.subscribable, ...catalog.events.map((e) => e.name)])].sort();

  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * Generated by scripts/gen-events.ts — do not edit by hand.');
  lines.push(' * Source: the @workos/openapi-spec package. Regenerate with:');
  lines.push(' *   npm run gen:events');
  lines.push(' */');
  lines.push('');
  lines.push('/** All WorkOS event names defined in the OpenAPI spec. */');
  lines.push('export const EVENTS = {');
  for (const name of allNames) {
    lines.push(`  ${eventConstantKey(name)}: '${name}',`);
  }
  lines.push('} as const;');
  lines.push('');
  lines.push('export type WorkOSEventName = (typeof EVENTS)[keyof typeof EVENTS];');
  lines.push('');
  lines.push('/** Event names subscribable via webhook endpoints (CreateWebhookEndpointDto). */');
  lines.push('export const SUBSCRIBABLE_EVENTS: readonly WorkOSEventName[] = [');
  for (const name of catalog.subscribable) {
    lines.push(`  '${name}',`);
  }
  lines.push('];');
  lines.push('');

  const authFields = deriveAuthEventDataFields(catalog.events);
  if (authFields.length > 0) {
    lines.push('/** Payload shape shared by authentication.*_succeeded / *_failed events. */');
    lines.push('export interface AuthenticationEventData {');
    for (const field of authFields) {
      lines.push(`  ${field.name}${field.optional ? '?' : ''}: ${field.tsType};`);
    }
    lines.push('}');
    lines.push('');
  }

  lines.push('/** Per-event payload requirements from the spec, for test assertions. */');
  lines.push('export const EVENT_DATA_REQUIREMENTS: Record<');
  lines.push('  string,');
  lines.push('  { type?: string; status?: string; required: readonly string[] }');
  lines.push('> = {');
  for (const event of catalog.events) {
    const parts: string[] = [];
    if (event.dataType) parts.push(`type: '${event.dataType}'`);
    if (event.dataStatus) parts.push(`status: '${event.dataStatus}'`);
    parts.push(`required: [${event.dataRequired.map((f) => `'${f}'`).join(', ')}]`);
    lines.push(`  '${event.name}': { ${parts.join(', ')} },`);
  }
  lines.push('};');
  lines.push('');

  return lines.join('\n');
}
