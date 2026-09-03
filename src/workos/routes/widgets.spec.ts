import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap, type Entity } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';
import { paginateForWidget, WIDGET_SCOPE_API_KEYS_MANAGE } from './widgets.js';

const apiKeys: ApiKeyMap = { sk_test_widgets: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_widgets', 'Content-Type': 'application/json' };

// The allow-list is passed by reference and mutated by key creation, so every server gets a copy.
function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys: { ...apiKeys } });
}

/** Decode a JWT payload the way the widget client does: base64 of the second segment, unverified. */
const claims = (token: string) =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()) as Record<string, unknown>;

const insertOrganization = (ws: WorkOSStore, id: string) =>
  ws.organizations.insert({
    id,
    object: 'organization',
    name: id,
    external_id: null,
    metadata: {},
    stripe_customer_id: null,
    allow_profiles_outside_organization: false,
    entitlements: [],
  });

describe('Widget routes', () => {
  let server: ReturnType<typeof createTestApp>;
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    server = createTestApp();
    app = server.app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  /** Mint a widget token for org_123 the way a backend would, via the API-key-authenticated route. */
  const mintToken = async (overrides: Record<string, unknown> = {}) => {
    const res = await req('/widgets/token', {
      method: 'POST',
      body: JSON.stringify({
        organization_id: 'org_123',
        user_id: 'user_456',
        scopes: [WIDGET_SCOPE_API_KEYS_MANAGE],
        ...overrides,
      }),
    });
    expect(res.status).toBe(200);
    return (await json(res)).token as string;
  };

  describe('POST /widgets/token', () => {
    it('generates a widgets token', async () => {
      const res = await req('/widgets/token', {
        method: 'POST',
        body: JSON.stringify({
          organization_id: 'org_123',
          user_id: 'user_456',
          scopes: ['widgets:users-table:manage'],
        }),
      });
      expect(res.status).toBe(200);
      const data = await json(res);
      expect(data.token).toBeDefined();
      expect(typeof data.token).toBe('string');
      // JWT has 3 dot-separated parts
      expect(data.token.split('.')).toHaveLength(3);
    });

    it('mints the claims the widget client reads', async () => {
      const token = await mintToken({ scopes: [WIDGET_SCOPE_API_KEYS_MANAGE, 'widgets:users-table:manage'] });
      const payload = claims(token);
      expect(payload.aud).toBe('widgets');
      expect(payload.sub).toBe('user_456');
      expect(payload.org_id).toBe('org_123');
      // The client throws NoAuthTokenError unless `permissions` is an array, and gates each
      // widget on its own scope being in it — so the scopes travel under that claim.
      expect(payload.permissions).toEqual([WIDGET_SCOPE_API_KEYS_MANAGE, 'widgets:users-table:manage']);
      expect(payload.scopes).toBeUndefined();
      // The client schedules its token refresh 30s before `exp`.
      const now = Math.floor(Date.now() / 1000);
      expect(payload.exp).toBeGreaterThan(now);
      expect(payload.exp).toBeLessThanOrEqual(now + 3600);
    });

    it('requires organization_id', async () => {
      const res = await req('/widgets/token', {
        method: 'POST',
        body: JSON.stringify({ user_id: 'user_456', scopes: ['read'] }),
      });
      expect(res.status).toBe(422);
    });

    it('requires user_id', async () => {
      const res = await req('/widgets/token', {
        method: 'POST',
        body: JSON.stringify({ organization_id: 'org_123', scopes: ['read'] }),
      });
      expect(res.status).toBe(422);
    });

    it('requires scopes', async () => {
      const res = await req('/widgets/token', {
        method: 'POST',
        body: JSON.stringify({ organization_id: 'org_123', user_id: 'user_456' }),
      });
      expect(res.status).toBe(422);
    });

    it('requires scopes to be strings', async () => {
      const res = await req('/widgets/token', {
        method: 'POST',
        body: JSON.stringify({ organization_id: 'org_123', user_id: 'user_456', scopes: [1] }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).errors).toEqual([{ field: 'scopes', code: 'required' }]);
    });
  });

  describe('/_widgets authentication', () => {
    const list = (authorization?: string) =>
      app.request('/_widgets/ApiKeys/organization-api-keys', {
        headers: authorization ? { Authorization: authorization } : {},
      });

    it('accepts a widget token instead of an API key', async () => {
      const token = await mintToken();
      expect((await list(`Bearer ${token}`)).status).toBe(200);
    });

    it('answers 403 to a missing token — the status the widget client treats as a token problem', async () => {
      const res = await list();
      expect(res.status).toBe(403);
      const body = await json(res);
      expect(body.code).toBe('forbidden');
      expect(typeof body.message).toBe('string');
    });

    it('rejects an API key presented as a widget token', async () => {
      expect((await list('Bearer sk_test_widgets')).status).toBe(403);
    });

    it('rejects an expired widget token', async () => {
      const token = server.jwt.sign(
        { sub: 'user_456', org_id: 'org_123', aud: 'widgets', permissions: [WIDGET_SCOPE_API_KEYS_MANAGE] },
        { expiresIn: -60 },
      );
      const res = await list(`Bearer ${token}`);
      expect(res.status).toBe(403);
      expect((await json(res)).message).toContain('expired');
    });

    it('rejects a token minted for another audience', async () => {
      // Signed by the same key, but an AuthKit access token is not a widget session.
      const token = server.jwt.sign({
        sub: 'user_456',
        org_id: 'org_123',
        aud: 'client_123',
        permissions: [WIDGET_SCOPE_API_KEYS_MANAGE],
      });
      expect((await list(`Bearer ${token}`)).status).toBe(403);
    });

    it('rejects a token whose payload was tampered with', async () => {
      const token = await mintToken();
      const [header, , signature] = token.split('.');
      const forged = Buffer.from(JSON.stringify({ ...claims(token), org_id: 'org_other' })).toString('base64url');
      expect((await list(`Bearer ${header}.${forged}.${signature}`)).status).toBe(403);
    });

    it('rejects a widget token without an organization', async () => {
      const token = server.jwt.sign({ sub: 'user_456', aud: 'widgets', permissions: [WIDGET_SCOPE_API_KEYS_MANAGE] });
      expect((await list(`Bearer ${token}`)).status).toBe(403);
    });

    it('rejects a widget token minted for a different widget', async () => {
      const token = await mintToken({ scopes: ['widgets:users-table:manage'] });
      const res = await list(`Bearer ${token}`);
      expect(res.status).toBe(403);
      expect((await json(res)).message).toContain(WIDGET_SCOPE_API_KEYS_MANAGE);
    });
  });

  describe('/_widgets/ApiKeys', () => {
    let ws: WorkOSStore;
    let token: string;

    beforeEach(async () => {
      ws = getWorkOSStore(server.store);
      insertOrganization(ws, 'org_123');
      token = await mintToken();
    });

    // The headers the shipped client sends on every call.
    const wreq = (path: string, init?: RequestInit) =>
      app.request(path, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'WorkOS-Widgets-Version': '1',
          'WorkOS-Widgets-Type': 'api-keys',
        },
        ...init,
      });

    const createKey = (body: Record<string, unknown>) =>
      wreq('/_widgets/ApiKeys/organization-api-keys', { method: 'POST', body: JSON.stringify(body) });

    const authStatus = async (value: string) =>
      (await app.request('/connect/applications', { headers: { Authorization: `Bearer ${value}` } })).status;

    it('creates a key, returning the plaintext once in the camelCase shape', async () => {
      const res = await createKey({ name: 'CI key', permissions: ['posts:read'], expiresAt: null });
      expect(res.status).toBe(201);
      const key = await json(res);
      expect(key.id.startsWith('api_key_')).toBe(true);
      expect(key.value.startsWith('sk_test_')).toBe(true);
      expect(key.obfuscatedValue).toBe(`sk_...${key.value.slice(-4)}`);
      expect(key.name).toBe('CI key');
      expect(key.permissions).toEqual(['posts:read']);
      expect(key.expiresAt).toBeNull();
      expect(typeof key.createdAt).toBe('string');
      // Resource fields are camelCase; nothing of the public snake_case shape leaks through.
      expect(key.object).toBeUndefined();
      expect(key.obfuscated_value).toBeUndefined();
      expect(key.created_at).toBeUndefined();

      // The key belongs to the token's organization and authenticates real requests.
      expect(ws.apiKeyRecords.get(key.id)!.owner).toEqual({ type: 'organization', id: 'org_123' });
      expect(await authStatus(key.value)).toBe(200);
    });

    it('creates a key with an expiry', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
      const key = await json(await createKey({ name: 'Short-lived', permissions: [], expiresAt }));
      expect(key.expiresAt).toBe(expiresAt);
      expect(ws.apiKeyRecords.get(key.id)!.expires_at).toBe(expiresAt);
    });

    it('refuses to issue a key for an organization that does not exist', async () => {
      // A token can be minted for any organization id, and the org may be deleted afterwards;
      // honoring it would create a live credential no organization route can reach.
      const orphanToken = await mintToken({ organization_id: 'org_missing' });
      const res = await app.request('/_widgets/ApiKeys/organization-api-keys', {
        method: 'POST',
        headers: { Authorization: `Bearer ${orphanToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Orphan', permissions: [] }),
      });
      expect(res.status).toBe(404);
      expect((await json(res)).message).toBe('Organization not found');
      expect(ws.apiKeyRecords.all()).toHaveLength(0);
    });

    it('validates the create body under the widget field names', async () => {
      let res = await createKey({ permissions: [] });
      expect(res.status).toBe(422);
      let body = await json(res);
      expect(body.message).toBe('name is required');
      expect(body.errors).toEqual([{ field: 'name', code: 'required' }]);

      res = await createKey({ name: 'No permissions array' });
      expect(res.status).toBe(422);
      expect((await json(res)).errors).toEqual([{ field: 'permissions', code: 'invalid' }]);

      res = await createKey({ name: 'Bad expiry', permissions: [], expiresAt: 'tomorrow-ish' });
      expect(res.status).toBe(422);
      body = await json(res);
      expect(body.errors).toEqual([{ field: 'expiresAt', code: 'invalid' }]);

      res = await createKey({ name: 'Past expiry', permissions: [], expiresAt: '2000-01-01T00:00:00.000Z' });
      expect(res.status).toBe(422);
      expect((await json(res)).errors).toEqual([{ field: 'expiresAt', code: 'invalid' }]);

      expect(ws.apiKeyRecords.all()).toHaveLength(0);
    });

    it('lists the organization keys without their secrets', async () => {
      const created = await json(await createKey({ name: 'Listed', permissions: ['posts:read'] }));

      const res = await wreq('/_widgets/ApiKeys/organization-api-keys?limit=10');
      expect(res.status).toBe(200);
      const list = await json(res);
      // camelCase resources inside a snake_case envelope, exactly as the client reads them.
      expect(list.object).toBeUndefined();
      expect(list.list_metadata).toEqual({ before: null, after: null });
      expect(list.data).toEqual([
        {
          id: created.id,
          name: 'Listed',
          obfuscatedValue: created.obfuscatedValue,
          createdAt: created.createdAt,
          lastUsedAt: null,
          expiresAt: null,
          permissions: ['posts:read'],
        },
      ]);
      expect(JSON.stringify(list)).not.toContain(created.value);
    });

    it("lists keys created through the public API, and only this organization's", async () => {
      insertOrganization(ws, 'org_other');
      const mine = await json(
        await req('/organizations/org_123/api_keys', { method: 'POST', body: JSON.stringify({ name: 'Public key' }) }),
      );
      await req('/organizations/org_other/api_keys', { method: 'POST', body: JSON.stringify({ name: 'Other org' }) });

      const list = await json(await wreq('/_widgets/ApiKeys/organization-api-keys'));
      expect(list.data.map((k: any) => k.id)).toEqual([mine.id]);
    });

    it('searches keys by name, case-insensitively', async () => {
      await createKey({ name: 'Deploy bot', permissions: [] });
      await createKey({ name: 'Analytics export', permissions: [] });

      const list = await json(await wreq('/_widgets/ApiKeys/organization-api-keys?search=DEPLOY'));
      expect(list.data.map((k: any) => k.name)).toEqual(['Deploy bot']);
      expect((await json(await wreq('/_widgets/ApiKeys/organization-api-keys?search=nothing'))).data).toEqual([]);
    });

    it('paginates newest-first in the widget convention: `before` pages forward, `after` pages back', async () => {
      for (let i = 1; i <= 25; i++) {
        ws.apiKeyRecords.insert({
          id: `api_key_${String(i).padStart(4, '0')}`,
          object: 'api_key',
          name: `key-${i}`,
          key: `sk_test_${String(i).padStart(4, '0')}`,
          environment: 'test',
          owner: { type: 'organization', id: 'org_123' },
          permissions: [],
          last_used_at: null,
          expires_at: null,
        });
      }
      const names = (page: any) => page.data.map((k: any) => k.name);
      const path = '/_widgets/ApiKeys/organization-api-keys?limit=10';

      const page1 = await json(await wreq(path));
      expect(names(page1)).toEqual([
        'key-25',
        'key-24',
        'key-23',
        'key-22',
        'key-21',
        'key-20',
        'key-19',
        'key-18',
        'key-17',
        'key-16',
      ]);
      // The widget enables Next on `before` and Previous on `after`.
      expect(page1.list_metadata.after).toBeNull();
      expect(page1.list_metadata.before).toBe('api_key_0016');

      const page2 = await json(await wreq(`${path}&before=${page1.list_metadata.before}`));
      expect(names(page2)).toEqual([
        'key-15',
        'key-14',
        'key-13',
        'key-12',
        'key-11',
        'key-10',
        'key-9',
        'key-8',
        'key-7',
        'key-6',
      ]);
      expect(page2.list_metadata).toEqual({ before: 'api_key_0006', after: 'api_key_0015' });

      const page3 = await json(await wreq(`${path}&before=${page2.list_metadata.before}`));
      expect(names(page3)).toEqual(['key-5', 'key-4', 'key-3', 'key-2', 'key-1']);
      expect(page3.list_metadata).toEqual({ before: null, after: 'api_key_0005' });

      // Previous from the last page is the middle page, not the first.
      const back = await json(await wreq(`${path}&after=${page3.list_metadata.after}`));
      expect(names(back)).toEqual(names(page2));
      expect(back.list_metadata).toEqual(page2.list_metadata);
    });

    it('deletes a key, which stops authenticating at once', async () => {
      const key = await json(await createKey({ name: 'Doomed', permissions: [] }));
      expect(await authStatus(key.value)).toBe(200);

      const res = await wreq(`/_widgets/ApiKeys/${key.id}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(await json(res)).toEqual({ success: true });

      expect(ws.apiKeyRecords.get(key.id)).toBeUndefined();
      expect(await authStatus(key.value)).toBe(401);
      expect((await wreq(`/_widgets/ApiKeys/${key.id}`, { method: 'DELETE' })).status).toBe(404);
    });

    it("answers 404, never 403, for another organization's key", async () => {
      insertOrganization(ws, 'org_other');
      const other = await json(
        await req('/organizations/org_other/api_keys', { method: 'POST', body: JSON.stringify({ name: 'Other' }) }),
      );

      const del = await wreq(`/_widgets/ApiKeys/${other.id}`, { method: 'DELETE' });
      expect(del.status).toBe(404);
      expect((await json(del)).message).toBe('ApiKey not found');
      const expire = await wreq(`/_widgets/ApiKeys/${other.id}/expire`, {
        method: 'POST',
        body: JSON.stringify({ expiresAt: null }),
      });
      expect(expire.status).toBe(404);
      // The other organization's key is untouched.
      expect(ws.apiKeyRecords.get(other.id)).toBeDefined();
      expect(await authStatus(other.value)).toBe(200);
    });

    it('sets, clears, and immediately enforces an expiry', async () => {
      const key = await json(await createKey({ name: 'Expiring', permissions: [] }));
      const expire = (body: unknown) =>
        wreq(`/_widgets/ApiKeys/${key.id}/expire`, { method: 'POST', body: JSON.stringify(body) });

      const future = new Date(Date.now() + 3_600_000).toISOString();
      let res = await expire({ expiresAt: future });
      expect(res.status).toBe(200);
      expect((await json(res)).expiresAt).toBe(future);
      const listed = await json(await wreq('/_widgets/ApiKeys/organization-api-keys'));
      expect(listed.data[0].expiresAt).toBe(future);

      // `null` is how the widget's expiration dialog says "never".
      res = await expire({ expiresAt: null });
      expect(res.status).toBe(200);
      expect((await json(res)).expiresAt).toBeNull();
      expect(await authStatus(key.value)).toBe(200);

      // A past timestamp expires the key now, and the auth allow-list agrees at once.
      res = await expire({ expiresAt: '2000-01-01T00:00:00.000Z' });
      expect(res.status).toBe(200);
      expect(Date.parse((await json(res)).expiresAt)).toBeLessThanOrEqual(Date.now());
      expect(await authStatus(key.value)).toBe(401);

      // An expired key cannot be rescheduled — the same 409 the public route answers.
      res = await expire({ expiresAt: future });
      expect(res.status).toBe(409);
    });

    it('rejects a malformed expiresAt on expire', async () => {
      const key = await json(await createKey({ name: 'Expiring', permissions: [] }));
      const res = await wreq(`/_widgets/ApiKeys/${key.id}/expire`, {
        method: 'POST',
        body: JSON.stringify({ expiresAt: 42 }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).errors).toEqual([{ field: 'expiresAt', code: 'invalid' }]);
      expect(ws.apiKeyRecords.get(key.id)!.expires_at).toBeNull();
    });

    it('serves the environment permissions for the create dialog', async () => {
      ws.permissions.insert({
        object: 'permission',
        slug: 'posts:read',
        name: 'Read posts',
        description: 'Read posts',
      });
      ws.permissions.insert({ object: 'permission', slug: 'posts:write', name: 'Write posts', description: null });

      const res = await wreq('/_widgets/ApiKeys/permissions?limit=100');
      expect(res.status).toBe(200);
      const list = await json(res);
      expect(list.list_metadata).toEqual({ before: null, after: null });
      expect(list.data.map((p: any) => p.slug).sort()).toEqual(['posts:read', 'posts:write']);
      expect(list.data.find((p: any) => p.slug === 'posts:read')).toEqual({
        id: expect.stringMatching(/^perm_/),
        slug: 'posts:read',
        name: 'Read posts',
        description: 'Read posts',
      });
      expect(list.data.find((p: any) => p.slug === 'posts:write').description).toBeNull();

      const filtered = await json(await wreq('/_widgets/ApiKeys/permissions?search=WRITE'));
      expect(filtered.data.map((p: any) => p.slug)).toEqual(['posts:write']);
    });

    it('returns the standard 404 for an unknown /_widgets route', async () => {
      const res = await wreq('/_widgets/ApiKeys/organization-api-keys/nope');
      expect(res.status).toBe(404);
      expect((await json(res)).message).toBe('Not Found');
    });
  });
});

describe('paginateForWidget', () => {
  interface Item extends Entity {
    name: string;
  }
  const items = (count: number): Item[] =>
    Array.from({ length: count }, (_, i) => {
      const n = i + 1;
      const ts = new Date(2024, 0, 1, 0, 0, n).toISOString();
      return { id: `item_${String(n).padStart(4, '0')}`, name: `item-${n}`, created_at: ts, updated_at: ts };
    });
  const names = (page: { data: Item[] }) => page.data.map((i) => i.name);

  it('returns an empty page with no cursors', () => {
    expect(paginateForWidget([], { limit: 10 })).toEqual({ data: [], list_metadata: { before: null, after: null } });
  });

  it('returns everything newest-first when it fits, with no cursors', () => {
    const page = paginateForWidget(items(3), { limit: 10 });
    expect(names(page)).toEqual(['item-3', 'item-2', 'item-1']);
    expect(page.list_metadata).toEqual({ before: null, after: null });
  });

  it('clamps the limit to 1..100', () => {
    expect(paginateForWidget(items(5), { limit: 0 }).data).toHaveLength(1);
    expect(paginateForWidget(items(150), { limit: 500 }).data).toHaveLength(100);
  });

  it('starts over from the first page for an unknown cursor', () => {
    const page = paginateForWidget(items(5), { limit: 2, before: 'item_missing' });
    expect(names(page)).toEqual(['item-5', 'item-4']);
  });

  it('prefers `before` when both cursors are sent', () => {
    const page = paginateForWidget(items(5), { limit: 2, before: 'item_0004', after: 'item_0001' });
    expect(names(page)).toEqual(['item-3', 'item-2']);
  });

  it('pages back to a partial first page without overshooting', () => {
    // Page 2 (item-3, item-2) came from `before=item_0004`; stepping back from it lands on the
    // two newest items — the same page 1 the list opened on — not a page that underflows.
    const page = paginateForWidget(items(5), { limit: 2, after: 'item_0003' });
    expect(names(page)).toEqual(['item-5', 'item-4']);
    expect(page.list_metadata).toEqual({ before: 'item_0004', after: null });
  });
});
