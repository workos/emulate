/**
 * End-to-end login flow story, over real HTTP.
 *
 * Boots the emulator with createEmulator() plus a local webhook receiver, then
 * walks the workos.com/docs login flows and asserts that every resource
 * creation and authentication outcome delivers a signed webhook whose name and
 * payload match the OpenAPI spec (via the generated EVENT_DATA_REQUIREMENTS).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { createEmulator, type Emulator } from './index.js';
import { EVENT_DATA_REQUIREMENTS } from './workos/generated/events.js';

let webhookSecret = '';

interface ReceivedWebhook {
  id: string;
  event: string;
  data: Record<string, any>;
  created_at: string;
  signature: string;
  rawBody: string;
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
      received.push({ ...parsed, signature: req.headers['workos-signature'] as string, rawBody });
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

describe('end-to-end login flow (workos.com/docs story)', () => {
  let emulator: Emulator;
  let receiver: WebhookReceiver;
  let userId: string;
  const email = 'alice@e2e-story.test';

  const api = (path: string, init?: RequestInit) =>
    fetch(`${emulator.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${emulator.apiKey}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });

  /** Deliveries are fire-and-forget — poll until the named webhook arrives past the cursor. */
  function waitForWebhook(event: string, opts?: { after?: number; timeout?: number }): Promise<ReceivedWebhook> {
    return vi.waitFor(
      () => {
        const hit = receiver.received.slice(opts?.after ?? 0).find((w) => w.event === event);
        if (!hit) {
          const seen = receiver.received.map((w) => w.event).join(', ') || '(none)';
          throw new Error(`no '${event}' webhook yet; saw: ${seen}`);
        }
        return hit;
      },
      { timeout: opts?.timeout ?? 3000, interval: 25 },
    );
  }

  /** WorkOS-Signature: t=<unix>,v1=<hmac-sha256 of "t.body"> — same scheme the official SDKs verify. */
  function verifySignature(webhook: ReceivedWebhook): void {
    const match = webhook.signature?.match(/^t=(\d+),v1=([a-f0-9]{64})$/);
    expect(match, `unexpected signature format: ${webhook.signature}`).toBeTruthy();
    const expected = createHmac('sha256', webhookSecret).update(`${match![1]}.${webhook.rawBody}`).digest('hex');
    expect(match![2]).toBe(expected);
  }

  /** Assert the payload carries every field the OpenAPI spec marks required for this event. */
  function expectSpecShape(webhook: ReceivedWebhook): void {
    const requirements = EVENT_DATA_REQUIREMENTS[webhook.event];
    expect(requirements, `event '${webhook.event}' is not in the spec catalog`).toBeDefined();
    for (const field of requirements.required) {
      expect(webhook.data, `'${webhook.event}' payload is missing required field '${field}'`).toHaveProperty(field);
    }
    if (requirements.type) expect(webhook.data.type).toBe(requirements.type);
    if (requirements.status) expect(webhook.data.status).toBe(requirements.status);
  }

  beforeAll(async () => {
    webhookSecret = randomBytes(32).toString('hex');
    receiver = await startWebhookReceiver();
    emulator = await createEmulator({ port: 0 });

    const res = await api('/webhook_endpoints', {
      method: 'POST',
      body: JSON.stringify({ endpoint_url: receiver.url, secret: webhookSecret, events: [] }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(async () => {
    await emulator.close();
    await receiver.close();
  });

  it('delivers a signed, spec-shaped user.created webhook when a user registers', async () => {
    const cursor = receiver.received.length;

    const res = await api('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email, password: 'correct horse battery staple', first_name: 'Alice' }),
    });
    expect(res.status).toBe(201);
    userId = (await res.json()).id;

    const webhook = await waitForWebhook('user.created', { after: cursor });
    expect(webhook.data.email).toBe(email);
    expect(webhook.data.id).toBe(userId);
    verifySignature(webhook);
    expectSpecShape(webhook);
  });

  it('delivers organization.created and organization_membership.created webhooks', async () => {
    const cursor = receiver.received.length;

    const orgRes = await api('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'E2E Story Org' }),
    });
    const org = await orgRes.json();

    await api('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ user_id: userId, organization_id: org.id }),
    });

    const orgWebhook = await waitForWebhook('organization.created', { after: cursor });
    expect(orgWebhook.data.name).toBe('E2E Story Org');
    verifySignature(orgWebhook);
    expectSpecShape(orgWebhook);

    const membershipWebhook = await waitForWebhook('organization_membership.created', { after: cursor });
    expect(membershipWebhook.data.user_id).toBe(userId);
    expect(membershipWebhook.data.organization_id).toBe(org.id);
    verifySignature(membershipWebhook);
  });

  it('completes the hosted authorize → authenticate flow with session and oauth webhooks', async () => {
    const cursor = receiver.received.length;

    // Step 1 (docs: "Redirect users to AuthKit"): the app sends the browser to /authorize
    const authorizeRes = await fetch(
      `${emulator.url}/user_management/authorize?` +
        new URLSearchParams({
          response_type: 'code',
          client_id: 'client_e2e',
          redirect_uri: 'http://localhost:3000/callback',
          state: 'e2e-state',
          login_hint: email,
        }),
      { redirect: 'manual' },
    );
    expect(authorizeRes.status).toBe(302);
    const callback = new URL(authorizeRes.headers.get('location')!);
    expect(callback.searchParams.get('state')).toBe('e2e-state');
    const code = callback.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // Step 2 (docs: "Exchange the code"): the callback handler authenticates
    const authRes = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'client_e2e' }),
    });
    expect(authRes.status).toBe(200);
    const auth = await authRes.json();
    expect(auth.access_token).toBeTruthy();
    expect(auth.refresh_token).toBeTruthy();
    expect(auth.user.email).toBe(email);
    // The hosted flow carries no provider info and this user has no oauth_provider configured, so
    // the emulator omits authentication_method rather than inventing one. (The oauth *event* and
    // session auth_method below still assert the generic 'oauth' — those enums allow it.)
    expect(auth.authentication_method).toBeUndefined();

    // Step 3: webhooks for the new session and the authentication outcome
    const sessionWebhook = await waitForWebhook('session.created', { after: cursor });
    expect(sessionWebhook.data).toMatchObject({ user_id: userId, auth_method: 'oauth', status: 'active' });
    verifySignature(sessionWebhook);
    expectSpecShape(sessionWebhook);

    const authWebhook = await waitForWebhook('authentication.oauth_succeeded', { after: cursor });
    expect(authWebhook.data).toMatchObject({ type: 'oauth', status: 'succeeded', user_id: userId, email });
    verifySignature(authWebhook);
    expectSpecShape(authWebhook);
  });

  it('signs in with a password and emits authentication.password_succeeded', async () => {
    const cursor = receiver.received.length;

    const res = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email, password: 'correct horse battery staple' }),
    });
    expect(res.status).toBe(200);

    const webhook = await waitForWebhook('authentication.password_succeeded', { after: cursor });
    expect(webhook.data).toMatchObject({ type: 'password', status: 'succeeded', user_id: userId, email });
    expectSpecShape(webhook);
  });

  it('completes magic auth using the code delivered by the magic_auth.created webhook', async () => {
    const cursor = receiver.received.length;

    const res = await api('/user_management/magic_auth', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(201);

    // The story beat: the webhook carries the code your app would have emailed
    const createdWebhook = await waitForWebhook('magic_auth.created', { after: cursor });
    expectSpecShape(createdWebhook);
    const code = createdWebhook.data.code as string;
    expect(code).toBeTruthy();

    const authRes = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'urn:workos:oauth:grant-type:magic-auth:code', code, email }),
    });
    expect(authRes.status).toBe(200);

    const webhook = await waitForWebhook('authentication.magic_auth_succeeded', { after: cursor });
    expect(webhook.data).toMatchObject({ type: 'magic_auth', status: 'succeeded', user_id: userId, email });
    expectSpecShape(webhook);
  });

  it('emits authentication.password_failed with an error object on a bad password', async () => {
    const cursor = receiver.received.length;

    const res = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email, password: 'wrong password' }),
    });
    expect(res.status).toBe(401);

    const webhook = await waitForWebhook('authentication.password_failed', { after: cursor });
    expect(webhook.data).toMatchObject({
      type: 'password',
      status: 'failed',
      email,
      error: { code: 'invalid_credentials', message: 'Invalid credentials' },
    });
    verifySignature(webhook);
    expectSpecShape(webhook);
  });

  it('completes a password reset driven entirely by webhooks', async () => {
    const cursor = receiver.received.length;

    const res = await api('/user_management/password_reset', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    expect(res.status).toBe(201);

    const createdWebhook = await waitForWebhook('password_reset.created', { after: cursor });
    expectSpecShape(createdWebhook);
    const token = createdWebhook.data.token as string;
    expect(token).toBeTruthy();

    const confirmRes = await api('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token, new_password: 'an even better passphrase' }),
    });
    expect(confirmRes.status).toBe(200);

    await waitForWebhook('password_reset.succeeded', { after: cursor });

    // The new password works — and emits its own success event
    const loginRes = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email, password: 'an even better passphrase' }),
    });
    expect(loginRes.status).toBe(200);
    await waitForWebhook('authentication.password_succeeded', { after: cursor });
  });

  it('triggers MFA challenge when user has enrolled factor and authenticates with password', async () => {
    const cursor = receiver.received.length;

    // Step 1: Enroll an MFA factor for the user
    const factorRes = await api(`/user_management/users/${userId}/auth_factors`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'totp',
      }),
    });
    expect(factorRes.status).toBe(201);
    const factor = await factorRes.json();

    // Step 2: Authenticate with password - should trigger MFA challenge
    const passwordRes = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email, password: 'an even better passphrase' }),
    });
    expect(passwordRes.status).toBe(403);
    const passwordChallenge = await passwordRes.json();
    expect(passwordChallenge.code).toBe('mfa_challenge');
    expect(passwordChallenge.pending_authentication_token).toBeTruthy();
    expect(passwordChallenge.authentication_challenge).toBeTruthy();

    // Verify that no session was created (MFA challenge prevents session creation)
    const sessionWebhooks = receiver.received.slice(cursor).filter((w) => w.event === 'session.created');
    expect(sessionWebhooks.length).toBe(0);

    // Verify that no authentication event was emitted yet (MFA not completed)
    const authWebhooks = receiver.received.slice(cursor).filter((w) => w.event.startsWith('authentication.'));
    expect(authWebhooks.length).toBe(0);

    // Cleanup: Remove the MFA factor for other tests
    await api(`/user_management/auth_factors/${factor.id}`, {
      method: 'DELETE',
    });
  });

  it('completes full MFA flow with password as primary factor and emits correct events', async () => {
    const cursor = receiver.received.length;

    // Step 1: Enroll an MFA factor for the user
    const factorRes = await api(`/user_management/users/${userId}/auth_factors`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'totp',
      }),
    });
    expect(factorRes.status).toBe(201);
    const factor = await factorRes.json();

    // Step 2: Authenticate with password to trigger MFA challenge
    const passwordRes = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email, password: 'an even better passphrase' }),
    });
    expect(passwordRes.status).toBe(403);
    const passwordChallenge = await passwordRes.json();
    const pendingToken = passwordChallenge.pending_authentication_token as string;
    const challengeId = passwordChallenge.authentication_challenge.id as string;

    // Step 3: Access the emulator's internal store to get the challenge code
    // In production, this would come from the user's TOTP app, but for testing
    // we need to extract it from the store since it's excluded from the response
    const { getWorkOSStore } = await import('./workos/store.js');
    const ws = getWorkOSStore(emulator.store);
    const challenge = ws.authChallenges.get(challengeId);
    const challengeCode = challenge?.code;

    if (!challengeCode) {
      throw new Error('Challenge code not found in store');
    }

    // Step 4: Complete MFA challenge with the code
    const mfaRes = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:mfa-totp',
        code: challengeCode,
        pending_authentication_token: pendingToken,
        authentication_challenge_id: challengeId,
      }),
    });
    expect(mfaRes.status).toBe(200);
    const mfaAuth = await mfaRes.json();
    expect(mfaAuth.access_token).toBeTruthy();
    expect(mfaAuth.refresh_token).toBeTruthy();

    // Step 5: Verify session was created with auth_method='password' (primary factor, not 'mfa')
    const sessionWebhook = await waitForWebhook('session.created', { after: cursor });
    expect(sessionWebhook.data.auth_method).toBe('password');
    expect(sessionWebhook.data.user_id).toBe(userId);
    verifySignature(sessionWebhook);
    expectSpecShape(sessionWebhook);

    // Step 6: Verify authentication.mfa_succeeded event was emitted
    const authWebhook = await waitForWebhook('authentication.mfa_succeeded', { after: cursor });
    expect(authWebhook.data).toMatchObject({
      type: 'mfa',
      status: 'succeeded',
      user_id: userId,
      email,
    });
    verifySignature(authWebhook);
    expectSpecShape(authWebhook);

    // Cleanup: Remove the MFA factor for other tests
    await api(`/user_management/auth_factors/${factor.id}`, {
      method: 'DELETE',
    });
  });
});
