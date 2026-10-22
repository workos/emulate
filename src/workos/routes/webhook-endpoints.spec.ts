import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin, seedFromConfig, getWorkOSStore } from '../index.js';
import { validateSeedConfig } from '../config-validator.js';

const apiKeys: ApiKeyMap = { sk_test_wh: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_wh', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

const VALID = { endpoint_url: 'https://example.com/webhooks', events: ['user.created', 'user.updated'] };

/** The 422 body production's `ValidationWithErrorCodePipe` renders for a DTO failure. */
const validationFailed = (errors: Array<{ code: string; message: string }>) => ({
  code: 'invalid_request_parameters',
  message: 'Validation failed',
  errors,
});

describe('Webhook endpoint routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;
  const post = (body: unknown) => req('/webhook_endpoints', { method: 'POST', body: JSON.stringify(body) });
  const patch = (id: string, body: unknown) =>
    req(`/webhook_endpoints/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  const create = async (body: unknown = VALID) => {
    const res = await post(body);
    expect(res.status).toBe(201);
    return json(res);
  };

  describe('POST /webhook_endpoints', () => {
    it('creates an enabled endpoint with a generated secret, in the WebhookEndpointJson shape', async () => {
      const ep = await create();
      expect(ep).toStrictEqual({
        object: 'webhook_endpoint',
        id: expect.stringMatching(/^we_/),
        endpoint_url: 'https://example.com/webhooks',
        secret: expect.stringMatching(/^[A-Za-z0-9]{25}$/),
        status: 'enabled',
        events: ['user.created', 'user.updated'],
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
    });

    it('dedupes the subscribed events as production does', async () => {
      const ep = await create({ ...VALID, events: ['user.created', 'user.created'] });
      expect(ep.events).toEqual(['user.created']);
    });

    // Production's body pipe runs without a whitelist, so fields its DTO does not declare are
    // dropped rather than rejected: the secret is always generated and the status always enabled.
    it('ignores secret, enabled, description and the legacy url', async () => {
      const ep = await create({
        ...VALID,
        secret: 'my_custom_secret',
        enabled: false,
        description: 'Test endpoint',
        url: 'https://ignored.example.com/webhooks',
      });
      expect(ep.secret).not.toBe('my_custom_secret');
      expect(ep.status).toBe('enabled');
      expect(ep.endpoint_url).toBe('https://example.com/webhooks');
      expect(ep).not.toHaveProperty('enabled');
      expect(ep).not.toHaveProperty('description');
    });

    it.each([
      [
        'an empty body',
        {},
        [
          { code: 'endpoint_url_string_required', message: 'Endpoint Url must be a non-empty string.' },
          { code: 'events_string_required', message: 'Events must be a non-empty string.' },
        ],
      ],
      [
        'a missing endpoint_url',
        { events: ['user.created'] },
        [{ code: 'endpoint_url_string_required', message: 'Endpoint Url must be a non-empty string.' }],
      ],
      [
        'a null endpoint_url',
        { ...VALID, endpoint_url: null },
        [{ code: 'endpoint_url_string_required', message: 'Endpoint Url must be a non-empty string.' }],
      ],
      [
        'an empty endpoint_url',
        { ...VALID, endpoint_url: '' },
        [{ code: 'endpoint_url_string_required', message: 'Endpoint Url must be a non-empty string.' }],
      ],
      [
        'a non-string endpoint_url',
        { ...VALID, endpoint_url: 123 },
        [{ code: 'endpoint_url_string_required', message: 'Endpoint Url must be a string.' }],
      ],
      [
        'missing events',
        { endpoint_url: VALID.endpoint_url },
        [{ code: 'events_string_required', message: 'Events must be a non-empty string.' }],
      ],
      [
        'null events',
        { ...VALID, events: null },
        [{ code: 'events_string_required', message: 'Events must be a non-empty string.' }],
      ],
      [
        'events as a string',
        { ...VALID, events: 'user.created' },
        [{ code: 'events_array_required', message: 'Events must be a non-empty array.' }],
      ],
      [
        'empty events',
        { ...VALID, events: [] },
        [{ code: 'events_array_required', message: 'Events must be a non-empty array.' }],
      ],
      [
        'a non-string event',
        { ...VALID, events: [123, 'user.created'] },
        [{ code: 'events_string_required', message: 'Events must be a string.' }],
      ],
      [
        'an empty event name',
        { ...VALID, events: [''] },
        [{ code: 'events_string_required', message: 'Events must be a non-empty string.' }],
      ],
    ])('returns 422 invalid_request_parameters for %s', async (_case, body, errors) => {
      const res = await post(body);
      expect(res.status).toBe(422);
      expect(await json(res)).toStrictEqual(validationFailed(errors));
    });

    // The one deliberate departure from production's HTTPS rule: a receiver on this machine.
    it.each([
      'http://localhost:5005/webhooks',
      'http://app.localhost:5005/webhooks',
      'http://127.0.0.1:5005/webhooks',
      'http://127.1.2.3:5005/webhooks',
      'http://[::1]:5005/webhooks',
    ])('accepts the plain http loopback receiver %s', async (endpoint_url) => {
      const ep = await create({ ...VALID, endpoint_url });
      expect(ep.endpoint_url).toBe(endpoint_url);
    });

    it.each([
      ['an http URL on a non-loopback host', 'http://example.com/webhooks'],
      ['an http URL on a private, non-loopback address', 'http://10.0.0.5/webhooks'],
      ['an http URL whose host only starts with localhost', 'http://localhost.example.com/webhooks'],
      ['something that is not a URL', 'not a url'],
      ['a non-web scheme', 'ftp://localhost/webhooks'],
    ])('returns 422 invalid_url for %s', async (_case, endpoint_url) => {
      const res = await post({ ...VALID, endpoint_url });
      expect(res.status).toBe(422);
      expect(await json(res)).toStrictEqual({
        message: 'The `endpoint_url` must be an HTTPS URL',
        code: 'invalid_url',
      });
    });

    it('returns 422 unknown_event_type for every name outside the subscribable catalog', async () => {
      // `authentication.mfa_failed` is a real event — it is recorded and listable — but production
      // hides it from webhook subscription, so the catalog the DTO enumerates does not carry it.
      const res = await post({ ...VALID, events: ['unknown.event', 'user.created', 'authentication.mfa_failed'] });
      expect(res.status).toBe(422);
      expect(await json(res)).toStrictEqual(
        validationFailed([
          { code: 'unknown_event_type', message: '`unknown.event` is not a supported event type' },
          { code: 'unknown_event_type', message: '`authentication.mfa_failed` is not a supported event type' },
        ]),
      );
    });

    it('checks the URL before the events, as production does', async () => {
      const res = await post({ endpoint_url: 'http://example.com/webhooks', events: ['unknown.event'] });
      expect((await json(res)).code).toBe('invalid_url');
    });

    it('returns 409 duplicate_endpoint for a URL another endpoint already uses', async () => {
      await create();
      const res = await post({ ...VALID, events: ['session.created'] });
      expect(res.status).toBe(409);
      expect(await json(res)).toStrictEqual({
        message: "A Webhook Endpoint with the endpoint url 'https://example.com/webhooks' already exists.",
        code: 'duplicate_endpoint',
      });
    });
  });

  describe('GET /webhook_endpoints', () => {
    it('returns the secret on read, as production serializes it on every read', async () => {
      const created = await create();

      const ep = await json(await req(`/webhook_endpoints/${created.id}`));
      expect(ep).toStrictEqual(created);

      const list = await json(await req('/webhook_endpoints'));
      expect(list.data).toHaveLength(1);
      expect(list.data[0].secret).toBe(created.secret);
    });

    it('returns 404 entity_not_found for an unknown endpoint', async () => {
      const res = await req('/webhook_endpoints/we_nonexistent');
      expect(res.status).toBe(404);
      expect(await json(res)).toStrictEqual({
        message: "Webhook Endpoint not found: 'we_nonexistent'.",
        code: 'entity_not_found',
        entity_id: 'we_nonexistent',
      });
    });
  });

  describe('PATCH /webhook_endpoints/:id', () => {
    it('updates only the status', async () => {
      const created = await create();
      const res = await patch(created.id, { status: 'disabled' });
      expect(res.status).toBe(200);
      expect(await json(res)).toStrictEqual({ ...created, status: 'disabled', updated_at: expect.any(String) });

      const reenabled = await json(await patch(created.id, { status: 'enabled' }));
      expect(reenabled.status).toBe('enabled');
    });

    it('updates only the endpoint_url', async () => {
      const created = await create();
      const updated = await json(await patch(created.id, { endpoint_url: 'https://updated.example.com/webhooks' }));
      expect(updated.endpoint_url).toBe('https://updated.example.com/webhooks');
      expect(updated.events).toEqual(created.events);
      expect(updated.secret).toBe(created.secret);
      expect(updated.status).toBe('enabled');
    });

    it('updates only the events', async () => {
      const created = await create();
      const updated = await json(await patch(created.id, { events: ['session.created', 'session.created'] }));
      expect(updated.events).toEqual(['session.created']);
      expect(updated.endpoint_url).toBe(created.endpoint_url);
    });

    it('leaves an endpoint alone for an empty body', async () => {
      const created = await create();
      const res = await patch(created.id, {});
      expect(res.status).toBe(200);
      expect(await json(res)).toStrictEqual({ ...created, updated_at: expect.any(String) });
    });

    it('ignores enabled, secret and the legacy url', async () => {
      const created = await create();
      const updated = await json(
        await patch(created.id, { enabled: false, secret: 'rotated', url: 'https://ignored.example.com' }),
      );
      expect(updated.status).toBe('enabled');
      expect(updated.secret).toBe(created.secret);
      expect(updated.endpoint_url).toBe(created.endpoint_url);
    });

    it.each([
      [
        'an invalid status',
        { status: 'invalid' },
        [{ code: 'status_required', message: 'status must be one of the following values: enabled, disabled' }],
      ],
      [
        'a null status',
        { status: null },
        [{ code: 'status_required', message: 'status must be one of the following values: enabled, disabled' }],
      ],
      [
        'a boolean status',
        { status: true },
        [{ code: 'status_required', message: 'status must be one of the following values: enabled, disabled' }],
      ],
      [
        'a null endpoint_url',
        { endpoint_url: null },
        [{ code: 'endpoint_url_string_required', message: 'Endpoint Url must be a non-empty string.' }],
      ],
      [
        'a non-string endpoint_url',
        { endpoint_url: 123 },
        [{ code: 'endpoint_url_string_required', message: 'Endpoint Url must be a string.' }],
      ],
      [
        'null events',
        { events: null },
        [{ code: 'events_string_required', message: 'Events must be a non-empty string.' }],
      ],
      [
        'empty events',
        { events: [] },
        [{ code: 'events_array_required', message: 'Events must be a non-empty array.' }],
      ],
      [
        'a non-string event',
        { events: [123] },
        [{ code: 'events_string_required', message: 'Events must be a string.' }],
      ],
      [
        'several bad fields, reported in DTO order',
        { endpoint_url: '', status: 'off', events: 'user.created' },
        [
          { code: 'endpoint_url_string_required', message: 'Endpoint Url must be a non-empty string.' },
          { code: 'status_required', message: 'status must be one of the following values: enabled, disabled' },
          { code: 'events_array_required', message: 'Events must be a non-empty array.' },
        ],
      ],
    ])('returns 422 invalid_request_parameters for %s', async (_case, body, errors) => {
      const created = await create();
      const res = await patch(created.id, body);
      expect(res.status).toBe(422);
      expect(await json(res)).toStrictEqual(validationFailed(errors));
    });

    it('returns 422 invalid_url for an http endpoint_url off the loopback, and accepts one on it', async () => {
      const created = await create();
      const res = await patch(created.id, { endpoint_url: 'http://example.com/webhooks' });
      expect(res.status).toBe(422);
      expect(await json(res)).toStrictEqual({
        message: 'The `endpoint_url` must be an HTTPS URL',
        code: 'invalid_url',
      });

      const local = await patch(created.id, { endpoint_url: 'http://localhost:5005/webhooks' });
      expect(local.status).toBe(200);
      expect((await json(local)).endpoint_url).toBe('http://localhost:5005/webhooks');
    });

    it('returns 422 unknown_event_type for a name outside the subscribable catalog', async () => {
      const created = await create();
      const res = await patch(created.id, { events: ['user.created', 'unknown.event'] });
      expect(res.status).toBe(422);
      expect(await json(res)).toStrictEqual(
        validationFailed([{ code: 'unknown_event_type', message: '`unknown.event` is not a supported event type' }]),
      );
    });

    it('returns 409 duplicate_endpoint when moving to a URL another endpoint uses', async () => {
      await create({ ...VALID, endpoint_url: 'https://existing.example.com/webhooks' });
      const created = await create();
      const res = await patch(created.id, { endpoint_url: 'https://existing.example.com/webhooks' });
      expect(res.status).toBe(409);
      expect(await json(res)).toStrictEqual({
        message: "A Webhook Endpoint with the endpoint url 'https://existing.example.com/webhooks' already exists.",
        code: 'duplicate_endpoint',
      });
    });

    it('accepts an endpoint keeping its own URL', async () => {
      const created = await create();
      const res = await patch(created.id, { endpoint_url: created.endpoint_url });
      expect(res.status).toBe(200);
    });

    it('returns 404 entity_not_found for an unknown endpoint', async () => {
      const res = await patch('we_nonexistent', { status: 'disabled' });
      expect(res.status).toBe(404);
      expect(await json(res)).toStrictEqual({
        message: "Webhook Endpoint not found: 'we_nonexistent'.",
        code: 'entity_not_found',
        entity_id: 'we_nonexistent',
      });
    });

    // Production validates the DTO while resolving the handler's arguments, before the lookup;
    // the controller-level rules (HTTPS, catalog) run after it.
    it('checks the body before looking the endpoint up, as the DTO pipe does', async () => {
      const malformed = await patch('we_nonexistent', { status: 'off' });
      expect(malformed.status).toBe(422);
      expect((await json(malformed)).code).toBe('invalid_request_parameters');

      const wellFormed = await patch('we_nonexistent', { endpoint_url: 'http://example.com/webhooks' });
      expect(wellFormed.status).toBe(404);
    });

    it('no longer answers PUT, which production never served', async () => {
      const created = await create();
      const res = await req(`/webhook_endpoints/${created.id}`, {
        method: 'PUT',
        body: JSON.stringify({ status: 'disabled' }),
      });
      expect(res.status).toBe(404);
    });
  });

  // The seed keeps what the API refuses — an `http://` receiver, a pinned secret, an empty
  // `events` list meaning every event — but speaks the wire vocabulary and rejects what could
  // never fire. `validateSeedConfig` (behind `--validate-config`) and `seedFromConfig` agree,
  // so a bad seed is reported before the emulator starts, not at startup.
  describe('seed config', () => {
    const receiver = 'http://localhost:5005/webhooks';

    it('seeds status, a pinned secret, an http receiver and the catch-all empty events list', () => {
      const { store } = createTestApp();
      seedFromConfig(store, 'http://localhost:0', {
        webhookEndpoints: [
          { endpoint_url: receiver, secret: 'whsec_pinned', events: [] },
          {
            endpoint_url: 'http://localhost:5006/webhooks',
            events: ['user.created', 'user.created'],
            status: 'disabled',
          },
          { endpoint_url: 'http://localhost:5007/webhooks', enabled: false },
        ],
      });
      const [all, disabled, legacy] = getWorkOSStore(store).webhookEndpoints.all();
      expect(all).toMatchObject({ endpoint_url: receiver, secret: 'whsec_pinned', status: 'enabled', events: [] });
      expect(disabled).toMatchObject({ status: 'disabled', events: ['user.created'] });
      expect(legacy.status).toBe('disabled');
    });

    it.each([
      ['an unknown event name', { endpoint_url: receiver, events: ['user.cretaed'] }, 'events'],
      [
        'an event hidden from subscription',
        { endpoint_url: receiver, events: ['authentication.mfa_failed'] },
        'events',
      ],
      ['an invalid status', { endpoint_url: receiver, status: 'off' as 'enabled' }, 'status'],
    ])('reports %s from validateSeedConfig and refuses it in seedFromConfig', (_case, endpoint, field) => {
      const { valid, errors } = validateSeedConfig({ webhookEndpoints: [endpoint] });
      expect(valid).toBe(false);
      expect(errors.map((e) => e.path)).toEqual([`webhookEndpoints[0].${field}`]);

      const { store } = createTestApp();
      expect(() => seedFromConfig(store, 'http://localhost:0', { webhookEndpoints: [endpoint] })).toThrow(
        `webhookEndpoints[0].${field}`,
      );
    });
  });

  describe('DELETE /webhook_endpoints/:id', () => {
    it('deletes a webhook endpoint', async () => {
      const created = await create();

      const delRes = await req(`/webhook_endpoints/${created.id}`, { method: 'DELETE' });
      expect(delRes.status).toBe(204);

      const getRes = await req(`/webhook_endpoints/${created.id}`);
      expect(getRes.status).toBe(404);
    });

    it('returns 404 entity_not_found for an unknown endpoint', async () => {
      const res = await req('/webhook_endpoints/we_nonexistent', { method: 'DELETE' });
      expect(res.status).toBe(404);
      expect((await json(res)).code).toBe('entity_not_found');
    });
  });
});
