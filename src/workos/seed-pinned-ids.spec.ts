/**
 * Pinning organization and user ids in a seed file. WorkOS ids are foreign keys that
 * live in an application's database, so a seed must be able to declare the id a backend
 * already references — otherwise a fresh, generated id never matches the copied data and
 * the restart-minted id churns duplicate rows. These tests prove a pinned id is what the
 * API returns, what a login token carries, and what a webhook delivers.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createEmulator, type Emulator } from '../index.js';
import { validateSeedConfig } from './config-validator.js';

const PINNED_ORG_ID = 'org_01ABCDEFGHIJKLMNOPQRSTUVWX';
const PINNED_USER_ID = 'user_01ABCDEFGHIJKLMNOPQRSTUVWX';

interface ReceivedWebhook {
  event: string;
  data: Record<string, any>;
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
      received.push(JSON.parse(rawBody));
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

/** Decode a JWT payload without verifying — the test only inspects claims. */
function decodeJwt(token: string): Record<string, any> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
}

/**
 * Poll until a predicate over received webhooks holds, or a timeout elapses. Webhook
 * delivery is fire-and-forget, so a fixed sleep races delivery on a slow runner; wait for
 * the events to actually arrive instead.
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

describe('Seeding pinned organization and user ids', () => {
  let emulator: Emulator | undefined;
  let receiver: WebhookReceiver | undefined;

  afterEach(async () => {
    await emulator?.close();
    await receiver?.close();
    emulator = undefined;
    receiver = undefined;
  });

  const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

  it('returns the pinned organization id from the API', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: { organizations: [{ id: PINNED_ORG_ID, name: 'Preview Org' }] },
    });

    const res = await fetch(`${emulator.url}/organizations/${PINNED_ORG_ID}`, { headers: auth(emulator.apiKey) });
    expect(res.status).toBe(200);
    const org = (await res.json()) as any;
    expect(org.id).toBe(PINNED_ORG_ID);
    expect(org.name).toBe('Preview Org');
  });

  it('returns the pinned user id from the API', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: { users: [{ id: PINNED_USER_ID, email: 'operator@acme.com', password: 'secret', email_verified: true }] },
    });

    const res = await fetch(`${emulator.url}/user_management/users/${PINNED_USER_ID}`, {
      headers: auth(emulator.apiKey),
    });
    expect(res.status).toBe(200);
    const user = (await res.json()) as any;
    expect(user.id).toBe(PINNED_USER_ID);
    expect(user.email).toBe('operator@acme.com');
  });

  it('reports the pinned ids in login tokens', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ id: PINNED_USER_ID, email: 'operator@acme.com', password: 'secret', email_verified: true }],
        organizations: [
          {
            id: PINNED_ORG_ID,
            name: 'Preview Org',
            memberships: [{ email: 'operator@acme.com', role: 'member', status: 'active' }],
          },
        ],
      },
    });

    // Password login resolves the pinned user id into the response and the access token.
    const loginRes = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'operator@acme.com', password: 'secret' }),
    });
    expect(loginRes.status).toBe(200);
    const login = (await loginRes.json()) as any;
    expect(login.user.id).toBe(PINNED_USER_ID);
    expect(decodeJwt(login.access_token).sub).toBe(PINNED_USER_ID);

    // Selecting the org (switchToOrganization) scopes the session to the pinned org id.
    const orgRes = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: login.refresh_token,
        organization_id: PINNED_ORG_ID,
      }),
    });
    expect(orgRes.status).toBe(200);
    const scoped = (await orgRes.json()) as any;
    expect(scoped.organization_id).toBe(PINNED_ORG_ID);
    expect(decodeJwt(scoped.access_token).org_id).toBe(PINNED_ORG_ID);
  });

  it('delivers the pinned ids in webhooks', async () => {
    receiver = await startWebhookReceiver();
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ id: PINNED_USER_ID, email: 'operator@acme.com', password: 'secret' }],
        organizations: [{ id: PINNED_ORG_ID, name: 'Preview Org' }],
      },
    });

    // Endpoints registered in a seed file receive no deliveries for that same seed data
    // (they are registered last, mirroring real WorkOS), so register via the API and then
    // mutate the seeded resources to fire delivered events carrying the pinned ids.
    const reg = await fetch(`${emulator.url}/webhook_endpoints`, {
      method: 'POST',
      headers: auth(emulator.apiKey),
      body: JSON.stringify({ endpoint_url: receiver.url, events: [] }),
    });
    expect(reg.status).toBe(201);

    await fetch(`${emulator.url}/organizations/${PINNED_ORG_ID}`, {
      method: 'PUT',
      headers: auth(emulator.apiKey),
      body: JSON.stringify({ name: 'Preview Org Renamed' }),
    });
    await fetch(`${emulator.url}/user_management/users/${PINNED_USER_ID}`, {
      method: 'PUT',
      headers: auth(emulator.apiKey),
      body: JSON.stringify({ first_name: 'Operator' }),
    });

    await waitForWebhooks(
      receiver,
      (received) =>
        received.some((w) => w.event === 'organization.updated') && received.some((w) => w.event === 'user.updated'),
    );

    const orgEvent = receiver.received.find((w) => w.event === 'organization.updated');
    expect(orgEvent?.data.id).toBe(PINNED_ORG_ID);
    const userEvent = receiver.received.find((w) => w.event === 'user.updated');
    expect(userEvent?.data.id).toBe(PINNED_USER_ID);
  });

  describe('seed config validation', () => {
    const findError = (config: Parameters<typeof validateSeedConfig>[0], pathFragment: string) => {
      const { valid, errors } = validateSeedConfig(config);
      expect(valid).toBe(false);
      const error = errors.find((e) => e.path.includes(pathFragment));
      expect(error, `expected an error at ${pathFragment}, got: ${JSON.stringify(errors)}`).toBeDefined();
      return error!;
    };

    it('rejects two organizations sharing a pinned id', () => {
      const error = findError(
        {
          organizations: [
            { id: PINNED_ORG_ID, name: 'Org A' },
            { id: PINNED_ORG_ID, name: 'Org B' },
          ],
        },
        'organizations[1].id',
      );
      expect(error.message).toContain('unique');
    });

    it('rejects two users sharing a pinned id', () => {
      const error = findError(
        {
          users: [
            { id: PINNED_USER_ID, email: 'a@acme.com' },
            { id: PINNED_USER_ID, email: 'b@acme.com' },
          ],
        },
        'users[1].id',
      );
      expect(error.message).toContain('unique');
    });

    it('rejects an empty-string organization id', () => {
      const error = findError({ organizations: [{ id: '', name: 'Org A' }] }, 'organizations[0].id');
      expect(error.message).toContain('URL-safe');
    });

    it('rejects a non-string user id', () => {
      const error = findError({ users: [{ id: 123 as never, email: 'a@acme.com' }] }, 'users[0].id');
      expect(error.message).toContain('URL-safe');
    });

    it('rejects a pinned id with a path delimiter (unreachable via the :id route)', () => {
      const orgErr = findError({ organizations: [{ id: 'org/custom', name: 'Org A' }] }, 'organizations[0].id');
      expect(orgErr.message).toContain('URL-safe');
      const userErr = findError({ users: [{ id: 'user/custom', email: 'a@acme.com' }] }, 'users[0].id');
      expect(userErr.message).toContain('URL-safe');
    });

    it('accepts distinct pinned ids on organizations and users', () => {
      const result = validateSeedConfig({
        users: [{ id: PINNED_USER_ID, email: 'operator@acme.com' }],
        organizations: [{ id: PINNED_ORG_ID, name: 'Preview Org' }],
      });
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  });
});
