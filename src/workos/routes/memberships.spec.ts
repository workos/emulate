import { describe, it, expect, beforeEach } from 'vitest';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { formatMembership } from '../helpers.js';
import type { WorkOSStore } from '../store.js';

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

  it('rejects duplicate active membership', async () => {
    const org = await createOrg('Dup Org');
    const user = await createUser('dup@test.com');

    await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: org.id, user_id: user.id }),
    });

    const res = await req('/user_management/organization_memberships', {
      method: 'POST',
      body: JSON.stringify({ organization_id: org.id, user_id: user.id }),
    });
    expect(res.status).toBe(409);
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
