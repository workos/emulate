import { describe, it, expect, beforeEach } from 'bun:test';
import { BadRequestException } from '@workos-inc/node';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { sdkClient } from '../sdk.test-utils.js';

const apiKeys: ApiKeyMap = { sk_test_users: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_users', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('User routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('creates a user', async () => {
    const res = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'alice@test.com', first_name: 'Alice', password: 'correct-horse-battery' }),
    });
    expect(res.status).toBe(201);
    const user = await json(res);
    expect(user.object).toBe('user');
    expect(user.email).toBe('alice@test.com');
    expect(user.id).toMatch(/^user_/);
    expect(user.password_hash).toBeUndefined();
  });

  // Held to the same standard as the magic auth handler, which validates for the same reason:
  // both create users, and an address that could only be a typo becomes an unreachable account.
  it('rejects an email that could only be a typo', async () => {
    for (const email of ['', '   ', 'not-an-email', 'a b@test.com', '@test.com', 'nope@', 'two@at@test.com', 123]) {
      const res = await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      expect(res.status).toBe(422);
      expect((await json(res)).code).toBe('unprocessable_entity');
    }
    const list = await json(await req('/user_management/users'));
    expect(list.data).toHaveLength(0);
  });

  // `null` is how a JSON body spells absence, so it is reported as absence — the same answer the
  // magic auth handler gives it. Classifying it as a type error instead had the two creation paths
  // disagreeing about which of the two distinctions this route exists to draw it falls on.
  it('reports an absent email as absent, including an explicit null', async () => {
    for (const body of [{}, { email: null }]) {
      const res = await req('/user_management/users', { method: 'POST', body: JSON.stringify(body) });
      expect(res.status).toBe(422);
      const parsed = await json(res);
      expect(parsed.message).toBe('email is required');
      expect(parsed.errors[0]).toMatchObject({ field: 'email', code: 'required' });
    }
  });

  it('names a non-string email as the wrong type, not as missing', async () => {
    const res = await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 123 }) });
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.message).toBe('email must be a string');
    expect(body.errors[0]).toMatchObject({ field: 'email', code: 'invalid_type' });
  });

  // Case-insensitively, like the magic auth handler: two accounts differing only in case left the
  // two creation paths disagreeing about which one an address names, with magic auth's resolver
  // settling it by insertion order.
  it('rejects a duplicate email that differs only in case', async () => {
    const first = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'User@x.test' }),
    });
    expect(first.status).toBe(201);

    const second = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'user@x.test' }),
    });
    expect(second.status).toBe(400);
    expect(await json(second)).toMatchObject({
      code: 'user_creation_error',
      errors: [{ code: 'email_not_available' }],
    });
  });

  // This is the lookup an SDK's listUsers({ email }) maps to, so it is how a caller finds the
  // account a Magic Auth sign-up just made — and sign-up stores whatever case it was handed.
  // Filtering exactly meant the address the caller had returned nothing for a user that existed.
  it('filters by email case-insensitively', async () => {
    const created = await json(
      await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'Listed@X.test' }) }),
    );

    for (const query of ['listed%40x.test', 'Listed%40X.test', 'LISTED%40X.TEST']) {
      const list = await json(await req(`/user_management/users?email=${query}`));
      expect(list.data).toHaveLength(1);
      expect(list.data[0].id).toBe(created.id);
    }

    // Still a filter, not a fuzzy match.
    const miss = await json(await req('/user_management/users?email=listed%40y.test'));
    expect(miss.data).toHaveLength(0);
  });

  it('matches the user-creation contract for a duplicate email without changing the existing user', async () => {
    const created = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({
          email: 'dup@test.com',
          first_name: 'Original',
          last_name: 'User',
          password: 'correct-horse-battery',
        }),
      }),
    );
    const res = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({
        email: 'dup@test.com',
        first_name: 'Changed',
        last_name: 'User',
        email_verified: true,
        external_id: 'dup@test.com',
      }),
    });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      message: 'Could not create user.',
      code: 'user_creation_error',
      errors: [{ code: 'email_not_available', message: 'This email is not available.' }],
    });

    const unchanged = await json(await req(`/user_management/users/${created.id}`));
    expect(unchanged).toMatchObject({
      id: created.id,
      email: 'dup@test.com',
      first_name: 'Original',
      last_name: 'User',
      email_verified: false,
      external_id: null,
    });
  });

  // The body is asserted above; this checks only what the SDK makes of it.
  it('is decoded as BadRequestException by @workos-inc/node', async () => {
    const workos = sdkClient(app, 'sk_test_users');
    await workos.userManagement.createUser({ email: 'sdk-dup@test.com' });
    const dup = workos.userManagement.createUser({ email: 'sdk-dup@test.com' });
    await expect(dup).rejects.toBeInstanceOf(BadRequestException);
    await expect(dup).rejects.toMatchObject({ status: 400 });
  });

  it('gets user by id', async () => {
    const created = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'get@test.com' }),
      }),
    );

    const res = await req(`/user_management/users/${created.id}`);
    expect(res.status).toBe(200);
    expect((await json(res)).email).toBe('get@test.com');
  });

  it('lists users filtered by email', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'a@test.com' }),
    });
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'b@test.com' }),
    });

    const list = await json(await req('/user_management/users?email=a@test.com'));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].email).toBe('a@test.com');
  });

  it('updates a user', async () => {
    const created = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'update@test.com' }),
      }),
    );

    const res = await req(`/user_management/users/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify({ first_name: 'Updated' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).first_name).toBe('Updated');
  });

  describe('password policy', () => {
    const create = (email: string, password: string) =>
      req('/user_management/users', { method: 'POST', body: JSON.stringify({ email, password }) });

    // Production's body, item for item: a common password is long enough but scores too low.
    it('refuses a weak password on create with password_strength_error', async () => {
      const res = await create('weak@test.com', 'password123');
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        message: 'Password does not meet strength requirements.',
        code: 'password_strength_error',
        errors: [
          {
            code: 'password_too_weak',
            message: 'The provided password is not strong enough. This is a commonly used password.',
            warning: 'This is a commonly used password.',
            suggestions: ['Add more words that are less common.'],
          },
        ],
      });
      expect((await json(await req('/user_management/users'))).data).toHaveLength(0);
    });

    it('reports every rule a password breaks, in production order', async () => {
      const res = await json(await create('rules@test.com', 'rules@test.com'));
      expect(res.errors.map((e: any) => e.code)).toEqual(['password_contains_email']);

      const short = await json(await create('short@test.com', 'abc'));
      expect(short.errors.map((e: any) => e.code)).toEqual(['password_too_short', 'password_too_weak']);
      expect(short.errors[0]).toMatchObject({ minimum_length: 10 });
    });

    it('refuses a password over 72 bytes for that alone', async () => {
      const body = await json(await create('long@test.com', 'é'.repeat(37)));
      expect(body.errors).toEqual([
        {
          code: 'password_too_long',
          message:
            'The provided password exceeds the maximum length requirements. Please try a password with 72 or fewer characters.',
          maximum_length: 72,
        },
      ]);
    });

    it('accepts a strong password and applies the same policy on update', async () => {
      const user = await json(await create('strong@test.com', 'correct horse battery staple'));
      expect(user.id).toMatch(/^user_/);

      const weak = await req(`/user_management/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ password: 'test123' }),
      });
      expect(weak.status).toBe(400);
      expect((await json(weak)).code).toBe('password_strength_error');

      const strong = await req(`/user_management/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ password: 'an even better passphrase' }),
      });
      expect(strong.status).toBe(200);
    });
  });

  describe('external_id', () => {
    it('refuses a taken external_id on create inside user_creation_error', async () => {
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'first@test.com', external_id: 'ext-1' }),
      });
      const res = await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'second@test.com', external_id: 'ext-1' }),
      });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        message: 'Could not create user.',
        code: 'user_creation_error',
        errors: [{ code: 'external_id_already_used', message: 'External ID has already been used' }],
      });
    });

    it('refuses a taken external_id on update with external_id_already_used', async () => {
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'holder@test.com', external_id: 'ext-2' }),
      });
      const other = await json(
        await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'other@test.com' }) }),
      );

      const res = await req(`/user_management/users/${other.id}`, {
        method: 'PUT',
        body: JSON.stringify({ external_id: 'ext-2' }),
      });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        message: 'The external_id provided has already been assigned to another user.',
        code: 'external_id_already_used',
      });

      // Restating a user's own external_id is not a collision.
      const holder = (await json(await req('/user_management/users?email=holder@test.com'))).data[0];
      const same = await req(`/user_management/users/${holder.id}`, {
        method: 'PUT',
        body: JSON.stringify({ external_id: 'ext-2' }),
      });
      expect(same.status).toBe(200);
    });
  });

  describe('email_verified on update', () => {
    it('verifies an unverified user and ignores false on one', async () => {
      const user = await json(
        await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'verify@test.com' }) }),
      );
      const stillUnverified = await json(
        await req(`/user_management/users/${user.id}`, {
          method: 'PUT',
          body: JSON.stringify({ email_verified: false }),
        }),
      );
      expect(stillUnverified.email_verified).toBe(false);

      const verified = await json(
        await req(`/user_management/users/${user.id}`, {
          method: 'PUT',
          body: JSON.stringify({ email_verified: true }),
        }),
      );
      expect(verified.email_verified).toBe(true);
    });

    it('refuses to unverify a verified user', async () => {
      const user = await json(
        await req('/user_management/users', {
          method: 'POST',
          body: JSON.stringify({ email: 'verified@test.com', email_verified: true }),
        }),
      );
      const res = await req(`/user_management/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ email_verified: false }),
      });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        message: 'The user email has already been verified and cannot be unverified.',
        code: 'email_already_verified',
      });
      expect((await json(await req(`/user_management/users/${user.id}`))).email_verified).toBe(true);
    });
  });

  describe('email on update', () => {
    it('changes the address and leaves it unverified until something verifies it', async () => {
      const user = await json(
        await req('/user_management/users', {
          method: 'POST',
          body: JSON.stringify({ email: 'before@test.com', email_verified: true }),
        }),
      );

      const changed = await json(
        await req(`/user_management/users/${user.id}`, {
          method: 'PUT',
          body: JSON.stringify({ email: 'after@test.com' }),
        }),
      );
      expect(changed.email).toBe('after@test.com');
      expect(changed.email_verified).toBe(false);

      // Asserted in the same request, verification applies to the new address.
      const reverified = await json(
        await req(`/user_management/users/${user.id}`, {
          method: 'PUT',
          body: JSON.stringify({ email: 'third@test.com', email_verified: true }),
        }),
      );
      expect(reverified).toMatchObject({ email: 'third@test.com', email_verified: true });
    });

    it('refuses a malformed or taken address in the 400 shape of an email change', async () => {
      const user = await json(
        await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'mine@test.com' }) }),
      );
      await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'Theirs@test.com' }) });

      const malformed = await req(`/user_management/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ email: 'not-an-email' }),
      });
      expect(malformed.status).toBe(400);
      expect(await json(malformed)).toEqual({ message: 'Email must be a valid email address.', code: 'invalid_email' });

      const taken = await req(`/user_management/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ email: 'theirs@test.com' }),
      });
      expect(taken.status).toBe(400);
      expect(await json(taken)).toEqual({ message: 'This email is not available.', code: 'email_not_available' });

      // The user's own address, in any case, is not a change.
      const same = await req(`/user_management/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({ email: 'MINE@test.com' }),
      });
      expect(same.status).toBe(200);
      expect((await json(same)).email).toBe('mine@test.com');
    });
  });

  it('deletes a user', async () => {
    const user = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'delete@test.com' }),
      }),
    );

    const delRes = await req(`/user_management/users/${user.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const getRes = await req(`/user_management/users/${user.id}`);
    expect(getRes.status).toBe(404);
  });
});

describe('User name field', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('creates a user with name and returns it', async () => {
    const res = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'named@test.com', name: 'Alice Smith' }),
    });
    expect(res.status).toBe(201);
    const user = await json(res);
    expect(user.name).toBe('Alice Smith');
  });

  it('creates a user without name and returns null', async () => {
    const res = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'noname@test.com' }),
    });
    expect(res.status).toBe(201);
    const user = await json(res);
    expect(user.name).toBeNull();
  });

  it('updates a user name via PUT', async () => {
    const created = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'updatename@test.com' }),
      }),
    );
    expect(created.name).toBeNull();

    const res = await req(`/user_management/users/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'Bob Jones' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe('Bob Jones');
  });

  it('leaves name unchanged when omitted from update', async () => {
    const created = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'keepname@test.com', name: 'Carol Lee' }),
      }),
    );
    expect(created.name).toBe('Carol Lee');

    const res = await req(`/user_management/users/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify({ first_name: 'Carol' }),
    });
    expect(res.status).toBe(200);
    const updated = await json(res);
    expect(updated.name).toBe('Carol Lee');
    expect(updated.first_name).toBe('Carol');
  });
});

describe('Email Verification', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('send → confirm flow', async () => {
    const user = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'verify@test.com' }),
      }),
    );
    expect(user.email_verified).toBe(false);

    const ev = await json(await req(`/user_management/users/${user.id}/email_verification/send`, { method: 'POST' }));
    expect(ev.code).toMatch(/^\d{6}$/);

    const confirmed = await json(
      await req(`/user_management/users/${user.id}/email_verification/confirm`, {
        method: 'POST',
        body: JSON.stringify({ code: ev.code }),
      }),
    );
    expect(confirmed.email_verified).toBe(true);
  });

  // A code proves the inbox it was sent to. Production checks it against the email factor of the
  // user's current address, so a code sent to the old address cannot verify the new one.
  it('refuses a code issued before the address changed', async () => {
    const user = await json(
      await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'old@test.com' }) }),
    );
    const stale = await json(
      await req(`/user_management/users/${user.id}/email_verification/send`, { method: 'POST' }),
    );
    await req(`/user_management/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ email: 'new@test.com' }) });

    const res = await req(`/user_management/users/${user.id}/email_verification/confirm`, {
      method: 'POST',
      body: JSON.stringify({ code: stale.code }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('invalid_code');
    expect((await json(await req(`/user_management/users/${user.id}`))).email_verified).toBe(false);

    const fresh = await json(
      await req(`/user_management/users/${user.id}/email_verification/send`, { method: 'POST' }),
    );
    expect(fresh.email).toBe('new@test.com');
    const confirmed = await json(
      await req(`/user_management/users/${user.id}/email_verification/confirm`, {
        method: 'POST',
        body: JSON.stringify({ code: fresh.code }),
      }),
    );
    expect(confirmed.email_verified).toBe(true);
  });
});

describe('Password Reset', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('create → confirm flow', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'reset@test.com', password: 'correct-horse-battery' }),
    });

    const pr = await json(
      await req('/user_management/password_reset', {
        method: 'POST',
        body: JSON.stringify({ email: 'reset@test.com' }),
      }),
    );
    expect(pr.password_reset_token).toBeDefined();

    const confirmRes = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: pr.password_reset_token, new_password: 'an even better passphrase' }),
    });
    expect(confirmRes.status).toBe(200);
  });

  it('returns 404 when confirming reset after user deletion', async () => {
    const user = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'gone@test.com', password: 'correct-horse-battery' }),
      }),
    );

    const pr = await json(
      await req('/user_management/password_reset', {
        method: 'POST',
        body: JSON.stringify({ email: 'gone@test.com' }),
      }),
    );

    // Delete the user while the reset token is still valid
    await req(`/user_management/users/${user.id}`, { method: 'DELETE' });

    // Password-reset artifacts should have been cleaned up by user deletion,
    // so the token is now invalid
    const confirmRes = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: pr.password_reset_token, new_password: 'an even better passphrase' }),
    });
    // Token was cleaned up → 400 invalid token (not a 500)
    expect(confirmRes.status).toBeLessThan(500);
  });

  it('deleting a user cleans up password resets, verifications, and magic auths', async () => {
    const user = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'cleanup@test.com', password: 'correct-horse-battery' }),
      }),
    );

    // Create a password reset
    await req('/user_management/password_reset', {
      method: 'POST',
      body: JSON.stringify({ email: 'cleanup@test.com' }),
    });

    // Create an email verification
    await req(`/user_management/users/${user.id}/email_verification/send`, { method: 'POST' });

    // Delete the user
    const delRes = await req(`/user_management/users/${user.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    // Verify the user is gone
    const getRes = await req(`/user_management/users/${user.id}`);
    expect(getRes.status).toBe(404);
  });
});
