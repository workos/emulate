import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin, getWorkOSStore } from '../index.js';
import { ORGANIZATION_ROLE_SLUG_MESSAGE } from '../authorization-validation.js';
import { generateRoleSlug } from '../role-helpers.js';

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

  const createEnvRole = (slug: string, name = slug) =>
    req('/authorization/roles', { method: 'POST', body: JSON.stringify({ slug, name }) });

  const createOrgRole = (orgId: string, body: Record<string, unknown>) =>
    req(`/authorization/organizations/${orgId}/roles`, { method: 'POST', body: JSON.stringify(body) });

  it('creates an org role', async () => {
    const org = await createOrg('Test Org');
    const res = await createOrgRole(org.id, { slug: 'org-admin', name: 'Org Admin' });
    expect(res.status).toBe(201);
    const role = await json(res);
    expect(role.type).toBe('OrganizationRole');
    expect(role.organization_id).toBe(org.id);
    expect(role.slug).toBe('org-admin');
    expect(role.resource_type_slug).toBe('organization');
  });

  it('generates a slug from the name and the role id when none is given, as production does', async () => {
    const org = await createOrg('Auto Slug Org');
    const res = await createOrgRole(org.id, { name: 'Billing Manager', description: 'Can manage billing' });
    expect(res.status).toBe(201);
    const role = await json(res);
    expect(role).toMatchObject({
      object: 'role',
      name: 'Billing Manager',
      description: 'Can manage billing',
      type: 'OrganizationRole',
      resource_type_slug: 'organization',
      permissions: [],
    });
    // The name slugified plus the last six characters of the id, lowercased — no org- prefix.
    expect(role.slug).toMatch(/^billing-manager-[a-z0-9]{6}$/);
    expect(role.slug).toBe(`billing-manager-${role.id.slice(-6).toLowerCase()}`);

    const stripped = await json(await createOrgRole(org.id, { name: 'Super Admin (All Access)' }));
    expect(stripped.slug).toMatch(/^super-admin-all-access-[a-z0-9]{6}$/);

    // The same name in two organizations never collides: the suffix comes from the role.
    const other = await createOrg('Other Auto Slug Org');
    const first = await json(await createOrgRole(org.id, { name: 'Admin' }));
    const second = await json(await createOrgRole(other.id, { name: 'Admin' }));
    expect(first.slug).toMatch(/^admin-[a-z0-9]{6}$/);
    expect(second.slug).toMatch(/^admin-[a-z0-9]{6}$/);
    expect(first.slug).not.toBe(second.slug);
  });

  it('generates slugs the way production slugifies', () => {
    const id = 'role_01J5K7M2X9ABCDEFGHJKMNPQRS';
    expect(generateRoleSlug('Admin', id)).toBe('admin-mnpqrs');
    expect(generateRoleSlug('  Billing   Manager ', id)).toBe('billing-manager-mnpqrs');
    expect(generateRoleSlug('a'.repeat(42), id)).toBe('a'.repeat(41) + '-mnpqrs');
    expect(generateRoleSlug('a'.repeat(40) + '-bbb', id)).toBe('a'.repeat(40) + '-mnpqrs');
    expect(generateRoleSlug('!@#$%^&*()', id)).toBe('mnpqrs');
    expect(generateRoleSlug('a__b--c', id)).toBe('a-b-c-mnpqrs');
  });

  it.each([
    ['billing-admin', ORGANIZATION_ROLE_SLUG_MESSAGE],
    ['org-', ORGANIZATION_ROLE_SLUG_MESSAGE],
    ['org-Billing', ORGANIZATION_ROLE_SLUG_MESSAGE],
    ['org-billing--admin', ORGANIZATION_ROLE_SLUG_MESSAGE],
    ['org-' + 'a'.repeat(45), 'slug cannot be more than 48 characters'],
    ['', 'slug should not be empty'],
    [null, 'slug should not be empty'],
    [42, 'slug must be a string'],
  ])('rejects the organization role slug %p the way production does', async (slug, code) => {
    const org = await createOrg('Slug Org');
    const res = await createOrgRole(org.id, { slug, name: 'Billing' });
    expect(res.status).toBe(422);
    expect(await json(res)).toMatchObject({ message: 'Validation failed', errors: [{ field: 'slug', code }] });
  });

  it('ignores properties its create DTO does not declare, as production does without a whitelist', async () => {
    const org = await createOrg('Lenient Org');
    const res = await createOrgRole(org.id, {
      slug: 'org-lenient',
      name: 'Lenient',
      priority: 7,
      is_default_role: true,
    });
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ slug: 'org-lenient', priority: 0, is_default_role: false });
  });

  it('validates the body before it resolves the organization', async () => {
    const res = await createOrgRole('org_does_not_exist', { slug: 'nope', name: 'Nope' });
    expect(res.status).toBe(422);

    const unknownOrg = await createOrgRole('org_does_not_exist', { slug: 'org-fine', name: 'Fine' });
    expect(unknownOrg.status).toBe(404);
  });

  it('preserves an org role resource type', async () => {
    const org = await createOrg('Scoped Org');
    const res = await createOrgRole(org.id, {
      slug: 'org-doc-editor',
      name: 'Doc Editor',
      resource_type_slug: 'document',
    });
    expect(res.status).toBe(201);
    expect((await json(res)).resource_type_slug).toBe('document');
  });

  it('rejects duplicate slug within same org', async () => {
    const org = await createOrg('Dup Org');
    await createOrgRole(org.id, { slug: 'org-dup', name: 'Dup' });
    const res = await createOrgRole(org.id, { slug: 'org-dup', name: 'Dup 2' });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('organization_role_slug_conflict');
  });

  it('allows same slug in different orgs', async () => {
    const org1 = await createOrg('Org1');
    const org2 = await createOrg('Org2');
    const res1 = await createOrgRole(org1.id, { slug: 'org-shared', name: 'Shared' });
    const res2 = await createOrgRole(org2.id, { slug: 'org-shared', name: 'Shared' });
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
  });

  it('lists org roles scoped to org', async () => {
    const org1 = await createOrg('List Org1');
    const org2 = await createOrg('List Org2');
    await createOrgRole(org1.id, { slug: 'org-r1', name: 'R1' });
    await createOrgRole(org2.id, { slug: 'org-r2', name: 'R2' });

    const res = await req(`/authorization/organizations/${org1.id}/roles`);
    const body = await json(res);
    expect(body.data.length).toBe(1);
    expect(body.data[0].slug).toBe('org-r1');
  });

  it('lists the environment roles that apply to the org too, shadowed by its own, in priority order', async () => {
    const org = await createOrg('Applies Org');
    const other = await createOrg('Other Org');
    // An environment role may carry the org- prefix, so an organization role can shadow it.
    await createEnvRole('member', 'Member');
    await createEnvRole('org-admin', 'Admin');
    await createOrgRole(org.id, { slug: 'org-reviewer', name: 'Reviewer' });
    await createOrgRole(org.id, { slug: 'org-admin', name: 'Applies admin' });
    await createOrgRole(other.id, { slug: 'org-outsider', name: 'Outsider' });

    // Creation order is the priority order until one is set
    const created = await json(await req(`/authorization/organizations/${org.id}/roles`));
    expect(created.data.map((r: any) => [r.slug, r.type])).toEqual([
      ['member', 'EnvironmentRole'],
      ['org-reviewer', 'OrganizationRole'],
      ['org-admin', 'OrganizationRole'],
    ]);
    expect(created.data[2].name).toBe('Applies admin');

    await req(`/authorization/organizations/${org.id}/roles/priority`, {
      method: 'PUT',
      body: JSON.stringify({ role_priority_order: ['member', 'org-admin', 'org-reviewer'] }),
    });
    const body = await json(await req(`/authorization/organizations/${org.id}/roles`));
    expect(body.data.map((r: any) => [r.slug, r.type])).toEqual([
      ['member', 'EnvironmentRole'],
      ['org-admin', 'OrganizationRole'],
      ['org-reviewer', 'OrganizationRole'],
    ]);
  });

  it('lists a seeded organization-owned role as the org override, the way memberships resolve it', async () => {
    const org = await createOrg('Seeded Org');
    await createEnvRole('admin', 'Admin');
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
      await createEnvRole(`env-${i}`, `Env ${i}`);
    }
    await createOrgRole(org.id, { slug: 'org-own', name: 'Own' });

    const body = await json(await req(`/authorization/organizations/${org.id}/roles`));

    expect(body.data.length).toBe(13);
    expect(body.data[12].slug).toBe('org-own');
    expect(body.list_metadata).toEqual({ before: null, after: null });
  });

  it('answers 404 for an unknown organization rather than the environment roles', async () => {
    await createEnvRole('member', 'Member');

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
    await createOrgRole(org.id, { slug: 'org-getter', name: 'Getter' });
    const res = await req(`/authorization/organizations/${org.id}/roles/org-getter`);
    expect(res.status).toBe(200);
    const role = await json(res);
    expect(role.slug).toBe('org-getter');
  });

  it('gets an environment role that applies to the org by slug, shadowed by the org role', async () => {
    const org = await createOrg('Get Env Org');
    await createEnvRole('member', 'Member');
    await createEnvRole('org-admin', 'Env admin');
    await createOrgRole(org.id, { slug: 'org-admin', name: 'Org admin' });

    const env = await json(await req(`/authorization/organizations/${org.id}/roles/member`));
    expect(env).toMatchObject({ slug: 'member', type: 'EnvironmentRole' });

    const shadowed = await json(await req(`/authorization/organizations/${org.id}/roles/org-admin`));
    expect(shadowed).toMatchObject({ name: 'Org admin', type: 'OrganizationRole', organization_id: org.id });

    // Only the organization's own roles are written through this path
    const patched = await req(`/authorization/organizations/${org.id}/roles/member`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(patched.status).toBe(404);
    expect((await req(`/authorization/organizations/${org.id}/roles/member`, { method: 'DELETE' })).status).toBe(404);
    expect((await req('/authorization/organizations/org_does_not_exist/roles/member')).status).toBe(404);
  });

  it('updates an org role', async () => {
    const org = await createOrg('Upd Org');
    await createOrgRole(org.id, { slug: 'org-upd', name: 'Original' });
    const res = await req(`/authorization/organizations/${org.id}/roles/org-upd`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Updated' }),
    });
    expect(res.status).toBe(200);
    const role = await json(res);
    expect(role.name).toBe('Updated');

    const emptyName = await req(`/authorization/organizations/${org.id}/roles/org-upd`, {
      method: 'PATCH',
      body: JSON.stringify({ name: '' }),
    });
    expect(emptyName.status).toBe(422);
    expect((await json(emptyName)).errors).toEqual([{ field: 'name', code: 'name should not be empty' }]);
  });

  it('deletes an org role', async () => {
    const org = await createOrg('Del Org');
    await createOrgRole(org.id, { slug: 'org-del', name: 'Del' });
    const res = await req(`/authorization/organizations/${org.id}/roles/org-del`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const getRes = await req(`/authorization/organizations/${org.id}/roles/org-del`);
    expect(getRes.status).toBe(404);
  });

  it('refuses to delete an org role a membership still holds, as production does', async () => {
    const org = await createOrg('Held Org');
    await createOrgRole(org.id, { slug: 'org-held', name: 'Held' });
    const user = await json(
      await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'held@test.com' }) }),
    );
    const membership = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slug: 'org-held' }),
      }),
    );

    const res = await req(`/authorization/organizations/${org.id}/roles/org-held`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect(await json(res)).toEqual({
      message: "Role 'org-held' cannot be deleted because it has user role assignments.",
      code: 'role_has_assignments',
    });
    expect((await req(`/authorization/organizations/${org.id}/roles/org-held`)).status).toBe(200);
    expect(getWorkOSStore(store).events.findBy('event', 'organization_role.deleted')).toHaveLength(0);

    // Once nothing holds it, the delete goes through
    await req(`/user_management/organization_memberships/${membership.id}`, { method: 'DELETE' });
    expect((await req(`/authorization/organizations/${org.id}/roles/org-held`, { method: 'DELETE' })).status).toBe(204);
  });

  it('refuses to delete an org role a resource-scoped assignment still names', async () => {
    const org = await createOrg('Assigned Org');
    await createOrgRole(org.id, { slug: 'org-scoped', name: 'Scoped', resource_type_slug: 'doc' });
    const user = await json(
      await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'scoped@test.com' }) }),
    );
    const membership = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slug: 'member' }),
      }),
    );
    const resource = await json(
      await req('/authorization/resources', {
        method: 'POST',
        body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'd1', organization_id: org.id, name: 'd1' }),
      }),
    );
    const assignment = await json(
      await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
        method: 'POST',
        body: JSON.stringify({ role_slug: 'org-scoped', resource_id: resource.id }),
      }),
    );

    const res = await req(`/authorization/organizations/${org.id}/roles/org-scoped`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('role_has_assignments');

    await req(`/authorization/organization_memberships/${membership.id}/role_assignments/${assignment.id}`, {
      method: 'DELETE',
    });
    expect((await req(`/authorization/organizations/${org.id}/roles/org-scoped`, { method: 'DELETE' })).status).toBe(
      204,
    );
  });

  it('refuses to delete an org role a native group with members still holds', async () => {
    const org = await createOrg('Group Org');
    await createOrgRole(org.id, { slug: 'org-grouped', name: 'Grouped' });
    const user = await json(
      await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'grouped@test.com' }) }),
    );
    const membership = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slug: 'member' }),
      }),
    );
    const group = await json(
      await req(`/organizations/${org.id}/groups`, { method: 'POST', body: JSON.stringify({ name: 'Grouped' }) }),
    );
    // A grant to an empty group derives no assignment, so the role is still deletable
    const grant = await json(
      await req(`/authorization/groups/${group.id}/role_assignments`, {
        method: 'POST',
        body: JSON.stringify({ role_slug: 'org-grouped' }),
      }),
    );
    expect(grant.object).toBe('group_role_assignment');
    await req(`/organizations/${org.id}/groups/${group.id}/organization-memberships`, {
      method: 'POST',
      body: JSON.stringify({ organization_membership_id: membership.id }),
    });

    const res = await req(`/authorization/organizations/${org.id}/roles/org-grouped`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('role_has_assignments');
    expect((await req(`/authorization/groups/${group.id}/role_assignments/${grant.id}`)).status).toBe(200);

    // Once the group has no members the grant derives nothing, and the delete takes it along
    await req(`/organizations/${org.id}/groups/${group.id}/organization-memberships/${membership.id}`, {
      method: 'DELETE',
    });
    expect((await req(`/authorization/organizations/${org.id}/roles/org-grouped`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await req(`/authorization/groups/${group.id}/role_assignments/${grant.id}`)).status).toBe(404);
  });

  it('ignores a group link whose membership was deleted when deciding if a role is held', async () => {
    const org = await createOrg('Ghost Link Org');
    await createOrgRole(org.id, { slug: 'org-ghosted', name: 'Ghosted' });
    const user = await json(
      await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'ghosted@test.com' }) }),
    );
    const membership = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slug: 'member' }),
      }),
    );
    const group = await json(
      await req(`/organizations/${org.id}/groups`, { method: 'POST', body: JSON.stringify({ name: 'Ghosted' }) }),
    );
    await req(`/authorization/groups/${group.id}/role_assignments`, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'org-ghosted' }),
    });
    await req(`/organizations/${org.id}/groups/${group.id}/organization-memberships`, {
      method: 'POST',
      body: JSON.stringify({ organization_membership_id: membership.id }),
    });

    // Deleting the membership itself (not its group link) leaves the link pointing at nothing,
    // which must not count as the group still holding the role.
    expect((await req(`/user_management/organization_memberships/${membership.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await req(`/authorization/organizations/${org.id}/roles/org-ghosted`, { method: 'DELETE' })).status).toBe(
      204,
    );
  });

  it('does not count a membership of another organization that holds the same slug', async () => {
    const org = await createOrg('Mine Org');
    const other = await createOrg('Theirs Org');
    await createOrgRole(org.id, { slug: 'org-same', name: 'Same' });
    await createOrgRole(other.id, { slug: 'org-same', name: 'Same' });
    const user = await json(
      await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'theirs@test.com' }) }),
    );
    await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: other.id, user_id: user.id, role_slug: 'org-same' }),
    });

    expect((await req(`/authorization/organizations/${org.id}/roles/org-same`, { method: 'DELETE' })).status).toBe(204);
    expect((await req(`/authorization/organizations/${other.id}/roles/org-same`, { method: 'DELETE' })).status).toBe(
      409,
    );
  });

  it('sets role priority ordering with role_priority_order, environment roles included', async () => {
    const org = await createOrg('Priority Org');
    await createEnvRole('member', 'Member');
    await createOrgRole(org.id, { slug: 'org-low', name: 'Low' });
    await createOrgRole(org.id, { slug: 'org-high', name: 'High' });
    const events = () => getWorkOSStore(store).events.findBy('event', 'organization_role.updated');
    const before = events().length;

    const res = await req(`/authorization/organizations/${org.id}/roles/priority`, {
      method: 'PUT',
      body: JSON.stringify({ role_priority_order: ['org-high', 'org-low', 'member'] }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.object).toBe('list');
    expect(body.data.map((r: any) => [r.slug, r.priority])).toEqual([
      ['org-high', 0],
      ['org-low', 1],
      ['member', 2],
    ]);
    // Production keeps the order on the role config, so no role.updated accompanies it
    expect(events().length).toBe(before);
    expect(getWorkOSStore(store).events.findBy('event', 'role.updated')).toHaveLength(0);
  });

  it('rejects a priority order production refuses', async () => {
    const org = await createOrg('Bad Priority Org');
    await createEnvRole('member', 'Member');
    await createOrgRole(org.id, { slug: 'org-admin', name: 'Admin' });
    const put = (body: unknown) =>
      req(`/authorization/organizations/${org.id}/roles/priority`, { method: 'PUT', body: JSON.stringify(body) });

    const duplicate = await put({ role_priority_order: ['member', 'member'] });
    expect(duplicate.status).toBe(400);
    expect(await json(duplicate)).toEqual({
      message: 'Priority order contains duplicate role slugs',
      code: 'duplicate_role_slugs',
    });

    const unknown = await put({ role_priority_order: ['member', 'nonexistent-slug'] });
    expect(unknown.status).toBe(400);
    expect(await json(unknown)).toEqual({ message: 'Unknown role slug: nonexistent-slug', code: 'unknown_role_slugs' });

    const incomplete = await put({ role_priority_order: ['member'] });
    expect(incomplete.status).toBe(400);
    expect(await json(incomplete)).toEqual({
      message: 'Error updating role priority order due to invalid priority list',
      code: 'bad_request',
    });

    // The body is validated before the organization is resolved
    for (const body of [{}, { role_priority_order: [] }, { role_priority_order: 'member' }, { slugs: ['member'] }]) {
      const res = await put(body);
      expect(res.status).toBe(422);
      expect((await json(res)).errors).toEqual([
        { field: 'role_priority_order', code: 'role_priority_order must contain at least 1 elements' },
      ]);
    }
    const notStrings = await put({ role_priority_order: ['member', 7] });
    expect((await json(notStrings)).errors).toEqual([
      { field: 'role_priority_order', code: 'each value in role_priority_order must be a string' },
    ]);

    const noOrg = await req('/authorization/organizations/org_does_not_exist/roles/priority', {
      method: 'PUT',
      body: JSON.stringify({ role_priority_order: ['member'] }),
    });
    expect(noOrg.status).toBe(404);
  });

  it('emits organization_role.deleted with the permissions the role held', async () => {
    const org = await createOrg('Deleted Org');
    await req('/authorization/permissions', {
      method: 'POST',
      body: JSON.stringify({ slug: 'org-gone', name: 'Gone' }),
    });
    await createOrgRole(org.id, { slug: 'org-doomed', name: 'Doomed' });
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
    await createOrgRole(org.id, { slug: 'org-editor', name: 'Editor' });

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

    // Removing a permission the role does not hold is a no-op that still answers with the
    // role and emits nothing; one that does not exist is a 404.
    const again = await req(`/authorization/organizations/${org.id}/roles/org-editor/permissions/org-write`, {
      method: 'DELETE',
    });
    expect(again.status).toBe(200);
    expect((await json(again)).permissions).toEqual(['org-read']);
    expect(getWorkOSStore(store).events.findBy('event', 'organization_role.updated')).toHaveLength(2);
    const missing = await req(`/authorization/organizations/${org.id}/roles/org-editor/permissions/org-nope`, {
      method: 'DELETE',
    });
    expect(missing.status).toBe(404);

    // Attaching an unknown permission is a 422 invalid_permission_slug
    const unknown = await req(`/authorization/organizations/${org.id}/roles/org-editor/permissions`, {
      method: 'POST',
      body: JSON.stringify({ slug: 'org-nope' }),
    });
    expect(unknown.status).toBe(422);
    expect(await json(unknown)).toEqual({
      message: "Permission not found: 'org-nope'.",
      code: 'invalid_permission_slug',
    });
  });
});
