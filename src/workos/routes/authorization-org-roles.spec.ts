import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin, getWorkOSStore } from '../index.js';

const apiKeys: ApiKeyMap = { sk_test_orgrole: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_orgrole', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Authorization org role routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  async function createOrg(name: string) {
    const res = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    return json(res);
  }

  it('creates an org role', async () => {
    const org = await createOrg('Test Org');
    const res = await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'org-admin', name: 'Org Admin' }),
    });
    expect(res.status).toBe(201);
    const role = await json(res);
    expect(role.type).toBe('OrganizationRole');
    expect(role.organization_id).toBe(org.id);
    expect(role.slug).toBe('org-admin');
    expect(role.resource_type_slug).toBe('organization');
  });

  it('preserves an org role resource type', async () => {
    const org = await createOrg('Scoped Org');
    const res = await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'doc-editor', name: 'Doc Editor', resource_type_slug: 'document' }),
    });
    expect(res.status).toBe(201);
    expect((await json(res)).resource_type_slug).toBe('document');
  });

  it('rejects duplicate slug within same org', async () => {
    const org = await createOrg('Dup Org');
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'dup', name: 'Dup' }),
    });
    const res = await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'dup', name: 'Dup 2' }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('organization_role_slug_conflict');
  });

  it('allows same slug in different orgs', async () => {
    const org1 = await createOrg('Org1');
    const org2 = await createOrg('Org2');
    const res1 = await req(`/authorization/organizations/${org1.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'shared', name: 'Shared' }),
    });
    const res2 = await req(`/authorization/organizations/${org2.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'shared', name: 'Shared' }),
    });
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
  });

  it('lists org roles scoped to org', async () => {
    const org1 = await createOrg('List Org1');
    const org2 = await createOrg('List Org2');
    await req(`/authorization/organizations/${org1.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'r1', name: 'R1' }),
    });
    await req(`/authorization/organizations/${org2.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'r2', name: 'R2' }),
    });

    const res = await req(`/authorization/organizations/${org1.id}/roles`);
    const body = await json(res);
    expect(body.data.length).toBe(1);
    expect(body.data[0].slug).toBe('r1');
  });

  it('lists the environment roles that apply to the org too, shadowed by its own, in priority order', async () => {
    const org = await createOrg('Applies Org');
    const other = await createOrg('Other Org');
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'member', name: 'Member', priority: 0 }),
    });
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'admin', name: 'Admin', priority: 1 }),
    });
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'reviewer', name: 'Reviewer', priority: 2 }),
    });
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'admin', name: 'Applies admin', priority: 1 }),
    });
    await req(`/authorization/organizations/${other.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'outsider', name: 'Outsider', priority: 0 }),
    });

    const body = await json(await req(`/authorization/organizations/${org.id}/roles`));

    expect(body.data.map((r: any) => [r.slug, r.type])).toEqual([
      ['member', 'EnvironmentRole'],
      ['admin', 'OrganizationRole'],
      ['reviewer', 'OrganizationRole'],
    ]);
    expect(body.data[1].name).toBe('Applies admin');
  });

  it('lists a seeded organization-owned role as the org override, the way memberships resolve it', async () => {
    const org = await createOrg('Seeded Org');
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'admin', name: 'Admin', priority: 0 }),
    });
    // A seeded role carries an organization_id with the type defaulted to EnvironmentRole.
    getWorkOSStore(store).roles.insert({
      object: 'role',
      slug: 'admin',
      name: 'Seeded admin',
      description: null,
      type: 'EnvironmentRole',
      organization_id: org.id,
      is_default_role: false,
      priority: 0,
      resource_type_slug: 'organization',
    });

    const body = await json(await req(`/authorization/organizations/${org.id}/roles`));

    expect(body.data.map((r: any) => r.name)).toEqual(['Seeded admin']);
  });

  it('returns every applying role in one unpaged list', async () => {
    const org = await createOrg('Many Roles Org');
    for (let i = 0; i < 12; i++) {
      await req('/authorization/roles', {
        method: 'POST',
        body: JSON.stringify({ slug: `env-${i}`, name: `Env ${i}`, priority: i }),
      });
    }
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'own', name: 'Own', priority: 99 }),
    });

    const body = await json(await req(`/authorization/organizations/${org.id}/roles`));

    expect(body.data.length).toBe(13);
    expect(body.data[12].slug).toBe('own');
    expect(body.list_metadata).toEqual({ before: null, after: null });
  });

  it('answers 404 for an unknown organization rather than the environment roles', async () => {
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'member', name: 'Member' }),
    });

    const res = await req('/authorization/organizations/org_does_not_exist/roles');

    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({
      message: "Organization not found: 'org_does_not_exist'.",
      code: 'entity_not_found',
      entity_id: 'org_does_not_exist',
    });
  });

  it('gets an org role by slug', async () => {
    const org = await createOrg('Get Org');
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'getter', name: 'Getter' }),
    });
    const res = await req(`/authorization/organizations/${org.id}/roles/getter`);
    expect(res.status).toBe(200);
    const role = await json(res);
    expect(role.slug).toBe('getter');
  });

  it('updates an org role', async () => {
    const org = await createOrg('Upd Org');
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'upd', name: 'Original' }),
    });
    const res = await req(`/authorization/organizations/${org.id}/roles/upd`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated' }),
    });
    expect(res.status).toBe(200);
    const role = await json(res);
    expect(role.name).toBe('Updated');
  });

  it('deletes an org role', async () => {
    const org = await createOrg('Del Org');
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'del', name: 'Del' }),
    });
    const res = await req(`/authorization/organizations/${org.id}/roles/del`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const getRes = await req(`/authorization/organizations/${org.id}/roles/del`);
    expect(getRes.status).toBe(404);
  });

  it('sets role priority ordering', async () => {
    const org = await createOrg('Priority Org');
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'low', name: 'Low', priority: 99 }),
    });
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'high', name: 'High', priority: 99 }),
    });

    const res = await req(`/authorization/organizations/${org.id}/roles/priority`, {
      method: 'PUT',
      body: JSON.stringify({ slugs: ['high', 'low'] }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data[0].slug).toBe('high');
    expect(body.data[0].priority).toBe(0);
    expect(body.data[1].slug).toBe('low');
    expect(body.data[1].priority).toBe(1);
  });

  it('emits organization_role.deleted with the permissions the role held', async () => {
    const org = await createOrg('Deleted Org');
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'org-gone', name: 'Gone' }),
    });
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'org-doomed', name: 'Doomed' }),
    });
    await req(`/authorization/organizations/${org.id}/roles/org-doomed/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['org-gone'] }),
    });

    const res = await req(`/authorization/organizations/${org.id}/roles/org-doomed`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const deleted = getWorkOSStore(store).events.findBy('event', 'organization_role.deleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.data).toMatchObject({ slug: 'org-doomed', permissions: ['org-gone'] });
  });

  it('manages org role permissions', async () => {
    const org = await createOrg('Perm Org');

    // Create permissions
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'org-read', name: 'Read' }),
    });
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'org-write', name: 'Write' }),
    });

    // Create org role
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'org-editor', name: 'Editor' }),
    });

    // Set permissions
    await req(`/authorization/organizations/${org.id}/roles/org-editor/permissions`, {
      method: 'PUT',
      body: JSON.stringify({ permissions: ['org-read', 'org-write'] }),
    });

    // Get permissions
    const res = await req(`/authorization/organizations/${org.id}/roles/org-editor/permissions`);
    const body = await json(res);
    expect(body.data.length).toBe(2);

    // Remove one permission
    const delRes = await req(`/authorization/organizations/${org.id}/roles/org-editor/permissions/org-write`, {
      method: 'DELETE',
    });
    expect(delRes.status).toBe(200);
    expect((await json(delRes)).permissions).toEqual(['org-read']);

    // Both the set and the removal changed the permission set, so each emitted
    const updated = getWorkOSStore(store).events.findBy('event', 'organization_role.updated');
    expect(updated).toHaveLength(2);
    expect(updated[1]!.data).toMatchObject({ slug: 'org-editor', permissions: ['org-read'] });

    // Verify removal
    const afterRes = await req(`/authorization/organizations/${org.id}/roles/org-editor/permissions`);
    const afterBody = await json(afterRes);
    expect(afterBody.data.length).toBe(1);
    expect(afterBody.data[0].slug).toBe('org-read');
  });
});
