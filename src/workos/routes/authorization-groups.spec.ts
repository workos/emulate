import { beforeEach, describe, expect, it } from 'bun:test';
import { createServer } from '../../core/index.js';
import { workosPlugin } from '../index.js';

const headers = { authorization: 'Bearer sk_test_groups_authz', 'content-type': 'application/json' };

describe('Native group authorization', () => {
  let app: ReturnType<typeof createServer>['app'];
  beforeEach(() => {
    app = createServer(workosPlugin, { apiKeys: { sk_test_groups_authz: { environment: 'test' } } }).app;
  });
  const request = (path: string, method = 'GET', body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  async function create(path: string, body: unknown) {
    const response = await request(path, 'POST', body);
    expect(response.status).toBe(201);
    return response.json() as Promise<any>;
  }
  async function setup() {
    const organization = await create('/organizations', { name: 'Group authorization' });
    const user = await create('/user_management/users', { email: 'writer@example.com' });
    const membership = await create('/user_management/organization_memberships', {
      organization_id: organization.id,
      user_id: user.id,
      role_slug: 'member',
    });
    await create('/authorization/permissions', {
      slug: 'repository:read',
      name: 'Read',
      resource_type_slug: 'repository',
    });
    const role = await create('/authorization/roles', {
      slug: 'repository-reader',
      name: 'Reader',
      resource_type_slug: 'repository',
    });
    await request('/authorization/roles/repository-reader/permissions', 'PUT', { permissions: ['repository:read'] });
    const resource = await create('/authorization/resources', {
      organization_id: organization.id,
      resource_type_slug: 'repository',
      external_id: 'repo',
      name: 'Repository',
    });
    const group = await create(`/organizations/${organization.id}/groups`, { name: 'Readers' });
    await request(`/organizations/${organization.id}/groups/${group.id}/organization-memberships`, 'POST', {
      organization_membership_id: membership.id,
    });
    const path = `/authorization/groups/${group.id}/role_assignments`;
    const assignment = await create(path, { role_slug: role.slug, resource_id: resource.id });
    const check = async (resourceId = resource.id) => {
      const response = await request(`/authorization/organization_memberships/${membership.id}/check`, 'POST', {
        permission_slug: 'repository:read',
        resource_id: resourceId,
      });
      expect(response.status).toBe(200);
      return ((await response.json()) as { authorized: boolean }).authorized;
    };
    return { organization, membership, role, resource, group, path, assignment, check };
  }

  it('grants scoped access, lists derived assignments, and revokes when group membership is removed', async () => {
    const { organization, membership, resource, group, path, assignment, check } = await setup();
    expect(await check()).toBe(true);
    const other = await create('/authorization/resources', {
      organization_id: organization.id,
      resource_type_slug: 'repository',
      external_id: 'other',
      name: 'Other',
    });
    expect(await check(other.id)).toBe(false);
    const child = await create('/authorization/resources', {
      organization_id: organization.id,
      resource_type_slug: 'document',
      external_id: 'child',
      name: 'Child',
      parent_resource_id: resource.id,
    });
    expect(await check(child.id)).toBe(true);

    expect(((await (await request(path)).json()) as any).data[0]).toMatchObject({
      id: assignment.id,
      object: 'group_role_assignment',
      group_id: group.id,
      role: { slug: 'repository-reader' },
      resource: { id: resource.id },
    });
    expect((await request(`${path}/${assignment.id}`)).status).toBe(200);
    const memberPath = `/authorization/organization_memberships/${membership.id}/role_assignments`;
    const derived = ((await (await request(`${memberPath}?resource_id=${resource.id}`)).json()) as any).data;
    expect(derived).toHaveLength(1);
    expect(derived[0].id).toMatch(/^role_assignment_/);
    expect(derived[0]).toMatchObject({
      object: 'role_assignment',
      organization_membership_id: membership.id,
      source: { type: 'group', group_role_assignment_id: assignment.id },
    });
    expect(((await (await request(memberPath)).json()) as any).data[0].id).toBe(derived[0].id);
    expect(((await (await request(`${memberPath}?resource_id=${other.id}`)).json()) as any).data).toEqual([]);
    const resourcePath = `/authorization/organizations/${organization.id}/resources/repository/repo/role_assignments`;
    expect(((await (await request(resourcePath)).json()) as any).data[0]).toMatchObject({
      id: derived[0].id,
      source: { type: 'group' },
    });
    const resources = await request(
      `/authorization/organization_memberships/${membership.id}/resources?permission_slug=repository:read&parent_resource_type_slug=organization&parent_resource_external_id=${organization.id}`,
    );
    expect(((await resources.json()) as any).data.map((row: any) => row.id)).toEqual([resource.id]);
    await request(
      `/organizations/${organization.id}/groups/${group.id}/organization-memberships/${membership.id}`,
      'DELETE',
    );
    expect(await check()).toBe(false);
  });

  it('removes direct and group grants by role and resource criteria', async () => {
    const { membership, resource, path, check } = await setup();
    const memberPath = `/authorization/organization_memberships/${membership.id}/role_assignments`;
    const criteria = {
      role_slug: 'repository-reader',
      resource_type_slug: 'repository',
      resource_external_id: resource.external_id,
    };
    await create(memberPath, criteria);
    expect((await request(memberPath, 'DELETE', criteria)).status).toBe(204);
    expect(await check()).toBe(true);
    expect((await request(path, 'DELETE', criteria)).status).toBe(204);
    expect(await check()).toBe(false);
    // Group criteria removal is a 404 once nothing matches; the direct route stays a 204 no-op.
    expect((await request(path, 'DELETE', criteria)).status).toBe(404);
    expect((await request(memberPath, 'DELETE', criteria)).status).toBe(204);
    // An unknown role slug is a 404 on both routes.
    const unknownRole = { ...criteria, role_slug: 'missing-role' };
    expect((await request(path, 'DELETE', unknownRole)).status).toBe(404);
    expect((await request(memberPath, 'DELETE', unknownRole)).status).toBe(404);
  });

  it('removes only the shadowing organization role grant, leaving the environment role grant', async () => {
    const { organization, membership, role, resource, check } = await setup();
    const memberPath = `/authorization/organization_memberships/${membership.id}/role_assignments`;
    const criteria = { role_slug: role.slug, resource_id: resource.id };
    // Grant the environment role before an organization role takes the slug: from then on
    // the slug resolves to the organization role, so the second grant lands on that one.
    const envGrant = await create(memberPath, criteria);
    expect(envGrant.role_id).toBe(role.id);
    const orgRole = await create(`/authorization/organizations/${organization.id}/roles`, {
      slug: role.slug,
      name: 'Organization reader',
      resource_type_slug: 'repository',
    });
    const orgGrant = await create(memberPath, criteria);
    expect(orgGrant.role_id).toBe(orgRole.id);

    // Removal by criteria resolves the slug the same way, so only the organization role's
    // grant goes; the environment role's grant, and the permissions it carries, stay.
    expect((await request(memberPath, 'DELETE', criteria)).status).toBe(204);
    const remaining = (await (await request(`${memberPath}?resource_id=${resource.id}`)).json()) as any;
    const direct = remaining.data.filter((assignment: any) => assignment.source.type === 'direct');
    expect(direct.map((assignment: any) => assignment.id)).toEqual([envGrant.id]);
    expect(direct[0].role_id).toBe(role.id);
    expect(await check()).toBe(true);
  });

  it('rejects a duplicate group grant with the spec error code', async () => {
    const { role, resource, path } = await setup();
    const duplicate = await request(path, 'POST', { role_slug: role.slug, resource_id: resource.id });
    expect(duplicate.status).toBe(409);
    expect(((await duplicate.json()) as any).code).toBe('duplicate_group_role_assignment');
  });

  it('mints gra_ ids and grants on the organization resource when no resource is named', async () => {
    const { organization, role, group, path, assignment, check } = await setup();
    expect(assignment.id).toMatch(/^gra_/);
    const rootGrant = await create(path, { role_slug: role.slug });
    expect(rootGrant.resource).toEqual({
      id: expect.stringMatching(/^authz_resource_/),
      external_id: organization.id,
      resource_type_slug: 'organization',
    });
    expect(rootGrant).toMatchObject({ object: 'group_role_assignment', group_id: group.id });
    // The organization resource is an ancestor of every resource in the organization.
    const other = await create('/authorization/resources', {
      organization_id: organization.id,
      resource_type_slug: 'repository',
      external_id: 'other',
      name: 'Other',
    });
    expect(await check(other.id)).toBe(true);
    expect((await request(path, 'DELETE', { role_slug: role.slug })).status).toBe(204);
    expect(await check(other.id)).toBe(false);
    expect((await request(`${path}/${rootGrant.id}`)).status).toBe(404);
  });

  it('deleting a group removes its grants and revokes access', async () => {
    const { organization, group, path, assignment, check } = await setup();
    expect((await request(`/organizations/${organization.id}/groups/${group.id}`, 'DELETE')).status).toBe(204);
    expect(await check()).toBe(false);
    expect((await request(`${path}/${assignment.id}`)).status).toBe(404);
  });

  it('updates resources through SDK PATCH paths by ID and external ID, including null descriptions', async () => {
    const { organization, resource } = await setup();
    const first = await request(`/authorization/resources/${resource.id}`, 'PATCH', {
      name: 'Renamed',
      description: null,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ name: 'Renamed', description: null });
    const path = `/authorization/organizations/${organization.id}/resources/repository/repo`;
    const second = await request(path, 'PATCH', { description: 'Current description' });
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ id: resource.id, name: 'Renamed', description: 'Current description' });
  });
});
