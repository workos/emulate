import { describe, it, expect } from 'bun:test';
import { buildSchema } from 'graphql';
import { escapeTemplateLiteral, generateWidgetsSchemaFile } from './gen-widgets-schema-lib.js';
import { WIDGETS_API_SCHEMA_SDL } from '../src/workos/generated/widgets-api-schema.js';

describe('gen-widgets-schema', () => {
  it('escapes everything a template literal would interpret, and nothing else', () => {
    const sdl = '"""Uses `code`, a ${placeholder} and a back\\slash"""\ntype Query { ok: Boolean }';
    const escaped = escapeTemplateLiteral(sdl);
    // Evaluating the escaped text as a template literal gives the original back.
    expect(new Function(`return \`${escaped}\`;`)()).toBe(sdl);
  });

  it('writes a module whose export round-trips the SDL', () => {
    const sdl = 'type Query {\n  """Says `hi`."""\n  hi: String!\n}\n';
    const file = generateWidgetsSchemaFile(sdl, 'file.graphql');
    expect(file).toContain('Source: file.graphql');
    const exported = /export const WIDGETS_API_SCHEMA_SDL = `([\s\S]*)`;\n$/.exec(file);
    expect(exported).not.toBeNull();
    expect(new Function(`return \`${exported![1]}\`;`)()).toBe(sdl);
  });

  it('refuses a download that is not a schema', () => {
    expect(() => generateWidgetsSchemaFile('<html>not a schema</html>', 'x')).toThrow();
    expect(() => generateWidgetsSchemaFile('type Query { hi: Missing }', 'x')).toThrow(/Missing/);
  });

  it('ships a schema that builds and defines what the widgets query', () => {
    const schema = buildSchema(WIDGETS_API_SCHEMA_SDL);
    const query = schema.getQueryType();
    expect(query).toBeDefined();
    expect(Object.keys(query!.getFields())).toEqual(expect.arrayContaining(['me', 'authenticationSettings']));
  });
});
