import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin, seedFromConfig, getWorkOSStore } from '../index.js';
import { validateSeedConfig } from '../config-validator.js';
import { SLUG_MESSAGE } from '../authorization-validation.js';

const apiKeys: ApiKeyMap = { sk_test_role: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_role', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Authorization environment role routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('creates an environment role', async () => {
    const res = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'admin', name: 'Admin' }),
    });
    expect(res.status).toBe(201);
    const role = await json(res);
    expect(role.object).toBe('role');
    expect(role.slug).toBe('admin');
    expect(role.type).toBe('EnvironmentRole');
    expect(role.organization_id).toBeNull();
    expect(role.resource_type_slug).toBe('organization');
    expect(role.id).toMatch(/^role_/);
  });

  it('preserves a role resource type', async () => {
    const res = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'doc-editor', name: 'Doc Editor', resource_type_slug: 'document' }),
    });
    expect(res.status).toBe(201);
    expect((await json(res)).resource_type_slug).toBe('document');

    // The update DTO has no scope field, so production refuses a PATCH that names one
    const patched = await req('/authorization/roles/doc-editor', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Document Editor', resource_type_slug: 'folder' }),
    });
    expect(patched.status).toBe(422);
    expect((await json(patched)).errors).toEqual([
      { field: 'resource_type_slug', code: 'property resource_type_slug should not exist' },
    ]);
    expect(await json(await req('/authorization/roles/doc-editor'))).toMatchObject({
      name: 'Doc Editor',
      resource_type_slug: 'document',
    });
  });

  it.each([
    [42, 'resource_type_slug must be a string'],
    ['', SLUG_MESSAGE],
    ['Invalid Slug!', SLUG_MESSAGE],
  ])('rejects an invalid resource type %p', async (resource_type_slug, code) => {
    const res = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'bad-scope', name: 'Bad Scope', resource_type_slug }),
    });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({
      message: 'Validation failed',
      errors: [{ field: 'resource_type_slug', code }],
    });
  });

  it.each([
    ['Invalid Slug!', SLUG_MESSAGE],
    ['admin--role', SLUG_MESSAGE],
    ['-leading', SLUG_MESSAGE],
    ['org:scoped', SLUG_MESSAGE],
    ['this-slug-is-way-too-long-and-exceeds-the-maximum', 'slug cannot be more than 48 characters'],
    ['', 'slug should not be empty'],
    [undefined, 'slug should not be empty'],
    [42, 'slug must be a string'],
  ])('rejects the slug %p the way production does', async (slug, code) => {
    const res = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug, name: 'Admin' }),
    });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ message: 'Validation failed', errors: [{ field: 'slug', code }] });
  });

  it('accepts every separator production allows in an environment role slug', async () => {
    const res = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'org-billing_admin-2', name: 'Billing' }),
    });
    expect(res.status).toBe(201);
  });

  it.each([
    [{ slug: 'admin' }, { field: 'name', code: 'name should not be empty' }],
    [
      { slug: 'admin', name: 'x'.repeat(49) },
      { field: 'name', code: 'name cannot be more than 48 characters' },
    ],
    [
      { slug: 'admin', name: 'Admin', description: 'x'.repeat(151) },
      { field: 'description', code: 'description cannot be more than 150 characters' },
    ],
    [
      { slug: 'admin', name: 'Admin', description: 7 },
      { field: 'description', code: 'description must be a string' },
    ],
  ])('rejects the body %j with the field error production reports', async (body, error) => {
    const res = await req('/authorization/roles', { method: 'POST', body: JSON.stringify(body) });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ message: 'Validation failed', errors: [error] });
  });

  it('counts an astral character once against a length cap, as class-validator does', async () => {
    const name = '😀'.repeat(48);
    expect(name.length).toBe(96);
    const accepted = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'emoji', name, description: '🙂'.repeat(150) }),
    });
    expect(accepted.status).toBe(201);
    expect((await json(accepted)).name).toBe(name);

    const rejected = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'emoji-2', name: '😀'.repeat(49), description: '🙂'.repeat(151) }),
    });
    expect(rejected.status).toBe(422);
    expect((await json(rejected)).errors).toEqual([
      { field: 'name', code: 'name cannot be more than 48 characters' },
      { field: 'description', code: 'description cannot be more than 150 characters' },
    ]);
  });

  it('refuses the properties the create DTO does not declare, unknown ones first', async () => {
    const res = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'default-role', name: 'Default', is_default_role: true, priority: 3 }),
    });
    expect(res.status).toBe(422);
    expect((await json(res)).errors).toEqual([
      { field: 'is_default_role', code: 'property is_default_role should not exist' },
      { field: 'priority', code: 'property priority should not exist' },
    ]);

    // A malformed field and an unknown property are both reported, the unknown one first.
    const both = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'Bad Slug', name: 'Bad', priority: 3 }),
    });
    expect((await json(both)).errors).toEqual([
      { field: 'priority', code: 'property priority should not exist' },
      { field: 'slug', code: SLUG_MESSAGE },
    ]);
  });

  it('appends a new role to the end of the priority order, as production does', async () => {
    for (const slug of ['first', 'second']) {
      await req('/authorization/roles', { method: 'POST', body: JSON.stringify({ slug, name: slug }) });
    }
    const body = await json(await req('/authorization/roles'));
    expect(body.data.map((r: any) => [r.slug, r.priority, r.is_default_role])).toEqual([
      ['first', 0, false],
      ['second', 1, false],
    ]);
  });

  it('accepts a null description on create and clears one on update', async () => {
    const created = await json(
      await req('/authorization/roles', {
        method: 'POST',
        body: JSON.stringify({ slug: 'nullable', name: 'Nullable', description: null }),
      }),
    );
    expect(created.description).toBeNull();

    await req('/authorization/roles/nullable', { method: 'PATCH', body: JSON.stringify({ description: 'Set' }) });
    const cleared = await json(
      await req('/authorization/roles/nullable', { method: 'PATCH', body: JSON.stringify({ description: null }) }),
    );
    expect(cleared.description).toBeNull();
  });

  it.each([
    [{ name: '' }, { field: 'name', code: 'name should not be empty' }],
    [{ name: 'x'.repeat(49) }, { field: 'name', code: 'name cannot be more than 48 characters' }],
    [
      { name: 'Renamed', slug: 'new-slug' },
      { field: 'slug', code: 'property slug should not exist' },
    ],
    [
      { name: 'Renamed', priority: 1 },
      { field: 'priority', code: 'property priority should not exist' },
    ],
  ])('rejects the update %j the way production does', async (body, error) => {
    await req('/authorization/roles', { method: 'POST', body: JSON.stringify({ slug: 'fixed', name: 'Fixed' }) });
    const res = await req('/authorization/roles/fixed', { method: 'PATCH', body: JSON.stringify(body) });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ message: 'Validation failed', errors: [error] });
    expect((await json(await req('/authorization/roles/fixed'))).name).toBe('Fixed');
  });

  it('keeps the name when an update sends null for it', async () => {
    await req('/authorization/roles', { method: 'POST', body: JSON.stringify({ slug: 'kept', name: 'Kept' }) });
    const res = await req('/authorization/roles/kept', { method: 'PATCH', body: JSON.stringify({ name: null }) });
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe('Kept');
  });

  it('preserves a seeded role resource type', async () => {
    const server = createTestApp();
    seedFromConfig(server.store, 'http://localhost:0', {
      roles: [{ slug: 'seeded-editor', name: 'Seeded Editor', resource_type_slug: 'document' }],
    });
    const res = await server.app.request('/authorization/roles/seeded-editor', { headers });
    expect(res.status).toBe(200);
    expect((await json(res)).resource_type_slug).toBe('document');
  });

  it.each([[42 as unknown as string], ['']])('rejects an invalid seeded resource type %p', (resource_type_slug) => {
    const result = validateSeedConfig({
      roles: [{ slug: 'bad-seed', name: 'Bad Seed', resource_type_slug }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.path === 'roles[0].resource_type_slug')).toBe(true);
  });

  it('rejects duplicate slug', async () => {
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'dup', name: 'Dup' }),
    });
    const res = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'dup', name: 'Dup 2' }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('role_slug_conflict');
  });

  it('lists environment roles', async () => {
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'r1', name: 'R1' }),
    });
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'r2', name: 'R2' }),
    });
    const res = await req('/authorization/roles');
    const body = await json(res);
    expect(body.object).toBe('list');
    expect(body.data.length).toBe(2);
  });

  it('gets a role by slug', async () => {
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'viewer', name: 'Viewer' }),
    });
    const res = await req('/authorization/roles/viewer');
    expect(res.status).toBe(200);
    const role = await json(res);
    expect(role.slug).toBe('viewer');
  });

  it('updates a role', async () => {
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'upd', name: 'Original' }),
    });
    const res = await req('/authorization/roles/upd', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated', description: 'new desc' }),
    });
    expect(res.status).toBe(200);
    const role = await json(res);
    expect(role.name).toBe('Updated');
    expect(role.description).toBe('new desc');
  });

  it('has no route to delete an environment role, as production has none', async () => {
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'del', name: 'Del' }),
    });
    const res = await req('/authorization/roles/del', { method: 'DELETE' });
    expect(res.status).toBe(404);

    const getRes = await req('/authorization/roles/del');
    expect(getRes.status).toBe(200);
  });

  it('sets and gets role permissions', async () => {
    // Create permissions
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'read', name: 'Read' }),
    });
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'write', name: 'Write' }),
    });

    // Create role
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'editor', name: 'Editor' }),
    });

    // Set permissions
    const setRes = await req('/authorization/roles/editor/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['read', 'write'] }),
    });
    expect(setRes.status).toBe(200);
    const setBody = await json(setRes);
    expect(setBody.object).toBe('role');
    expect([...setBody.permissions].sort()).toEqual(['read', 'write']);

    // The role itself carries the slugs, as in production
    const roleRes = await req('/authorization/roles/editor');
    expect([...(await json(roleRes)).permissions].sort()).toEqual(['read', 'write']);

    // Get permissions
    const getRes = await req('/authorization/roles/editor/permissions');
    const getBody = await json(getRes);
    expect(getBody.data.length).toBe(2);
    const slugs = getBody.data.map((p: any) => p.slug).sort();
    expect(slugs).toEqual(['read', 'write']);
  });

  it('replaces permissions on repeated set', async () => {
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'p1', name: 'P1' }),
    });
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'p2', name: 'P2' }),
    });
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'rep', name: 'Rep' }),
    });

    // Set to p1
    await req('/authorization/roles/rep/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['p1'] }),
    });

    // Replace with p2
    await req('/authorization/roles/rep/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['p2'] }),
    });

    const res = await req('/authorization/roles/rep/permissions');
    const body = await json(res);
    expect(body.data.length).toBe(1);
    expect(body.data[0].slug).toBe('p2');
  });

  it('adds a single permission with POST', async () => {
    for (const slug of ['add-a', 'add-b']) {
      await req('/authorization/permissions', { method: 'POST', body: JSON.stringify({ slug, name: slug }) });
    }
    await req('/authorization/roles', { method: 'POST', body: JSON.stringify({ slug: 'adder', name: 'Adder' }) });
    await req('/authorization/roles/adder/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['add-a'] }),
    });

    const res = await req('/authorization/roles/adder/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'add-b' }),
    });
    expect(res.status).toBe(200);
    expect([...(await json(res)).permissions].sort()).toEqual(['add-a', 'add-b']);

    // Re-attaching is a no-op, not a duplicate
    const again = await req('/authorization/roles/adder/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'add-b' }),
    });
    expect([...(await json(again)).permissions].sort()).toEqual(['add-a', 'add-b']);
  });

  it('rejects malformed permission changes', async () => {
    await req('/authorization/roles', { method: 'POST', body: JSON.stringify({ slug: 'strict', name: 'Strict' }) });

    // An unknown permission slug is a 422 invalid_permission_slug in production, not a 404.
    const missing = await req('/authorization/roles/strict/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'nope' }),
    });
    expect(missing.status).toBe(422);
    expect(await json(missing)).toEqual({ message: "Permission not found: 'nope'.", code: 'invalid_permission_slug' });

    const noSlug = await req('/authorization/roles/strict/permissions', { method: 'POST', body: JSON.stringify({}) });
    expect(noSlug.status).toBe(422);
    expect((await json(noSlug)).errors).toEqual([{ field: 'slug', code: 'slug should not be empty' }]);

    const extra = await req('/authorization/roles/strict/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'nope', permissions: ['nope'] }),
    });
    expect((await json(extra)).errors).toEqual([
      { field: 'permissions', code: 'property permissions should not exist' },
    ]);

    const notArray = await req('/authorization/roles/strict/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: 'read' }),
    });
    expect(notArray.status).toBe(422);
    expect((await json(notArray)).errors).toEqual([{ field: 'permissions', code: 'permissions must be an array' }]);

    const notStrings = await req('/authorization/roles/strict/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['read', 7] }),
    });
    expect((await json(notStrings)).errors).toEqual([
      { field: 'permissions', code: 'each value in permissions must be a string' },
    ]);
  });

  it('leaves permissions intact when a replacement names an unknown slug', async () => {
    await req('/authorization/permissions', { method: 'POST', body: JSON.stringify({ slug: 'keep', name: 'Keep' }) });
    await req('/authorization/roles', { method: 'POST', body: JSON.stringify({ slug: 'atomic', name: 'Atomic' }) });
    await req('/authorization/roles/atomic/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['keep'] }),
    });

    const res = await req('/authorization/roles/atomic/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['keep', 'missing'] }),
    });
    expect(res.status).toBe(422);
    expect(await json(res)).toEqual({ message: "Permission not found: 'missing'.", code: 'invalid_permission_slug' });

    const role = await json(await req('/authorization/roles/atomic'));
    expect(role.permissions).toEqual(['keep']);
  });

  it('emits role.updated only when the permission set changes', async () => {
    for (const slug of ['ev-a', 'ev-b']) {
      await req('/authorization/permissions', { method: 'POST', body: JSON.stringify({ slug, name: slug }) });
    }
    await req('/authorization/roles', { method: 'POST', body: JSON.stringify({ slug: 'evented', name: 'Evented' }) });
    const updates = () => getWorkOSStore(store).events.findBy('event', 'role.updated');

    await req('/authorization/roles/evented/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['ev-a'] }),
    });
    expect(updates()).toHaveLength(1);
    expect(updates()[0]!.data).toMatchObject({ slug: 'evented', permissions: ['ev-a'] });

    // The same set again changes nothing and emits nothing
    await req('/authorization/roles/evented/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['ev-a'] }),
    });
    expect(updates()).toHaveLength(1);

    await req('/authorization/roles/evented/permissions', { method: 'POST', body: JSON.stringify({ slug: 'ev-b' }) });
    expect(updates()).toHaveLength(2);
    expect([...(updates()[1]!.data as any).permissions].sort()).toEqual(['ev-a', 'ev-b']);

    // Re-attaching is a no-op
    await req('/authorization/roles/evented/permissions', { method: 'POST', body: JSON.stringify({ slug: 'ev-b' }) });
    expect(updates()).toHaveLength(2);
  });

  it('emits role.deleted without permissions, as production does', async () => {
    await req('/authorization/permissions', { method: 'POST', body: JSON.stringify({ slug: 'gone', name: 'Gone' }) });
    const doomed = await json(
      await req('/authorization/roles', { method: 'POST', body: JSON.stringify({ slug: 'doomed', name: 'Doomed' }) }),
    );
    await req('/authorization/roles/doomed/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['gone'] }),
    });

    // No route deletes an environment role (production removes one from the dashboard), so
    // the event comes from the store hook alone.
    getWorkOSStore(store).roles.delete(doomed.id);

    const deleted = getWorkOSStore(store).events.findBy('event', 'role.deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.data).toMatchObject({ slug: 'doomed', resource_type_slug: 'organization' });
    expect(deleted[0]!.data).not.toHaveProperty('permissions');
  });

  it('formats a directly inserted role without a resource type using the default', async () => {
    getWorkOSStore(store).roles.insert({
      object: 'role',
      slug: 'legacy',
      name: 'Legacy',
      description: null,
      type: 'EnvironmentRole',
      organization_id: null,
      is_default_role: false,
      priority: 0,
    });
    const res = await req('/authorization/roles/legacy');
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ resource_type_slug: 'organization', permissions: [] });
  });
});
