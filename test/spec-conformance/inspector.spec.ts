import { describe, expect, it } from 'bun:test';
import type { Exchange } from '../../src/core/index.js';
import { findingKey, inspectExchange } from './inspector.js';

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

  it('reports a status the operation does not document, but never a 5xx', () => {
    expect(keys(exchange({ status: 418, responseBody: { message: 'short and stout' } }))).toEqual([
      'GET /organizations 418 status undocumented',
    ]);
    // A 5xx from the emulator is an error hook a test installed, not a shape the spec could cover.
    expect(keys(exchange({ status: 503, responseBody: { message: 'hooked' } }))).toEqual([]);
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

  it('ignores a route the spec does not define', () => {
    const url = new URL('http://localhost/sdk/feature-flags');
    expect(keys(exchange({ url, responseBody: { beta: {} } }))).toEqual([]);
  });
});
