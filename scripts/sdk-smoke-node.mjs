#!/usr/bin/env node
// Drives the emulator through an installed @workos-inc/node, whichever major is installed, so a
// release of the SDK that changes what it sends or what it can read (the 12.0 feature-flag poll
// payload, for one) shows up before a user reports it.
//
// Usage:
//   node scripts/sdk-smoke-node.mjs            # the repo's own devDependency
//   node scripts/sdk-smoke-node.mjs <dir>      # a directory whose node_modules holds the SDK under test
//
// Runs against dist/, so build first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEmulator } from '../dist/index.js';

const sdkDir = process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(join(sdkDir, 'package.json'));
const { WorkOS } = require('@workos-inc/node');
const sdkVersion = JSON.parse(
  readFileSync(join(sdkDir, 'node_modules/@workos-inc/node/package.json'), 'utf-8'),
).version;

const seed = {
  users: [
    { email: 'alice@acme.com', password: 'test123', email_verified: true },
    { email: 'bob@acme.com', password: 'test123', email_verified: true },
  ],
  organizations: [{ name: 'Acme Corp', memberships: [{ email: 'alice@acme.com' }, { email: 'bob@acme.com' }] }],
  featureFlags: [
    { slug: 'everyone', default_value: true },
    { slug: 'alice-only', targets: { users: ['alice@acme.com'] } },
    { slug: 'acme-only', targets: { organizations: ['Acme Corp'] } },
  ],
};

const emulator = await createEmulator({ port: 0, seed });
let runtime;
try {
  const workos = new WorkOS(emulator.apiKey, { apiHostname: 'localhost', port: emulator.port, https: false });

  const organizations = (await workos.organizations.listOrganizations()).data;
  const acme = organizations.find((org) => org.name === 'Acme Corp');
  assert.ok(acme, 'the seeded organization is listed');

  const users = (await workos.userManagement.listUsers()).data;
  const alice = users.find((user) => user.email === 'alice@acme.com');
  const bob = users.find((user) => user.email === 'bob@acme.com');
  assert.ok(alice && bob, 'the seeded users are listed');

  const memberships = (await workos.userManagement.listOrganizationMemberships({ userId: alice.id })).data;
  assert.deepEqual(
    memberships.map((m) => m.organizationId),
    [acme.id],
  );

  // Events are a forward-only log, oldest first, whatever the SDK's default `order` is.
  const created = [];
  for (const i of [1, 2, 3]) {
    const user = await workos.userManagement.createUser({ email: `sdk-${i}@example.com`, emailVerified: true });
    created.push(user.id);
  }
  const events = (await workos.events.listEvents({ events: ['user.created'] })).data;
  const listed = events.map((event) => event.data.id).filter((id) => created.includes(id));
  assert.deepEqual(listed, created, 'user.created events come back oldest first');

  // The runtime client polls /sdk/feature-flags in whichever payload generation this SDK reads.
  if (typeof workos.featureFlags?.createRuntimeClient === 'function') {
    runtime = workos.featureFlags.createRuntimeClient({ pollingIntervalMs: 5_000 });
    const ready = await Promise.race([
      runtime.waitUntilReady().then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    assert.ok(ready, 'the runtime client became ready within 10s (it could read the poll payload)');
    assert.equal(runtime.isEnabled('everyone', { userId: bob.id }), true);
    assert.equal(runtime.isEnabled('alice-only', { userId: alice.id }), true);
    assert.equal(runtime.isEnabled('alice-only', { userId: bob.id }), false);
    assert.equal(runtime.isEnabled('acme-only', { organizationId: acme.id }), true);
    assert.equal(runtime.isEnabled('acme-only', { userId: bob.id }), false);
  } else {
    console.log(`sdk-smoke-node: @workos-inc/node ${sdkVersion} has no runtime client; skipped`);
  }

  console.log(`sdk-smoke-node: OK (@workos-inc/node ${sdkVersion})`);
} finally {
  runtime?.close?.();
  await emulator.close();
}
