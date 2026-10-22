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
        body: JSON.stringify({ email: 'reset@test.com', password: 'correct-horse-battery', email_verified: true }),
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

  // Issue #98: the SDKs deserialize `password_reset_token` and `password_reset_url`. A bare
  // `token` left `passwordResetToken` undefined, and the resetPassword call built on it failed.
  it('returns the spec-shaped password reset', async () => {
    const { user, reset } = await createUserAndRequestReset();

    expect(reset.object).toBe('password_reset');
    expect(reset.id).toMatch(/^password_reset_/);
    expect(reset.user_id).toBe(user.id);
    expect(reset.email).toBe('reset@test.com');
    expect(reset.password_reset_token).toMatch(/^[0-9a-f]{32}$/);
    // The link points at the emulator (the test server's base URL) and carries the token under
    // the `token` query parameter the confirm endpoint documents.
    expect(reset.password_reset_url).toBe(
      `http://localhost:0/user_management/password_reset/confirm?token=${reset.password_reset_token}`,
    );
    expect(Object.keys(reset).sort()).toEqual([
      'created_at',
      'email',
      'expires_at',
      'id',
      'object',
      'password_reset_token',
      'password_reset_url',
      'user_id',
    ]);
  });

  // The link is `${baseUrl}/path`, so a base URL written with a trailing slash would double it
  // — the server normalizes the option, and this pins that the link still names the endpoint.
  it('does not double the slash when the base URL ends in one', async () => {
    const trailing = createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0/', apiKeys });
    const post = (path: string, body: unknown) =>
      trailing.app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });

    await post('/user_management/users', { email: 'slash@test.com' });
    const reset = await json(await post('/user_management/password_reset', { email: 'slash@test.com' }));
    expect(reset.password_reset_url).toBe(
      `http://localhost:0/user_management/password_reset/confirm?token=${reset.password_reset_token}`,
    );
  });

  it('returns the same shape when fetched by id', async () => {
    const { reset } = await createUserAndRequestReset();

    const res = await req(`/user_management/password_reset/${reset.id}`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual(reset);
  });

  it('delivers the token under its spec name in password_reset.created', async () => {
    const { reset } = await createUserAndRequestReset();

    const [event] = eventsNamed('password_reset.created');
    expect(event.data.password_reset_token).toBe(reset.password_reset_token);
    expect(event.data.password_reset_url).toBe(reset.password_reset_url);
    expect(event.data).not.toHaveProperty('token');
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
      body: JSON.stringify({ token: reset.password_reset_token, new_password: 'an even better passphrase' }),
    });
    expect(confirmRes.status).toBe(200);

    const [event] = eventsNamed('password_reset.succeeded');
    expect(event).toBeDefined();
    expect(event.data).toMatchObject({ email: 'reset@test.com' });

    const authRes = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'reset@test.com', password: 'an even better passphrase' }),
    });
    expect(authRes.status).toBe(200);
  });

  // Production looks the user up by the token, so a token it never issued is a 404 for the user.
  it('404s an unknown token without emitting password_reset.succeeded', async () => {
    await createUserAndRequestReset();

    const confirmRes = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: 'bogus', new_password: 'an even better passphrase' }),
    });
    expect(confirmRes.status).toBe(404);
    expect(await json(confirmRes)).toEqual({
      message: "Could not locate user with provided token: 'bogus'",
      code: 'password_reset_token_not_found',
    });
    expect(eventsNamed('password_reset.succeeded')).toHaveLength(0);
  });

  it('issues a token that lasts 15 minutes, as production does', async () => {
    const { reset } = await createUserAndRequestReset();
    const ttl = new Date(reset.expires_at).getTime() - new Date(reset.created_at).getTime();
    expect(ttl).toBeGreaterThan(14 * 60 * 1000);
    expect(ttl).toBeLessThanOrEqual(15 * 60 * 1000);
  });

  it('reports an expired token inside password_reset_error', async () => {
    const { reset } = await createUserAndRequestReset();
    const stored = getWorkOSStore(store).passwordResets.get(reset.id)!;
    getWorkOSStore(store).passwordResets.update(stored.id, { expires_at: new Date(Date.now() - 1000).toISOString() });

    const confirmRes = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: reset.password_reset_token, new_password: 'an even better passphrase' }),
    });
    expect(confirmRes.status).toBe(400);
    expect(await json(confirmRes)).toEqual({
      message: 'Could not reset password.',
      code: 'password_reset_error',
      errors: [{ code: 'password_reset_token_expired', message: 'The password reset token has expired.' }],
    });
    expect(eventsNamed('password_reset.succeeded')).toHaveLength(0);
  });

  // The reset applies the same policy as user creation; its failures ride in the reset's own
  // error, after an expired token when both apply.
  it('holds the new password to the password policy', async () => {
    const { reset } = await createUserAndRequestReset();

    const confirmRes = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: reset.password_reset_token, new_password: 'password123' }),
    });
    expect(confirmRes.status).toBe(400);
    const body = await json(confirmRes);
    expect(body.code).toBe('password_reset_error');
    expect(body.errors.map((e: any) => e.code)).toEqual(['password_too_weak']);

    // The token survives a refused attempt, so a stronger password still goes through.
    const retry = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: reset.password_reset_token, new_password: 'an even better passphrase' }),
    });
    expect(retry.status).toBe(200);
  });

  it('signs the user out everywhere: a live session and its refresh token stop working', async () => {
    const { user, reset } = await createUserAndRequestReset();
    const authenticate = (body: Record<string, unknown>) =>
      app.request('/user_management/authenticate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    const signedIn = await json(
      await authenticate({ grant_type: 'password', email: user.email, password: 'correct-horse-battery' }),
    );
    expect(signedIn.refresh_token).toBeDefined();
    const ws = getWorkOSStore(store);
    const [session] = ws.sessions.findBy('user_id', user.id);
    expect(session).toBeDefined();
    // An agent session delegated from that sign-in, as a user_delegated mint chains one to the
    // backing user session; minting one for real needs a blueprint, instance and token exchange,
    // so the row is written directly with the link the revocation walks.
    const delegated = ws.agentInstanceSessions.insert({
      object: 'agent_instance_session',
      agent_instance_id: 'agent_instance_delegated',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      revoked_at: null,
      refresh_token: 'agent-refresh-token',
      parent_session_id: null,
      user_session_id: session.id,
      permissions: [],
      intent: null,
    });

    const confirmRes = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: reset.password_reset_token, new_password: 'an even better passphrase' }),
    });
    expect(confirmRes.status).toBe(200);

    // The session is ended the way a revoke ends it, so its refresh token is refused like an
    // unknown one, the agent session delegated from it is revoked with it, and the old password
    // no longer signs in.
    expect(ws.sessions.findBy('user_id', user.id)).toHaveLength(0);
    expect(eventsNamed('session.revoked')).toHaveLength(1);
    expect(ws.agentInstanceSessions.get(delegated.id)!.revoked_at).not.toBeNull();
    const refreshed = await authenticate({ grant_type: 'refresh_token', refresh_token: signedIn.refresh_token });
    expect(refreshed.status).toBe(400);
    expect((await json(refreshed)).error).toBe('invalid_grant');
    const oldPassword = await authenticate({
      grant_type: 'password',
      email: user.email,
      password: 'correct-horse-battery',
    });
    expect(oldPassword.status).toBe(400);
    expect((await json(oldPassword)).code).toBe('invalid_credentials');
  });

  it('spends the token and verifies the email', async () => {
    const user = await json(
      await req('/user_management/users', {
        method: 'POST',
        body: JSON.stringify({ email: 'unverified@test.com', password: 'correct-horse-battery' }),
      }),
    );
    expect(user.email_verified).toBe(false);
    const reset = await json(
      await req('/user_management/password_reset', { method: 'POST', body: JSON.stringify({ email: user.email }) }),
    );

    const confirmRes = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: reset.password_reset_token, new_password: 'an even better passphrase' }),
    });
    expect(confirmRes.status).toBe(200);
    // Production serializes the user it looked up by the token, so the response predates the reset.
    expect((await json(confirmRes)).user).toMatchObject({ object: 'user', id: user.id, email_verified: false });
    expect((await json(await req(`/user_management/users/${user.id}`))).email_verified).toBe(true);

    const replay = await req('/user_management/password_reset/confirm', {
      method: 'POST',
      body: JSON.stringify({ token: reset.password_reset_token, new_password: 'an even better passphrase' }),
    });
    expect(replay.status).toBe(404);
  });
});
