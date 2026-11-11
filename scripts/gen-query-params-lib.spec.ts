import { describe, it, expect } from 'bun:test';
import type { EventSchemaNode } from './gen-events-lib.js';
import { parseQueryParamCatalog, generateQueryParamsFile, queryOperationKey } from './gen-query-params-lib.js';

const query = (name: string) => ({ name, in: 'query', schema: { type: 'string' } });

const fixtureSpec = {
  openapi: '3.1.0',
  components: {
    parameters: {
      Limit: { name: 'limit', in: 'query', schema: { type: 'integer' } },
      OrganizationId: { name: 'organizationId', in: 'path', schema: { type: 'string' } },
    },
  },
  paths: {
    '/widgets/{id}': {
      parameters: [{ name: 'id', in: 'path' }, query('expand')],
      get: { parameters: [query('expand'), { name: 'X-Trace', in: 'header' }] },
      delete: { parameters: [query('cascade')] },
    },
    '/organizations/{organizationId}/groups': {
      get: {
        parameters: [
          { $ref: '#/components/parameters/OrganizationId' },
          query('before'),
          query('after'),
          { $ref: '#/components/parameters/Limit' },
        ],
      },
      post: {},
    },
  },
} as unknown as EventSchemaNode;

describe('queryOperationKey', () => {
  it('upper-cases the method and keeps the spec path', () => {
    expect(queryOperationKey('get', '/a/{b}')).toBe('GET /a/{b}');
  });
});

describe('parseQueryParamCatalog', () => {
  const catalog = parseQueryParamCatalog(fixtureSpec);
  const paramsOf = (key: string) => catalog.find((operation) => operation.key === key)?.params;

  it('lists every operation, sorted by key', () => {
    expect(catalog.map((operation) => operation.key)).toEqual([
      'DELETE /widgets/{id}',
      'GET /organizations/{organizationId}/groups',
      'GET /widgets/{id}',
      'POST /organizations/{organizationId}/groups',
    ]);
  });

  it('keeps only query parameters, in declaration order, following references', () => {
    expect(paramsOf('GET /organizations/{organizationId}/groups')).toEqual(['before', 'after', 'limit']);
  });

  it("applies a path item's parameters to each of its operations, once", () => {
    expect(paramsOf('GET /widgets/{id}')).toEqual(['expand']);
    expect(paramsOf('DELETE /widgets/{id}')).toEqual(['expand', 'cascade']);
  });

  it('lists an operation without query parameters as empty', () => {
    expect(paramsOf('POST /organizations/{organizationId}/groups')).toEqual([]);
  });

  it('fails on a parameter reference the spec does not define', () => {
    const broken = {
      paths: { '/a': { get: { parameters: [{ $ref: '#/components/parameters/Missing' }] } } },
    } as unknown as EventSchemaNode;
    expect(() => parseQueryParamCatalog(broken)).toThrow('Unresolved parameter reference');
  });
});

describe('generateQueryParamsFile', () => {
  const output = generateQueryParamsFile(parseQueryParamCatalog(fixtureSpec));

  it('emits one entry per operation', () => {
    expect(output).toContain('"GET /organizations/{organizationId}/groups": ["before", "after", "limit"],');
    expect(output).toContain('"POST /organizations/{organizationId}/groups": [],');
  });

  it('exports the catalog and its key type', () => {
    expect(output).toContain('export const QUERY_PARAMETERS = {');
    expect(output).toContain('export type QueryOperation = keyof typeof QUERY_PARAMETERS;');
  });

  it('is deterministic', () => {
    expect(generateQueryParamsFile(parseQueryParamCatalog(fixtureSpec))).toBe(output);
  });
});
