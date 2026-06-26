/**
 * Core codegen logic for gen-shapes. Separated from the CLI entry point so the
 * transformation functions can be unit-tested independently.
 *
 * Extracts per-resource response *shapes* (property + required field sets) from
 * a WorkOS OpenAPI spec and generates src/workos/generated/response-shapes.ts.
 *
 * Unlike the event catalog — discovered structurally via properties.event.const
 * — resource schemas are neither uniformly named nor uniformly shaped in the
 * spec (e.g. `UserObject` is a partial SCIM-style user, while `UserlandUser` is
 * the AuthKit User Management user). So the authoritative schema per emulator
 * object type is curated in OBJECT_SCHEMA_MAP below: only the *selection* is
 * hand-maintained — every field requirement is still extracted from the spec,
 * and extraction fails loudly if a mapped schema's `object` discriminator does
 * not match, so a spec rename can't silently point the test at the wrong shape.
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
];

export interface ParsedShape {
  objectType: string;
  schemaName: string;
  /** Every property the spec defines for this object, sorted. */
  properties: string[];
  /** Properties the spec marks required, sorted. */
  required: string[];
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
    required: [...(resolved.required ?? [])].sort(),
  };
}

export function parseShapeCatalog(
  spec: EventSchemaNode,
  map: readonly ShapeMapEntry[] = OBJECT_SCHEMA_MAP,
): ParsedShape[] {
  return map.map((entry) => extractShape(entry, spec)).sort((a, b) => a.objectType.localeCompare(b.objectType));
}

export function generateShapesFile(shapes: ParsedShape[]): string {
  const lines: string[] = [];
  lines.push('/**');
  lines.push(' * Generated by scripts/gen-shapes.ts — do not edit by hand.');
  lines.push(' * Source: the @workos/openapi-spec package. Regenerate with:');
  lines.push(' *   npm run gen:shapes');
  lines.push(' *');
  lines.push(' * Per-resource response shape requirements, extracted from the spec schema');
  lines.push(' * curated for each object type in scripts/gen-shapes-lib.ts (OBJECT_SCHEMA_MAP).');
  lines.push(' * Consumed by src/workos/response-shapes.spec.ts to assert the hand-written');
  lines.push(' * format* helpers match the spec and never leak internal fields.');
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
  return lines.join('\n');
}
