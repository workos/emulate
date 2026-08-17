// Black-box compatibility suite for the published Node library.
// Run with plain Node, never Bun: the invariant is that dist/ boots and its
// major integration boundaries work without Bun-only APIs.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { createEmulator } from '../dist/index.js';

const webhookSecret = 'node_compat_webhook_secret';

const receiver = await startWebhookReceiver();
let emulator;

try {
  emulator = await createEmulator({ port: 0 });

  const api = (path, init = {}) =>
    fetch(`${emulator.url}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${emulator.apiKey}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });

  const health = await fetch(`${emulator.url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const jwksResponse = await fetch(`${emulator.url}/oauth2/jwks`);
  assert.equal(jwksResponse.status, 200);
  const jwks = await jwksResponse.json();
  assert.ok(Array.isArray(jwks.keys) && jwks.keys.length > 0, 'JWKS must contain at least one key');

  const endpointResponse = await api('/webhook_endpoints', {
    method: 'POST',
    body: JSON.stringify({
      endpoint_url: receiver.url,
      events: ['user.created'],
      secret: webhookSecret,
    }),
  });
  assert.equal(endpointResponse.status, 201);

  const email = 'node-compat@example.com';
  const userResponse = await api('/user_management/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: 'correct horse battery staple',
      first_name: 'Node',
      last_name: 'Compatibility',
      // The password grant gates an unverified mailbox with email_verification_required.
      email_verified: true,
    }),
  });
  assert.equal(userResponse.status, 201);
  const user = await userResponse.json();
  assert.equal(user.email, email);
  assert.match(user.id, /^user_/);

  const webhook = await receiver.next();
  assert.equal(webhook.body.event, 'user.created');
  assert.equal(webhook.body.data.id, user.id);
  verifyWebhookSignature(webhook.signature, webhook.rawBody);

  const authResponse = await api('/user_management/authenticate', {
    method: 'POST',
    body: JSON.stringify({
      grant_type: 'password',
      email,
      password: 'correct horse battery staple',
    }),
  });
  assert.equal(authResponse.status, 200);
  const auth = await authResponse.json();
  assert.equal(auth.user.id, user.id);
  assert.equal(auth.authentication_method, 'Password');
  assert.equal(typeof auth.access_token, 'string');
  assert.equal(typeof auth.refresh_token, 'string');

  const hook = emulator.addErrorHook({
    method: 'GET',
    path: '/user_management/users',
    status: 503,
    body: { code: 'node_compat_error', message: 'Node compatibility hook' },
    count: 1,
  });
  const hookedResponse = await api('/user_management/users');
  assert.equal(hookedResponse.status, 503);
  assert.equal((await hookedResponse.json()).code, 'node_compat_error');
  assert.equal(
    emulator.listErrorHooks().some((candidate) => candidate.id === hook.id),
    false,
  );

  emulator.reset();
  const usersAfterReset = await api('/user_management/users');
  assert.equal(usersAfterReset.status, 200);
  assert.deepEqual((await usersAfterReset.json()).data, []);

  console.log('smoke-node: OK (HTTP, crypto, CRUD, auth, webhooks, hooks, reset)');
} finally {
  if (emulator) await emulator.close();
  await receiver.close();
}

function verifyWebhookSignature(signature, rawBody) {
  const match = signature?.match(/^t=(\d+), v1=([a-f0-9]{64})$/);
  assert.ok(match, `unexpected WorkOS-Signature: ${signature}`);
  const expected = createHmac('sha256', webhookSecret).update(`${match[1]}.${rawBody}`).digest('hex');
  assert.equal(match[2], expected);
}

async function startWebhookReceiver() {
  const queue = [];
  const waiters = [];

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      const delivery = {
        rawBody,
        body: JSON.parse(rawBody),
        signature: request.headers['workos-signature'],
      };

      const waiter = waiters.shift();
      if (waiter) waiter(delivery);
      else queue.push(delivery);

      response.writeHead(200);
      response.end('ok');
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address && typeof address === 'object');

  return {
    url: `http://127.0.0.1:${address.port}/webhooks`,
    next() {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('webhook was not delivered within 5 seconds')), 5_000);
        waiters.push((delivery) => {
          clearTimeout(timeout);
          resolve(delivery);
        });
      });
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
