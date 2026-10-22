import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin, seedFromConfig } from '../index.js';
import { validateSeedConfig } from '../config-validator.js';
import { PERMISSION_SLUG_MESSAGE, SLUG_MESSAGE } from '../authorization-validation.js';

const apiKeys: ApiKeyMap = { sk_test_perm: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_perm', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Authorization permission routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('creates a permission', async () => {
    const res = await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'posts:read', name: 'Read Posts' }),
    });
    expect(res.status).toBe(201);
    const perm = await json(res);
    expect(perm.object).toBe('permission');
    expect(perm.slug).toBe('posts:read');
    expect(perm.name).toBe('Read Posts');
    expect(perm).toMatchObject({ system: false, resource_type_slug: 'organization' });
    expect(perm.id).toMatch(/^perm_/);
  });

  it('preserves a permission resource type', async () => {
    const res = await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'documents:read', name: 'Read Documents', resource_type_slug: 'document' }),
    });
    expect(res.status).toBe(201);
    expect((await json(res)).resource_type_slug).toBe('document');
  });

  it('preserves a seeded permission resource type', async () => {
    const server = createTestApp();
    seedFromConfig(server.store, 'http://localhost:0', {
      permissions: [{ slug: 'seeded:read', name: 'Seeded Read', resource_type_slug: 'document' }],
    });
    const res = await server.app.request('/authorization/permissions/seeded:read', { headers });
    expect(res.status).toBe(200);
    expect((await json(res)).resource_type_slug).toBe('document');
  });

  it.each([[42 as unknown as string], ['']])('rejects an invalid seeded resource type %p', (resource_type_slug) => {
    const result = validateSeedConfig({
      permissions: [{ slug: 'invalid:seed', name: 'Invalid Seed', resource_type_slug }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((error) => error.path === 'permissions[0].resource_type_slug')).toBe(true);
  });

  it('keeps the resource type when a permission is updated', async () => {
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'documents:write', name: 'Write Documents', resource_type_slug: 'document' }),
    });
    const res = await req('/authorization/permissions/documents:write', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Edit Documents' }),
    });
    expect(res.status).toBe(200);
    expect(await json(res)).toMatchObject({ name: 'Edit Documents', resource_type_slug: 'document' });
  });

  it('rejects duplicate slug', async () => {
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'dup', name: 'Dup' }),
    });
    const res = await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'dup', name: 'Dup 2' }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('permission_slug_conflict');
  });

  it('rejects missing slug', async () => {
    const res = await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ name: 'No Slug' }),
    });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({
      message: 'Validation failed',
      errors: [{ field: 'slug', code: 'slug should not be empty' }],
    });
  });

  it.each([
    [42, 'resource_type_slug must be a string'],
    ['', SLUG_MESSAGE],
    ['Document Type', SLUG_MESSAGE],
    ['doc:type', SLUG_MESSAGE],
  ])('rejects an invalid resource type %p', async (resource_type_slug, code) => {
    const res = await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'invalid:scope', name: 'Invalid Scope', resource_type_slug }),
    });
    expect(res.status).toBe(422);
    expect((await json(res)).errors).toEqual([{ field: 'resource_type_slug', code }]);
  });

  it.each(['documents:read', 'reports.export', 'billing_admin', 'posts-write', 'documents:*', '*'])(
    'accepts the permission slug %p',
    async (slug) => {
      const res = await req('/authorization/permissions', {
        method: 'POST',
        body: JSON.stringify({ slug, name: 'Allowed' }),
      });
      expect(res.status).toBe(201);
    },
  );

  it.each([
    ['Documents:Read', PERMISSION_SLUG_MESSAGE],
    ['documents::read', PERMISSION_SLUG_MESSAGE],
    [':read', PERMISSION_SLUG_MESSAGE],
    ['documents/read', PERMISSION_SLUG_MESSAGE],
    ['has space', PERMISSION_SLUG_MESSAGE],
    ['a'.repeat(49), 'slug cannot be more than 48 characters'],
    [42, 'slug must be a string'],
  ])('rejects the permission slug %p the way production does', async (slug, code) => {
    const res = await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug, name: 'Rejected' }),
    });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ message: 'Validation failed', errors: [{ field: 'slug', code }] });
  });

  it.each([
    [{ slug: 'posts:read' }, { field: 'name', code: 'name should not be empty' }],
    [
      { slug: 'posts:read', name: 'x'.repeat(49) },
      { field: 'name', code: 'name cannot be more than 48 characters' },
    ],
    [
      { slug: 'posts:read', name: 'Read', description: 'x'.repeat(151) },
      { field: 'description', code: 'description cannot be more than 150 characters' },
    ],
    [
      { slug: 'posts:read', name: 'Read', system: true },
      { field: 'system', code: 'property system should not exist' },
    ],
  ])('rejects the body %j with the field error production reports', async (body, error) => {
    const res = await req('/authorization/permissions', { method: 'POST', body: JSON.stringify(body) });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ message: 'Validation failed', errors: [error] });
  });

  it.each([
    [{ name: '' }, { field: 'name', code: 'name should not be empty' }],
    [{ slug: 'renamed' }, { field: 'slug', code: 'property slug should not exist' }],
    [
      { resource_type_slug: 'other' },
      { field: 'resource_type_slug', code: 'property resource_type_slug should not exist' },
    ],
  ])('rejects the update %j the way production does', async (body, error) => {
    await req('/authorization/permissions', { method: 'POST', body: JSON.stringify({ slug: 'fixed', name: 'Fixed' }) });
    const res = await req('/authorization/permissions/fixed', { method: 'PATCH', body: JSON.stringify(body) });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ message: 'Validation failed', errors: [error] });
    expect(await json(await req('/authorization/permissions/fixed'))).toMatchObject({ slug: 'fixed', name: 'Fixed' });
  });

  it('lists permissions', async () => {
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'a', name: 'A' }),
    });
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'b', name: 'B' }),
    });
    const res = await req('/authorization/permissions');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.object).toBe('list');
    expect(body.data.length).toBe(2);
  });

  it('gets a permission by slug', async () => {
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'test-get', name: 'Test' }),
    });
    const res = await req('/authorization/permissions/test-get');
    expect(res.status).toBe(200);
    const perm = await json(res);
    expect(perm.slug).toBe('test-get');
  });

  it('returns 404 for unknown slug', async () => {
    const res = await req('/authorization/permissions/nonexistent');
    expect(res.status).toBe(404);
  });

  it('updates a permission', async () => {
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'upd', name: 'Original' }),
    });
    const res = await req('/authorization/permissions/upd', {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated', description: 'desc' }),
    });
    expect(res.status).toBe(200);
    const perm = await json(res);
    expect(perm.name).toBe('Updated');
    expect(perm.description).toBe('desc');
  });

  it('deletes a permission', async () => {
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'del', name: 'Del' }),
    });
    const res = await req('/authorization/permissions/del', { method: 'DELETE' });
    expect(res.status).toBe(204);

    const getRes = await req('/authorization/permissions/del');
    expect(getRes.status).toBe(404);
  });

  it('cascade deletes permission from role-permission joins', async () => {
    // Create permission + role + link
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'cascade-perm', name: 'Cascade' }),
    });
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'cascade-role', name: 'Cascade Role' }),
    });
    await req('/authorization/roles/cascade-role/permissions', {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['cascade-perm'] }),
    });

    // Delete the permission
    await req('/authorization/permissions/cascade-perm', { method: 'DELETE' });

    // Role should have no permissions now
    const res = await req('/authorization/roles/cascade-role/permissions');
    const body = await json(res);
    expect(body.data.length).toBe(0);
  });
});
