import { beforeEach, describe, expect, it } from 'bun:test';
import { createServer } from '../../core/index.js';
import { seedFromConfig, workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';

const headers = { Authorization: 'Bearer sk_test_default', 'Content-Type': 'application/json' };

describe('Implicit organization resources', () => {
  let server: ReturnType<typeof createServer>;
  beforeEach(() => {
    server = createServer(workosPlugin);
  });
  const req = (path: string, init?: RequestInit) => server.app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;
  const createOrg = async (externalId?: string) =>
    json(
      await req('/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: 'Example', external_id: externalId }),
      }),
    );
  const rootPath = (org: any, externalId = org.external_id ?? org.id) =>
    `/authorization/organizations/${org.id}/resources/organization/${externalId}`;

  it('uses the configured external ID and defaults children to that root', async () => {
    const org = await createOrg('customer-1');
    const res = await req(rootPath(org));
    expect(res.status).toBe(200);
    const root = await json(res);
    expect(root.external_id).toBe('customer-1');
    expect(root.parent_resource_id).toBeNull();
    const child = await json(
      await req('/authorization/resources', {
        method: 'POST',
        body: JSON.stringify({
          organization_id: org.id,
          resource_type_slug: 'workspace',
          external_id: 'workspace-1',
          name: 'Workspace',
        }),
      }),
    );
    expect(child.parent_resource_id).toBe(root.id);
  });

  it('falls back to the organization ID when no external ID is configured', async () => {
    const org = await createOrg();
    expect((await req(rootPath(org))).status).toBe(200);
  });

  it('keeps root identity and child links when organization metadata changes', async () => {
    const org = await createOrg('before');
    const root = await json(await req(rootPath(org)));
    const child = await json(
      await req('/authorization/resources', {
        method: 'POST',
        body: JSON.stringify({
          organization_id: org.id,
          resource_type_slug: 'workspace',
          external_id: 'workspace-1',
          name: 'Workspace',
        }),
      }),
    );
    await req(`/organizations/${org.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Renamed', external_id: 'after' }),
    });
    expect((await req(rootPath(org))).status).toBe(404);
    const updated = await json(await req(rootPath(org, 'after')));
    expect(updated.id).toBe(root.id);
    expect(updated.name).toBe('Renamed');
    expect((await json(await req(`/authorization/resources/${child.id}`))).parent_resource_id).toBe(root.id);
    await req(`/organizations/${org.id}`, { method: 'PUT', body: JSON.stringify({ external_id: null }) });
    expect((await json(await req(rootPath(org, org.id)))).id).toBe(root.id);
  });

  it('keeps root grants addressable after changing or clearing the organization external ID', async () => {
    seedFromConfig(server.store, 'http://localhost', {
      users: [{ id: 'user_rename', email: 'rename@example.com' }],
      permissions: [{ slug: 'workspace:read', name: 'Read workspace' }],
      roles: [{ slug: 'reader', name: 'Reader', permissions: ['workspace:read'] }],
    });
    const org = await createOrg('before');
    const membership = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: 'user_rename' }),
      }),
    );
    const path = `/authorization/organization_memberships/${membership.id}/role_assignments`;
    const assigned = await req(path, {
      method: 'POST',
      body: JSON.stringify({ role_slug: 'reader', resource_type_slug: 'organization', resource_external_id: 'before' }),
    });
    expect(assigned.status).toBe(201);
    const grant = await json(assigned);
    for (const externalId of ['after', null]) {
      expect(
        (
          await req(`/organizations/${org.id}`, {
            method: 'PUT',
            body: JSON.stringify({ external_id: externalId }),
          })
        ).status,
      ).toBe(200);
      const listed = await json(await req(path));
      expect(listed.data).toHaveLength(1);
      expect(listed.data[0].id).toBe(grant.id);
      expect(listed.data[0].resource.id).toBe(grant.resource.id);
      expect(listed.data[0].resource.external_id).toBe(externalId ?? org.id);
      const check = await req(`/authorization/organization_memberships/${membership.id}/check`, {
        method: 'POST',
        body: JSON.stringify({
          resource_type_slug: listed.data[0].resource.resource_type_slug,
          resource_external_id: listed.data[0].resource.external_id,
          permission_slug: 'workspace:read',
        }),
      });
      expect(check.status).toBe(200);
      expect((await json(check)).authorized).toBe(true);
    }
  });

  it('creates roots for seeded organizations, including after resetting', async () => {
    const seed = { organizations: [{ id: 'org_seed', name: 'Seeded', external_id: 'seed-external' }] };
    seedFromConfig(server.store, 'http://localhost', seed);
    const path = '/authorization/organizations/org_seed/resources/organization/seed-external';
    expect((await req(path)).status).toBe(200);
    server.store.reset();
    seedFromConfig(server.store, 'http://localhost', seed);
    expect((await req(path)).status).toBe(200);
  });

  it('runs grant, check, discovery, and cleanup twice with the same external IDs', async () => {
    seedFromConfig(server.store, 'http://localhost', {
      users: [{ id: 'user_repeat', email: 'repeat@example.com' }],
      permissions: [{ slug: 'workspace:read', name: 'Read workspace', resource_type_slug: 'workspace' }],
      roles: [{ slug: 'reader', name: 'Reader', permissions: ['workspace:read'], resource_type_slug: 'workspace' }],
    });

    async function runCycle() {
      const org = await createOrg('repeat-customer');
      const root = await json(await req(rootPath(org)));
      const child = await json(
        await req('/authorization/resources', {
          method: 'POST',
          body: JSON.stringify({
            organization_id: org.id,
            resource_type_slug: 'workspace',
            external_id: 'repeat-workspace',
            name: 'Workspace',
          }),
        }),
      );
      expect(child.parent_resource_id).toBe(root.id);
      const membership = await json(
        await req('/user_management/organization_memberships', {
          method: 'POST',
          body: JSON.stringify({ organization_id: org.id, user_id: 'user_repeat' }),
        }),
      );
      const checkPath = `/authorization/organization_memberships/${membership.id}/check`;
      const checkInput = {
        method: 'POST',
        body: JSON.stringify({
          resource_type_slug: 'workspace',
          resource_external_id: 'repeat-workspace',
          permission_slug: 'workspace:read',
        }),
      };
      const discoveryPath = `/authorization/organization_memberships/${membership.id}/resources?permission_slug=workspace:read&parent_resource_type_slug=organization&parent_resource_external_id=repeat-customer`;
      const before = await req(checkPath, checkInput);
      expect(before.status).toBe(200);
      expect((await json(before)).authorized).toBe(false);
      expect((await json(await req(discoveryPath))).data).toEqual([]);
      const assigned = await req(`/authorization/organization_memberships/${membership.id}/role_assignments`, {
        method: 'POST',
        body: JSON.stringify({
          role_slug: 'reader',
          resource_type_slug: 'workspace',
          resource_external_id: 'repeat-workspace',
        }),
      });
      expect(assigned.status).toBe(201);
      expect((await json(await req(checkPath, checkInput))).authorized).toBe(true);
      const discovered = await req(discoveryPath);
      expect(discovered.status).toBe(200);
      expect((await json(discovered)).data.map((resource: any) => resource.id)).toEqual([child.id]);
      expect((await req(`/organizations/${org.id}`, { method: 'DELETE' })).status).toBe(204);
      expect((await req(rootPath(org))).status).toBe(404);
      return root.id;
    }

    const firstRoot = await runCycle();
    const secondRoot = await runCycle();
    expect(secondRoot).not.toBe(firstRoot);
  });

  it('removes membership-wide, root, and child grants on organization deletion but preserves other grants', async () => {
    seedFromConfig(server.store, 'http://localhost', {
      users: [{ id: 'user_cleanup', email: 'cleanup@example.com' }],
      roles: [{ slug: 'reader', name: 'Reader' }],
    });
    async function assignInOrganization(externalId: string) {
      const org = await createOrg(externalId);
      const child = await json(
        await req('/authorization/resources', {
          method: 'POST',
          body: JSON.stringify({
            organization_id: org.id,
            resource_type_slug: 'workspace',
            external_id: 'workspace',
            name: 'Workspace',
          }),
        }),
      );
      const membership = await json(
        await req('/user_management/organization_memberships', {
          method: 'POST',
          body: JSON.stringify({ organization_id: org.id, user_id: 'user_cleanup' }),
        }),
      );
      const assignmentPath = `/authorization/organization_memberships/${membership.id}/role_assignments`;
      const rootGrant = await req(assignmentPath, {
        method: 'POST',
        body: JSON.stringify({
          role_slug: 'reader',
          resource_type_slug: 'organization',
          resource_external_id: externalId,
        }),
      });
      const childGrant = await req(assignmentPath, {
        method: 'POST',
        body: JSON.stringify({ role_slug: 'reader', resource_id: child.id }),
      });
      const membershipGrant = await req(assignmentPath, {
        method: 'POST',
        body: JSON.stringify({ role_slug: 'reader' }),
      });
      expect(membershipGrant.status).toBe(201);
      expect(rootGrant.status).toBe(201);
      expect(childGrant.status).toBe(201);
      return {
        org,
        assignmentPath,
        grants: [(await json(rootGrant)).id, (await json(childGrant)).id, (await json(membershipGrant)).id],
      };
    }
    const removed = await assignInOrganization('removed');
    const retained = await assignInOrganization('retained');
    expect((await req(`/organizations/${removed.org.id}`, { method: 'DELETE' })).status).toBe(204);
    // Deleted memberships cannot be queried through the API; inspect storage to detect orphan grants.
    const assignments = getWorkOSStore(server.store).roleAssignments;
    expect(assignments.get(removed.grants[0])).toBeUndefined();
    expect(assignments.get(removed.grants[1])).toBeUndefined();
    expect(assignments.get(removed.grants[2])).toBeUndefined();
    const remaining = await req(retained.assignmentPath);
    expect(remaining.status).toBe(200);
    expect((await json(remaining)).data.map((grant: any) => grant.id).sort()).toEqual(retained.grants.sort());
  });

  it('rejects direct root creation, updates, and deletion', async () => {
    const org = await createOrg('protected');
    const root = await json(await req(rootPath(org)));
    const create = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        organization_id: org.id,
        resource_type_slug: 'organization',
        external_id: 'another-root',
        name: 'Root',
      }),
    });
    expect(create.status).toBe(400);
    expect(
      (await req(`/authorization/resources/${root.id}`, { method: 'PUT', body: JSON.stringify({ name: 'Changed' }) }))
        .status,
    ).toBe(400);
    expect((await req(`/authorization/resources/${root.id}?cascade_delete=true`, { method: 'DELETE' })).status).toBe(
      400,
    );
    expect((await req(rootPath(org))).status).toBe(200);
  });

  it('deletes organization resources without touching another organization', async () => {
    const org = await createOrg('first');
    const other = await createOrg('second');
    const child = await json(
      await req('/authorization/resources', {
        method: 'POST',
        body: JSON.stringify({
          organization_id: org.id,
          resource_type_slug: 'workspace',
          external_id: 'workspace-1',
          name: 'Workspace',
        }),
      }),
    );
    expect((await req(`/organizations/${org.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await req(rootPath(org))).status).toBe(404);
    expect((await req(`/authorization/resources/${child.id}`)).status).toBe(404);
    expect((await req(rootPath(other))).status).toBe(200);
  });
});
