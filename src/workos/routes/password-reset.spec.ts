import { describe, it, expect, beforeEach } from 'vitest';
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
        body: JSON.stringify({ email: 'reset@test.com', password: 'oldpassword' }),
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
