import { describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { createApiErrorHandler, notFound } from './error-handler.js';
import {
  queryPropertyName,
  strictQueryMiddleware,
  unknownQueryProperties,
  type StrictQueryRule,
} from './strict-query.js';

describe('queryPropertyName', () => {
  // What `qs.parse(query, { allowPrototypes: true })`, Express 4's extended parser, names each key.
  it.each([
    ['name', 'name'],
    ['name[]', 'name'],
    ['name[0]', 'name'],
    ['name[key]', 'name'],
    ['name[a][b]', 'name'],
    ['name[', 'name'],
    ['name.key', 'name.key'],
    ['name]', 'name]'],
    ['[name]', 'name'],
    ['[]', '0'],
    ['', undefined],
    ['__proto__', undefined],
  ])('%p names %p', (key, property) => {
    expect(queryPropertyName(key)).toBe(property);
  });
});

describe('unknownQueryProperties', () => {
  const allowed = new Set(['limit', 'ids']);

  it('reports each unknown property once, in the order it first appears', () => {
    const params = new URLSearchParams('b=1&limit=2&a[]=3&b=4&a[0]=5');
    expect(unknownQueryProperties(params, allowed)).toEqual(['b', 'a']);
  });

  it('accepts a declared property however its key is bracketed', () => {
    expect(unknownQueryProperties(new URLSearchParams('ids[]=1&ids[0]=2&ids=3&limit=4'), allowed)).toEqual([]);
  });
});

describe('strictQueryMiddleware', () => {
  const rules: StrictQueryRule[] = [
    { method: 'GET', path: '/things/{thingId}/parts', allowed: ['limit'], pipe: 'validation' },
    { method: 'GET', path: '/coded', allowed: ['limit'], pipe: 'validation_with_error_code' },
  ];

  function createApp() {
    const app = new Hono();
    app.onError(createApiErrorHandler());
    app.use('*', strictQueryMiddleware(rules));
    app.get('/things/:id/parts', (c) => {
      if (c.req.param('id') === 'missing') throw notFound('Thing', 'missing');
      return c.json({ ok: true });
    });
    app.post('/things/:id/parts', (c) => c.json({ ok: true }));
    app.get('/things/:id', (c) => c.json({ ok: true }));
    app.get('/coded', (c) => c.json({ ok: true }));
    return app;
  }

  it("answers production's ValidationPipe body for an unknown parameter", async () => {
    const res = await createApp().request('/things/t_1/parts?limit=1&extra=1&other[]=2');
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      message: 'Validation failed',
      errors: [
        { field: 'extra', code: 'property extra should not exist' },
        { field: 'other', code: 'property other should not exist' },
      ],
    });
  });

  it("answers production's ValidationWithErrorCodePipe body where the rule names that pipe", async () => {
    const res = await createApp().request('/coded?extra=1');
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      message: 'Validation failed',
      code: 'invalid_request_parameters',
      errors: [{ code: 'extra_not_supported', message: 'property extra should not exist' }],
    });
  });

  it('refuses before the handler runs, so ahead of its not-found', async () => {
    const app = createApp();
    expect((await app.request('/things/missing/parts')).status).toBe(404);
    expect((await app.request('/things/missing/parts?extra=1')).status).toBe(422);
  });

  it('lets a request through when every parameter is declared, or there are none', async () => {
    const app = createApp();
    expect((await app.request('/things/t_1/parts')).status).toBe(200);
    expect((await app.request('/things/t_1/parts?limit=5')).status).toBe(200);
  });

  it('leaves other methods and other paths alone', async () => {
    const app = createApp();
    expect((await app.request('/things/t_1/parts?extra=1', { method: 'POST' })).status).toBe(200);
    expect((await app.request('/things/t_1?extra=1')).status).toBe(200);
  });
});
