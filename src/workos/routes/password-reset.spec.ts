import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';
import type { Store } from '../../core/index.js';

const apiKeys: ApiKeyMap = { sk_test_pwreset: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_pwreset', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Password reset routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  const eventsNamed = (name: string) =>
    getWorkOSStore(store)
      .events.all()
      .filter((e) => e.event === name);

  async function createUserAndRequestReset() {
    const user = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'reset@test.com', password: 'oldpassword', email_verified: true }),
      }),
    );
    const reset = await json(
      await req('/user_management/password_reset', {
        method: 'POST',
        body: JSON.stringify({ email: 'reset@test.com' }),
      }),
    );
    return { user, reset };
  }

  // Resolving the account case-insensitively means lowercasing the address, so a type-asserted
  // non-string reached `.toLowerCase()` and this came back a 500 rather than a named 400.
  it('rejects a non-string email with 400, not 500', async () => {
    const res = await req('/user_management/password_reset', {
      method: 'POST',
      body: JSON.stringify({ email: 123 }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toBe('email must be a string');
  });

  it('still reports an absent email as absent', async () => {
    const res = await req('/user_management/password_reset', { method: 'POST', body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toBe('email is required');
  });

  it('resolves the account by any casing of its address', async () => {
    await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'Mixed@Reset.test' }) });
    const res = await req('/user_management/password_reset', {
      method: 'POST',
      body: JSON.stringify({ email: 'mixed@reset.test' }),
    });
    expect(res.status).toBe(201);
    // The reset is recorded against the stored casing, not the one the caller sent.
    expect((await json(res)).email).toBe('Mixed@Reset.test');
  });

  it('emits password_reset.created when a reset is requested', async () => {
    const { user } = await createUserAndRequestReset();

    const [event] = eventsNamed('password_reset.created');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({ user_id: user.id, email: 'reset@test.com' });
  });

  it('emits password_reset.succeeded on confirm and the new password works', async () => {
    const { reset } = await createUserAndRequestReset();

    const confirmRes = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: reset.token, new_password: 'newpassword' }),
    });
    expect(confirmRes.status).toBe(200);

    const [event] = eventsNamed('password_reset.succeeded');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({ email: 'reset@test.com' });

    const authRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'reset@test.com', password: 'newpassword' }),
    });
    expect(authRes.status).toBe(200);
  });

  it('rejects an invalid token without emitting password_reset.succeeded', async () => {
    await createUserAndRequestReset();

    const confirmRes = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: 'bogus', new_password: 'newpassword' }),
    });
    expect(confirmRes.status).toBe(400);
    expect(eventsNamed('password_reset.succeeded')).toHaveLength(0);
  });
});
