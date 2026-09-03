import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin, seedFromConfig } from '../index.js';
import { validateSeedConfig } from '../config-validator.js';

const apiKeys: ApiKeyMap = { sk_test_role: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_role', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Authorization environment role routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
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

    // The update DTO has no scope field, so PATCH must leave it untouched
    const patched = await req('/authorization/roles/doc-editor', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Document Editor', resource_type_slug: 'folder' }),
    });
    expect(await json(patched)).toMatchObject({ name: 'Document Editor', resource_type_slug: 'document' });
  });

  it.each([[42], ['']])('rejects an invalid resource type %p', async (resource_type_slug) => {
    const res = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'bad-scope', name: 'Bad Scope', resource_type_slug }),
    });
    expect(res.status).toBe(422);
    expect((await json(res)).errors).toEqual([{ field: 'resource_type_slug', code: 'invalid' }]);
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

  it('deletes a role', async () => {
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'del', name: 'Del' }),
    });
    const res = await req('/authorization/roles/del', { method: 'DELETE' });
    expect(res.status).toBe(204);

    const getRes = await req('/authorization/roles/del');
    expect(getRes.status).toBe(404);
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

    const missing = await req('/authorization/roles/strict/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'nope' }),
    });
    expect(missing.status).toBe(404);

    const noSlug = await req('/authorization/roles/strict/permissions', { method: 'POST', body: JSON.stringify({}) });
    expect(noSlug.status).toBe(422);

    const notArray = await req('/authorization/roles/strict/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: 'read' }),
    });
    expect(notArray.status).toBe(422);
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
    expect(res.status).toBe(404);

    const role = await json(await req('/authorization/roles/atomic'));
    expect(role.permissions).toEqual(['keep']);
  });

  it('creates role with default flag', async () => {
    const res = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'default-role', name: 'Default', is_default_role: true }),
    });
    const role = await json(res);
    expect(role.is_default_role).toBe(true);
  });
});
