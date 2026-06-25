import { describe, it, expect } from 'vitest';
import {
  resolveSchema,
  extractShape,
  parseShapeCatalog,
  generateShapesFile,
  type ShapeMapEntry,
} from './gen-shapes-lib.js';
import type { EventSchemaNode } from './gen-events-lib.js';

function spec(schemas: Record<string, EventSchemaNode>): EventSchemaNode {
  return { components: { schemas } } as unknown as EventSchemaNode;
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

describe('generateShapesFile', () => {
  it('emits a RESPONSE_SHAPE_REQUIREMENTS record keyed by object type', () => {
    const out = generateShapesFile([
      { objectType: 'widget', schemaName: 'Widget', properties: ['id', 'object'], required: ['id'] },
    ]);
    expect(out).toContain('export const RESPONSE_SHAPE_REQUIREMENTS');
    expect(out).toContain('widget: {');
    expect(out).toContain("schema: 'Widget'");
    expect(out).toContain('do not edit by hand');
  });
});
