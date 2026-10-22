import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap, type Store } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';

const apiKeys: ApiKeyMap = { sk_test_inv: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_inv', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Invitation routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('creates an invitation', async () => {
    const res = await req('/user_management/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'invite@test.com' }),
    });
    expect(res.status).toBe(201);
    const inv = await json(res);
    expect(inv.object).toBe('invitation');
    expect(inv.email).toBe('invite@test.com');
    expect(inv.state).toBe('pending');
    expect(inv.token).toBeDefined();
    expect(inv.accept_invitation_url).toContain(inv.token);
    expect(inv.id).toMatch(/^invitation_/);
    // The generated SDK reads these as required keys; omitting them raises KeyError on parse.
    expect(inv.accepted_at).toBeNull();
    expect(inv.revoked_at).toBeNull();
    expect(inv.accepted_user_id).toBeNull();
  });

  it('lists invitations with email filter', async () => {
    await req('/user_management/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@test.com' }),
    });
    await req('/user_management/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'b@test.com' }),
    });

    const list = await json(await req('/user_management/invitations?email=a@test.com'));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].email).toBe('a@test.com');
    // List responses serialize through the same formatter; the required nullable keys appear here too.
    expect(list.data[0].accepted_at).toBeNull();
    expect(list.data[0].revoked_at).toBeNull();
    expect(list.data[0].accepted_user_id).toBeNull();
  });

  it('lists invitations with organization_id filter', async () => {
    const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Inv Org' }) }));
    await req('/user_management/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'org@test.com', organization_id: org.id }),
    });
    await req('/user_management/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'no-org@test.com' }),
    });

    const list = await json(await req(`/user_management/invitations?organization_id=${org.id}`));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].email).toBe('org@test.com');
  });

  describe('what production refuses to create', () => {
    const invite = (body: Record<string, unknown>) =>
      req('/user_management/invitations', { method: 'POST', body: JSON.stringify(body) });
    const createOrg = async (name: string) =>
      json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name }) }));

    it('404s an unknown organization or inviter', async () => {
      expect((await invite({ email: 'x@test.com', organization_id: 'org_nope' })).status).toBe(404);
      expect((await invite({ email: 'x@test.com', inviter_user_id: 'user_nope' })).status).toBe(404);
    });

    it('refuses a second open invitation to the same organization', async () => {
      const org = await createOrg('Twice Org');
      expect((await invite({ email: 'dup@test.com', organization_id: org.id })).status).toBe(201);

      const res = await invite({ email: 'Dup@test.com', organization_id: org.id });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        message: 'Email already invited to organization.',
        code: 'email_already_invited_to_organization',
      });

      // Another organization is another invitation.
      const other = await createOrg('Other Org');
      expect((await invite({ email: 'dup@test.com', organization_id: other.id })).status).toBe(201);
    });

    it('refuses a second open invitation to the environment, or one for an existing account', async () => {
      expect((await invite({ email: 'signup@test.com' })).status).toBe(201);
      const again = await invite({ email: 'signup@test.com' });
      expect(again.status).toBe(400);
      expect(await json(again)).toEqual({ message: 'Email already invited.', code: 'email_already_invited' });

      await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'exists@test.com' }) });
      const exists = await invite({ email: 'exists@test.com' });
      expect(exists.status).toBe(400);
      expect(await json(exists)).toEqual({ message: 'User already exists.', code: 'user_already_exists' });
    });

    it('allows a new invitation once the open one is revoked', async () => {
      const first = await json(await invite({ email: 'retry@test.com' }));
      await req(`/user_management/invitations/${first.id}/revoke`, { method: 'POST' });
      expect((await invite({ email: 'retry@test.com' })).status).toBe(201);
    });

    it('refuses a role slug that names no role, before the invitation exists', async () => {
      const org = await createOrg('Role Org');
      const res = await invite({ email: 'role@test.com', organization_id: org.id, role_slug: 'no-such-role' });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ message: 'The role is invalid.', code: 'invalid_role' });
      expect((await json(await req('/user_management/invitations'))).data).toHaveLength(0);

      // The built-in environment roles need no seeding; a defined organization role resolves too.
      expect((await invite({ email: 'admin@test.com', organization_id: org.id, role_slug: 'admin' })).status).toBe(201);
      await req(`/authorization/organizations/${org.id}/roles`, {
        method: 'POST',
        body: JSON.stringify({ slug: 'org-auditor', name: 'Auditor' }),
      });
      expect(
        (await invite({ email: 'auditor@test.com', organization_id: org.id, role_slug: 'org-auditor' })).status,
      ).toBe(201);
    });

    it('holds expires_in_days to 1..30 and defaults to 7 days', async () => {
      const tooLong = await invite({ email: 'long@test.com', expires_in_days: 31 });
      expect(tooLong.status).toBe(400);
      expect(await json(tooLong)).toEqual({
        message: 'Expires in days must be less than or equal to 30.',
        code: 'expires_in_days_too_long',
      });
      const tooShort = await invite({ email: 'short@test.com', expires_in_days: 0 });
      expect(tooShort.status).toBe(400);
      expect(await json(tooShort)).toEqual({
        message: 'Expires in days must be greater than 1.',
        code: 'expires_in_days_too_short',
      });
      expect((await invite({ email: 'float@test.com', expires_in_days: 1.5 })).status).toBe(422);

      const day = 24 * 60 * 60 * 1000;
      const lifetime = (inv: any) => new Date(inv.expires_at).getTime() - new Date(inv.created_at).getTime();
      const defaulted = await json(await invite({ email: 'default@test.com' }));
      expect(lifetime(defaulted)).toBeGreaterThan(7 * day - 1000);
      expect(lifetime(defaulted)).toBeLessThanOrEqual(7 * day);
      const month = await json(await invite({ email: 'month@test.com', expires_in_days: 30 }));
      expect(lifetime(month)).toBeGreaterThan(30 * day - 1000);
    });
  });

  describe('expiry', () => {
    /** An invitation whose lifetime has run out, as the clock sees it. */
    async function expiredInvitation() {
      const created = await json(
        await req('/user_management/invitations', { method: 'POST', body: JSON.stringify({ email: 'late@test.com' }) }),
      );
      getWorkOSStore(store).invitations.update(created.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
      return created;
    }

    it('reports an invitation as expired once its expires_at has passed, without any request', async () => {
      const created = await expiredInvitation();
      expect(created.state).toBe('pending');

      const read = await json(await req(`/user_management/invitations/${created.id}`));
      expect(read.state).toBe('expired');
      expect((await json(await req(`/user_management/invitations/by_token/${created.token}`))).state).toBe('expired');
      expect((await json(await req('/user_management/invitations'))).data[0].state).toBe('expired');
    });

    it('refuses to accept, revoke or resend an expired invitation', async () => {
      const created = await expiredInvitation();

      for (const action of ['accept', 'revoke']) {
        const res = await req(`/user_management/invitations/${created.id}/${action}`, { method: 'POST' });
        expect(res.status).toBe(400);
        expect(await json(res)).toEqual({ message: 'Invite is not pending.', code: 'invite_not_pending' });
      }
      const resend = await req(`/user_management/invitations/${created.id}/resend`, { method: 'POST' });
      expect(resend.status).toBe(400);
      expect(await json(resend)).toEqual({ message: 'Invite has expired.', code: 'invite_expired' });
    });

    it('no longer counts an expired invitation as open', async () => {
      await expiredInvitation();
      const res = await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'late@test.com' }),
      });
      expect(res.status).toBe(201);
    });
  });

  it('gets invitation by id', async () => {
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'get@test.com' }),
      }),
    );

    const res = await req(`/user_management/invitations/${created.id}`);
    expect(res.status).toBe(200);
    expect((await json(res)).email).toBe('get@test.com');
  });

  it('gets invitation by token', async () => {
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'token@test.com' }),
      }),
    );

    const res = await req(`/user_management/invitations/by_token/${created.token}`);
    expect(res.status).toBe(200);
    expect((await json(res)).email).toBe('token@test.com');
  });

  it('accepts an invitation', async () => {
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'accept@test.com' }),
      }),
    );

    const res = await req(`/user_management/invitations/${created.id}/accept`, { method: 'POST' });
    expect(res.status).toBe(200);
    const accepted = await json(res);
    expect(accepted.state).toBe('accepted');
    expect(accepted.accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(accepted.revoked_at).toBeNull();
    // No user signed up under this email, so nobody is recorded as the accepter.
    expect(accepted.accepted_user_id).toBeNull();
  });

  it('accepts invitation with org creates membership', async () => {
    // Create a user and org first
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'member@test.com' }),
    });
    const org = await json(
      await req('/organizations', {
        method: 'POST',
        body: JSON.stringify({ name: 'Test Org' }),
      }),
    );

    const inv = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'member@test.com', organization_id: org.id }),
      }),
    );

    await req(`/user_management/invitations/${inv.id}/accept`, { method: 'POST' });

    // Check membership was created
    const memberships = await json(await req(`/user_management/organization_memberships?organization_id=${org.id}`));
    expect(memberships.data).toHaveLength(1);
    expect(memberships.data[0].organization_id).toBe(org.id);

    // The recipient exists, so their id is recorded as the accepter.
    const accepted = await json(await req(`/user_management/invitations/${inv.id}`));
    expect(accepted.accepted_user_id).toBe(memberships.data[0].user_id);
  });

  describe('pending membership', () => {
    // On WorkOS, inviting a user to an organization creates their membership at once as `pending`
    // with the invitation's role; accepting activates it, and revoking leaves it behind.
    async function invite(roleSlug?: string) {
      const user = await json(
        await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'alice@example.test' }) }),
      );
      const org = await json(
        await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Pending Org' }) }),
      );
      const inv = await json(
        await req('/user_management/invitations', {
          method: 'POST',
          body: JSON.stringify({ email: 'alice@example.test', organization_id: org.id, role_slug: roleSlug }),
        }),
      );
      return { user, org, inv };
    }

    const membershipsOf = async (orgId: string) =>
      (
        await json(
          await req(
            `/user_management/organization_memberships?organization_id=${orgId}&statuses=active,inactive,pending`,
          ),
        )
      ).data;

    it('creates a pending membership with the invitation role', async () => {
      const { user, org } = await invite('admin');
      const memberships = await membershipsOf(org.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0].user_id).toBe(user.id);
      expect(memberships[0].status).toBe('pending');
      expect(memberships[0].role.slug).toBe('admin');
    });

    it('activates the same membership on accept', async () => {
      const { org, inv } = await invite();
      const [pending] = await membershipsOf(org.id);
      expect(pending.role.slug).toBe('member');

      await req(`/user_management/invitations/${inv.id}/accept`, { method: 'POST' });
      const memberships = await membershipsOf(org.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0].id).toBe(pending.id);
      expect(memberships[0].status).toBe('active');
    });

    it('leaves the pending membership behind on revoke', async () => {
      const { org, inv } = await invite();
      await req(`/user_management/invitations/${inv.id}/revoke`, { method: 'POST' });
      const memberships = await membershipsOf(org.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0].status).toBe('pending');
    });

    it('creates the user when the address has no account yet', async () => {
      const org = await json(
        await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'New Org' }) }),
      );
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'carol@example.test', organization_id: org.id }),
      });

      const users = await json(await req('/user_management/users?email=carol@example.test'));
      expect(users.data).toHaveLength(1);
      expect(users.data[0].email_verified).toBe(false);
      const memberships = await membershipsOf(org.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0].user_id).toBe(users.data[0].id);
      expect(memberships[0].status).toBe('pending');
    });

    async function member(email: string) {
      const user = await json(await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email }) }));
      const org = await json(
        await req('/organizations', { method: 'POST', body: JSON.stringify({ name: `${email} Org` }) }),
      );
      const membership = await json(
        await req('/user_management/organization_memberships', {
          method: 'POST',
          body: JSON.stringify({ organization_id: org.id, user_id: user.id }),
        }),
      );
      return { user, org, membership };
    }

    it('refuses to invite an active member', async () => {
      const { org } = await member('bob@example.test');
      const res = await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'bob@example.test', organization_id: org.id }),
      });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('user_already_organization_member');
      const memberships = await membershipsOf(org.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0].status).toBe('active');
      expect((await json(await req('/user_management/invitations?email=bob@example.test'))).data).toHaveLength(0);
    });

    it('resets an inactive membership to pending with the invitation role', async () => {
      const { org, membership } = await member('dana@example.test');
      await req(`/user_management/organization_memberships/${membership.id}/deactivate`, { method: 'PUT' });

      const inv = await json(
        await req('/user_management/invitations', {
          method: 'POST',
          body: JSON.stringify({ email: 'dana@example.test', organization_id: org.id, role_slug: 'admin' }),
        }),
      );
      let memberships = await membershipsOf(org.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0].id).toBe(membership.id);
      expect(memberships[0].status).toBe('pending');
      expect(memberships[0].role.slug).toBe('admin');

      await req(`/user_management/invitations/${inv.id}/accept`, { method: 'POST' });
      memberships = await membershipsOf(org.id);
      expect(memberships[0].id).toBe(membership.id);
      expect(memberships[0].status).toBe('active');
      expect(memberships[0].role.slug).toBe('admin');
    });

    it('gives a pending membership the role of a fresh invitation', async () => {
      const { org, inv } = await invite();
      await req(`/user_management/invitations/${inv.id}/revoke`, { method: 'POST' });
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'alice@example.test', organization_id: org.id, role_slug: 'admin' }),
      });
      const memberships = await membershipsOf(org.id);
      expect(memberships).toHaveLength(1);
      expect(memberships[0].status).toBe('pending');
      expect(memberships[0].role.slug).toBe('admin');
    });
  });

  // Resolving the recipient exactly enrolled nobody for an account stored under a different case:
  // the invitation was still spent and invitation.accepted still fired, with no membership to show
  // for it and no error anywhere. Magic Auth sign-up makes accounts under whatever case it was
  // handed, and the authenticate flow already compares the two addresses case-insensitively.
  it('accepts an invitation for an account stored under a different case', async () => {
    const user = await json(
      await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'Member@X.test' }) }),
    );
    const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Case Org' }) }));

    const inv = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'member@x.test', organization_id: org.id }),
      }),
    );
    const accepted = await req(`/user_management/invitations/${inv.id}/accept`, { method: 'POST' });
    expect(accepted.status).toBe(200);
    expect((await json(accepted)).state).toBe('accepted');

    const memberships = await json(await req(`/user_management/organization_memberships?organization_id=${org.id}`));
    expect(memberships.data).toHaveLength(1);
    expect(memberships.data[0].user_id).toBe(user.id);
  });

  it('filters invitations by email case-insensitively', async () => {
    await req('/user_management/invitations', { method: 'POST', body: JSON.stringify({ email: 'Filter@X.test' }) });

    const list = await json(await req('/user_management/invitations?email=filter%40x.test'));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].email).toBe('Filter@X.test');
  });

  // A non-string was survivable while every consumer of a stored email compared it with `!==`.
  // Resolving the recipient case-insensitively means calling `toLowerCase` on it, so accepting a
  // number here turned both the email filter and accepting the invitation into a 500 — a
  // `server_error` in a consumer's suite reads as an emulator defect rather than a bad request.
  it('rejects a non-string email rather than storing one nothing can read back', async () => {
    for (const email of [123, { not: 'a string' }, ['a@x.test']]) {
      const res = await req('/user_management/invitations', { method: 'POST', body: JSON.stringify({ email }) });
      expect(res.status).toBe(422);
      const body = await json(res);
      expect(body.code).toBe('unprocessable_entity');
      expect(body.message).toBe('email must be a string');
    }

    // The two reads that would have 500d on a stored non-string.
    expect((await req('/user_management/invitations?email=a%40x.test')).status).toBe(200);
    expect((await json(await req('/user_management/invitations'))).data).toHaveLength(0);
  });

  // Acceptance resolves the recipient by this address, so a typo is spent silently: 200, the
  // invitation marked accepted, invitation.accepted emitted, and nobody enrolled. Held to the same
  // standard as the two routes that create users, which reject for the same reason.
  it('rejects an email that could only be a typo', async () => {
    for (const email of ['', '   ', 'not-an-email', 'a b@test.com', '@test.com', 'nope@', 'two@at@test.com']) {
      const res = await req('/user_management/invitations', { method: 'POST', body: JSON.stringify({ email }) });
      expect(res.status).toBe(422);
      expect((await json(res)).message).toMatch(/email (is required|must be a valid email address)/);
    }
    expect((await json(await req('/user_management/invitations'))).data).toHaveLength(0);
  });

  // Absent and malformed have the same fix only if the caller is told which one happened, and
  // `null` in a JSON body is how a caller spells absence.
  it('reports an absent email as absent, including an explicit null', async () => {
    for (const body of [{}, { email: null }]) {
      const res = await req('/user_management/invitations', { method: 'POST', body: JSON.stringify(body) });
      expect(res.status).toBe(422);
      const parsed = await json(res);
      expect(parsed.message).toBe('email is required');
      expect(parsed.errors[0]).toMatchObject({ field: 'email', code: 'required' });
    }
  });

  it('trims a padded address before storing it', async () => {
    const inv = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: '  padded@x.test  ' }),
      }),
    );
    expect(inv.email).toBe('padded@x.test');

    const list = await json(await req('/user_management/invitations?email=padded%40x.test'));
    expect(list.data).toHaveLength(1);
  });

  it('revokes an invitation', async () => {
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'revoke@test.com' }),
      }),
    );

    const res = await req(`/user_management/invitations/${created.id}/revoke`, { method: 'POST' });
    expect(res.status).toBe(200);
    const revoked = await json(res);
    expect(revoked.state).toBe('revoked');
    expect(revoked.revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(revoked.accepted_at).toBeNull();
  });

  it('rejects accept on non-pending invitation', async () => {
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'twice@test.com' }),
      }),
    );

    await req(`/user_management/invitations/${created.id}/revoke`, { method: 'POST' });

    const res = await req(`/user_management/invitations/${created.id}/accept`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ message: 'Invite is not pending.', code: 'invite_not_pending' });

    const again = await req(`/user_management/invitations/${created.id}/revoke`, { method: 'POST' });
    expect(again.status).toBe(400);
    expect((await json(again)).code).toBe('invite_not_pending');
  });

  it('resends an invitation with new token', async () => {
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'resend@test.com' }),
      }),
    );
    const originalToken = created.token;

    const res = await req(`/user_management/invitations/${created.id}/resend`, { method: 'POST' });
    expect(res.status).toBe(200);
    const resent = await json(res);
    expect(resent.token).not.toBe(originalToken);
    expect(resent.state).toBe('pending');
    expect(resent.accept_invitation_url).toContain(resent.token);
  });

  // Resending sends the pending invitation again; it does not reopen one that was accepted or
  // revoked, and production names which under a code of its own.
  it('refuses to resend an accepted invitation', async () => {
    const user = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'resend-accepted@test.com' }),
      }),
    );
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: user.email, organization_id: (await createOrgFor('Accepted Org')).id }),
      }),
    );

    const accepted = await json(await req(`/user_management/invitations/${created.id}/accept`, { method: 'POST' }));
    expect(accepted.state).toBe('accepted');
    expect(accepted.accepted_user_id).toBe(user.id);

    const res = await req(`/user_management/invitations/${created.id}/resend`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ message: 'Invite has already been accepted.', code: 'invite_accepted' });
    expect((await json(await req(`/user_management/invitations/${created.id}`))).state).toBe('accepted');
  });

  it('refuses to resend a revoked invitation', async () => {
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'resend-revoked@test.com' }),
      }),
    );

    const revoked = await json(await req(`/user_management/invitations/${created.id}/revoke`, { method: 'POST' }));
    expect(revoked.state).toBe('revoked');

    const res = await req(`/user_management/invitations/${created.id}/resend`, { method: 'POST' });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({ message: 'Invite has been revoked.', code: 'invite_revoked' });
    expect((await json(await req(`/user_management/invitations/${created.id}`))).state).toBe('revoked');
  });

  // The spec has no DELETE for an invitation; revoking is how one is withdrawn.
  it('has no delete route', async () => {
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'delete@test.com' }),
      }),
    );

    const delRes = await req(`/user_management/invitations/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(404);
    expect((await req(`/user_management/invitations/${created.id}`)).status).toBe(200);
  });

  const createOrgFor = async (name: string) =>
    json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name }) }));
});
