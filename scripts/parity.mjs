#!/usr/bin/env node
// Differential run: the same requests against a real WorkOS environment and against the
// emulator, with the responses normalized and diffed. This is the check for behavior the
// OpenAPI spec does not express — ordering, error bodies, which fields come back null — which
// is where the emulator drifts without anyone noticing.
//
// Usage:
//   WORKOS_PARITY_API_KEY=sk_... node scripts/parity.mjs
//   node scripts/parity.mjs --self-check     # emulator against a second emulator: proves the harness
//
// Environment:
//   WORKOS_PARITY_API_KEY   API key of a sandbox environment the run may create and delete
//                           organizations and users in. Nothing it creates is left behind.
//   WORKOS_PARITY_BASE_URL  Defaults to https://api.workos.com.
//
// Every sample is one request; the two sides' responses are compared after ids, timestamps and
// the run's own names are replaced with placeholders. A sample's status code is always compared.
import assert from 'node:assert/strict';
import { createEmulator } from '../dist/index.js';

const SELF_CHECK = process.argv.includes('--self-check');
const stamp = `parity-${Date.now().toString(36)}`;
const startedAt = new Date().toISOString();

// Production holds ascending event reads behind a short visibility delay, so the events sample
// polls until the run's own events are all there.
const EVENTS_TIMEOUT_MS = 90_000;

async function main() {
  const emulator = await createEmulator({ port: 0 });
  const reference = SELF_CHECK ? await createEmulator({ port: 0 }) : null;
  try {
    // `||` on the URL: the workflow exports the variable even when it is not configured, as ''.
    const left = {
      name: SELF_CHECK ? 'reference emulator' : 'production',
      url: SELF_CHECK
        ? reference.url
        : (process.env.WORKOS_PARITY_BASE_URL || 'https://api.workos.com').replace(/\/+$/, ''),
      key: SELF_CHECK ? reference.apiKey : process.env.WORKOS_PARITY_API_KEY,
    };
    if (!left.key) {
      console.error('WORKOS_PARITY_API_KEY is not set; pass --self-check to run emulator against emulator.');
      process.exit(2);
    }
    const right = { name: 'emulator', url: emulator.url, key: emulator.apiKey };

    const [a, b] = await Promise.all([collect(left), collect(right)]);
    const differences = compare(a, b);
    for (const line of differences) console.log(line);
    const samples = Object.keys(a).length;
    if (differences.length > 0) {
      console.error(
        `\nparity: ${differences.length} difference(s) across ${samples} samples (${left.name} vs ${right.name})`,
      );
      process.exit(1);
    }
    console.log(`parity: OK, ${samples} samples agree (${left.name} vs ${right.name})`);
  } finally {
    await emulator.close();
    if (reference) await reference.close();
  }
}

/** Runs the scenario against one target and returns its named samples. Cleans up what it made. */
async function collect(target) {
  const call = async (method, path, body) => {
    const init = { method, headers: { Authorization: `Bearer ${target.key}`, 'Content-Type': 'application/json' } };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${target.url}${path}`, init);
    const text = await response.text();
    let json;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, body: json };
  };

  const samples = {};
  const created = { users: [], organization: null };
  try {
    const org = await call('POST', '/organizations', { name: stamp });
    samples['organization.create'] = org;
    assert.equal(org.status, 201, `${target.name}: could not create an organization: ${JSON.stringify(org.body)}`);
    created.organization = org.body.id;

    samples['organization.get'] = await call('GET', `/organizations/${created.organization}`);
    samples['organization.update'] = await call('PUT', `/organizations/${created.organization}`, {
      name: `${stamp} renamed`,
    });
    samples['organization.get.missing'] = await call('GET', '/organizations/org_01HXYZ123456789ABCDEFGHIJ');
    samples['organization.create.invalid'] = await call('POST', '/organizations', {});

    for (let i = 0; i < 3; i++) {
      const user = await call('POST', '/user_management/users', {
        email: `${stamp}-${i}@example.com`,
        email_verified: true,
        first_name: 'Parity',
        last_name: `User ${i}`,
      });
      samples[`user.create.${i}`] = user;
      assert.equal(user.status, 201, `${target.name}: could not create a user: ${JSON.stringify(user.body)}`);
      created.users.push(user.body.id);
    }
    samples['user.get'] = await call('GET', `/user_management/users/${created.users[0]}`);
    samples['user.get.missing'] = await call('GET', '/user_management/users/user_01HXYZ123456789ABCDEFGHIJ');

    samples['membership.create'] = await call('POST', '/user_management/organization_memberships', {
      user_id: created.users[0],
      organization_id: created.organization,
    });
    samples['membership.list'] = await call(
      'GET',
      `/user_management/organization_memberships?user_id=${created.users[0]}&organization_id=${created.organization}`,
    );

    samples['events.missing_filter'] = await call('GET', '/events');
    samples['events.user_created'] = await eventsFor(call, 'user.created', created.users);

    samples['flags.poll.v2'] = (await call('GET', '/sdk/feature-flags?payload_version=2')).status;
    samples['flags.poll.invalid_version'] = await call('GET', '/sdk/feature-flags?payload_version=zero');
  } finally {
    // Every deletion is attempted on its own, and each is a sample, so one failure neither stops
    // the cleanup nor hides behind a later success.
    const remove = async (name, path) => {
      try {
        samples[name] = await call('DELETE', path);
      } catch (error) {
        samples[name] = { status: 'request failed', body: error instanceof Error ? error.message : String(error) };
      }
      if (samples[name].status !== 204) {
        console.error(`${target.name}: ${name} ${path} was not removed: ${JSON.stringify(samples[name])}`);
      }
    };
    for (const [i, id] of created.users.entries()) await remove(`user.delete.${i}`, `/user_management/users/${id}`);
    if (created.organization) await remove('organization.delete', `/organizations/${created.organization}`);
  }
  return normalize(samples);
}

/**
 * The run's own `user.created` events, in the order the API lists them, once all are visible.
 * Pages forward from the run's start, since a busy sandbox can push this run's events off the
 * first page. Only the run's events are kept, and no cursor: the pages the two sides needed
 * say nothing about parity.
 */
async function eventsFor(call, name, userIds) {
  const deadline = Date.now() + EVENTS_TIMEOUT_MS;
  for (;;) {
    const { status, data } = await eventsSince(call, name);
    const ours = data.filter((event) => userIds.includes(event.data?.id));
    if (ours.length >= userIds.length || Date.now() > deadline) {
      return { status, body: { object: 'list', data: ours } };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

const MAX_EVENT_PAGES = 20;

async function eventsSince(call, name) {
  const data = [];
  let after = null;
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const cursor = after ? `&after=${encodeURIComponent(after)}` : `&range_start=${encodeURIComponent(startedAt)}`;
    const response = await call('GET', `/events?events=${name}&limit=100${cursor}`);
    if (response.status !== 200) return { status: response.status, data };
    data.push(...(response.body?.data ?? []));
    after = response.body?.list_metadata?.after ?? null;
    if (!after) return { status: response.status, data };
  }
  return { status: 200, data };
}

const ID = /^[a-z_]+_[0-9A-HJKMNP-TV-Z]{26}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Replaces ids, timestamps and the run's own names with placeholders, numbered by first sight. */
function normalize(value) {
  const ids = new Map();
  const walk = (node) => {
    if (typeof node === 'string') {
      if (ID.test(node)) {
        if (!ids.has(node)) ids.set(node, `<${node.slice(0, node.lastIndexOf('_'))}#${ids.size + 1}>`);
        return ids.get(node);
      }
      if (TIMESTAMP.test(node)) return '<timestamp>';
      if (node.includes(stamp)) return node.replace(stamp, '<run>');
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      return Object.fromEntries(
        Object.entries(node)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([k, v]) => [k, walk(v)]),
      );
    }
    return node;
  };
  return walk(value);
}

/** One line per leaf that differs, as `sample path: left | right`. */
function compare(left, right) {
  const lines = [];
  const walk = (a, b, path) => {
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) lines.push(`${path}: ${a.length} items | ${b.length} items`);
      for (let i = 0; i < Math.min(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!(key in a)) lines.push(`${path}.${key}: (absent) | ${JSON.stringify(b[key])}`);
        else if (!(key in b)) lines.push(`${path}.${key}: ${JSON.stringify(a[key])} | (absent)`);
        else walk(a[key], b[key], `${path}.${key}`);
      }
      return;
    }
    if (a !== b) lines.push(`${path}: ${JSON.stringify(a)} | ${JSON.stringify(b)}`);
  };
  for (const sample of new Set([...Object.keys(left), ...Object.keys(right)]))
    walk(left[sample], right[sample], sample);
  return lines;
}

await main();
