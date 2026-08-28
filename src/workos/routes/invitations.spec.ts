import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';

const apiKeys: ApiKeyMap = { sk_test_inv: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_inv', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Invitation routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
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
    expect(inv.id).toMatch(/^inv_/);
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
    await req('/user_management/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'org@test.com', organization_id: 'org_123' }),
    });
    await req('/user_management/invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'no-org@test.com' }),
    });

    const list = await json(await req('/user_management/invitations?organization_id=org_123'));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].email).toBe('org@test.com');
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

  // Resending puts the invitation back to pending, so the terminal metadata has to clear with it:
  // a pending invitation that still carries accepted_at or revoked_at contradicts its own state.
  it('clears acceptance metadata when an accepted invitation is resent', async () => {
    const user = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'resend-accepted@test.com' }),
      }),
    );
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: user.email }),
      }),
    );

    const accepted = await json(await req(`/user_management/invitations/${created.id}/accept`, { method: 'POST' }));
    expect(accepted.accepted_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(accepted.accepted_user_id).toBe(user.id);

    const resent = await json(await req(`/user_management/invitations/${created.id}/resend`, { method: 'POST' }));
    expect(resent.state).toBe('pending');
    expect(resent.accepted_at).toBeNull();
    expect(resent.accepted_user_id).toBeNull();
  });

  it('clears revocation metadata when a revoked invitation is resent', async () => {
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'resend-revoked@test.com' }),
      }),
    );

    const revoked = await json(await req(`/user_management/invitations/${created.id}/revoke`, { method: 'POST' }));
    expect(revoked.revoked_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const resent = await json(await req(`/user_management/invitations/${created.id}/resend`, { method: 'POST' }));
    expect(resent.state).toBe('pending');
    expect(resent.revoked_at).toBeNull();
  });

  it('deletes an invitation', async () => {
    const created = await json(
      await req('/user_management/invitations', {
        method: 'POST',
        body: JSON.stringify({ email: 'delete@test.com' }),
      }),
    );

    const delRes = await req(`/user_management/invitations/${created.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const getRes = await req(`/user_management/invitations/${created.id}`);
    expect(getRes.status).toBe(404);
  });
});
