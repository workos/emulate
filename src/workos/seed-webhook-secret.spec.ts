/**
 * Pinning a webhook endpoint's signing secret in a seed file. A consumer that verifies
 * `WorkOS-Signature` headers needs the secret in its environment before anything talks to
 * the emulator, and the API masks the secret after creation (`abc12345****`), so a generated
 * one is unrecoverable — like `apiKeys[].value` and `connectApplications[].client_secret`,
 * the seed must be able to declare it. These tests prove a pinned secret is what actually
 * signs deliveries, and that a seed without one still gets a generated secret.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { createEmulator, type Emulator } from '../index.js';
import { validateSeedConfig } from './config-validator.js';

interface ReceivedWebhook {
  signature: string;
  rawBody: string;
  event: string;
}

interface WebhookReceiver {
  url: string;
  received: ReceivedWebhook[];
  close: () => Promise<void>;
}

/** Capture the raw body and signature header, which is what a verifying consumer reads. */
function startWebhookReceiver(): Promise<WebhookReceiver> {
  const received: ReceivedWebhook[] = [];
  const server: Server = createServer((req, res) => {
    let rawBody = '';
    req.on('data', (chunk) => (rawBody += chunk));
    req.on('end', () => {
      received.push({
        signature: (req.headers['workos-signature'] as string) ?? '',
        rawBody,
        event: JSON.parse(rawBody).event,
      });
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
        close: () => new Promise((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

/**
 * Poll until a predicate over received webhooks holds, or a timeout elapses. Webhook
 * delivery is fire-and-forget, so a fixed sleep races delivery on a slow runner.
 */
async function waitForWebhooks(
  receiver: WebhookReceiver,
  predicate: (received: ReceivedWebhook[]) => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate(receiver.received)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Verify the way the SDKs' `webhooks.constructEvent` does: HMAC-SHA256 over `{t}.{body}`. */
function verifySignature(delivery: ReceivedWebhook, secret: string): boolean {
  const match = delivery.signature.match(/^t=(\d+), v1=([0-9a-f]+)$/);
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(`${match[1]}.${delivery.rawBody}`).digest('hex');
  return match[2] === expected;
}

const PINNED_SECRET = 'whsec_seeded_for_tests';

describe('Seeding a pinned webhook signing secret', () => {
  let emulator: Emulator | undefined;
  let receiver: WebhookReceiver | undefined;

  afterEach(async () => {
    await emulator?.close();
    await receiver?.close();
    emulator = undefined;
    receiver = undefined;
  });

  const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

  it('signs deliveries with the pinned secret', async () => {
    receiver = await startWebhookReceiver();
    emulator = await createEmulator({
      port: 0,
      seed: {
        webhookEndpoints: [{ endpoint_url: receiver.url, secret: PINNED_SECRET, events: [] }],
      },
    });

    const res = await fetch(`${emulator.url}/user_management/users`, {
      method: 'POST',
      headers: auth(emulator.apiKey),
      body: JSON.stringify({ email: 'verified-consumer@acme.com' }),
    });
    expect(res.status).toBe(201);

    await waitForWebhooks(receiver, (r) => r.some((d) => d.event === 'user.created'));
    const delivery = receiver.received.find((d) => d.event === 'user.created');
    expect(delivery).toBeDefined();
    expect(verifySignature(delivery!, PINNED_SECRET)).toBe(true);
  });

  it('still generates a secret when the seed omits one', async () => {
    receiver = await startWebhookReceiver();
    emulator = await createEmulator({
      port: 0,
      seed: {
        webhookEndpoints: [{ endpoint_url: receiver.url, events: [] }],
      },
    });

    const res = await fetch(`${emulator.url}/user_management/users`, {
      method: 'POST',
      headers: auth(emulator.apiKey),
      body: JSON.stringify({ email: 'generated-secret@acme.com' }),
    });
    expect(res.status).toBe(201);

    await waitForWebhooks(receiver, (r) => r.some((d) => d.event === 'user.created'));
    const delivery = receiver.received.find((d) => d.event === 'user.created');
    expect(delivery).toBeDefined();
    // Signed, but not with the pinned value — a generated secret still signs every delivery.
    expect(delivery!.signature).toMatch(/^t=\d+, v1=[0-9a-f]{64}$/);
    expect(verifySignature(delivery!, PINNED_SECRET)).toBe(false);
  });

  it('accepts a string secret and rejects anything else', () => {
    const ok = validateSeedConfig({
      webhookEndpoints: [{ endpoint_url: 'http://localhost:5005/webhooks', secret: PINNED_SECRET }],
    });
    expect(ok.valid).toBe(true);

    const bad = validateSeedConfig({
      webhookEndpoints: [{ endpoint_url: 'http://localhost:5005/webhooks', secret: 12345 as unknown as string }],
    });
    expect(bad.valid).toBe(false);
    expect(bad.errors[0].path).toBe('webhookEndpoints[0].secret');

    const empty = validateSeedConfig({
      webhookEndpoints: [{ endpoint_url: 'http://localhost:5005/webhooks', secret: '' }],
    });
    expect(empty.valid).toBe(false);
    expect(empty.errors[0].path).toBe('webhookEndpoints[0].secret');
  });
});
