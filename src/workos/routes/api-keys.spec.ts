import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';
import type { Store } from '../../core/index.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' }, sk_live_key: { environment: 'production' } };
const headers = { Authorization: 'Bearer sk_test_org', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('API Keys routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('validates a known API key', async () => {
    const res = await req('/api_keys/validations', {
      method: 'POST',
      body: JSON.stringify({ key: 'sk_test_org' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).valid).toBe(true);
  });

  it('rejects an unknown API key', async () => {
    const res = await req('/api_keys/validations', {
      method: 'POST',
      body: JSON.stringify({ key: 'sk_unknown' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).valid).toBe(false);
  });

  const insertKey = (ws: ReturnType<typeof getWorkOSStore>, name: string, key: string) =>
    ws.apiKeyRecords.insert({
      object: 'api_key',
      name,
      key,
      environment: 'test',
      owner: { type: 'organization', id: 'org_123' },
      permissions: [],
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
});
