import { describe, it, expect, beforeEach } from 'bun:test';
import { NotFoundException, UnprocessableEntityException } from '@workos-inc/node';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';
import { sdkClient } from '../sdk.test-utils.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_org', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Audit Logs routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;
  const storedEvents = () => getWorkOSStore(store).auditLogEvents.all();

  async function createOrg(name = 'Acme Corp') {
    return json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name }) }));
  }

  // The body production's ingestion DTO takes, as the SDKs send it.
  const event = (overrides: Record<string, unknown> = {}) => ({
    action: 'user.signed_in',
    occurred_at: '2026-02-02T16:35:39.317Z',
    actor: { id: 'user_1', type: 'user', name: 'Jon Smith' },
    targets: [{ id: 'team_1', type: 'team' }],
    context: { location: '1.1.1.1', user_agent: 'Chrome/104.0.0.0' },
    metadata: { plan: 'enterprise' },
    ...overrides,
  });

  const postEvent = (body: unknown, extraHeaders: Record<string, string> = {}) =>
    req('/audit_logs/events', {
      method: 'POST',
      headers: { ...headers, ...extraHeaders },
      body: JSON.stringify(body),
    });

  const postSchema = (action: string, body: unknown) =>
    req(`/audit_logs/actions/${action}/schemas`, { method: 'POST', body: JSON.stringify(body) });

  describe('action schemas', () => {
    it('answers 201 with the created audit_log_schema, not the action', async () => {
      const res = await postSchema('user.login', { targets: [{ type: 'user' }] });
      expect(res.status).toBe(201);
      const schema = await json(res);
      expect(Object.keys(schema).sort()).toEqual(['created_at', 'object', 'targets', 'version']);
      expect(schema.object).toBe('audit_log_schema');
      expect(schema.version).toBe(1);
      expect(schema.targets).toEqual([{ type: 'user' }]);
    });

    it('carries actor and metadata only when the schema defines them', async () => {
      const actor = { metadata: { type: 'object', properties: { role: { type: 'string' } } } };
      const metadata = { type: 'object', properties: { plan: { type: 'string' } } };
      const schema = await json(await postSchema('user.login', { actor, targets: [{ type: 'user' }], metadata }));
      expect(schema.actor).toEqual(actor);
      expect(schema.metadata).toEqual(metadata);
    });

    it('creates the action on its first schema, and the next version on every changed one', async () => {
      expect((await json(await postSchema('user.login', { targets: [{ type: 'user' }] }))).version).toBe(1);
      expect((await json(await postSchema('user.login', { targets: [{ type: 'team' }] }))).version).toBe(2);
      expect((await json(await postSchema('user.logout', { targets: [{ type: 'user' }] }))).version).toBe(1);

      const actions = await json(await req('/audit_logs/actions'));
      expect(actions.data.map((a: any) => a.name).sort()).toEqual(['user.login', 'user.logout']);
    });

    // Production compares a submitted schema with the action's latest version and answers that
    // version when they match, rather than storing the same schema twice.
    it('answers an unchanged schema with the latest version', async () => {
      const body = { actor: { metadata: { type: 'object' } }, targets: [{ type: 'user' }] };
      const first = await json(await postSchema('user.login', body));
      const repeat = await postSchema('user.login', body);
      expect(repeat.status).toBe(201);
      expect(await json(repeat)).toEqual(first);

      // Only a schema that differs from the latest adds a version, and an earlier one repeated
      // after it is a change again.
      expect((await json(await postSchema('user.login', { targets: [{ type: 'team' }] }))).version).toBe(2);
      expect((await json(await postSchema('user.login', body))).version).toBe(3);

      const list = await json(await req('/audit_logs/actions/user.login/schemas'));
      expect(list.data.map((s: any) => s.version)).toEqual([3, 2, 1]);
    });

    it("lists an action's schema versions, newest first by default", async () => {
      await postSchema('user.login', { targets: [{ type: 'user' }] });
      await postSchema('user.login', { targets: [{ type: 'team' }] });

      const res = await req('/audit_logs/actions/user.login/schemas');
      expect(res.status).toBe(200);
      const list = await json(res);
      expect(list.object).toBe('list');
      expect(list.data.map((s: any) => s.version)).toEqual([2, 1]);
      expect(list.data[0].targets).toEqual([{ type: 'team' }]);

      const asc = await json(await req('/audit_logs/actions/user.login/schemas?order=asc&limit=1'));
      expect(asc.data.map((s: any) => s.version)).toEqual([1]);
    });

    it('404s the schema list of an unknown action', async () => {
      const res = await req('/audit_logs/actions/user.unknown/schemas');
      expect(res.status).toBe(404);
    });

    it('serves createSchema and listSchemas to the Node SDK', async () => {
      const workos = sdkClient(app, 'sk_test_org');
      const created = await workos.auditLogs.createSchema({
        action: 'user.signed_in',
        targets: [{ type: 'user' }],
        actor: { metadata: { role: 'string' } },
      });
      expect(created.object).toBe('audit_log_schema');
      expect(created.version).toBe(1);
      expect(created.targets).toEqual([{ type: 'user', metadata: undefined }]);
      expect(created.actor).toEqual({ metadata: { role: 'string' } });

      const list = await workos.auditLogs.listSchemas('user.signed_in');
      expect(list.data.map((s) => s.version)).toEqual([1]);
    });
  });

  it('lists actions', async () => {
    await postSchema('user.login', { targets: [{ type: 'user' }] });

    const res = await req('/audit_logs/actions');
    expect(res.status).toBe(200);
    const list = await json(res);
    expect(list.object).toBe('list');
    expect(list.data).toHaveLength(1);
  });

  describe('POST /audit_logs/events', () => {
    it('ingests the production body and answers 200 {success: true}', async () => {
      const org = await createOrg();

      const res = await postEvent({ organization_id: org.id, event: event() });

      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ success: true });
      const [stored] = storedEvents();
      expect(stored).toMatchObject({
        object: 'audit_log_event',
        organization_id: org.id,
        action: 'user.signed_in',
        occurred_at: '2026-02-02T16:35:39.317Z',
        actor: { id: 'user_1', type: 'user', name: 'Jon Smith' },
        targets: [{ id: 'team_1', type: 'team' }],
        context: { location: '1.1.1.1', user_agent: 'Chrome/104.0.0.0' },
        metadata: { plan: 'enterprise' },
        version: 1,
      });
    });

    it('keeps an explicit version and the optional fields a client leaves out', async () => {
      const org = await createOrg();

      const res = await postEvent({
        organization_id: org.id,
        event: {
          action: 'user.signed_in',
          occurred_at: '2026-02-02T16:35:39.317Z',
          actor: { id: 'user_1', type: 'user' },
          targets: [],
          context: { location: '1.1.1.1' },
          version: 2,
        },
      });

      expect(res.status).toBe(200);
      const [stored] = storedEvents();
      expect(stored.version).toBe(2);
      expect(stored.metadata).toBeUndefined();
      expect(stored.actor).toEqual({ id: 'user_1', type: 'user' });
      expect(stored.context).toEqual({ location: '1.1.1.1' });
    });

    it('accepts an action with no registered schema and any target type', async () => {
      const org = await createOrg();

      const res = await postEvent({
        organization_id: org.id,
        event: event({ action: 'anything.goes', targets: [{ id: 'x', type: 'never-registered' }] }),
      });

      expect(res.status).toBe(200);
      expect(storedEvents()).toHaveLength(1);
    });

    it('ingests an event sent through the Node SDK', async () => {
      const org = await createOrg();
      const workos = sdkClient(app, 'sk_test_org');

      await expect(
        workos.auditLogs.createEvent(org.id, {
          action: 'user.signed_in',
          occurredAt: new Date('2026-02-02T16:35:39.317Z'),
          actor: { id: 'user_1', type: 'user' },
          targets: [{ id: 'team_1', type: 'team' }],
          context: { location: '1.1.1.1', userAgent: 'Chrome/104.0.0.0' },
          metadata: { plan: 'enterprise' },
        }),
      ).resolves.toBeUndefined();

      expect(storedEvents()).toHaveLength(1);
      expect(storedEvents()[0]).toMatchObject({
        organization_id: org.id,
        action: 'user.signed_in',
        context: { location: '1.1.1.1', user_agent: 'Chrome/104.0.0.0' },
      });
    });

    it("rejects the flat body the emulator used to take, since production's DTO nests it under `event`", async () => {
      const org = await createOrg();

      const res = await postEvent({
        organization_id: org.id,
        action: { name: 'user.login', type: 'C' },
        actor: { type: 'user', id: 'user_1' },
        targets: [{ type: 'team', id: 'team_1' }],
      });

      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        message: 'Validation failed',
        errors: [{ field: 'event', code: 'event must be an object' }],
      });
      expect(storedEvents()).toHaveLength(0);
    });

    it('rejects a missing organization_id', async () => {
      const res = await postEvent({ event: event() });

      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        message: 'Validation failed',
        errors: [{ field: 'organization_id', code: 'organization_id must be a string' }],
      });
    });

    it.each([
      ['action', 'must be a string'],
      ['actor', 'must be an object'],
      ['targets', 'must be an array'],
      ['context', 'must be an object'],
      ['occurred_at', 'must be a valid ISO 8601 date string'],
    ])('rejects an event missing %s with the field path and class-validator message', async (attribute, message) => {
      const org = await createOrg();
      const payload = { organization_id: org.id, event: event() as Record<string, unknown> };
      delete payload.event[attribute];

      const res = await postEvent(payload);

      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        message: 'Validation failed',
        errors: [{ field: `event.${attribute}`, code: `${attribute} ${message}` }],
      });
      expect(storedEvents()).toHaveLength(0);
    });

    it('names a nested field by its dotted path', async () => {
      const org = await createOrg();

      const res = await postEvent({
        organization_id: org.id,
        event: event({ targets: [{ type: 'team' }], context: { user_agent: 'Chrome' } }),
      });

      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        message: 'Validation failed',
        errors: [
          { field: 'event.targets.0.id', code: 'id must be a string' },
          { field: 'event.context.location', code: 'location must be a string' },
        ],
      });
    });

    it('rejects a non-integer version and a non-string occurred_at', async () => {
      const org = await createOrg();

      const res = await postEvent({
        organization_id: org.id,
        event: event({ occurred_at: 'yesterday', version: '1' }),
      });

      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        message: 'Validation failed',
        errors: [
          { field: 'event.occurred_at', code: 'occurred_at must be a valid ISO 8601 date string' },
          { field: 'event.version', code: 'version must be an integer number' },
        ],
      });
    });

    it('404s an organization the emulator does not have, with the entity_id', async () => {
      const res = await postEvent({ organization_id: 'org_missing', event: event() });

      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({
        message: "Organization not found: 'org_missing'.",
        code: 'entity_not_found',
        entity_id: 'org_missing',
      });
      expect(storedEvents()).toHaveLength(0);
    });

    it('surfaces as the SDK exception classes production does', async () => {
      const workos = sdkClient(app, 'sk_test_org');
      const sdkEvent = {
        action: 'user.signed_in',
        occurredAt: new Date('2026-02-02T16:35:39.317Z'),
        actor: { id: 'user_1', type: 'user' },
        targets: [{ id: 'team_1', type: 'team' }],
        context: { location: '1.1.1.1' },
      };

      await expect(workos.auditLogs.createEvent('org_missing', sdkEvent)).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        workos.auditLogs.createEvent('org_missing', { ...sdkEvent, action: undefined as unknown as string }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it.each([
      ['before the first partition', '1970-01-21T17:45:42.015Z'],
      ['more than a day ahead', new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()],
      ['the Date parser rejects', '2026-W05'],
    ])('400s an occurred_at %s without storing the event', async (_, occurredAt) => {
      const org = await createOrg();

      const res = await postEvent({ organization_id: org.id, event: event({ occurred_at: occurredAt }) });

      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.code).toBe('invalid_audit_log');
      expect(body.message).toStartWith(
        "Invalid Audit Log event: 'occurred_at' must be between '2018-10-01T00:00:00.000Z' and '",
      );
      expect(body.message).toEndWith(`. Received '${occurredAt}'`);
      expect(body.errors).toBeUndefined();
      expect(storedEvents()).toHaveLength(0);
    });

    it('accepts an occurred_at up to a day ahead', async () => {
      const org = await createOrg();
      const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const res = await postEvent({ organization_id: org.id, event: event({ occurred_at: soon }) });

      expect(res.status).toBe(200);
    });

    it('stores a request retried under the same Idempotency-Key once', async () => {
      const org = await createOrg();
      const key = { 'Idempotency-Key': '884793cd-bef4-46cf-8790-e3d4957a09ce' };

      const first = await postEvent({ organization_id: org.id, event: event() }, key);
      const retry = await postEvent({ organization_id: org.id, event: event({ version: 1 }) }, key);

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
      expect(await json(retry)).toEqual({ success: true });
      expect(storedEvents()).toHaveLength(1);
    });

    it('stores a different body under the same Idempotency-Key as a new event', async () => {
      const org = await createOrg();
      const key = { 'Idempotency-Key': '884793cd-bef4-46cf-8790-e3d4957a09ce' };

      await postEvent({ organization_id: org.id, event: event() }, key);
      await postEvent({ organization_id: org.id, event: event({ action: 'user.signed_out' }) }, key);

      expect(storedEvents()).toHaveLength(2);
    });

    it('stores the same body sent twice without a key as two events', async () => {
      const org = await createOrg();

      await postEvent({ organization_id: org.id, event: event() });
      await postEvent({ organization_id: org.id, event: event() });

      expect(storedEvents()).toHaveLength(2);
    });
  });

  it('creates an export (auto-ready)', async () => {
    const res = await req('/audit_logs/exports', {
      method: 'POST',
      body: JSON.stringify({ organization_id: 'org_123' }),
    });
    expect(res.status).toBe(201);
    const exp = await json(res);
    expect(exp.object).toBe('audit_log_export');
    expect(exp.state).toBe('ready');
    expect(exp.url).toBeDefined();
  });

  it('gets an export by id', async () => {
    const createRes = await req('/audit_logs/exports', {
      method: 'POST',
      body: JSON.stringify({ organization_id: 'org_123' }),
    });
    const created = await json(createRes);

    const res = await req(`/audit_logs/exports/${created.id}`);
    expect(res.status).toBe(200);
    expect((await json(res)).state).toBe('ready');
  });

  it('returns 404 for nonexistent export', async () => {
    const res = await req('/audit_logs/exports/audit_log_export_nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns org audit log configuration', async () => {
    const res = await req('/organizations/org_123/audit_log_configuration');
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.enabled).toBe(true);
    expect(data.retention_days).toBe(365);
  });

  it('returns org audit logs retention', async () => {
    const res = await req('/organizations/org_123/audit_logs_retention');
    expect(res.status).toBe(200);
    const data = await json(res);
    expect(data.retention_days).toBe(365);
  });
});
