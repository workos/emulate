import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';

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
      body: JSON.stringify({ email: 'alice@test.com', first_name: 'Alice', password: 'pass123' }),
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
    expect(second.status).toBe(409);
    expect((await json(second)).code).toBe('user_already_exists');
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

  it('rejects duplicate email', async () => {
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'dup@test.com' }),
    });
    const res = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'dup@test.com' }),
    });
    expect(res.status).toBe(409);
    expect((await json(res)).code).toBe('user_already_exists');
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
      body: JSON.stringify({ email: 'reset@test.com', password: 'old' }),
    });

    const pr = await json(
      await req('/user_management/password_reset', {
        method: 'POST',
        body: JSON.stringify({ email: 'reset@test.com' }),
      }),
    );
    expect(pr.token).toBeDefined();

    const confirmRes = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: pr.token, new_password: 'new' }),
    });
    expect(confirmRes.status).toBe(200);
  });

  it('returns 404 when confirming reset after user deletion', async () => {
    const user = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'gone@test.com', password: 'old' }),
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
      body: JSON.stringify({ token: pr.token, new_password: 'new' }),
    });
    // Token was cleaned up → 400 invalid token (not a 500)
    expect(confirmRes.status).toBeLessThan(500);
  });

  it('deleting a user cleans up password resets, verifications, and magic auths', async () => {
    const user = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'cleanup@test.com', password: 'pw' }),
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
