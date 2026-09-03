/**
 * Core codegen logic for gen-shapes. Separated from the CLI entry point so the
 * transformation functions can be unit-tested independently.
 *
 * Extracts response *shapes* (property + required field sets) from a WorkOS
 * OpenAPI spec and generates src/workos/generated/response-shapes.ts.
 *
 * Two catalogs, because a response body has two layers that can drift apart:
 *
 *   1. OBJECT_SCHEMA_MAP — the *resource* objects (`user`, `api_key`, ...),
 *      keyed by the emulator's `object` discriminator. Covers what the
 *      hand-written format* helpers emit.
 *   2. ENVELOPE_SCHEMA_MAP — the *envelope* a route wraps a resource in
 *      (`{ api_key }`, `{ object, data, list_metadata }`, ...), keyed by
 *      operation. Envelopes have no `object` discriminator, so catalog 1 cannot
 *      see them — and an envelope is assembled inline in the route handler,
 *      which is exactly where a plausible-looking invention like `{ valid }`
 *      slips past a spec that says `{ api_key }`.
 *
 * Unlike the event catalog — discovered structurally via properties.event.const
 * — resource schemas are neither uniformly named nor uniformly shaped in the
 * spec (e.g. `UserObject` is a partial SCIM-style user, while `UserlandUser` is
 * the AuthKit User Management user). So the authoritative schema is curated per
 * entry in both maps below: only the *selection* is hand-maintained — every
 * field requirement is still extracted from the spec, and extraction fails
 * loudly when a mapped schema's `object` discriminator (catalog 1) or an
 * operation's declared `$ref` (catalog 2) does not match, so a spec rename
 * can't silently point the test at the wrong shape.
 */
import type { EventSchemaNode } from './gen-events-lib.js';

export interface ShapeMapEntry {
  /** The emulator's `object` discriminator, e.g. "user". */
  objectType: string;
  /** The authoritative spec schema name in components.schemas, e.g. "UserlandUser". */
  schemaName: string;
}

/**
 * Which spec schema is authoritative for each emulator response object.
 *
 * Scoped to the pure-data resources whose emulator output should mirror the
 * spec 1:1. Auth/flow payloads (authenticate, authorize) deliberately stay out
 * — their shapes are covered by the event catalog's EVENT_DATA_REQUIREMENTS.
 * The password reset is the one flow resource included: the spec documents its
 * token (`password_reset_token`), so on the wire it is pure data too.
 */
export const OBJECT_SCHEMA_MAP: readonly ShapeMapEntry[] = [
  { objectType: 'user', schemaName: 'UserlandUser' },
  { objectType: 'organization', schemaName: 'Organization' },
  { objectType: 'connection', schemaName: 'Connection' },
  { objectType: 'directory', schemaName: 'Directory' },
  { objectType: 'directory_group', schemaName: 'DirectoryGroup' },
  { objectType: 'directory_user', schemaName: 'DirectoryUserWithGroups' },
  { objectType: 'role', schemaName: 'Role' },
  { objectType: 'permission', schemaName: 'AuthorizationPermission' },
  { objectType: 'api_key', schemaName: 'ApiKey' },
  { objectType: 'password_reset', schemaName: 'PasswordReset' },
];

export interface EnvelopeMapEntry {
  /** HTTP method, uppercase. */
  method: string;
  /** The spec path with params in braces, e.g. "/organizations/{organizationId}/api_keys". */
  path: string;
  /** The response status whose body is authoritative, e.g. "200". */
  status: string;
  /** The expected components.schemas name — asserted against what the operation declares. */
  schemaName: string;
}

/**
 * Which operations' top-level response envelopes are checked against the spec.
 *
 * Scoped to operations whose envelope the emulator assembles by hand and whose
 * body is pure data. Auth/flow endpoints (`/user_management/authenticate`,
 * `/oauth2/token`) deliberately stay out: they are hand-authored runtime OAuth
 * behavior the spec does not describe.
 *
 * Adding an entry here is cheap; the test that consumes it must exercise the
 * operation for real, and asserts it covers this catalog exactly, so a new entry
 * without a matching request fails rather than silently going unchecked.
 */
export const ENVELOPE_SCHEMA_MAP: readonly EnvelopeMapEntry[] = [
  // Single-resource and single-value envelopes — each a distinct hand-assembled shape,
  // and the class of body where an invention is easiest to miss.
  { method: 'POST', path: '/api_keys/validations', status: '200', schemaName: 'ApiKeyValidationResponse' },
  { method: 'POST', path: '/portal/generate_link', status: '201', schemaName: 'PortalLinkResponse' },
  { method: 'POST', path: '/widgets/token', status: '201', schemaName: 'WidgetSessionTokenResponse' },
  {
    method: 'POST',
    path: '/user_management/password_reset/confirm',
    status: '200',
    schemaName: 'ResetPasswordResponse',
  },
  // Resource bodies rather than wrappers — but the route is the surface the SDKs read, and the
  // one that drifted to a bare `token` (issue #98). The resource catalog only sees the formatter.
  { method: 'POST', path: '/user_management/password_reset', status: '201', schemaName: 'PasswordReset' },
  { method: 'GET', path: '/user_management/password_reset/{id}', status: '200', schemaName: 'PasswordReset' },
  {
    method: 'POST',
    path: '/user_management/users/{id}/email_verification/send',
    status: '200',
    schemaName: 'SendVerificationEmailResponse',
  },
  {
    method: 'POST',
    path: '/authorization/organization_memberships/{organization_membership_id}/check',
    status: '200',
    schemaName: 'AuthorizationCheck',
  },
  { method: 'GET', path: '/sso/jwks/{clientId}', status: '200', schemaName: 'JwksResponse' },
  // Paginated list envelopes. Several, not one, because each is wrapped by a different
  // route — a route that forgets `list_metadata` is invisible if only its neighbour is checked.
  { method: 'GET', path: '/organizations', status: '200', schemaName: 'OrganizationList' },
  { method: 'GET', path: '/user_management/users', status: '200', schemaName: 'UserlandUserList' },
  { method: 'GET', path: '/connect/applications', status: '200', schemaName: 'ConnectApplicationList' },
  { method: 'GET', path: '/webhook_endpoints', status: '200', schemaName: 'WebhookEndpointList' },
  { method: 'GET', path: '/events', status: '200', schemaName: 'EventList' },
  {
    method: 'GET',
    path: '/organizations/{organizationId}/api_keys',
    status: '200',
    schemaName: 'OrganizationApiKeyList',
  },
];

export interface ParsedShape {
  objectType: string;
  schemaName: string;
  /** Every property the spec defines for this object, sorted. */
  properties: string[];
  /** Properties the spec marks required, sorted. */
  required: string[];
}

export interface ParsedEnvelope {
  /** Catalog key, e.g. "POST /api_keys/validations". */
  operation: string;
  schemaName: string;
  /** Every top-level property the spec defines for the envelope, sorted. */
  properties: string[];
  /** Top-level properties the spec marks required, sorted. */
  required: string[];
}

/**
 * Sorted, de-duplicated field list. `resolveSchema` concatenates `required` across allOf
 * members, so a field two members both mark required would otherwise appear twice — a
 * duplicate in the generated catalog reads like a spec quirk rather than a merge artifact.
 */
function sortedUnique(fields: string[] | undefined): string[] {
  return [...new Set(fields ?? [])].sort();
}

function getSchemas(spec: EventSchemaNode): Record<string, EventSchemaNode> {
  const components = (spec as { components?: { schemas?: Record<string, EventSchemaNode> } }).components;
  return components?.schemas ?? {};
}

/**
 * Resolve a schema node to a plain object schema: follows $ref and merges allOf
 * members (properties unioned, required concatenated). oneOf/anyOf cannot be
 * resolved to a single shape and are left as-is at the top level (extractShape
 * then fails loudly on the resulting empty property set). An allOf member that
 * resolves to a oneOf/anyOf is rejected here rather than silently contributing
 * no fields — otherwise the generated catalog would understate the spec shape.
 * `seen` guards ref cycles.
 */
export function resolveSchema(
  node: EventSchemaNode,
  spec: EventSchemaNode,
  seen: Set<string> = new Set(),
): EventSchemaNode {
  if (node.$ref) {
    const match = node.$ref.match(/^#\/components\/schemas\/(.+)$/);
    if (match && !seen.has(match[1])) {
      seen.add(match[1]);
      const target = getSchemas(spec)[match[1]];
      if (target) return resolveSchema(target, spec, seen);
    }
    return node;
  }

  const allOf = node.allOf as EventSchemaNode[] | undefined;
  if (allOf) {
    const merged: EventSchemaNode = { type: 'object', properties: {}, required: [] };
    for (const sub of allOf) {
      const resolved = resolveSchema(sub, spec, seen);
      if (resolved.oneOf || resolved.anyOf) {
        throw new Error(
          'gen-shapes: allOf member resolved to a oneOf/anyOf — cannot merge into a single object shape without dropping fields',
        );
      }
      Object.assign(merged.properties!, resolved.properties ?? {});
      if (resolved.required) merged.required!.push(...resolved.required);
    }
    // Properties/required declared alongside allOf also count.
    Object.assign(merged.properties!, node.properties ?? {});
    if (node.required) merged.required!.push(...node.required);
    return merged;
  }

  return node;
}

export function extractShape(entry: ShapeMapEntry, spec: EventSchemaNode): ParsedShape {
  const raw = getSchemas(spec)[entry.schemaName];
  if (!raw) {
    throw new Error(
      `gen-shapes: schema "${entry.schemaName}" (mapped from object "${entry.objectType}") not found in components.schemas`,
    );
  }

  const resolved = resolveSchema(raw, spec);
  const properties = Object.keys(resolved.properties ?? {});
  if (properties.length === 0) {
    throw new Error(`gen-shapes: schema "${entry.schemaName}" resolved to no properties — wrong schema name?`);
  }

  // Guard the curation: the schema must declare an `object` discriminator that
  // matches the emulator object type. Resource *response* schemas carry it
  // (`object: { const: "user" }`); request DTOs do not — so this rejects a
  // mismapping to e.g. `OrganizationDto`, and a spec rename that repoints a
  // schema fails here instead of silently asserting against the wrong shape.
  const objectField = resolved.properties?.object;
  const objectConst = objectField?.const ?? (objectField?.enum?.length === 1 ? objectField.enum[0] : undefined);
  if (objectConst === undefined) {
    throw new Error(
      `gen-shapes: schema "${entry.schemaName}" (object "${entry.objectType}") has no \`object\` discriminator — is it a response schema, not a request DTO?`,
    );
  }
  if (objectConst !== entry.objectType) {
    throw new Error(
      `gen-shapes: schema "${entry.schemaName}" has object const "${objectConst}", expected "${entry.objectType}"`,
    );
  }

  return {
    objectType: entry.objectType,
    schemaName: entry.schemaName,
    properties: [...properties].sort(),
    required: sortedUnique(resolved.required),
  };
}

export function parseShapeCatalog(
  spec: EventSchemaNode,
  map: readonly ShapeMapEntry[] = OBJECT_SCHEMA_MAP,
): ParsedShape[] {
  return map.map((entry) => extractShape(entry, spec)).sort((a, b) => a.objectType.localeCompare(b.objectType));
}

/** The catalog key for an envelope entry, e.g. "POST /api_keys/validations". */
export function envelopeKey(entry: Pick<EnvelopeMapEntry, 'method' | 'path'>): string {
  return `${entry.method.toUpperCase()} ${entry.path}`;
}

export function extractEnvelope(entry: EnvelopeMapEntry, spec: EventSchemaNode): ParsedEnvelope {
  const key = envelopeKey(entry);
  const paths = (spec as { paths?: Record<string, EventSchemaNode> }).paths ?? {};
  const pathItem = paths[entry.path];
  if (!pathItem) {
    throw new Error(`gen-shapes: path "${entry.path}" (${key}) not found in spec paths`);
  }

  const operation = pathItem[entry.method.toLowerCase()] as EventSchemaNode | undefined;
  if (!operation) {
    throw new Error(`gen-shapes: path "${entry.path}" declares no ${entry.method} operation`);
  }

  const responses = operation.responses as Record<string, EventSchemaNode> | undefined;
  const response = responses?.[entry.status];
  const content = response?.content as Record<string, EventSchemaNode> | undefined;
  const schemaNode = content?.['application/json']?.schema as EventSchemaNode | undefined;
  if (!schemaNode) {
    throw new Error(`gen-shapes: ${key} declares no application/json schema for status ${entry.status}`);
  }

  // Guard the curation: the operation must declare exactly the mapped schema. This is the
  // envelope counterpart to the `object` discriminator check — a spec rename, or an
  // operation repointed at a different response schema, fails here rather than leaving the
  // test asserting yesterday's contract.
  const declared = schemaNode.$ref?.match(/^#\/components\/schemas\/(.+)$/)?.[1];
  if (declared !== entry.schemaName) {
    throw new Error(
      `gen-shapes: ${key} declares response schema ${declared ?? '(inline)'}, expected "${entry.schemaName}"`,
    );
  }

  const resolved = resolveSchema(schemaNode, spec);
  const properties = Object.keys(resolved.properties ?? {});
  if (properties.length === 0) {
    throw new Error(`gen-shapes: schema "${entry.schemaName}" (${key}) resolved to no properties`);
  }

  return {
    operation: key,
    schemaName: entry.schemaName,
    properties: [...properties].sort(),
    required: sortedUnique(resolved.required),
  };
}

export function parseEnvelopeCatalog(
  spec: EventSchemaNode,
  map: readonly EnvelopeMapEntry[] = ENVELOPE_SCHEMA_MAP,
): ParsedEnvelope[] {
  return map.map((entry) => extractEnvelope(entry, spec)).sort((a, b) => a.operation.localeCompare(b.operation));
}

export function generateShapesFile(shapes: ParsedShape[], envelopes: ParsedEnvelope[]): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * Generated by scripts/gen-shapes.ts — do not edit by hand.');
  lines.push(' * Source: the @workos/openapi-spec package. Regenerate with:');
  lines.push(' *   npm run gen:shapes');
  lines.push(' *');
  lines.push(' * Response shape requirements extracted from the spec schemas curated in');
  lines.push(' * scripts/gen-shapes-lib.ts:');
  lines.push(' *   - RESPONSE_SHAPE_REQUIREMENTS    per resource   (OBJECT_SCHEMA_MAP)');
  lines.push(' *   - RESPONSE_ENVELOPE_REQUIREMENTS per operation  (ENVELOPE_SCHEMA_MAP)');
  lines.push(' *');
  lines.push(' * Consumed by src/workos/response-shapes.spec.ts and');
  lines.push(' * src/workos/response-envelopes.spec.ts to assert the emulator matches the');
  lines.push(' * spec and never leaks internal fields.');
  lines.push(' */');
  lines.push('');
  lines.push('export interface ResponseShapeRequirement {');
  lines.push('  /** The spec schema (components.schemas) this shape was extracted from. */');
  lines.push('  schema: string;');
  lines.push('  /** Every property the spec defines for this object. */');
  lines.push('  properties: readonly string[];');
  lines.push('  /** Properties the spec marks required. */');
  lines.push('  required: readonly string[];');
  lines.push('}');
  lines.push('');
  lines.push('export const RESPONSE_SHAPE_REQUIREMENTS: Record<string, ResponseShapeRequirement> = {');
  for (const shape of shapes) {
    const props = shape.properties.map((p) => `'${p}'`).join(', ');
    const req = shape.required.map((p) => `'${p}'`).join(', ');
    lines.push(`  ${shape.objectType}: {`);
    lines.push(`    schema: '${shape.schemaName}',`);
    lines.push(`    properties: [${props}],`);
    lines.push(`    required: [${req}],`);
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  lines.push('/**');
  lines.push(' * Top-level envelope requirements, keyed by "METHOD /spec/path". The nested');
  lines.push(' * resource is covered by RESPONSE_SHAPE_REQUIREMENTS; these are the wrapper');
  lines.push(' * fields the route handler itself is responsible for.');
  lines.push(' */');
  lines.push('export const RESPONSE_ENVELOPE_REQUIREMENTS: Record<string, ResponseShapeRequirement> = {');
  for (const envelope of envelopes) {
    const props = envelope.properties.map((p) => `'${p}'`).join(', ');
    const req = envelope.required.map((p) => `'${p}'`).join(', ');
    lines.push(`  '${envelope.operation}': {`);
    lines.push(`    schema: '${envelope.schemaName}',`);
    lines.push(`    properties: [${props}],`);
    lines.push(`    required: [${req}],`);
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}
