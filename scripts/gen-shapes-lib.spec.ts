import { describe, it, expect } from 'bun:test';
import {
  resolveSchema,
  extractShape,
  extractEnvelope,
  parseShapeCatalog,
  parseEnvelopeCatalog,
  generateShapesFile,
  type ShapeMapEntry,
  type EnvelopeMapEntry,
} from './gen-shapes-lib.js';
import type { EventSchemaNode } from './gen-events-lib.js';

function spec(schemas: Record<string, EventSchemaNode>): EventSchemaNode {
  return { components: { schemas } } as unknown as EventSchemaNode;
}

/** A spec with both component schemas and paths, for the envelope catalog. */
function specWithPaths(schemas: Record<string, EventSchemaNode>, paths: Record<string, unknown>): EventSchemaNode {
  return { components: { schemas }, paths } as unknown as EventSchemaNode;
}

/** A minimal `responses` block pointing a status at a component schema. */
function jsonResponse(status: string, schemaName: string): Record<string, unknown> {
  return {
    responses: {
      [status]: { content: { 'application/json': { schema: { $ref: `#/components/schemas/${schemaName}` } } } },
    },
  };
}
function schema(s: EventSchemaNode, name: string): EventSchemaNode {
  return (s as { components: { schemas: Record<string, EventSchemaNode> } }).components.schemas[name];
}

describe('resolveSchema', () => {
  it('follows a $ref to its target schema', () => {
    const s = spec({
      Target: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      Ref: { $ref: '#/components/schemas/Target' },
    });
    const resolved = resolveSchema(schema(s, 'Ref'), s);
    expect(Object.keys(resolved.properties ?? {})).toEqual(['id']);
  });

  it('merges allOf members — properties unioned, required concatenated', () => {
    const s = spec({
      Base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      Thing: {
        allOf: [
          { $ref: '#/components/schemas/Base' },
          { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        ],
      } as unknown as EventSchemaNode,
    });
    const resolved = resolveSchema(schema(s, 'Thing'), s);
    expect(Object.keys(resolved.properties ?? {}).sort()).toEqual(['id', 'name']);
    expect((resolved.required ?? []).sort()).toEqual(['id', 'name']);
  });

  it('does not loop on a self-referential $ref', () => {
    const s = spec({ Cycle: { $ref: '#/components/schemas/Cycle' } });
    expect(() => resolveSchema(schema(s, 'Cycle'), s)).not.toThrow();
  });

  it('throws when an allOf member resolves to a oneOf/anyOf instead of silently dropping its fields', () => {
    const s = spec({
      Variant: {
        oneOf: [
          { type: 'object', properties: { a: { type: 'string' } } },
          { type: 'object', properties: { b: { type: 'string' } } },
        ],
      } as unknown as EventSchemaNode,
      Thing: {
        allOf: [{ type: 'object', properties: { id: { type: 'string' } } }, { $ref: '#/components/schemas/Variant' }],
      } as unknown as EventSchemaNode,
    });
    expect(() => resolveSchema(schema(s, 'Thing'), s)).toThrow(/oneOf\/anyOf/);
  });
});

describe('extractShape', () => {
  const widgetSpec = spec({
    Widget: {
      type: 'object',
      properties: { object: { const: 'widget' }, id: { type: 'string' }, color: { type: 'string' } },
      required: ['id', 'object'],
    },
  });

  it('extracts sorted properties and required from the mapped schema', () => {
    const shape = extractShape({ objectType: 'widget', schemaName: 'Widget' }, widgetSpec);
    expect(shape.properties).toEqual(['color', 'id', 'object']);
    expect(shape.required).toEqual(['id', 'object']);
    expect(shape.schemaName).toBe('Widget');
  });

  it('accepts an object discriminator expressed as a single-value enum', () => {
    const s = spec({
      Widget: {
        type: 'object',
        properties: { object: { enum: ['widget'] }, id: { type: 'string' } },
        required: ['id'],
      },
    });
    expect(() => extractShape({ objectType: 'widget', schemaName: 'Widget' }, s)).not.toThrow();
  });

  it('throws when the mapped schema is missing', () => {
    expect(() => extractShape({ objectType: 'widget', schemaName: 'Nope' }, widgetSpec)).toThrow(/not found/);
  });

  it('throws when the schema has no object discriminator (a request DTO)', () => {
    const s = spec({ CreateWidgetDto: { type: 'object', properties: { color: { type: 'string' } } } });
    expect(() => extractShape({ objectType: 'widget', schemaName: 'CreateWidgetDto' }, s)).toThrow(/discriminator/);
  });

  it('throws when the object discriminator does not match the mapped type', () => {
    expect(() => extractShape({ objectType: 'gadget', schemaName: 'Widget' }, widgetSpec)).toThrow(/expected "gadget"/);
  });
});

describe('parseShapeCatalog', () => {
  it('extracts each map entry and sorts by object type', () => {
    const s = spec({
      Beta: { type: 'object', properties: { object: { const: 'beta' }, id: { type: 'string' } }, required: ['id'] },
      Alpha: { type: 'object', properties: { object: { const: 'alpha' }, id: { type: 'string' } }, required: ['id'] },
    });
    const map: ShapeMapEntry[] = [
      { objectType: 'beta', schemaName: 'Beta' },
      { objectType: 'alpha', schemaName: 'Alpha' },
    ];
    expect(parseShapeCatalog(s, map).map((shape) => shape.objectType)).toEqual(['alpha', 'beta']);
  });
});

describe('extractEnvelope', () => {
  const envelopeSpec = specWithPaths(
    {
      WidgetValidation: {
        type: 'object',
        properties: { widget: { type: 'object' }, trace_id: { type: 'string' } },
        required: ['widget'],
      },
    },
    { '/widgets/validations': { post: jsonResponse('200', 'WidgetValidation') } },
  );
  const entry: EnvelopeMapEntry = {
    method: 'POST',
    path: '/widgets/validations',
    status: '200',
    schemaName: 'WidgetValidation',
  };

  it('extracts sorted top-level properties and required from the declared response schema', () => {
    const envelope = extractEnvelope(entry, envelopeSpec);
    expect(envelope.operation).toBe('POST /widgets/validations');
    expect(envelope.properties).toEqual(['trace_id', 'widget']);
    expect(envelope.required).toEqual(['widget']);
  });

  it('throws when the path is absent from the spec', () => {
    expect(() => extractEnvelope({ ...entry, path: '/nope' }, envelopeSpec)).toThrow(/not found in spec paths/);
  });

  it('throws when the path declares no such method', () => {
    expect(() => extractEnvelope({ ...entry, method: 'GET' }, envelopeSpec)).toThrow(/no GET operation/);
  });

  it('throws when the status has no application/json schema', () => {
    expect(() => extractEnvelope({ ...entry, status: '404' }, envelopeSpec)).toThrow(/no application\/json schema/);
  });

  // The envelope counterpart to the object-discriminator guard: a spec rename, or an
  // operation repointed at another schema, must fail rather than silently leave the
  // consuming test asserting the previous contract.
  it('throws when the operation declares a different schema than the one mapped', () => {
    expect(() => extractEnvelope({ ...entry, schemaName: 'SomethingElse' }, envelopeSpec)).toThrow(
      /declares response schema WidgetValidation, expected "SomethingElse"/,
    );
  });

  it('de-duplicates a field two allOf members both mark required', () => {
    const s = specWithPaths(
      {
        Base: { type: 'object', properties: { id: {} }, required: ['id'] },
        Merged: {
          allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: {}, required: ['id'] }],
        } as unknown as EventSchemaNode,
      },
      { '/merged': { get: jsonResponse('200', 'Merged') } },
    );
    const envelope = extractEnvelope({ method: 'GET', path: '/merged', status: '200', schemaName: 'Merged' }, s);
    expect(envelope.required).toEqual(['id']);
  });

  it('throws when the response schema is inline rather than a $ref', () => {
    const inline = specWithPaths(
      { WidgetValidation: { type: 'object', properties: { widget: {} } } },
      {
        '/widgets/validations': {
          post: { responses: { '200': { content: { 'application/json': { schema: { type: 'object' } } } } } },
        },
      },
    );
    expect(() => extractEnvelope(entry, inline)).toThrow(/\(inline\)/);
  });
});

describe('parseEnvelopeCatalog', () => {
  it('extracts each map entry and sorts by operation', () => {
    const s = specWithPaths(
      {
        Beta: { type: 'object', properties: { b: {} } },
        Alpha: { type: 'object', properties: { a: {} } },
      },
      {
        '/beta': { get: jsonResponse('200', 'Beta') },
        '/alpha': { get: jsonResponse('200', 'Alpha') },
      },
    );
    const map: EnvelopeMapEntry[] = [
      { method: 'GET', path: '/beta', status: '200', schemaName: 'Beta' },
      { method: 'GET', path: '/alpha', status: '200', schemaName: 'Alpha' },
    ];
    expect(parseEnvelopeCatalog(s, map).map((e) => e.operation)).toEqual(['GET /alpha', 'GET /beta']);
  });
});

describe('generateShapesFile', () => {
  const out = generateShapesFile(
    [{ objectType: 'widget', schemaName: 'Widget', properties: ['id', 'object'], required: ['id'] }],
    [
      {
        operation: 'POST /widgets/validations',
        schemaName: 'WidgetValidation',
        properties: ['widget'],
        required: ['widget'],
      },
    ],
  );

  it('emits a RESPONSE_SHAPE_REQUIREMENTS record keyed by object type', () => {
    expect(out).toContain('export const RESPONSE_SHAPE_REQUIREMENTS');
    expect(out).toContain('widget: {');
    expect(out).toContain("schema: 'Widget'");
    expect(out).toContain('do not edit by hand');
  });

  it('emits a RESPONSE_ENVELOPE_REQUIREMENTS record keyed by quoted operation', () => {
    expect(out).toContain('export const RESPONSE_ENVELOPE_REQUIREMENTS');
    expect(out).toContain("'POST /widgets/validations': {");
    expect(out).toContain("schema: 'WidgetValidation'");
  });
});
