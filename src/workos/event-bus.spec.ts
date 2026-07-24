import { describe, it, expect, beforeEach, afterEach, spyOn, type Mock } from 'bun:test';
import { createHmac } from 'node:crypto';
import { Store } from '../core/store.js';
import { getWorkOSStore } from './store.js';
import { EventBus } from './event-bus.js';

describe('EventBus', () => {
  let store: Store;
  let bus: EventBus;
  let fetchSpy: Mock<typeof fetch> | undefined;

  beforeEach(() => {
    store = new Store();
    bus = new EventBus(store);
  });

  // bun test runs every file in one process: restore here so a failing
  // assertion can never leak a mocked fetch into later spec files.
  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = undefined;
  });

  it('stores events on emit', () => {
    const ws = getWorkOSStore(store);
    bus.emit({ event: 'user.created', data: { id: 'user_1', email: 'test@example.com' } });

    const events = ws.events.all();
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('user.created');
    expect(events[0].data).toEqual({ id: 'user_1', email: 'test@example.com' });
    expect(events[0].environment_id).toBeNull();
  });

  it('stores environment_id when provided', () => {
    const ws = getWorkOSStore(store);
    bus.emit({ event: 'user.created', data: {}, environment_id: 'env_123' });

    const events = ws.events.all();
    expect(events[0].environment_id).toBe('env_123');
  });

  it('stores multiple events in order', () => {
    const ws = getWorkOSStore(store);
    bus.emit({ event: 'user.created', data: { id: '1' } });
    bus.emit({ event: 'user.updated', data: { id: '1' } });
    bus.emit({ event: 'organization.created', data: { id: '2' } });

    const events = ws.events.all();
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.event)).toEqual(['user.created', 'user.updated', 'organization.created']);
  });

  it('does not deliver to disabled webhook endpoints', () => {
    const ws = getWorkOSStore(store);
    ws.webhookEndpoints.insert({
      object: 'webhook_endpoint',
      endpoint_url: 'http://localhost:9999/webhook',
      secret: 'whsec_test',
      enabled: false,
      events: [],
      description: null,
    });

    bus.rebuildIndex();
    // This should not attempt delivery (no fetch error even though URL is unreachable)
    bus.emit({ event: 'user.created', data: {} });
    expect(ws.events.all()).toHaveLength(1);
  });

  it('filters webhook endpoints by event subscription', () => {
    const ws = getWorkOSStore(store);
    ws.webhookEndpoints.insert({
      object: 'webhook_endpoint',
      endpoint_url: 'http://localhost:9999/webhook',
      secret: 'whsec_test',
      enabled: true,
      events: ['organization.created'],
      description: null,
    });

    bus.rebuildIndex();
    // user.created should not match the endpoint's filter
    bus.emit({ event: 'user.created', data: {} });
    expect(ws.events.all()).toHaveLength(1);
  });

  it('delivers to webhook endpoint with correct HMAC signature', async () => {
    const ws = getWorkOSStore(store);
    const secret = 'whsec_test_verify_signature';
    let receivedBody: string | undefined;
    let receivedSignature: string | undefined;

    // Mock fetch to capture the delivery
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('ok'));

    ws.webhookEndpoints.insert({
      object: 'webhook_endpoint',
      endpoint_url: 'http://localhost:9999/webhook',
      secret,
      enabled: true,
      events: [],
      description: null,
    });

    bus.rebuildIndex();
    bus.emit({ event: 'user.created', data: { id: 'user_1' } });

    // Wait for async delivery
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, init] = fetchSpy.mock.calls[0];
    receivedBody = init!.body as string;
    receivedSignature = (init!.headers as Record<string, string>)['WorkOS-Signature'];

    // Verify signature format
    expect(receivedSignature).toMatch(/^t=\d+,v1=[a-f0-9]{64}$/);

    // Verify HMAC is correct
    const match = receivedSignature!.match(/^t=(\d+),v1=([a-f0-9]+)$/)!;
    const [, timestamp, hash] = match;
    const expectedHash = createHmac('sha256', secret).update(`${timestamp}.${receivedBody}`).digest('hex');
    expect(hash).toBe(expectedHash);
  });

  it('does not block when webhook delivery times out', async () => {
    const ws = getWorkOSStore(store);

    // Mock fetch to simulate a slow endpoint
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
      // Cast: Bun types `fetch` with a `preconnect` property the mock closure doesn't need.
      (() => new Promise((resolve) => setTimeout(() => resolve(new Response('ok')), 10000))) as unknown as typeof fetch,
    );

    ws.webhookEndpoints.insert({
      object: 'webhook_endpoint',
      endpoint_url: 'http://localhost:9999/webhook',
      secret: 'whsec_test',
      enabled: true,
      events: [],
      description: null,
    });

    bus.rebuildIndex();
    // emit() should return immediately (fire-and-forget)
    const start = Date.now();
    bus.emit({ event: 'user.created', data: {} });
    const elapsed = Date.now() - start;

    // Should complete in under 100ms (not waiting for 10s fetch)
    expect(elapsed).toBeLessThan(100);
    expect(ws.events.all()).toHaveLength(1);
  });
});
