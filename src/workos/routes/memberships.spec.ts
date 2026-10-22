import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { formatMembership } from '../helpers.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';

const apiKeys: ApiKeyMap = { sk_test_mem: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_mem', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Membership routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  async function createOrg(name: string) {
    return json(
      await req('/organizations', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    );
  }

  async function createUser(email: string) {
    return json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    );
  }

  it('creates a membership', async () => {
    const org = await createOrg('Mem Org');
    const user = await createUser('member@test.com');

    const res = await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({
        organization_id: org.id,
        user_id: user.id,
        role_slug: 'admin',
      }),
    });
    expect(res.status).toBe(201);
    const m = await json(res);
    expect(m.object).toBe('organization_membership');
    expect(m.role.slug).toBe('admin');
    expect(m.status).toBe('active');
  });

  it('404s when creating a membership for an unknown user', async () => {
    const org = await createOrg('No User Org');
    const res = await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: org.id, user_id: 'user_does_not_exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('cascades user deletion to memberships (no orphan -> embedded user is never null)', async () => {
    const org = await createOrg('Cascade Org');
    const user = await createUser('cascade@test.com');
    const m = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id }),
      }),
    );

    await req(`/user_management/users/${user.id}`, { method: 'DELETE' });

    // Membership is gone, so no read can surface a null embedded user.
    const got = await req(`/user_management/organization_memberships/${m.id}`);
    expect(got.status).toBe(404);
  });

  it('returns the existing membership, unchanged, on a create over an active one', async () => {
    const org = await createOrg('Dup Org');
    const user = await createUser('dup@test.com');

    const first = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slug: 'admin' }),
      }),
    );

    const res = await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slug: 'member' }),
    });
    expect(res.status).toBe(201);
    const again = await json(res);
    expect(again.id).toBe(first.id);
    expect(again.role.slug).toBe('admin');
    const list = await json(await req(`/user_management/organization_memberships?organization_id=${org.id}`));
    expect(list.data).toHaveLength(1);
  });

  describe('create over an existing membership', () => {
    // The API reference: creating over an inactive membership activates it with the requested
    // role; over a pending one it is a 400, since the user has to accept the invitation instead.
    let store: ReturnType<typeof createTestApp>['store'];

    beforeEach(() => {
      ({ app, store } = createTestApp());
    });

    async function existing(status: 'inactive' | 'pending', roleSlug?: string) {
      const org = await createOrg('Existing Org');
      const user = await createUser(`${status}@existing.test`);
      const m = await json(
        await req('/user_management/organization_memberships', {
          method: 'POST',
          body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slug: roleSlug }),
        }),
      );
      getWorkOSStore(store).organizationMemberships.update(m.id, { status });
      return { orgId: org.id as string, userId: user.id as string, id: m.id as string };
    }

    const create = (orgId: string, userId: string, roleSlug?: string) =>
      req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: orgId, user_id: userId, role_slug: roleSlug }),
      });

    const membershipsOf = async (orgId: string) =>
      (
        await json(
          await req(
            `/user_management/organization_memberships?organization_id=${orgId}&statuses=active,inactive,pending`,
          ),
        )
      ).data;

    it('activates an inactive membership with the requested role, keeping its id', async () => {
      const { orgId, userId, id } = await existing('inactive');
      const res = await create(orgId, userId, 'admin');
      expect(res.status).toBe(201);
      const m = await json(res);
      expect(m.id).toBe(id);
      expect(m.status).toBe('active');
      expect(m.role.slug).toBe('admin');
      expect(await membershipsOf(orgId)).toHaveLength(1);
    });

    it('activates an inactive membership with the default role when none is requested', async () => {
      const { orgId, userId, id } = await existing('inactive', 'admin');
      const res = await create(orgId, userId);
      expect(res.status).toBe(201);
      const m = await json(res);
      expect(m.id).toBe(id);
      expect(m.role.slug).toBe('member');
    });

    it('refuses to create over a pending membership', async () => {
      const { orgId, userId } = await existing('pending');
      const res = await create(orgId, userId);
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('cannot_reactivate_pending_organization_membership');
      const memberships = await membershipsOf(orgId);
      expect(memberships).toHaveLength(1);
      expect(memberships[0].status).toBe('pending');
    });
  });

  it('lists memberships filtered by org', async () => {
    const org = await createOrg('List Org');
    const u1 = await createUser('m1@test.com');
    const u2 = await createUser('m2@test.com');

    await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: org.id, user_id: u1.id }),
    });
    await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: org.id, user_id: u2.id }),
    });

    const list = await json(await req(`/user_management/organization_memberships?organization_id=${org.id}`));
    expect(list.data).toHaveLength(2);
  });

  describe('list statuses filter', () => {
    async function seedActiveAndInactive() {
      const org = await createOrg('Statuses Org');
      const ids: Record<string, string> = {};
      for (const name of ['active', 'inactive']) {
        const user = await createUser(`${name}@statuses.test`);
        const m = await json(
          await req('/user_management/organization_memberships', {
            method: 'POST',
            body: JSON.stringify({ organization_id: org.id, user_id: user.id }),
          }),
        );
        ids[name] = m.id;
      }
      await req(`/user_management/organization_memberships/${ids.inactive}/deactivate`, { method: 'PUT' });
      return org.id as string;
    }

    // Each row was checked against the real WorkOS API.
    it.each([
      ['', ['active']],
      ['statuses=active', ['active']],
      ['statuses[]=active', ['active']],
      ['statuses%5B%5D=active', ['active']],
      ['statuses=inactive', ['inactive']],
      ['statuses=active&statuses=inactive', ['active', 'inactive']],
      ['statuses[]=active&statuses[]=inactive', ['active', 'inactive']],
      ['statuses=active,inactive', ['active', 'inactive']],
    ])('?%s returns %p', async (query, expected) => {
      const orgId = await seedActiveAndInactive();
      const list = await json(await req(`/user_management/organization_memberships?organization_id=${orgId}&${query}`));
      expect(list.data.map((m: { status: string }) => m.status).sort()).toEqual(expected);
    });
  });

  it('deactivates and reactivates a membership', async () => {
    const org = await createOrg('Toggle Org');
    const user = await createUser('toggle@test.com');

    const m = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id }),
      }),
    );

    const deactivated = await json(
      await req(`/user_management/organization_memberships/${m.id}/deactivate`, { method: 'PUT' }),
    );
    expect(deactivated.status).toBe('inactive');

    const reactivated = await json(
      await req(`/user_management/organization_memberships/${m.id}/reactivate`, { method: 'PUT' }),
    );
    expect(reactivated.status).toBe('active');
  });

  describe('deactivate and reactivate by status', () => {
    // The API reference: deactivating an inactive membership and reactivating an active one are
    // no-ops that emit no event; either on a pending membership is a 400.
    let store: ReturnType<typeof createTestApp>['store'];

    beforeEach(() => {
      ({ app, store } = createTestApp());
    });

    async function membershipWithStatus(status: 'active' | 'inactive' | 'pending') {
      const org = await createOrg('Lifecycle Org');
      const user = await createUser(`${status}@lifecycle.test`);
      const m = await json(
        await req('/user_management/organization_memberships', {
          method: 'POST',
          body: JSON.stringify({ organization_id: org.id, user_id: user.id }),
        }),
      );
      if (status !== 'active') getWorkOSStore(store).organizationMemberships.update(m.id, { status });
      return m.id as string;
    }

    const updatedEvents = async () =>
      (await json(await req('/events?events[]=organization_membership.updated'))).data.length as number;

    it('refuses to deactivate a pending membership', async () => {
      const id = await membershipWithStatus('pending');
      const res = await req(`/user_management/organization_memberships/${id}/deactivate`, { method: 'PUT' });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('cannot_deactivate_pending_organization_membership');
      expect((await json(await req(`/user_management/organization_memberships/${id}`))).status).toBe('pending');
    });

    it('treats deactivating an inactive membership as a no-op', async () => {
      const id = await membershipWithStatus('inactive');
      const before = await updatedEvents();
      const res = await req(`/user_management/organization_memberships/${id}/deactivate`, { method: 'PUT' });
      expect(res.status).toBe(200);
      expect((await json(res)).status).toBe('inactive');
      expect(await updatedEvents()).toBe(before);
    });

    it('refuses to reactivate a pending membership', async () => {
      const id = await membershipWithStatus('pending');
      const res = await req(`/user_management/organization_memberships/${id}/reactivate`, { method: 'PUT' });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('cannot_reactivate_pending_organization_membership');
      expect((await json(await req(`/user_management/organization_memberships/${id}`))).status).toBe('pending');
    });

    it('treats reactivating an active membership as a no-op', async () => {
      const id = await membershipWithStatus('active');
      const before = await updatedEvents();
      const res = await req(`/user_management/organization_memberships/${id}/reactivate`, { method: 'PUT' });
      expect(res.status).toBe(200);
      expect((await json(res)).status).toBe('active');
      expect(await updatedEvents()).toBe(before);
    });
  });

  it('serializes directory_managed, roles, and the embedded user (WorkOS SDK contract)', async () => {
    const org = await createOrg('Contract Org');
    const user = await createUser('contract@test.com');

    const m = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slug: 'admin' }),
      }),
    );

    // Fields real WorkOS always returns; required by strict SDK deserializers.
    expect(m.directory_managed).toBe(false);
    expect(m.custom_attributes).toEqual({});
    expect(m.roles).toEqual([{ slug: 'admin' }]);
    expect(m.user).toMatchObject({ object: 'user', id: user.id, email: 'contract@test.com' });
    // The embedded user must be the full SDK User shape (every key present).
    for (const k of [
      'object',
      'id',
      'email',
      'email_verified',
      'first_name',
      'last_name',
      'profile_picture_url',
      'last_sign_in_at',
      'created_at',
      'updated_at',
    ]) {
      expect(m.user).toHaveProperty(k);
    }
  });

  it('includes the SDK-contract fields on GET and list responses', async () => {
    const org = await createOrg('GetList Org');
    const user = await createUser('getlist@test.com');
    const created = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id }),
      }),
    );

    const got = await json(await req(`/user_management/organization_memberships/${created.id}`));
    expect(got.directory_managed).toBe(false);
    expect(got.user.id).toBe(user.id);

    const list = await json(await req(`/user_management/organization_memberships?organization_id=${org.id}`));
    expect(list.data[0].directory_managed).toBe(false);
    expect(list.data[0].user.id).toBe(user.id);
  });

  it('creates a membership holding several roles', async () => {
    const org = await createOrg('Multi Role Org');
    const user = await createUser('multi@test.com');

    const res = await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slugs: ['admin', 'guardian-analyst'] }),
    });
    expect(res.status).toBe(201);
    const m = await json(res);
    expect(m.role).toEqual({ slug: 'admin' });
    expect(m.roles).toEqual([{ slug: 'admin' }, { slug: 'guardian-analyst' }]);
  });

  it('replaces the whole role set on update, by role_slugs or a single role_slug', async () => {
    const org = await createOrg('Role Set Org');
    const user = await createUser('roleset@test.com');
    const created = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id }),
      }),
    );

    const widened = await json(
      await req(`/user_management/organization_memberships/${created.id}`, {
        method: 'PUT',
        body: JSON.stringify({ role_slugs: ['member', 'guardian-analyst', 'guardian-analyst'] }),
      }),
    );
    expect(widened.role).toEqual({ slug: 'member' });
    expect(widened.roles).toEqual([{ slug: 'member' }, { slug: 'guardian-analyst' }]);

    const read = await json(await req(`/user_management/organization_memberships/${created.id}`));
    expect(read.roles).toEqual([{ slug: 'member' }, { slug: 'guardian-analyst' }]);

    const narrowed = await json(
      await req(`/user_management/organization_memberships/${created.id}`, {
        method: 'PUT',
        body: JSON.stringify({ role_slug: 'admin' }),
      }),
    );
    expect(narrowed.role).toEqual({ slug: 'admin' });
    expect(narrowed.roles).toEqual([{ slug: 'admin' }]);
  });

  it('orders roles by role priority, read when the membership is, with the primary first', async () => {
    const org = await createOrg('Priority Org');
    const user = await createUser('priority@test.com');
    for (const slug of ['org-editor', 'org-viewer']) {
      await req(`/authorization/organizations/${org.id}/roles`, {
        method: 'POST',
        body: JSON.stringify({ slug, name: slug }),
      });
    }
    const prioritize = (role_priority_order: string[]) =>
      req(`/authorization/organizations/${org.id}/roles/priority`, {
        method: 'PUT',
        body: JSON.stringify({ role_priority_order }),
      });
    await prioritize(['org-viewer', 'org-editor']);

    const created = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slugs: ['org-editor', 'org-viewer'] }),
      }),
    );
    expect(created.role).toEqual({ slug: 'org-viewer' });
    expect(created.roles).toEqual([{ slug: 'org-viewer' }, { slug: 'org-editor' }]);

    // Production resolves the priority when it serializes, not when the roles were written.
    await prioritize(['org-editor', 'org-viewer']);
    const read = await json(await req(`/user_management/organization_memberships/${created.id}`));
    expect(read.role).toEqual({ slug: 'org-editor' });
    expect(read.roles).toEqual([{ slug: 'org-editor' }, { slug: 'org-viewer' }]);
  });

  it('carries role and roles on organization_membership events, without the user', async () => {
    const org = await createOrg('Event Org');
    const user = await createUser('event@test.com');
    const m = await json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slugs: ['admin', 'guardian-analyst'] }),
      }),
    );

    const events = await json(await req('/events?events[]=organization_membership.created'));
    const event = events.data.find((e: any) => e.data.id === m.id);
    expect(event.data.role).toEqual({ slug: 'admin' });
    expect(event.data.roles).toEqual([{ slug: 'admin' }, { slug: 'guardian-analyst' }]);
    expect(event.data.user).toBeUndefined();
  });

  it('rejects role_slug sent alongside role_slugs', async () => {
    const org = await createOrg('Both Keys Org');
    const user = await createUser('bothkeys@test.com');
    const res = await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slug: 'admin', role_slugs: ['admin'] }),
    });
    expect(res.status).toBe(422);
    expect((await json(res)).message).toBe('The role_slug parameter cannot be used when role_slugs is provided.');
  });

  it('rejects an empty or malformed role_slugs', async () => {
    const org = await createOrg('Bad Roles Org');
    const user = await createUser('badroles@test.com');
    for (const role_slugs of [[], ['admin', 7], 'admin']) {
      const res = await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: org.id, user_id: user.id, role_slugs }),
      });
      expect(res.status).toBe(422);
    }
  });
});

describe('formatMembership invariant', () => {
  it('throws loudly on a dangling user reference instead of emitting user: null', () => {
    // Every insertion path validates the user and deletion cascades memberships, so a
    // miss is an emulator bug — a silent `user: null` would reproduce the strict-SDK
    // deserialization failure the serializer exists to prevent.
    const ws = { users: { get: () => undefined } } as unknown as WorkOSStore;
    const dangling = {
      object: 'organization_membership',
      id: 'om_dangling',
      organization_id: 'org_x',
      user_id: 'user_missing',
      role: { slug: 'member' },
      status: 'active',
      external_id: null,
      metadata: {},
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    expect(() => formatMembership(dangling as never, ws)).toThrow(/No user 'user_missing'/);
  });
});
