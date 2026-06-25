/**
 * Tests for concurrent webhook delivery scenarios
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createEmulator, type Emulator } from '../index.js';

interface ReceivedWebhook {
  id: string;
  event: string;
  data: Record<string, any>;
  created_at: string;
}

interface WebhookReceiver {
  url: string;
  received: ReceivedWebhook[];
  close: () => Promise<void>;
}

function startWebhookReceiver(): Promise<WebhookReceiver> {
  const received: ReceivedWebhook[] = [];
  const server: Server = createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => (rawBody += chunk));
    req.on('end', () => {
      const parsed = JSON.parse(rawBody);
      received.push(parsed);
      res.writeHead(200).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/webhooks`,
        received,
        close: () => new Promise((res2, rej) => server.close((err) => (err ? rej(err) : res2()))),
      });
    });
  });
}

describe('Concurrent Webhook Delivery', () => {
  let emulator: Emulator;
  let receiver: WebhookReceiver;

  beforeAll(async () => {
    receiver = await startWebhookReceiver();
    emulator = await createEmulator({ port: 0 });

    // Register webhook endpoint
    await fetch(`${emulator.url}/webhook_endpoints`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({
        endpoint_url: receiver.url,
        events: [],
      }),
    });
  });

  afterAll(async () => {
    await emulator.close();
    await receiver.close();
  });

  it('should handle concurrent user creation events', async () => {
    const initialCount = receiver.received.length;

    // Create 10 users concurrently
    const userPromises = Array.from({ length: 10 }, (_, i) =>
      fetch(`${emulator.url}/user_management/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${emulator.apiKey}`,
        },
        body: JSON.stringify({
          email: `concurrent${i}@example.com`,
          password: 'password123',
        }),
      }),
    );

    const responses = await Promise.all(userPromises);
    expect(responses.every((r) => r.status === 201)).toBe(true);

    // Wait for webhooks to be delivered
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify all webhooks were delivered
    const userCreatedEvents = receiver.received.slice(initialCount).filter((w) => w.event === 'user.created');
    expect(userCreatedEvents.length).toBe(10);
  });

  it('should handle mixed concurrent operations', async () => {
    const initialCount = receiver.received.length;

    // Perform mixed operations concurrently
    const operations = [
      // Create users
      fetch(`${emulator.url}/user_management/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${emulator.apiKey}`,
        },
        body: JSON.stringify({ email: 'user1@example.com', password: 'pass' }),
      }),
      fetch(`${emulator.url}/user_management/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${emulator.apiKey}`,
        },
        body: JSON.stringify({ email: 'user2@example.com', password: 'pass' }),
      }),
      // Create organizations
      fetch(`${emulator.url}/organizations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${emulator.apiKey}`,
        },
        body: JSON.stringify({ name: 'Org 1' }),
      }),
      fetch(`${emulator.url}/organizations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${emulator.apiKey}`,
        },
        body: JSON.stringify({ name: 'Org 2' }),
      }),
    ];

    const responses = await Promise.all(operations);
    // All operations should succeed
    expect(responses.every((r) => r.status === 201)).toBe(true);

    // Wait for webhooks
    await new Promise((resolve) => setTimeout(resolve, 100));

    const newEvents = receiver.received.slice(initialCount);
    expect(newEvents.length).toBeGreaterThanOrEqual(4); // Should get at least 4 events

    // Verify we got both user.created and organization.created events
    const eventTypes = new Set(newEvents.map((w) => w.event));
    expect(eventTypes.has('user.created')).toBe(true);
    expect(eventTypes.has('organization.created')).toBe(true);
  });

  it('should handle rapid sequential operations', async () => {
    const initialCount = receiver.received.length;

    // Create 50 users rapidly in sequence
    for (let i = 0; i < 50; i++) {
      await fetch(`${emulator.url}/user_management/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${emulator.apiKey}`,
        },
        body: JSON.stringify({
          email: `rapid${i}@example.com`,
          password: 'password123',
        }),
      });
    }

    // Wait for webhooks to catch up
    await new Promise((resolve) => setTimeout(resolve, 500));

    const userCreatedEvents = receiver.received.slice(initialCount).filter((w) => w.event === 'user.created');
    expect(userCreatedEvents.length).toBe(50);
  });

  it('should maintain event order for sequential operations', async () => {
    const initialCount = receiver.received.length;

    // Create users sequentially and track order
    const createdUserIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${emulator.url}/user_management/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${emulator.apiKey}`,
        },
        body: JSON.stringify({
          email: `ordered${i}@example.com`,
          password: 'password123',
        }),
      });
      const user = await res.json();
      createdUserIds.push(user.id);
    }

    // Wait for webhooks
    await new Promise((resolve) => setTimeout(resolve, 100));

    const userCreatedEvents = receiver.received.slice(initialCount).filter((w) => w.event === 'user.created');
    expect(userCreatedEvents.length).toBe(5);

    // Verify order is maintained
    const webhookUserIds = userCreatedEvents.map((w) => w.data.id);
    expect(webhookUserIds).toEqual(createdUserIds);
  });

  it('should handle webhook endpoint failures gracefully', async () => {
    // Create a second receiver that will fail
    const failingReceiver: WebhookReceiver = {
      url: 'http://127.0.0.1:59999/webhooks', // Non-existent port
      received: [],
      close: async () => {},
    };

    // Register failing endpoint
    const res = await fetch(`${emulator.url}/webhook_endpoints`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({
        endpoint_url: failingReceiver.url,
        events: [],
      }),
    });
    expect(res.status).toBe(201);

    // Create a user - should not throw despite webhook failure
    const userRes = await fetch(`${emulator.url}/user_management/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({
        email: 'failing@example.com',
        password: 'password123',
      }),
    });

    // User creation should succeed even if webhook delivery fails
    expect(userRes.status).toBe(201);
  });

  it('should handle concurrent authentication events', async () => {
    const initialCount = receiver.received.length;

    // Create users first
    const user1Res = await fetch(`${emulator.url}/user_management/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({
        email: 'auth1@example.com',
        password: 'password123',
      }),
    });
    await user1Res.json();

    const user2Res = await fetch(`${emulator.url}/user_management/users`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${emulator.apiKey}`,
      },
      body: JSON.stringify({
        email: 'auth2@example.com',
        password: 'password123',
      }),
    });
    await user2Res.json();

    // Authenticate both users concurrently
    const authPromises = [
      fetch(`${emulator.url}/user_management/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'password',
          email: 'auth1@example.com',
          password: 'password123',
        }),
      }),
      fetch(`${emulator.url}/user_management/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'password',
          email: 'auth2@example.com',
          password: 'password123',
        }),
      }),
    ];

    const authResponses = await Promise.all(authPromises);
    expect(authResponses.every((r) => r.status === 200)).toBe(true);

    // Wait for webhooks
    await new Promise((resolve) => setTimeout(resolve, 100));

    const newEvents = receiver.received.slice(initialCount);
    const authEvents = newEvents.filter((w) => w.event.startsWith('authentication.'));
    expect(authEvents.length).toBe(2);
  });
});
