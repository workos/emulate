import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_org', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Organization routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
    store = result.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('creates an organization', async () => {
    const res = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Acme Corp', external_id: 'acme' }),
    });
    expect(res.status).toBe(201);
    const org = await json(res);
    expect(org.object).toBe('organization');
    expect(org.name).toBe('Acme Corp');
    expect(org.external_id).toBe('acme');
    expect(org.id).toMatch(/^org_/);
  });

  it('creates an org with domain_data', async () => {
    const res = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Acme Corp',
        domain_data: [{ domain: 'acme.com', state: 'verified' }],
      }),
    });
    const org = await json(res);
    expect(org.domains).toHaveLength(1);
    expect(org.domains[0].domain).toBe('acme.com');
    expect(org.domains[0].state).toBe('verified');
  });

  it('rejects empty name', async () => {
    const res = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.code).toBe('unprocessable_entity');
  });

  it('gets an organization by id', async () => {
    const createRes = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Get Test' }),
    });
    const created = await json(createRes);

    const res = await req(`/organizations/${created.id}`);
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe('Get Test');
  });

  it('gets org by external_id', async () => {
    await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ext Test', external_id: 'ext_123' }),
    });

    const res = await req('/organizations/external_id/ext_123');
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe('Ext Test');
  });

  it('returns 404 for nonexistent org', async () => {
    const res = await req('/organizations/org_nonexistent');
    expect(res.status).toBe(404);
  });

  it('updates an organization', async () => {
    const createRes = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Old Name' }),
    });
    const created = await json(createRes);

    const res = await req(`/organizations/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'New Name' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe('New Name');
  });

  it('deletes an org and cascades', async () => {
    const createRes = await req('/organizations', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Delete Test',
        domain_data: [{ domain: 'delete.com' }],
      }),
    });
    const org = await json(createRes);

    const delRes = await req(`/organizations/${org.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const getRes = await req(`/organizations/${org.id}`);
    expect(getRes.status).toBe(404);
  });

  it('filters organizations by search', async () => {
    for (const name of ['Acme Corp', 'Globex']) {
      await req('/organizations', { method: 'POST', body: JSON.stringify({ name }) });
    }

    const res = await req('/organizations?search=acme');
    expect(res.status).toBe(200);
    const list = await json(res);
    expect(list.data).toHaveLength(1);
    expect(list.data[0].name).toBe('Acme Corp');

    const miss = await req('/organizations?search=initech');
    expect((await json(miss)).data).toHaveLength(0);
  });

  it('lists with cursor pagination', async () => {
    for (let i = 1; i <= 5; i++) {
      await req('/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: `Org ${i}` }),
      });
    }

    const res = await req('/organizations?limit=2&order=asc');
    const list = await json(res);
    expect(list.object).toBe('list');
    expect(list.data).toHaveLength(2);
    expect(list.list_metadata.after).toBeDefined();

    const res2 = await req(`/organizations?limit=2&order=asc&after=${list.list_metadata.after}`);
    const list2 = await json(res2);
    expect(list2.data).toHaveLength(2);

    const ids1 = list.data.map((d: any) => d.id);
    const ids2 = list2.data.map((d: any) => d.id);
    expect(ids1.filter((id: string) => ids2.includes(id))).toHaveLength(0);
  });

  it('rejects unauthenticated request', async () => {
    const res = await app.request('/organizations', { method: 'GET' });
    expect(res.status).toBe(401);
  });

  describe('authorized applications', () => {
    async function createUser(email: string) {
      return json(
        await req('/user_management/users', {
          method: 'POST',
          body: JSON.stringify({ email }),
        }),
      );
    }

    function joinOrg(userId: string, orgId: string) {
      const ws = getWorkOSStore(store);
      ws.organizationMemberships.insert({
        object: 'organization_membership',
        organization_id: orgId,
        user_id: userId,
        role: { slug: 'member' },
        status: 'active',
        external_id: null,
        metadata: {},
      });
    }

    it('lists authorized applications granted by org members', async () => {
      const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) }));
      const member = await createUser('member@acme.com');
      joinOrg(member.id, org.id);

      const ws = getWorkOSStore(store);
      ws.authorizedApplications.insert({
        object: 'authorized_application',
        user_id: member.id,
        name: 'Member App',
        redirect_uri: 'http://localhost:3000/callback',
      });

      const res = await req(`/organizations/${org.id}/authorized_applications`);
      expect(res.status).toBe(200);
      const list = await json(res);
      expect(list.object).toBe('list');
      expect(list.data).toHaveLength(1);
      expect(list.data[0].name).toBe('Member App');
    });

    it('excludes authorized applications from non-members', async () => {
      const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) }));
      const outsider = await createUser('outsider@example.com');
      // No membership created for the outsider.

      const ws = getWorkOSStore(store);
      ws.authorizedApplications.insert({
        object: 'authorized_application',
        user_id: outsider.id,
        name: 'Outsider App',
        redirect_uri: 'http://localhost:3000/callback',
      });

      const res = await req(`/organizations/${org.id}/authorized_applications`);
      expect(res.status).toBe(200);
      expect((await json(res)).data).toHaveLength(0);
    });

    it('returns 404 for nonexistent org', async () => {
      const res = await req('/organizations/org_nonexistent/authorized_applications');
      expect(res.status).toBe(404);
    });
  });
});
