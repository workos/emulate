import { describe, expect, it } from 'bun:test';
import type { Exchange } from '../../src/core/index.js';
import { describeErrors, findingKey, inspectExchange } from './inspector.js';

const emptyList = { object: 'list', data: [], list_metadata: { before: null, after: null } };

function exchange(overrides: Partial<Exchange>): Exchange {
  return {
    method: 'GET',
    url: new URL('http://localhost/organizations'),
    requestBody: undefined,
    status: 200,
    responseBody: undefined,
    ...overrides,
  };
}

const keys = (ex: Exchange) => inspectExchange(ex).map(findingKey);

describe('spec conformance inspector', () => {
  it('passes a response that matches the spec', () => {
    expect(keys(exchange({ responseBody: emptyList }))).toEqual([]);
  });

  it('reports a field the spec requires but the response lacks', () => {
    const body = { ...emptyList, data: [{ object: 'organization', id: 'org_01HXYZ123456789ABCDEFGHIJ' }] };
    expect(keys(exchange({ responseBody: body }))).toContain('GET /organizations 200 response /data/[] required: name');
  });

  it('reports a documented JSON response that arrives empty or unparseable', () => {
    // The core hook hands over `undefined` for an empty or non-JSON body and the raw text for
    // one that claims to be JSON but does not parse.
    expect(keys(exchange({ responseBody: undefined }))).toEqual(['GET /organizations 200 response / no JSON body']);
    expect(keys(exchange({ responseBody: '{"object": "list",' }))).toEqual([
      'GET /organizations 200 response / type: object',
    ]);
  });

  it('reports a status the operation does not document, but never a 5xx', () => {
    expect(keys(exchange({ status: 418, responseBody: { message: 'short and stout' } }))).toEqual([
      'GET /organizations 418 status undocumented',
    ]);
    // A 5xx from the emulator is an error hook a test installed, not a shape the spec could cover.
    expect(keys(exchange({ status: 503, responseBody: { message: 'hooked' } }))).toEqual([]);
  });

  it('reports an undocumented status that arrives with no body', () => {
    // The spec documents 200 and 202 for this delete; an empty 204 has no body to give it away.
    const url = new URL('http://localhost/organizations/org_01HXYZ123456789ABCDEFGHIJ');
    expect(keys(exchange({ method: 'DELETE', url, status: 204 }))).toEqual([
      'DELETE /organizations/{id} 204 status undocumented',
    ]);
    // The skips hold without a body too: a 5xx, and the statuses middleware produces everywhere.
    expect(keys(exchange({ method: 'DELETE', url, status: 503 }))).toEqual([]);
    expect(keys(exchange({ method: 'DELETE', url, status: 401 }))).toEqual([]);
  });

  it('reports a query parameter the spec does not list, whichever array form carries it', () => {
    const url = new URL('http://localhost/organizations?limit=5&flavor=vanilla&toppings[]=a&toppings[0]=b');
    expect(keys(exchange({ url, responseBody: emptyList }))).toEqual([
      'GET /organizations 200 query flavor undocumented',
      'GET /organizations 200 query toppings undocumented',
    ]);
  });

  it('holds an accepted request body to the request schema and leaves a refused one alone', () => {
    const url = new URL('http://localhost/organizations');
    const accepted = exchange({ method: 'POST', url, status: 201, requestBody: { name: 42 }, responseBody: {} });
    expect(keys(accepted)).toContain('POST /organizations 201 request /name type: string');

    const refused = exchange({ method: 'POST', url, status: 422, requestBody: { name: 42 }, responseBody: {} });
    expect(keys(refused).filter((key) => key.includes(' request '))).toEqual([]);
  });

  it('names the event variant whose payload falls short', () => {
    const url = new URL('http://localhost/events?events=user.created');
    const body = {
      object: 'list',
      data: [
        {
          object: 'event',
          id: 'event_01HXYZ123456789ABCDEFGHIJ',
          event: 'user.created',
          created_at: '2026-01-01T00:00:00.000Z',
          data: { object: 'user', id: 'user_01HXYZ123456789ABCDEFGHIJ' },
        },
      ],
      list_metadata: { after: null },
    };
    expect(keys(exchange({ url, responseBody: body }))).toContain(
      'GET /events 200 response /data/[event=user.created]/data required: email',
    );
  });

  it('keeps an independent error beside a failed oneOf and drops only the branch errors', () => {
    const document = {
      components: { schemas: { Named: { type: 'object', required: ['name'] } } },
      composite: {
        oneOf: [{ $ref: '#/components/schemas/Named' }, { type: 'object', required: ['slug'] }],
      },
    };
    const error = (instancePath: string, keyword: string, schemaPath: string, params: object) =>
      ({ instancePath, keyword, schemaPath, params, message: '' }) as never;
    const lines = describeErrors(
      [
        error('', 'required', 'openapi#/components/schemas/Named/required', { missingProperty: 'name' }),
        error('', 'required', 'openapi#/composite/oneOf/1/required', { missingProperty: 'slug' }),
        error('', 'oneOf', 'openapi#/composite/oneOf', {}),
        error('', 'required', 'openapi#/composite/required', { missingProperty: 'object' }),
        error('/k', 'type', 'openapi#/composite/properties/k/type', { type: 'number' }),
      ],
      { k: 'x' },
      document,
    );
    expect(lines).toEqual(['/ oneOf: ', '/ required: object', '/k type: number']);
  });

  it('ignores a route the spec does not define', () => {
    const url = new URL('http://localhost/sdk/feature-flags');
    expect(keys(exchange({ url, responseBody: { beta: {} } }))).toEqual([]);
  });
});
