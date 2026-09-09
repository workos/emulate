import { beforeEach, describe, expect, it } from 'bun:test';
import { createServer } from '../../core/index.js';
import { seedFromConfig, workosPlugin } from '../index.js';

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

  it('creates roots for seeded organizations, including after resetting', async () => {
    const seed = { organizations: [{ id: 'org_seed', name: 'Seeded', external_id: 'seed-external' }] };
    seedFromConfig(server.store, 'http://localhost', seed);
    const path = '/authorization/organizations/org_seed/resources/organization/seed-external';
    expect((await req(path)).status).toBe(200);
    server.store.reset();
    seedFromConfig(server.store, 'http://localhost', seed);
    expect((await req(path)).status).toBe(200);
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
