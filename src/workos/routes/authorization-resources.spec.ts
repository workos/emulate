import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';

const apiKeys: ApiKeyMap = { sk_test_res: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_res', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Authorization resource routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
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

  it('creates a resource', async () => {
    const org = await createOrg('Res Org');
    const res = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'document',
        external_id: 'doc-123',
        organization_id: org.id,
        name: 'doc-123',
      }),
    });
    expect(res.status).toBe(201);
    const resource = await json(res);
    expect(resource.object).toBe('authorization_resource');
    expect(resource.resource_type_slug).toBe('document');
    expect(resource.external_id).toBe('doc-123');
    expect(resource.organization_id).toBe(org.id);
    expect(resource.id).toMatch(/^auth_res_/);
  });

  it('rejects missing required fields', async () => {
    const res = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'document' }),
    });
    expect(res.status).toBe(422);
  });

  it('lists resources', async () => {
    const org = await createOrg('List Org');
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: '1', organization_id: org.id, name: '1' }),
    });
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: '2', organization_id: org.id, name: '2' }),
    });

    const res = await req('/authorization/resources');
    const body = await json(res);
    expect(body.object).toBe('list');
    expect(body.data.length).toBe(2);
  });

  it('filters resources by organization_id', async () => {
    const org1 = await createOrg('Filter Org1');
    const org2 = await createOrg('Filter Org2');
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: '1', organization_id: org1.id, name: '1' }),
    });
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: '2', organization_id: org2.id, name: '2' }),
    });

    const res = await req(`/authorization/resources?organization_id=${org1.id}`);
    const body = await json(res);
    expect(body.data.length).toBe(1);
    expect(body.data[0].organization_id).toBe(org1.id);
  });

  it('gets a resource by id', async () => {
    const org = await createOrg('Get Org');
    const createRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'get1', organization_id: org.id, name: 'get1' }),
    });
    const resource = await json(createRes);

    const res = await req(`/authorization/resources/${resource.id}`);
    expect(res.status).toBe(200);
    const fetched = await json(res);
    expect(fetched.id).toBe(resource.id);
  });

  it('updates a resource', async () => {
    const org = await createOrg('Upd Org');
    const createRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'upd1', organization_id: org.id, name: 'upd1' }),
    });
    const resource = await json(createRes);

    const res = await req(`/authorization/resources/${resource.id}`, {
      method: 'PUT',
      body: JSON.stringify({ metadata: { key: 'value' } }),
    });
    expect(res.status).toBe(200);
    const updated = await json(res);
    expect(updated.metadata).toEqual({ key: 'value' });
  });

  it('deletes a resource', async () => {
    const org = await createOrg('Del Org');
    const createRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'del1', organization_id: org.id, name: 'del1' }),
    });
    const resource = await json(createRes);

    const res = await req(`/authorization/resources/${resource.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);

    const getRes = await req(`/authorization/resources/${resource.id}`);
    expect(getRes.status).toBe(404);
  });

  it('gets resource by type + external_id within org', async () => {
    const org = await createOrg('TypeExt Org');
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'project',
        external_id: 'proj-42',
        organization_id: org.id,
        name: 'proj-42',
      }),
    });

    const res = await req(`/authorization/organizations/${org.id}/resources/project/proj-42`);
    expect(res.status).toBe(200);
    const resource = await json(res);
    expect(resource.resource_type_slug).toBe('project');
    expect(resource.external_id).toBe('proj-42');
  });

  it('returns the production shape keys with null defaults', async () => {
    const org = await createOrg('Shape Org');
    const res = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'doc',
        external_id: 'shape-1',
        organization_id: org.id,
        name: 'shape-1',
      }),
    });
    const resource = await json(res);
    expect(resource.name).toBe('shape-1');
    expect(resource.description).toBeNull();
    expect(resource.parent_resource_id).toBeNull();
  });

  it('requires name when creating a resource', async () => {
    const org = await createOrg('NoName Org');
    const res = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'no-name', organization_id: org.id }),
    });
    expect(res.status).toBe(422);
    const error = await json(res);
    expect(error.errors).toEqual([{ field: 'name', code: 'required' }]);
  });

  it('persists name and description', async () => {
    const org = await createOrg('Named Org');
    const res = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'workspace',
        external_id: 'ws-1',
        organization_id: org.id,
        name: 'Acme Workspace',
        description: 'Primary workspace',
      }),
    });
    expect(res.status).toBe(201);
    const resource = await json(res);
    expect(resource.name).toBe('Acme Workspace');
    expect(resource.description).toBe('Primary workspace');
  });

  it('returns 409 when the same external_id is created twice', async () => {
    const org = await createOrg('Dup Org');
    const body = JSON.stringify({
      resource_type_slug: 'doc',
      external_id: 'dup-1',
      organization_id: org.id,
      name: 'dup-1',
    });

    const first = await req('/authorization/resources', { method: 'POST', body });
    expect(first.status).toBe(201);

    const second = await req('/authorization/resources', { method: 'POST', body });
    expect(second.status).toBe(409);
    const error = await json(second);
    expect(error.code).toBe('authorization_resource_external_id_conflict');

    const list = await req(`/authorization/resources?organization_id=${org.id}`);
    expect((await json(list)).data.length).toBe(1);
  });

  it('allows the same external_id in another organization or resource type', async () => {
    const org1 = await createOrg('DupScope Org1');
    const org2 = await createOrg('DupScope Org2');

    const inOrg1 = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'doc',
        external_id: 'shared',
        organization_id: org1.id,
        name: 'shared',
      }),
    });
    expect(inOrg1.status).toBe(201);

    const inOrg2 = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'doc',
        external_id: 'shared',
        organization_id: org2.id,
        name: 'shared',
      }),
    });
    expect(inOrg2.status).toBe(201);

    const otherType = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'folder',
        external_id: 'shared',
        organization_id: org1.id,
        name: 'shared',
      }),
    });
    expect(otherType.status).toBe(201);
  });

  it('creates a nested resource via parent_resource_id', async () => {
    const org = await createOrg('Nest Org');
    const parentRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'workspace',
        external_id: 'ws-1',
        organization_id: org.id,
        name: 'ws-1',
      }),
    });
    const parent = await json(parentRes);

    const childRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'project',
        external_id: 'proj-1',
        organization_id: org.id,
        name: 'proj-1',
        parent_resource_id: parent.id,
      }),
    });
    expect(childRes.status).toBe(201);
    expect((await json(childRes)).parent_resource_id).toBe(parent.id);
  });

  it('creates a nested resource via parent external id + type slug', async () => {
    const org = await createOrg('NestExt Org');
    const parentRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'workspace',
        external_id: 'ws-2',
        organization_id: org.id,
        name: 'ws-2',
      }),
    });
    const parent = await json(parentRes);

    const childRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'project',
        external_id: 'proj-2',
        organization_id: org.id,
        name: 'proj-2',
        parent_resource_external_id: 'ws-2',
        parent_resource_type_slug: 'workspace',
      }),
    });
    expect(childRes.status).toBe(201);
    expect((await json(childRes)).parent_resource_id).toBe(parent.id);
  });

  it('returns 404 for an unknown parent and 422 for an incomplete parent pair', async () => {
    const org = await createOrg('NestErr Org');

    const unknownParent = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'project',
        external_id: 'proj-3',
        organization_id: org.id,
        name: 'proj-3',
        parent_resource_id: 'auth_res_nonexistent',
      }),
    });
    expect(unknownParent.status).toBe(404);

    const incompletePair = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'project',
        external_id: 'proj-3',
        organization_id: org.id,
        name: 'proj-3',
        parent_resource_external_id: 'ws-1',
      }),
    });
    expect(incompletePair.status).toBe(422);
  });

  it('updates name, description, and parent', async () => {
    const org = await createOrg('UpdFields Org');
    const parentRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'workspace',
        external_id: 'ws-3',
        organization_id: org.id,
        name: 'ws-3',
      }),
    });
    const parent = await json(parentRes);
    const createRes = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'project',
        external_id: 'proj-4',
        organization_id: org.id,
        name: 'proj-4',
      }),
    });
    const resource = await json(createRes);

    const res = await req(`/authorization/resources/${resource.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Renamed', description: 'Now nested', parent_resource_id: parent.id }),
    });
    expect(res.status).toBe(200);
    const updated = await json(res);
    expect(updated.name).toBe('Renamed');
    expect(updated.description).toBe('Now nested');
    expect(updated.parent_resource_id).toBe(parent.id);

    // Detach again
    const detached = await json(
      await req(`/authorization/resources/${resource.id}`, {
        method: 'PUT',
        body: JSON.stringify({ parent_resource_id: null }),
      }),
    );
    expect(detached.parent_resource_id).toBeNull();
  });

  it('filters resources by external id and parent', async () => {
    const org = await createOrg('ListFilter Org');
    const parent = await json(
      await req('/authorization/resources', {
        method: 'POST',
        body: JSON.stringify({
          resource_type_slug: 'workspace',
          external_id: 'ws-4',
          organization_id: org.id,
          name: 'ws-4',
        }),
      }),
    );
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'project',
        external_id: 'proj-5',
        organization_id: org.id,
        name: 'proj-5',
        parent_resource_id: parent.id,
      }),
    });
    await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({
        resource_type_slug: 'project',
        external_id: 'proj-6',
        organization_id: org.id,
        name: 'proj-6',
      }),
    });

    const byExternalId = await json(await req('/authorization/resources?resource_external_id=proj-5'));
    expect(byExternalId.data.map((r: any) => r.external_id)).toEqual(['proj-5']);

    const byParentId = await json(await req(`/authorization/resources?parent_resource_id=${parent.id}`));
    expect(byParentId.data.map((r: any) => r.external_id)).toEqual(['proj-5']);

    const byParentExternal = await json(
      await req('/authorization/resources?parent_resource_type_slug=workspace&parent_external_id=ws-4'),
    );
    expect(byParentExternal.data.map((r: any) => r.external_id)).toEqual(['proj-5']);
  });

  it('lists memberships for a resource', async () => {
    const org = await createOrg('Mem Org');
    // Create a user and membership
    const userRes = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'member@test.com' }),
    });
    const user = await json(userRes);
    await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: org.id, user_id: user.id }),
    });

    // Create resource
    const resCreate = await req('/authorization/resources', {
      method: 'POST',
      body: JSON.stringify({ resource_type_slug: 'doc', external_id: 'mem1', organization_id: org.id, name: 'mem1' }),
    });
    const resource = await json(resCreate);

    const res = await req(`/authorization/resources/${resource.id}/organization_memberships`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data.length).toBe(1);
    expect(body.data[0].user_id).toBe(user.id);
  });
});
