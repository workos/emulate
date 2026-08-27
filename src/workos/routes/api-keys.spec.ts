import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';
import type { Store } from '../../core/index.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' }, sk_live_key: { environment: 'production' } };
const headers = { Authorization: 'Bearer sk_test_org', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

/**
 * A server with its own allow-list object. The map is passed to the auth middleware by
 * reference, so tests that register keys at runtime need a copy of their own rather than
 * the shared `apiKeys` const, which would leak mutations into every other test.
 */
function createAppWithKeys(keys: ApiKeyMap) {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys: { ...keys } });
}

describe('API Keys routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
    getWorkOSStore(store).organizations.insert({
      id: 'org_123',
      object: 'organization',
      name: 'Acme',
      external_id: null,
      metadata: {},
      stripe_customer_id: null,
      allow_profiles_outside_organization: false,
      entitlements: [],
    });
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('returns the whole api_key object, permissions included, for a valid key', async () => {
    const server = createAppWithKeys({ sk_test_full: { environment: 'test' } });
    const record = insertKey(getWorkOSStore(server.store), 'CI Key', 'sk_test_full', ['posts:read', 'posts:write']);

    const res = await server.app.request('/api_keys/validations', {
      method: 'POST',
      headers: { Authorization: 'Bearer sk_test_full', 'Content-Type': 'application/json' },
      // The spec's ValidateApiKeyDto field is `value`.
      body: JSON.stringify({ value: 'sk_test_full' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.api_key.id).toBe(record.id);
    expect(body.api_key.object).toBe('api_key');
    expect(body.api_key.name).toBe('CI Key');
    // The reason a caller validates at all: the key's privileges.
    expect(body.api_key.permissions).toEqual(['posts:read', 'posts:write']);
    // Validation must not leak the secret it was handed back to the caller.
    expect(body.api_key.obfuscated_value).toBe('sk_...full');
    expect(body.api_key.key).toBeUndefined();
  });

  it('returns api_key: null for an unknown API key', async () => {
    const res = await req('/api_keys/validations', {
      method: 'POST',
      body: JSON.stringify({ value: 'sk_unknown' }),
    });
    // An invalid key is a 200 with an explicit null, not an error.
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ api_key: null });
  });

  it('returns api_key: null for an allow-list key with no resource behind it', async () => {
    // The map form registers a value for authentication without creating a resource.
    // There is no ApiKey to return, and synthesizing an owner or permission set would
    // report privileges the emulator does not hold.
    const res = await req('/api_keys/validations', {
      method: 'POST',
      body: JSON.stringify({ value: 'sk_test_org' }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ api_key: null });
  });

  it('enforces allow-list key expiry for both auth and validation', async () => {
    const server = createAppWithKeys({
      sk_test_expired: { environment: 'test', expiresAt: '2000-01-01T00:00:00.000Z' },
      sk_test_future: { environment: 'test', expiresAt: '2999-01-01T00:00:00.000Z' },
    });
    const expiredApp = server.app;
    // Both keys resolve to a resource, so expiry is the only thing under test.
    const ws = getWorkOSStore(server.store);
    insertKey(ws, 'expired', 'sk_test_expired');
    insertKey(ws, 'future', 'sk_test_future');

    const hdr = (k: string) => ({ Authorization: `Bearer ${k}`, 'Content-Type': 'application/json' });

    // Auth middleware rejects the expired key but allows the not-yet-expired one.
    expect((await expiredApp.request('/connect/applications', { headers: hdr('sk_test_expired') })).status).toBe(401);
    expect((await expiredApp.request('/connect/applications', { headers: hdr('sk_test_future') })).status).toBe(200);

    // Validation agrees with auth.
    const v = async (k: string) =>
      (
        (await (
          await expiredApp.request('/api_keys/validations', {
            method: 'POST',
            headers: hdr('sk_test_future'),
            body: JSON.stringify({ value: k }),
          })
        ).json()) as any
      ).api_key;
    expect(await v('sk_test_expired')).toBeNull();
    expect(await v('sk_test_future')).not.toBeNull();
  });

  it('fails closed on a malformed expiry timestamp', async () => {
    const badExpiryApp = createServer(workosPlugin, {
      port: 0,
      baseUrl: 'http://localhost:0',
      apiKeys: { sk_test_badexp: { environment: 'test', expiresAt: '2024-13-99' } },
    }).app;
    const hdr = { Authorization: 'Bearer sk_test_badexp', 'Content-Type': 'application/json' };
    // A NaN timestamp must be treated as expired, not as "never expires".
    expect((await badExpiryApp.request('/connect/applications', { headers: hdr })).status).toBe(401);
  });

  const insertKey = (ws: ReturnType<typeof getWorkOSStore>, name: string, key: string, permissions: string[] = []) =>
    ws.apiKeyRecords.insert({
      object: 'api_key',
      name,
      key,
      environment: 'test',
      owner: { type: 'organization', id: 'org_123' },
      permissions,
      last_used_at: null,
      expires_at: null,
    });

  it('deletes an API key record', async () => {
    const ws = getWorkOSStore(store);
    const record = insertKey(ws, 'test-key', 'sk_test_deletable');

    const res = await req(`/api_keys/${record.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
  });

  it('returns 404 for nonexistent API key', async () => {
    const res = await req('/api_keys/api_key_nonexistent', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });

  it('creates an organization API key that authenticates requests', async () => {
    const res = await req('/organizations/org_123/api_keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Runtime key', permissions: ['posts:read'] }),
    });
    expect(res.status).toBe(201);
    const key = await json(res);
    expect(key.owner).toEqual({ type: 'organization', id: 'org_123' });
    expect(key.value.startsWith('sk_test_')).toBe(true);
    expect(key.permissions).toEqual(['posts:read']);

    const authenticated = await app.request('/connect/applications', {
      headers: { Authorization: `Bearer ${key.value}` },
    });
    expect(authenticated.status).toBe(200);
  });

  it('creates and lists API keys for an active organization member', async () => {
    const ws = getWorkOSStore(store);
    ws.users.insert({
      id: 'user_123',
      object: 'user',
      email: 'member@acme.test',
      name: null,
      first_name: null,
      last_name: null,
      email_verified: true,
      profile_picture_url: null,
      last_sign_in_at: null,
      external_id: null,
      metadata: {},
      locale: null,
      password_hash: null,
      impersonator: null,
    });
    ws.organizationMemberships.insert({
      object: 'organization_membership',
      organization_id: 'org_123',
      user_id: 'user_123',
      role: { slug: 'member' },
      status: 'active',
      external_id: null,
      metadata: {},
    });

    const created = await req('/user_management/users/user_123/api_keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'User key', organization_id: 'org_123' }),
    });
    expect(created.status).toBe(201);
    expect((await json(created)).owner).toEqual({ type: 'user', id: 'user_123', organization_id: 'org_123' });

    const listed = await req('/user_management/users/user_123/api_keys?organization_id=org_123');
    expect(listed.status).toBe(200);
    expect((await json(listed)).data).toHaveLength(1);
  });

  it('expires a key in the auth allow-list', async () => {
    const created = await req('/organizations/org_123/api_keys', {
      method: 'POST',
      body: JSON.stringify({ name: 'Short-lived key' }),
    });
    const key = await json(created);

    const expired = await req(`/api_keys/${key.id}/expire`, { method: 'POST', body: '{}' });
    expect(expired.status).toBe(200);
    expect((await json(expired)).expires_at).not.toBeNull();
    expect(
      (await app.request('/connect/applications', { headers: { Authorization: `Bearer ${key.value}` } })).status,
    ).toBe(401);
  });

  it('lists API key records', async () => {
    const ws = getWorkOSStore(store);
    insertKey(ws, 'key-1', 'sk_test_aaaa1111');
    insertKey(ws, 'key-2', 'sk_test_bbbb2222');

    const res = await req('/organizations/org_123/api_keys');
    expect(res.status).toBe(200);
    const list = await json(res);
    expect(list.object).toBe('list');
    expect(list.data).toHaveLength(2);

    const key = list.data.find((k: any) => k.name === 'key-1');
    expect(key.object).toBe('api_key');
    expect(key.owner).toEqual({ type: 'organization', id: 'org_123' });
    expect(key.permissions).toEqual([]);
    expect(key.last_used_at).toBeNull();
    expect(key.expires_at).toBeNull();
    // The raw secret is never serialized — only an obfuscated representation.
    expect(key.obfuscated_value).toBe('sk_...1111');
    expect(key.key).toBeUndefined();
  });

  it('returns 404 when listing keys for an unknown owner', async () => {
    expect((await req('/organizations/org_missing/api_keys')).status).toBe(404);
    expect((await req('/user_management/users/user_missing/api_keys')).status).toBe(404);
  });
});
