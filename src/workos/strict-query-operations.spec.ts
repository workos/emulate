import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../core/index.js';
import { workosPlugin } from './index.js';
import { QUERY_PARAMETERS, type QueryOperation } from './generated/query-params.js';
import { QUERY_PARAMETER_OVERRIDES, STRICT_QUERY_OPERATIONS, strictQueryRules } from './strict-query-operations.js';

const apiKeys: ApiKeyMap = { sk_test_query: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_query', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

const rules = strictQueryRules();
/** A rule's path with every parameter filled by an id nothing in a fresh store answers to. */
const concretePath = (path: string) => path.replace(/\{[^}]+\}/g, 'missing_01');
const shapeOf = (path: string) => path.replace(/\{[^}]+\}|:[A-Za-z_]+/g, '{}');

describe('Unknown query parameters', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('polices only operations the emulator serves', () => {
    const served = new Set(app.routes.map((route) => `${route.method} ${shapeOf(route.path)}`));
    const unserved = rules.filter((rule) => !served.has(`${rule.method} ${shapeOf(rule.path)}`));
    expect(unserved.map((rule) => `${rule.method} ${rule.path}`)).toEqual([]);
  });

  it('names a production controller and DTO for every operation', () => {
    for (const [operation, source] of Object.entries(STRICT_QUERY_OPERATIONS)) {
      expect(`${operation}: ${source.controller}`).toMatch(/: \S+\.controller\.ts$/);
      expect(source.dto).not.toBe('');
    }
  });

  it('overrides only operations in the table, with parameters the spec really leaves out or lists', () => {
    for (const [operation, override] of Object.entries(QUERY_PARAMETER_OVERRIDES)) {
      expect(Object.keys(STRICT_QUERY_OPERATIONS)).toContain(operation);
      const declared: readonly string[] = QUERY_PARAMETERS[operation as QueryOperation];
      for (const name of override.add ?? []) expect(declared).not.toContain(name);
      for (const name of override.remove ?? []) expect(declared).toContain(name);
    }
  });

  // The paths name nothing that exists, so each of these is also the ordering production has:
  // its pipe refuses the query before the handler can look anything up.
  it.each(rules.filter((rule) => rule.pipe === 'validation').map((rule) => [rule.method, rule.path] as const))(
    '422s an unknown parameter on %s %s',
    async (method, path) => {
      const res = await req(`${concretePath(path)}?unsupported=value&also[]=one&also[]=two`, { method });
      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        message: 'Validation failed',
        errors: [
          { field: 'unsupported', code: 'property unsupported should not exist' },
          { field: 'also', code: 'property also should not exist' },
        ],
      });
    },
  );

  it.each(
    rules.filter((rule) => rule.pipe === 'validation_with_error_code').map((rule) => [rule.method, rule.path] as const),
  )('422s an unknown parameter on %s %s under the error-code pipe', async (method, path) => {
    const res = await req(`${concretePath(path)}?unsupported=value`, { method });
    expect(res.status).toBe(422);
    expect(await json(res)).toEqual({
      message: 'Validation failed',
      code: 'invalid_request_parameters',
      errors: [{ code: 'unsupported_not_supported', message: 'property unsupported should not exist' }],
    });
  });

  it.each(rules.map((rule) => [rule.method, rule.path, rule.allowed] as const))(
    'takes every declared parameter on %s %s',
    async (method, path, allowed) => {
      const query = allowed.map((name) => `${name}=1`).join('&');
      const res = await req(`${concretePath(path)}?${query}`, { method });
      // Whatever the route makes of the values, it is not this refusal.
      expect(await res.text()).not.toContain('should not exist');
    },
  );

  it('still answers 401 first when the request is not authenticated', async () => {
    const res = await app.request('/organizations/missing_01/groups/missing_01/organization-memberships?unsupported=1');
    expect(res.status).toBe(401);
  });

  it('answers 422 where the same path without the parameter is a 404', async () => {
    const path = '/organizations/missing_01/groups/missing_01/organization-memberships';
    expect((await req(path)).status).toBe(404);
    expect((await req(`${path}?unsupported=1`)).status).toBe(422);

    const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) }));
    const groupless = `/organizations/${org.id}/groups/missing_01/organization-memberships`;
    expect((await req(groupless)).status).toBe(404);
    expect((await req(`${groupless}?unsupported=1`)).status).toBe(422);
  });

  it("takes a parameter production's DTO declares and the spec leaves out", async () => {
    expect(QUERY_PARAMETERS['GET /connections']).not.toContain('external_id');
    const res = await req('/connections?external_id=ext_1');
    expect(res.status).toBe(200);
  });

  it('ignores unknown parameters on an operation production does not police', async () => {
    // organization-api-keys.controller.ts pipes this query through `new ValidationPipe()`, with no whitelist.
    const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) }));
    const res = await req(`/organizations/${org.id}/api_keys?unsupported=1`);
    expect(res.status).toBe(200);
  });
});
