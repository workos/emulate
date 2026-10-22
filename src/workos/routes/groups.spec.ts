import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap, type Store } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';

const apiKeys: ApiKeyMap = { sk_test_grp: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_grp', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Group routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  async function createOrg(name: string) {
    return json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name }) }));
  }

  async function createUser(email: string) {
    return json(await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email }) }));
  }

  async function createMembership(orgId: string, userId: string, role = 'member') {
    return json(
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ organization_id: orgId, user_id: userId, role_slug: role }),
      }),
    );
  }

  async function createGroup(orgId: string, name: string, description?: string) {
    return json(
      await req(`/organizations/${orgId}/groups`, {
        method: 'POST',
        body: JSON.stringify({ name, description }),
      }),
    );
  }

  async function events(...types: string[]) {
    const qs = types.map((t) => `events[]=${t}`).join('&');
    return json(await req(`/events?${qs}`));
  }

  it('creates a group', async () => {
    const org = await createOrg('Group Org');
    const res = await req(`/organizations/${org.id}/groups`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Engineering', description: 'The engineering team' }),
    });
    expect(res.status).toBe(201);
    const g = await json(res);
    expect(g.object).toBe('group');
    expect(g.id).toMatch(/^group_/);
    expect(g.organization_id).toBe(org.id);
    expect(g.name).toBe('Engineering');
    expect(g.description).toBe('The engineering team');
    expect(g.created_at).toBeTruthy();
    expect(g.updated_at).toBeTruthy();
  });

  it('defaults description to null and emits group.created', async () => {
    const org = await createOrg('Desc Org');
    const g = await createGroup(org.id, 'Sales');
    expect(g.description).toBeNull();

    const evts = await events('group.created');
    expect(evts.data.some((e: any) => e.data.id === g.id)).toBe(true);
  });

  it('404s creating a group in an unknown organization', async () => {
    const res = await req('/organizations/org_does_not_exist/groups', {
      method: 'POST',
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(404);
  });

  describe('what production refuses', () => {
    // Production keeps names unique per organization with a database constraint and reports the
    // collision as Nest renders a bare ConflictException: the message and reason phrase, no code.
    it('409s a duplicate name in the same organization, on create and on update', async () => {
      const org = await createOrg('Dup Org');
      await createGroup(org.id, 'Engineering');
      const res = await req(`/organizations/${org.id}/groups`, {
        method: 'POST',
        body: JSON.stringify({ name: 'Engineering' }),
      });
      expect(res.status).toBe(409);
      expect(await json(res)).toEqual({
        message: 'A group with name: Engineering already exists in the organization.',
        error: 'Conflict',
      });

      const other = await createGroup(org.id, 'Design');
      const renamed = await req(`/organizations/${org.id}/groups/${other.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Engineering' }),
      });
      expect(renamed.status).toBe(409);
      // Restating a group's own name is not a collision, and another organization is another namespace.
      const same = await req(`/organizations/${org.id}/groups/${other.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Design' }),
      });
      expect(same.status).toBe(200);
      const elsewhere = await createOrg('Other Org');
      expect(
        (
          await req(`/organizations/${elsewhere.id}/groups`, {
            method: 'POST',
            body: JSON.stringify({ name: 'Engineering' }),
          })
        ).status,
      ).toBe(201);
    });

    it('holds name to 256 characters and description to a non-empty 150', async () => {
      const org = await createOrg('Limits Org');
      const create = (body: Record<string, unknown>) =>
        req(`/organizations/${org.id}/groups`, { method: 'POST', body: JSON.stringify(body) });

      expect((await create({ name: 'n'.repeat(256) })).status).toBe(201);
      const longName = await create({ name: 'n'.repeat(257) });
      expect(longName.status).toBe(422);
      expect((await json(longName)).message).toBe('name cannot be more than 256 characters');

      expect((await create({ name: 'Described', description: 'd'.repeat(150) })).status).toBe(201);
      const longDescription = await create({ name: 'Described more', description: 'd'.repeat(151) });
      expect(longDescription.status).toBe(422);
      expect((await json(longDescription)).message).toBe('description cannot be more than 150 characters');
      expect((await create({ name: 'Blank', description: '' })).status).toBe(422);
      expect((await create({ name: 'Numeric', description: 7 })).status).toBe(422);
      // Null clears the description, as an absent one leaves it unset.
      const cleared = await json(await create({ name: 'Cleared', description: null }));
      expect(cleared.description).toBeNull();

      const group = await createGroup(org.id, 'Patched');
      const patch = (body: Record<string, unknown>) =>
        req(`/organizations/${org.id}/groups/${group.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      expect((await patch({ description: '' })).status).toBe(422);
      expect((await patch({ name: 'n'.repeat(257) })).status).toBe(422);
      expect((await json(await patch({ description: null }))).description).toBeNull();
    });

    it('caps a group at 500 members', async () => {
      const org = await createOrg('Crowd Org');
      const group = await createGroup(org.id, 'Everyone');
      // Written straight to the store: 500 users and memberships over HTTP is a slow fixture.
      const ws = getWorkOSStore(store);
      const membershipIds: string[] = [];
      for (let i = 0; i < 501; i++) {
        const user = ws.users.insert({
          object: 'user',
          email: `crowd-${i}@test.com`,
          name: null,
          first_name: null,
          last_name: null,
          email_verified: false,
          profile_picture_url: null,
          last_sign_in_at: null,
          external_id: null,
          metadata: {},
          locale: null,
          password_hash: null,
          impersonator: null,
        });
        const m = ws.organizationMemberships.insert({
          object: 'organization_membership',
          organization_id: org.id,
          user_id: user.id,
          role: { slug: 'member' },
          roles: [{ slug: 'member' }],
          status: 'active',
          external_id: null,
          metadata: {},
        });
        membershipIds.push(m.id);
      }
      for (const id of membershipIds.slice(0, 500)) {
        ws.groupMemberships.insert({ group_id: group.id, organization_membership_id: id });
      }

      const add = (id: string) =>
        req(`/organizations/${org.id}/groups/${group.id}/organization-memberships`, {
          method: 'POST',
          body: JSON.stringify({ organization_membership_id: id }),
        });
      const res = await add(membershipIds[500]);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        message: `Group '${group.id}' cannot have more than 500 members.`,
        code: 'group_membership_limit_exceeded',
      });
      // Production checks the size before it looks for the member, so a full group refuses a
      // member it already holds too.
      expect((await add(membershipIds[0])).status).toBe(400);

      // Removing one makes room again.
      await req(`/organizations/${org.id}/groups/${group.id}/organization-memberships/${membershipIds[0]}`, {
        method: 'DELETE',
      });
      expect((await add(membershipIds[500])).status).toBe(200);
    });
  });

  it('422s creating a group without a name', async () => {
    const org = await createOrg('No Name Org');
    const res = await req(`/organizations/${org.id}/groups`, {
      method: 'POST',
      body: JSON.stringify({ description: 'no name' }),
    });
    expect(res.status).toBe(422);
  });

  it('lists groups within an organization', async () => {
    const org = await createOrg('List Org');
    await createGroup(org.id, 'A');
    await createGroup(org.id, 'B');

    const list = await json(await req(`/organizations/${org.id}/groups`));
    expect(list.object).toBe('list');
    expect(list.data).toHaveLength(2);
  });

  it('gets, updates, and deletes a group', async () => {
    const org = await createOrg('CRUD Org');
    const g = await createGroup(org.id, 'Old');

    const got = await json(await req(`/organizations/${org.id}/groups/${g.id}`));
    expect(got.name).toBe('Old');

    const updated = await json(
      await req(`/organizations/${org.id}/groups/${g.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'New', description: 'updated' }),
      }),
    );
    expect(updated.name).toBe('New');
    expect(updated.description).toBe('updated');

    const evts = await events('group.updated');
    expect(evts.data.some((e: any) => e.data.id === g.id)).toBe(true);

    const del = await req(`/organizations/${org.id}/groups/${g.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    const after = await req(`/organizations/${org.id}/groups/${g.id}`);
    expect(after.status).toBe(404);
  });

  it('404s a group from a different organization', async () => {
    const orgA = await createOrg('Org A');
    const orgB = await createOrg('Org B');
    const g = await createGroup(orgA.id, 'A-only');

    expect((await req(`/organizations/${orgB.id}/groups/${g.id}`)).status).toBe(404);
    expect((await req(`/organizations/${orgB.id}/groups/${g.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('422s updating a group with an empty name', async () => {
    const org = await createOrg('Empty Update Org');
    const g = await createGroup(org.id, 'Keep');
    const res = await req(`/organizations/${org.id}/groups/${g.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(422);
  });

  it('emits group.deleted and drops members', async () => {
    const org = await createOrg('Delete Drop Org');
    const user = await createUser('drop@test.com');
    const m = await createMembership(org.id, user.id);
    const g = await createGroup(org.id, 'Doomed');

    await req(`/organizations/${org.id}/groups/${g.id}/organization-memberships`, {
      method: 'POST',
      body: JSON.stringify({ organization_membership_id: m.id }),
    });

    await req(`/organizations/${org.id}/groups/${g.id}`, { method: 'DELETE' });

    const evts = await events('group.deleted');
    expect(evts.data.some((e: any) => e.data.id === g.id)).toBe(true);

    // A group deletion is one event — not a `member_removed` per member.
    const removedEvts = await events('group.member_removed');
    expect(removedEvts.data.filter((e: any) => e.data.group_id === g.id)).toHaveLength(0);

    // The membership still exists; only the group is gone.
    const stillMember = await req(`/user_management/organization_memberships/${m.id}`);
    expect(stillMember.status).toBe(200);

    // And the membership is no longer listed as belonging to any group.
    const groups = await json(await req(`/user_management/organization_memberships/${m.id}/groups`));
    expect(groups.data).toHaveLength(0);
  });

  it('adds a member, lists members, and removes a member', async () => {
    const org = await createOrg('Member Org');
    const user = await createUser('member@test.com');
    const m = await createMembership(org.id, user.id);
    const g = await createGroup(org.id, 'Eng');

    const added = await json(
      await req(`/organizations/${org.id}/groups/${g.id}/organization-memberships`, {
        method: 'POST',
        body: JSON.stringify({ organization_membership_id: m.id }),
      }),
    );
    expect(added.object).toBe('group');

    const memberEvts = await events('group.member_added');
    expect(memberEvts.data.some((e: any) => e.data.group_id === g.id)).toBe(true);

    const list = await json(await req(`/organizations/${org.id}/groups/${g.id}/organization-memberships`));
    expect(list.data).toHaveLength(1);
    // The base membership shape: identifying fields, no embedded user or roles.
    const base = list.data[0];
    expect(base.object).toBe('organization_membership');
    expect(base.id).toBe(m.id);
    expect(base.user_id).toBe(user.id);
    expect(base.organization_id).toBe(org.id);
    expect(base.status).toBe('active');
    expect(base.directory_managed).toBe(false);
    expect(base).not.toHaveProperty('user');
    expect(base).not.toHaveProperty('roles');

    const removed = await req(`/organizations/${org.id}/groups/${g.id}/organization-memberships/${m.id}`, {
      method: 'DELETE',
    });
    expect(removed.status).toBe(204);

    const removedEvts = await events('group.member_removed');
    expect(removedEvts.data.some((e: any) => e.data.group_id === g.id)).toBe(true);

    const after = await json(await req(`/organizations/${org.id}/groups/${g.id}/organization-memberships`));
    expect(after.data).toHaveLength(0);
  });

  it('is idempotent when adding an existing member', async () => {
    const org = await createOrg('Idempotent Org');
    const user = await createUser('idem@test.com');
    const m = await createMembership(org.id, user.id);
    const g = await createGroup(org.id, 'Idem');

    await req(`/organizations/${org.id}/groups/${g.id}/organization-memberships`, {
      method: 'POST',
      body: JSON.stringify({ organization_membership_id: m.id }),
    });
    const second = await req(`/organizations/${org.id}/groups/${g.id}/organization-memberships`, {
      method: 'POST',
      body: JSON.stringify({ organization_membership_id: m.id }),
    });
    expect(second.status).toBe(200);

    const list = await json(await req(`/organizations/${org.id}/groups/${g.id}/organization-memberships`));
    expect(list.data).toHaveLength(1);
  });

  it('404s adding an unknown membership', async () => {
    const org = await createOrg('Unknown Om Org');
    const g = await createGroup(org.id, 'X');
    const res = await req(`/organizations/${org.id}/groups/${g.id}/organization-memberships`, {
      method: 'POST',
      body: JSON.stringify({ organization_membership_id: 'om_does_not_exist' }),
    });
    expect(res.status).toBe(404);
  });

  it('422s adding a membership from a different organization', async () => {
    const orgA = await createOrg('Cross A');
    const orgB = await createOrg('Cross B');
    const user = await createUser('cross@test.com');
    const mB = await createMembership(orgB.id, user.id);
    const gA = await createGroup(orgA.id, 'A group');

    const res = await req(`/organizations/${orgA.id}/groups/${gA.id}/organization-memberships`, {
      method: 'POST',
      body: JSON.stringify({ organization_membership_id: mB.id }),
    });
    expect(res.status).toBe(422);
  });

  it('422s adding a member without an organization_membership_id', async () => {
    const org = await createOrg('Missing Om Org');
    const g = await createGroup(org.id, 'X');
    const res = await req(`/organizations/${org.id}/groups/${g.id}/organization-memberships`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it('404s removing a membership that is not in the group', async () => {
    const org = await createOrg('Remove NotMember Org');
    const user = await createUser('notin@test.com');
    const m = await createMembership(org.id, user.id);
    const g = await createGroup(org.id, 'X');

    const res = await req(`/organizations/${org.id}/groups/${g.id}/organization-memberships/${m.id}`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });

  it('lists the groups an organization membership belongs to', async () => {
    const org = await createOrg('ListForOm Org');
    const user = await createUser('listfor@test.com');
    const m = await createMembership(org.id, user.id);
    const g1 = await createGroup(org.id, 'One');
    const g2 = await createGroup(org.id, 'Two');

    await req(`/organizations/${org.id}/groups/${g1.id}/organization-memberships`, {
      method: 'POST',
      body: JSON.stringify({ organization_membership_id: m.id }),
    });
    await req(`/organizations/${org.id}/groups/${g2.id}/organization-memberships`, {
      method: 'POST',
      body: JSON.stringify({ organization_membership_id: m.id }),
    });

    const list = await json(await req(`/user_management/organization_memberships/${m.id}/groups`));
    expect(list.data).toHaveLength(2);
    expect(list.data.every((g: any) => g.object === 'group')).toBe(true);
  });

  it('404s listing groups for an unknown membership', async () => {
    const res = await req('/user_management/organization_memberships/om_none/groups');
    expect(res.status).toBe(404);
  });

  it('keeps groups isolated between organizations', async () => {
    const orgA = await createOrg('Iso A');
    const orgB = await createOrg('Iso B');
    await createGroup(orgA.id, 'Only A');

    const listB = await json(await req(`/organizations/${orgB.id}/groups`));
    expect(listB.data).toHaveLength(0);
  });
});
