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
        domain_data: [{ domain: 'delete.com', state: 'pending' }],
      }),
    });
    const org = await json(createRes);
    const group = await json(
      await req(`/organizations/${org.id}/groups`, { method: 'POST', body: JSON.stringify({ name: 'Readers' }) }),
    );
    await req('/authorization/roles', { method: 'POST', body: JSON.stringify({ slug: 'reader', name: 'Reader' }) });
    const resource = await json(
      await req('/authorization/resources', {
        method: 'POST',
        body: JSON.stringify({
          organization_id: org.id,
          resource_type_slug: 'repository',
          external_id: 'repo',
          name: 'Repository',
        }),
      }),
    );
    const assignmentsPath = `/authorization/groups/${group.id}/role_assignments`;
    for (const resource_id of [resource.id, null]) {
      const assignmentRes = await req(assignmentsPath, {
        method: 'POST',
        body: JSON.stringify({ role_slug: 'reader', resource_id }),
      });
      expect(assignmentRes.status).toBe(201);
    }

    const delRes = await req(`/organizations/${org.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const getRes = await req(`/organizations/${org.id}`);
    expect(getRes.status).toBe(404);
    expect((await req(assignmentsPath)).status).toBe(404);
    expect(getWorkOSStore(store).groupRoleAssignments.findBy('group_id', group.id)).toEqual([]);
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

  describe('domain_data', () => {
    const create = (body: Record<string, unknown>) =>
      req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Acme Corp', ...body }) });
    const eventsOf = async (name: string): Promise<any[]> => (await json(await req(`/events?events[]=${name}`))).data;

    it('requires a state on every entry', async () => {
      const res = await create({ domain_data: [{ domain: 'acme.com' }] });
      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        message: 'Validation failed',
        errors: [{ field: 'domain_data.0.state', code: 'state should not be empty' }],
      });
    });

    it('accepts only pending and verified as a state', async () => {
      const res = await create({ domain_data: [{ domain: 'acme.com', state: 'legacy_verified' }] });
      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        message: 'Validation failed',
        errors: [
          { field: 'domain_data.0.state', code: 'state must be one of the following values: pending, verified' },
        ],
      });
    });

    it('rejects a malformed domain, naming its index', async () => {
      const res = await create({
        domain_data: [
          { domain: 'acme.com', state: 'verified' },
          { domain: 'not-a-domain', state: 'verified' },
        ],
      });
      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        message: 'Validation failed',
        errors: [{ field: 'domain_data.1.domain', code: 'domain must be valid domain name' }],
      });
    });

    it('rejects a non-ASCII domain, as production does without allowUnicode, and takes its punycode form', async () => {
      const unicode = await create({ domain_data: [{ domain: 'bücher.de', state: 'verified' }] });
      expect(unicode.status).toBe(422);
      expect(await json(unicode)).toEqual({
        message: 'Validation failed',
        errors: [{ field: 'domain_data.0.domain', code: 'domain must be valid domain name' }],
      });

      const punycode = await create({ domain_data: [{ domain: 'xn--bcher-kva.de', state: 'verified' }] });
      expect(punycode.status).toBe(201);
      expect((await json(punycode)).domains[0].domain).toBe('xn--bcher-kva.de');
    });

    it('rejects the same domain listed twice, in any casing', async () => {
      const res = await create({
        domain_data: [
          { domain: 'company.com', state: 'verified' },
          { domain: 'cOmPaNy.CoM', state: 'verified' },
        ],
      });
      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        error: 'Unprocessable Entity',
        message: '`domain_data` must contain unique domains',
      });
    });

    it('rejects a public consumer domain before the organization is written', async () => {
      const res = await create({ domain_data: [{ domain: 'icloud.com', state: 'verified' }] });
      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        error: 'Unprocessable Entity',
        message: 'The domain icloud.com is a public consumer domain and cannot be attached to an organization.',
      });
      expect((await json(await req('/organizations'))).data).toHaveLength(0);
      expect(await eventsOf('organization.created')).toHaveLength(0);
    });

    it('stores domains lowercased: verified under the manual strategy, pending with no verification fields', async () => {
      const org = await json(
        await create({
          domain_data: [
            { domain: 'Acme.COM', state: 'verified' },
            { domain: 'acme.dev', state: 'pending' },
          ],
        }),
      );
      expect(org.domains.map((d: any) => d.domain)).toEqual(['acme.com', 'acme.dev']);
      expect(org.domains[0]).toMatchObject({ state: 'verified', verification_strategy: 'manual' });
      expect(org.domains[0]).not.toHaveProperty('verification_token');
      expect(org.domains[0]).not.toHaveProperty('verification_prefix');
      expect(org.domains[1].state).toBe('pending');
      expect(org.domains[1]).not.toHaveProperty('verification_strategy');
      expect(org.domains[1]).not.toHaveProperty('verification_token');
    });

    describe('on update', () => {
      const put = (id: string, body: Record<string, unknown>) =>
        req(`/organizations/${id}`, { method: 'PUT', body: JSON.stringify(body) });

      it('recreates a domain resent with a different state under a new id', async () => {
        const org = await json(await create({ domain_data: [{ domain: 'acme.com', state: 'pending' }] }));
        const [pending] = org.domains;

        const res = await put(org.id, { domain_data: [{ domain: 'acme.com', state: 'verified' }] });
        expect(res.status).toBe(200);
        const { domains } = await json(res);
        expect(domains).toHaveLength(1);
        expect(domains[0]).toMatchObject({ domain: 'acme.com', state: 'verified', verification_strategy: 'manual' });
        expect(domains[0].id).not.toBe(pending.id);
        expect((await req(`/organization_domains/${pending.id}`)).status).toBe(404);
        expect((await eventsOf('organization_domain.deleted')).map((e) => e.data.id)).toEqual([pending.id]);
        expect((await eventsOf('organization_domain.created')).map((e) => e.data.id).sort()).toEqual(
          [pending.id, domains[0].id].sort(),
        );
      });

      it('keeps a domain resent unchanged, token and all, and clears the rest', async () => {
        const org = await json(
          await create({
            domain_data: [
              { domain: 'acme.com', state: 'pending' },
              { domain: 'old.com', state: 'verified' },
            ],
          }),
        );
        const started = await json(await req(`/organization_domains/${org.domains[0].id}/verify`, { method: 'POST' }));

        const updated = await json(
          await put(org.id, {
            name: 'Acme Inc',
            domain_data: [
              { domain: 'ACME.com', state: 'pending' },
              { domain: 'acme.dev', state: 'verified' },
            ],
          }),
        );
        expect(updated.name).toBe('Acme Inc');
        expect(updated.domains.map((d: any) => d.domain)).toEqual(['acme.com', 'acme.dev']);
        expect(updated.domains[0]).toMatchObject({
          id: started.id,
          verification_strategy: 'dns',
          verification_token: started.verification_token,
        });
        expect(updated.domains[1]).toMatchObject({ state: 'verified', verification_strategy: 'manual' });

        const cleared = await json(await put(org.id, { domain_data: [] }));
        expect(cleared.domains).toEqual([]);
      });

      it('reports domain changes through domain events, with organization.updated only for a field change', async () => {
        const org = await json(await create({ domain_data: [{ domain: 'acme.com', state: 'pending' }] }));

        // A domain-only update writes no organization row, so production emits no organization.updated.
        const domainsOnly = await json(await put(org.id, { domain_data: [{ domain: 'acme.dev', state: 'verified' }] }));
        expect(domainsOnly.domains.map((d: any) => d.domain)).toEqual(['acme.dev']);
        expect(domainsOnly.updated_at).toBe(org.updated_at);
        expect(await eventsOf('organization.updated')).toHaveLength(0);
        expect((await eventsOf('organization_domain.deleted')).map((e) => e.data.domain)).toEqual(['acme.com']);

        // A field change emits organization.updated from the organization write, which production
        // performs before the domain writes: the event carries the domains as they were, the
        // response the domains as they are.
        const renamed = await json(
          await put(org.id, { name: 'Acme Inc', domain_data: [{ domain: 'acme.io', state: 'verified' }] }),
        );
        expect(renamed.name).toBe('Acme Inc');
        expect(renamed.domains.map((d: any) => d.domain)).toEqual(['acme.io']);
        const updatedEvents = await eventsOf('organization.updated');
        expect(updatedEvents).toHaveLength(1);
        expect(updatedEvents[0].data.name).toBe('Acme Inc');
        expect(updatedEvents[0].data.domains.map((d: any) => d.domain)).toEqual(['acme.dev']);
      });

      it('applies the same validation and consumer-domain rules before the organization is written', async () => {
        const org = await json(await create({}));

        const duplicate = await put(org.id, {
          domain_data: [
            { domain: 'domain.com', state: 'verified' },
            { domain: 'domain.com', state: 'verified' },
          ],
        });
        expect(duplicate.status).toBe(422);
        expect(await json(duplicate)).toEqual({
          error: 'Unprocessable Entity',
          message: '`domain_data` must contain unique domains',
        });

        const consumer = await put(org.id, {
          name: 'Renamed',
          domain_data: [{ domain: 'icloud.com', state: 'verified' }],
        });
        expect(consumer.status).toBe(422);
        expect(await json(consumer)).toEqual({
          error: 'Unprocessable Entity',
          message: 'The domain icloud.com is a public consumer domain and cannot be attached to an organization.',
        });
        expect((await json(await req(`/organizations/${org.id}`))).name).toBe('Acme Corp');
        expect(await eventsOf('organization.updated')).toHaveLength(0);

        const missingState = await put(org.id, { domain_data: [{ domain: 'domain.com' }] });
        expect(missingState.status).toBe(422);
        expect(await json(missingState)).toEqual({
          message: 'Validation failed',
          errors: [{ field: 'domain_data.0.state', code: 'state should not be empty' }],
        });
      });
    });
  });

  describe('external_id', () => {
    const create = (body: Record<string, unknown>) =>
      req('/organizations', { method: 'POST', body: JSON.stringify(body) });
    const put = (id: string, body: Record<string, unknown>) =>
      req(`/organizations/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    const alreadyUsed = {
      message: 'The external_id provided has already been assigned to another organization.',
      code: 'external_id_already_used',
    };

    it("refuses a create that reuses another organization's external_id", async () => {
      await create({ name: 'First', external_id: 'ext_1' });
      const res = await create({ name: 'Second', external_id: 'ext_1' });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual(alreadyUsed);
      expect((await json(await req('/organizations'))).data).toHaveLength(1);
    });

    it("refuses an update that reuses another organization's external_id, but accepts its own", async () => {
      const first = await json(await create({ name: 'First', external_id: 'ext_1' }));
      const second = await json(await create({ name: 'Second', external_id: 'ext_2' }));

      const clash = await put(second.id, { external_id: 'ext_1' });
      expect(clash.status).toBe(400);
      expect(await json(clash)).toEqual(alreadyUsed);
      expect((await json(await req(`/organizations/${second.id}`))).external_id).toBe('ext_2');

      const own = await put(first.id, { external_id: 'ext_1' });
      expect(own.status).toBe(200);

      // Clearing it frees the value for another organization.
      expect((await json(await put(first.id, { external_id: null }))).external_id).toBeNull();
      expect((await put(second.id, { external_id: 'ext_1' })).status).toBe(200);
    });
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
