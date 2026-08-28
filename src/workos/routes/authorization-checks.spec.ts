import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap, type Store } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';

const apiKeys: ApiKeyMap = { sk_test_check: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_check', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Authorization check + role assignment routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  async function setup() {
    // Create user
    const userRes = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'check@test.com' }),
    });
    const user = await json(userRes);

    // Create org
    const orgRes = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Check Org' }),
    });
    const org = await json(orgRes);

    // Create membership with role_slug 'editor'
    const memRes = await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slug: 'editor' }),
    });
    const membership = await json(memRes);

    // Create permissions
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'posts:read', name: 'Read Posts' }),
    });
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'posts:write', name: 'Write Posts' }),
    });
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'admin:manage', name: 'Admin Manage' }),
    });

    // Create environment role 'editor' with read+write permissions
    await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'editor', name: 'Editor' }),
    });
    await req('/authorization/roles/editor/permissions', {
      method: 'POST',
      body: JSON.stringify({ permissions: ['posts:read', 'posts:write'] }),
    });

    // Create environment role 'admin' with admin:manage
    const adminRes = await req('/authorization/roles', {
      method: 'POST',
      body: JSON.stringify({ slug: 'admin-role', name: 'Admin' }),
    });
    const adminRole = await json(adminRes);
    await req('/authorization/roles/admin-role/permissions', {
      method: 'POST',
      body: JSON.stringify({ permissions: ['admin:manage'] }),
    });

    return { user, org, membership, adminRole };
  }

  it('returns authorized true when membership has permission via primary role', async () => {
    const { membership } = await setup();
    const res = await req(`/authorization/organization_memberships/${membership.id}/check`, {
      method: 'POST',
      body: JSON.stringify({ permission: 'posts:read' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.authorized).toBe(true);
  });

  it('returns authorized false when permission not assigned', async () => {
    const { membership } = await setup();
    const res = await req(`/authorization/organization_memberships/${membership.id}/check`, {
      method: 'POST',
      body: JSON.stringify({ permission: 'admin:manage' }),
    });
    const body = await json(res);
    expect(body.authorized).toBe(false);
  });

  it('returns authorized true via additional role assignment', async () => {
    const { membership, adminRole } = await setup();

    // Assign the admin role to the membership
    await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_id: adminRole.id }),
    });

    // Now should have admin:manage
    const res = await req(`/authorization/organization_memberships/${membership.id}/check`, {
      method: 'POST',
      body: JSON.stringify({ permission: 'admin:manage' }),
    });
    const body = await json(res);
    expect(body.authorized).toBe(true);
  });

  it('lists role assignments', async () => {
    const { membership, adminRole } = await setup();

    await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_id: adminRole.id }),
    });

    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.length).toBe(1);
    expect(body.data[0].role_id).toBe(adminRole.id);
    expect(body.data[0].organization_membership_id).toBe(membership.id);
  });

  it('creates a role assignment via role_slug (production/SDK contract)', async () => {
    const { membership, adminRole } = await setup();

    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'admin-role' }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.object).toBe('role_assignment');
    expect(body.organization_membership_id).toBe(membership.id);
    expect(body.role_id).toBe(adminRole.id);
    expect(body.role).toEqual({ slug: 'admin-role' });
    expect(body.resource).toEqual({ id: null, external_id: null, resource_type_slug: null });
    expect(body.source).toEqual({ type: 'direct', group_role_assignment_id: null });

    // The assignment grants its permissions
    const checkRes = await req(`/authorization/organization_memberships/${membership.id}/check`, {
      method: 'POST',
      body: JSON.stringify({ permission: 'admin:manage' }),
    });
    expect((await json(checkRes)).authorized).toBe(true);
  });

  it('creates a role assignment scoped to a resource by external id', async () => {
    const { membership, org } = await setup();

    const resourceRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'doc-1', organization_id: org.id, name: 'doc-1' }),
    });
    const resource = await json(resourceRes);

    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'admin-role', resource_external_id: 'doc-1', resource_type_slug: 'doc' }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.resource).toEqual({ id: resource.id, external_id: 'doc-1', resource_type_slug: 'doc' });
  });

  it('creates a role assignment scoped to a resource by id', async () => {
    const { membership, org } = await setup();

    const resourceRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'doc-2', organization_id: org.id, name: 'doc-2' }),
    });
    const resource = await json(resourceRes);

    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'admin-role', resource_id: resource.id }),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.resource.id).toBe(resource.id);
  });

  it('prefers the organization role when its slug collides with an environment role', async () => {
    const { membership, org } = await setup();

    // 'admin-role' already exists as an environment role (created first in setup)
    const orgRoleRes = await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'admin-role', name: 'Org Admin' }),
    });
    const orgRole = await json(orgRoleRes);

    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'admin-role' }),
    });
    expect(res.status).toBe(201);
    expect((await json(res)).role_id).toBe(orgRole.id);
  });

  it('returns 404 when resource_id belongs to another organization', async () => {
    const { membership } = await setup();

    const otherOrgRes = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Other Org' }),
    });
    const otherOrg = await json(otherOrgRes);
    const resourceRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'doc',
        external_id: 'doc-other',
        organization_id: otherOrg.id,
        name: 'doc-other',
      }),
    });
    const resource = await json(resourceRes);

    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'admin-role', resource_id: resource.id }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown role_slug', async () => {
    const { membership } = await setup();
    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'no-such-role' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown resource target', async () => {
    const { membership } = await setup();
    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'admin-role', resource_id: 'resource_nonexistent' }),
    });
    expect(res.status).toBe(404);
  });

  it('returns 404 when resource_external_id matches but resource_type_slug does not', async () => {
    const { membership, org } = await setup();

    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'doc-3', organization_id: org.id, name: 'doc-3' }),
    });

    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'admin-role', resource_external_id: 'doc-3', resource_type_slug: 'folder' }),
    });
    expect(res.status).toBe(404);
  });

  it('requires resource_type_slug when resource_external_id is provided', async () => {
    const { membership } = await setup();
    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'admin-role', resource_external_id: 'doc-1' }),
    });
    expect(res.status).toBe(422);
  });

  it('requires resource_external_id when resource_type_slug is provided', async () => {
    const { membership } = await setup();
    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'admin-role', resource_type_slug: 'doc' }),
    });
    expect(res.status).toBe(422);
  });

  it('requires role_slug or role_id when creating a role assignment', async () => {
    const { membership } = await setup();
    const res = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it('deletes a role assignment', async () => {
    const { membership, adminRole } = await setup();

    const createRes = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_id: adminRole.id }),
    });
    const assignment = await json(createRes);

    const delRes = await req(
      `/authorization/organization_memberships/${membership.id}/role_assignments/${assignment.id}`,
      { method: 'DELETE' },
    );
    expect(delRes.status).toBe(204);

    // Verify it's gone
    const listRes = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`);
    const body = await json(listRes);
    expect(body.data.length).toBe(0);
  });

  it('lists resources accessible to membership', async () => {
    const { membership, org } = await setup();

    // Create a resource in the org
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'res1', organization_id: org.id, name: 'res1' }),
    });

    const res = await req(`/authorization/organization_memberships/${membership.id}/resources`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.length).toBe(1);
    expect(body.data[0].external_id).toBe('res1');
  });

  async function setupWithResource() {
    const ctx = await setup();
    const resourceRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'doc',
        external_id: 'doc-1',
        organization_id: ctx.org.id,
        name: 'doc-1',
      }),
    });
    const resource = await json(resourceRes);
    return { ...ctx, resource };
  }

  it('lists effective permissions on a resource by external id', async () => {
    const { membership } = await setupWithResource();

    const res = await req(`/authorization/organization_memberships/${membership.id}/resources/doc/doc-1/permissions`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.object).toBe('list');
    expect(body.data.map((p: any) => p.slug).sort()).toEqual(['posts:read', 'posts:write']);
    expect(body.data[0].object).toBe('permission');
    expect(body.data[0].id).toBeDefined();
  });

  it('includes permissions from additional role assignments in effective permissions', async () => {
    const { membership, adminRole } = await setupWithResource();

    await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_id: adminRole.id }),
    });

    const res = await req(`/authorization/organization_memberships/${membership.id}/resources/doc/doc-1/permissions`);
    const body = await json(res);
    expect(body.data.map((p: any) => p.slug).sort()).toEqual(['admin:manage', 'posts:read', 'posts:write']);
  });

  it('lists effective permissions addressing the resource by id', async () => {
    const { membership, resource } = await setupWithResource();

    const res = await req(
      `/authorization/organization_memberships/${membership.id}/resources/${resource.id}/permissions`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.map((p: any) => p.slug).sort()).toEqual(['posts:read', 'posts:write']);
  });

  it('lists effective permissions via the resource-centric route', async () => {
    const { membership, resource } = await setupWithResource();

    const res = await req(
      `/authorization/resources/${resource.id}/organization_memberships/${membership.id}/permissions`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.map((p: any) => p.slug).sort()).toEqual(['posts:read', 'posts:write']);
  });

  it('returns 404 via the resource-centric route for an unknown resource', async () => {
    const { membership } = await setupWithResource();
    const res = await req(
      `/authorization/resources/res_nonexistent/organization_memberships/${membership.id}/permissions`,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 via the resource-centric route for an unknown membership', async () => {
    const { resource } = await setupWithResource();
    const res = await req(
      `/authorization/resources/${resource.id}/organization_memberships/om_nonexistent/permissions`,
    );
    expect(res.status).toBe(404);
  });

  it('paginates effective permissions', async () => {
    const { membership } = await setupWithResource();

    const res = await req(
      `/authorization/organization_memberships/${membership.id}/resources/doc/doc-1/permissions?limit=1`,
    );
    const body = await json(res);
    expect(body.data.length).toBe(1);
    expect(body.list_metadata.after).toBeTruthy();
  });

  it('returns 404 for effective permissions with an unknown membership', async () => {
    await setupWithResource();
    const res = await req('/authorization/organization_memberships/om_nonexistent/resources/doc/doc-1/permissions');
    expect(res.status).toBe(404);
  });

  it('returns 404 for effective permissions on an unknown resource', async () => {
    const { membership } = await setupWithResource();
    const res = await req(`/authorization/organization_memberships/${membership.id}/resources/doc/nope/permissions`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for effective permissions on a resource in another organization', async () => {
    const { membership } = await setupWithResource();

    const otherOrgRes = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Other Org' }),
    });
    const otherOrg = await json(otherOrgRes);
    const resourceRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'doc',
        external_id: 'other-doc',
        organization_id: otherOrg.id,
        name: 'other-doc',
      }),
    });
    const otherResource = await json(resourceRes);

    const res = await req(
      `/authorization/organization_memberships/${membership.id}/resources/${otherResource.id}/permissions`,
    );
    expect(res.status).toBe(404);
  });

  it('resolves an external id collision to the resource in the membership organization', async () => {
    const ctx = await setup();

    // Another org registers the same type slug + external id first
    const otherOrgRes = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Other Org' }),
    });
    const otherOrg = await json(otherOrgRes);
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'doc',
        external_id: 'doc-1',
        organization_id: otherOrg.id,
        name: 'doc-1',
      }),
    });

    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'doc',
        external_id: 'doc-1',
        organization_id: ctx.org.id,
        name: 'doc-1',
      }),
    });

    const res = await req(
      `/authorization/organization_memberships/${ctx.membership.id}/resources/doc/doc-1/permissions`,
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.map((p: any) => p.slug).sort()).toEqual(['posts:read', 'posts:write']);
  });

  it('prefers an organization role over an environment role with the same slug', async () => {
    const { org, membership } = await setupWithResource();

    // Org-scoped 'editor' role with narrower permissions than the environment 'editor'
    await req(`/authorization/organizations/${org.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'editor', name: 'Org Editor' }),
    });
    await req(`/authorization/organizations/${org.id}/roles/editor/permissions`, {
      method: 'POST',
      body: JSON.stringify({ permissions: ['posts:read'] }),
    });

    const res = await req(`/authorization/organization_memberships/${membership.id}/resources/doc/doc-1/permissions`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.map((p: any) => p.slug)).toEqual(['posts:read']);

    // The shadowing applies to /check as well — same helper
    const checkRes = await req(`/authorization/organization_memberships/${membership.id}/check`, {
      method: 'POST',
      body: JSON.stringify({ permission: 'posts:write' }),
    });
    const checkBody = await json(checkRes);
    expect(checkBody.authorized).toBe(false);
  });

  it('ignores a foreign organization role seeded with an environment type', async () => {
    const ctx = await setup();
    const ws = getWorkOSStore(store);

    const otherOrgRes = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Other Org' }),
    });
    const otherOrg = await json(otherOrgRes);

    // Seed normalization allows an organization-owned role whose type
    // defaulted to EnvironmentRole. One from another org must not satisfy
    // the environment fallback.
    const phantomRole = ws.roles.insert({
      object: 'role',
      slug: 'phantom',
      name: 'Phantom',
      description: null,
      type: 'EnvironmentRole',
      organization_id: otherOrg.id,
      is_default_role: false,
      priority: 0,
    });
    const adminPerm = ws.permissions.findOneBy('slug', 'admin:manage')!;
    ws.rolePermissions.insert({ role_id: phantomRole.id, permission_id: adminPerm.id });

    const phantomMembership = ws.organizationMemberships.insert({
      object: 'organization_membership',
      organization_id: ctx.org.id,
      user_id: ctx.user.id,
      role: { slug: 'phantom' },
      status: 'active',
      external_id: null,
      metadata: {},
    });

    const res = await req(`/authorization/organization_memberships/${phantomMembership.id}/check`, {
      method: 'POST',
      body: JSON.stringify({ permission: 'admin:manage' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.authorized).toBe(false);

    // Assigning that foreign role by slug must not resolve it either
    const assignRes = await req(`/authorization/organization_memberships/${ctx.membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'phantom' }),
    });
    expect(assignRes.status).toBe(404);

    // Nor by the compatibility role_id path
    const assignByIdRes = await req(`/authorization/organization_memberships/${ctx.membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_id: phantomRole.id }),
    });
    expect(assignByIdRes.status).toBe(404);
  });

  it('returns 404 for nonexistent membership', async () => {
    const res = await req('/authorization/organization_memberships/om_nonexistent/check', {
      method: 'POST',
      body: JSON.stringify({ permission: 'anything' }),
    });
    expect(res.status).toBe(404);
  });

  it('requires permission field in check', async () => {
    const { membership } = await setup();
    const res = await req(`/authorization/organization_memberships/${membership.id}/check`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it('accepts permission_slug in check (production/SDK contract)', async () => {
    const { membership } = await setupWithResource();
    const res = await req(`/authorization/organization_memberships/${membership.id}/check`, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: 'posts:read', resource_external_id: 'doc-1', resource_type_slug: 'doc' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).authorized).toBe(true);
  });

  it('scopes check to the resource named in the body', async () => {
    const { membership, adminRole, org } = await setupWithResource();
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'doc-2', organization_id: org.id, name: 'doc-2' }),
    });

    // admin:manage granted on doc-1 only
    await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_id: adminRole.id, resource_external_id: 'doc-1', resource_type_slug: 'doc' }),
    });

    const check = (target: Record<string, unknown>) =>
      req(`/authorization/organization_memberships/${membership.id}/check`, {
        method: 'POST',
        body: JSON.stringify({ permission_slug: 'admin:manage', ...target }),
      });

    const onDoc1 = await json(await check({ resource_external_id: 'doc-1', resource_type_slug: 'doc' }));
    expect(onDoc1.authorized).toBe(true);

    const onDoc2 = await json(await check({ resource_external_id: 'doc-2', resource_type_slug: 'doc' }));
    expect(onDoc2.authorized).toBe(false);

    // Org-wide permissions from the primary role apply on every resource
    const primaryOnDoc2 = await json(
      await req(`/authorization/organization_memberships/${membership.id}/check`, {
        method: 'POST',
        body: JSON.stringify({
          permission_slug: 'posts:read',
          resource_external_id: 'doc-2',
          resource_type_slug: 'doc',
        }),
      }),
    );
    expect(primaryOnDoc2.authorized).toBe(true);
  });

  it('inherits permissions from role assignments on ancestor resources', async () => {
    const { membership, adminRole, org, resource } = await setupWithResource();

    // doc-1 is the parent of child-1
    const child = await json(
      await req('/authorization/resources', {
        method: 'POST',
        body: JSON.stringify({
          resource_type_slug: 'doc',
          external_id: 'child-1',
          organization_id: org.id,
          name: 'child-1',
          parent_resource_id: resource.id,
        }),
      }),
    );

    await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_id: adminRole.id, resource_id: resource.id }),
    });

    const res = await req(`/authorization/organization_memberships/${membership.id}/check`, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: 'admin:manage', resource_id: child.id }),
    });
    expect((await json(res)).authorized).toBe(true);
  });

  it('returns 404 when check names an unknown resource', async () => {
    const { membership } = await setupWithResource();
    const res = await req(`/authorization/organization_memberships/${membership.id}/check`, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: 'posts:read', resource_id: 'auth_res_nonexistent' }),
    });
    expect(res.status).toBe(404);
  });

  it('requires resource_type_slug when check names a resource by external id', async () => {
    const { membership } = await setupWithResource();
    const res = await req(`/authorization/organization_memberships/${membership.id}/check`, {
      method: 'POST',
      body: JSON.stringify({ permission_slug: 'posts:read', resource_external_id: 'doc-1' }),
    });
    expect(res.status).toBe(422);
  });

  it('scopes effective permissions to the resource', async () => {
    const { membership, adminRole, org, resource } = await setupWithResource();
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'doc-2', organization_id: org.id, name: 'doc-2' }),
    });

    // admin:manage on doc-1 only
    await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_id: adminRole.id, resource_id: resource.id }),
    });

    const onDoc1 = await json(
      await req(`/authorization/organization_memberships/${membership.id}/resources/doc/doc-1/permissions`),
    );
    expect(onDoc1.data.map((p: any) => p.slug).sort()).toEqual(['admin:manage', 'posts:read', 'posts:write']);

    const onDoc2 = await json(
      await req(`/authorization/organization_memberships/${membership.id}/resources/doc/doc-2/permissions`),
    );
    expect(onDoc2.data.map((p: any) => p.slug).sort()).toEqual(['posts:read', 'posts:write']);
  });

  it('includes ancestor-scoped assignments in effective permissions', async () => {
    const { membership, adminRole, org, resource } = await setupWithResource();
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'doc',
        external_id: 'child-2',
        organization_id: org.id,
        name: 'child-2',
        parent_resource_id: resource.id,
      }),
    });

    await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_id: adminRole.id, resource_id: resource.id }),
    });

    const onChild = await json(
      await req(`/authorization/organization_memberships/${membership.id}/resources/doc/child-2/permissions`),
    );
    expect(onChild.data.map((p: any) => p.slug).sort()).toEqual(['admin:manage', 'posts:read', 'posts:write']);
  });

  it('lists child resources where the membership holds a permission (production contract)', async () => {
    const { membership, adminRole, org, resource } = await setupWithResource();

    const childOf = async (externalId: string) =>
      json(
        await req('/authorization/resources', {
          method: 'POST',
          body: JSON.stringify({
            resource_type_slug: 'project',
            external_id: externalId,
            organization_id: org.id,
            name: 'test-resource',
            parent_resource_id: resource.id,
          }),
        }),
      );
    const projectA = await childOf('proj-a');
    await childOf('proj-b');

    // admin:manage on proj-a only
    await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_id: adminRole.id, resource_id: projectA.id }),
    });

    const scoped = await json(
      await req(
        `/authorization/organization_memberships/${membership.id}/resources?permission_slug=admin:manage&parent_resource_id=${resource.id}`,
      ),
    );
    expect(scoped.data.map((r: any) => r.external_id)).toEqual(['proj-a']);

    // Org-wide permission: both children qualify
    const orgWide = await json(
      await req(
        `/authorization/organization_memberships/${membership.id}/resources?permission_slug=posts:read&parent_resource_id=${resource.id}`,
      ),
    );
    expect(orgWide.data.map((r: any) => r.external_id).sort()).toEqual(['proj-a', 'proj-b']);

    // Parent addressed by external id + type slug
    const byExternal = await json(
      await req(
        `/authorization/organization_memberships/${membership.id}/resources?permission_slug=admin:manage&parent_resource_external_id=doc-1&parent_resource_type_slug=doc`,
      ),
    );
    expect(byExternal.data.map((r: any) => r.external_id)).toEqual(['proj-a']);
  });

  it('requires a parent target when permission_slug is given for the resources listing', async () => {
    const { membership } = await setupWithResource();
    const res = await req(
      `/authorization/organization_memberships/${membership.id}/resources?permission_slug=posts:read`,
    );
    expect(res.status).toBe(422);
  });

  it('filters memberships for a resource by permission_slug', async () => {
    const { membership, adminRole, org, user, resource } = await setupWithResource();

    // A second membership without the admin role
    const otherUser = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'other@test.com' }),
      }),
    );
    await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: org.id, user_id: otherUser.id, role_slug: 'editor' }),
    });

    await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_id: adminRole.id, resource_id: resource.id }),
    });

    const filtered = await json(
      await req(`/authorization/resources/${resource.id}/organization_memberships?permission_slug=admin:manage`),
    );
    expect(filtered.data.length).toBe(1);
    expect(filtered.data[0].user_id).toBe(user.id);

    const unfiltered = await json(await req(`/authorization/resources/${resource.id}/organization_memberships`));
    expect(unfiltered.data.length).toBe(2);
  });
});
