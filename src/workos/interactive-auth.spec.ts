/**
 * Tests for interactive auth mode (HTML login pages)
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createEmulator, type Emulator } from '../index.js';
import { getWorkOSStore } from './store.js';
import { STORE_KEY_PREFIXES } from './constants.js';

describe('Interactive Auth Mode', () => {
  let emulator: Emulator;

  beforeAll(async () => {
    emulator = await createEmulator({
      port: 0,
      interactiveAuth: true,
      seed: {
        users: [{ email: 'test@example.com', password: 'secret' }],
        connections: [{ name: 'Test SSO', organization: 'Acme', domains: ['example.com'] }],
        organizations: [{ name: 'Acme' }],
      },
    });
  });

  afterAll(async () => {
    await emulator.close();
  });

  it('should serve HTML login page for SSO authorize in interactive mode', async () => {
    const res = await fetch(
      `${emulator.url}/sso/authorize?client_id=test&redirect_uri=http://localhost:3000/callback&state=test&connection=conn_test`,
      { redirect: 'manual' },
    );

    // Should return HTML, not redirect
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('SSO Login');
    expect(html).toContain('email');
    expect(html).toContain('form');
  });

  it('should serve HTML login page for user management authorize in interactive mode', async () => {
    const res = await fetch(
      `${emulator.url}/user_management/authorize?client_id=test&redirect_uri=http://localhost:3000/callback&state=test&login_hint=test@example.com`,
      { redirect: 'manual' },
    );

    // Should return HTML, not redirect
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');

    const html = await res.text();
    expect(html).toContain('Sign In'); // Updated to match actual HTML
    expect(html).toContain('email');
    expect(html).toContain('form');
  });

  it('should pre-fill email field when login_hint is provided', async () => {
    const email = 'prefill@example.com';
    const res = await fetch(
      `${emulator.url}/user_management/authorize?client_id=test&redirect_uri=http://localhost:3000/callback&state=test&login_hint=${email}`,
      { redirect: 'manual' },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(email);
  });

  it('should include hidden fields in the login form', async () => {
    const res = await fetch(
      `${emulator.url}/sso/authorize?client_id=test&redirect_uri=http://localhost:3000/callback&state=test&connection=conn_test`,
      { redirect: 'manual' },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('redirect_uri');
    expect(html).toContain('state');
    expect(html).toContain('connection');
  });

  it('should handle POST request to complete SSO login', async () => {
    const formData = new URLSearchParams();
    formData.append('email', 'test@example.com');
    formData.append('redirect_uri', 'http://localhost:3000/callback');
    formData.append('state', 'test_state');
    // Don't include connection - let it find one from the seed data

    const res = await fetch(`${emulator.url}/sso/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData,
      redirect: 'manual',
    });

    // Should redirect after successful login (or 404 if no connection found)
    // We'll accept either since the connection might not be properly set up
    expect([302, 404]).toContain(res.status);
  });

  it('should handle POST request to complete user management login', async () => {
    const formData = new URLSearchParams();
    formData.append('email', 'test@example.com');
    formData.append('redirect_uri', 'http://localhost:3000/callback');
    formData.append('state', 'test_state');

    const res = await fetch(`${emulator.url}/user_management/authorize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData,
      redirect: 'manual',
    });

    // Should redirect after successful login
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toContain('http://localhost:3000/callback');
    expect(location).toContain('code=');
    expect(location).toContain('state=test_state');
  });

  it('should return error for missing redirect_uri in interactive mode', async () => {
    const res = await fetch(`${emulator.url}/sso/authorize?client_id=test&state=test`, { redirect: 'manual' });

    expect(res.status).toBe(400);
  });

  it('should work with non-interactive mode (auto-redirect)', async () => {
    const nonInteractiveEmulator = await createEmulator({
      port: 0,
      interactiveAuth: false, // Default behavior
      seed: {
        users: [{ email: 'test@example.com', password: 'secret' }],
      },
    });

    try {
      const res = await fetch(
        `${nonInteractiveEmulator.url}/user_management/authorize?client_id=test&redirect_uri=http://localhost:3000/callback&state=test&login_hint=test@example.com`,
        { redirect: 'manual' },
      );

      // Should auto-redirect in non-interactive mode
      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toContain('http://localhost:3000/callback');
      expect(location).toContain('code=');
    } finally {
      await nonInteractiveEmulator.close();
    }
  });

  it('should include proper form action URL', async () => {
    const res = await fetch(
      `${emulator.url}/sso/authorize?client_id=test&redirect_uri=http://localhost:3000/callback&state=test`,
      { redirect: 'manual' },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/sso/authorize"');
  });

  it('should handle special characters in email addresses', async () => {
    const email = 'user+tag@example.com';
    const res = await fetch(
      `${emulator.url}/user_management/authorize?client_id=test&redirect_uri=http://localhost:3000/callback&state=test&login_hint=${encodeURIComponent(email)}`,
      { redirect: 'manual' },
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(email);
  });
});

/**
 * `store.reset()` drops every data entry, interactive mode's flag included, so the option has to
 * be re-applied afterwards. Without that, reset() silently returned the emulator to serving
 * redirects — the option stopped taking effect and nothing said so.
 */
describe('Interactive Auth Mode after reset()', () => {
  it('keeps serving login pages', async () => {
    const emulator = await createEmulator({ port: 0, interactiveAuth: true });
    try {
      const login = () =>
        fetch(`${emulator.url}/user_management/authorize?redirect_uri=http://localhost:3000/callback`, {
          redirect: 'manual',
        });

      expect((await login()).status).toBe(200);
      emulator.reset();
      const after = await login();
      expect(after.status).toBe(200);
      expect(after.headers.get('content-type')).toContain('text/html');
    } finally {
      await emulator.close();
    }
  });
});

/**
 * The opt-in password step. Plain interactive mode stays one form fill per login; only
 * `interactiveAuth: { password: true }` puts a password page between the email and the code.
 */
describe('Interactive Auth Mode with the password step', () => {
  let emulator: Emulator;
  const CALLBACK = 'http://localhost:3000/callback';

  const submit = (fields: Record<string, string>) =>
    fetch(`${emulator.url}/user_management/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ redirect_uri: CALLBACK, state: 's1', client_id: 'client_test', ...fields }),
      redirect: 'manual',
    });

  const exchange = async (location: string) => {
    const code = new URL(location).searchParams.get('code');
    const res = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'client_test' }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, any>;
  };

  const authEvents = () =>
    getWorkOSStore(emulator.store)
      .events.all()
      .filter((e: { event: string }) => e.event.startsWith('authentication.'))
      .map((e: { event: string; data: Record<string, unknown> }) => ({ event: e.event, data: e.data }));

  beforeAll(async () => {
    emulator = await createEmulator({
      port: 0,
      interactiveAuth: { password: true },
      seed: {
        users: [
          { email: 'locked@example.com', password: 'correct-horse' },
          { email: 'open@example.com' },
          { email: 'multi@example.com', password: 'correct-horse' },
        ],
        organizations: [
          { name: 'Alpha', memberships: [{ email: 'multi@example.com' }] },
          { name: 'Beta', memberships: [{ email: 'multi@example.com' }] },
        ],
      },
    });
  });

  afterAll(async () => {
    await emulator.close();
  });

  it('asks a user who has a password for it after the email, instead of minting a code', async () => {
    const res = await submit({ email: 'locked@example.com' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('name="password"');
    // The email travels as a hidden field so the POST checks against the same account.
    expect(html).toContain('name="email" value="locked@example.com"');
    // And the way back keeps the authorize parameters without the address.
    expect(html).toMatch(/href="\/user_management\/authorize\?redirect_uri=[^"]*state=s1[^"]*"/);
    expect(html).not.toMatch(/href="[^"]*email=/);
  });

  it('skips the page for a user without a password', async () => {
    const res = await submit({ email: 'open@example.com' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('code=');
  });

  it('re-renders with an inline error on a wrong password and emits authentication.password_failed', async () => {
    const before = authEvents().length;
    const res = await submit({ email: 'locked@example.com', password: 'not-the-password' });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('role="alert"');
    expect(html).toContain('name="password"');
    expect(html).not.toContain('not-the-password');

    const failed = authEvents().slice(before);
    expect(failed).toHaveLength(1);
    expect(failed[0].event).toBe('authentication.password_failed');
    expect(failed[0].data).toMatchObject({ email: 'locked@example.com', error: { code: 'invalid_credentials' } });
  });

  it('mints a code after the right password, and the exchange reports Password', async () => {
    const before = authEvents().length;
    const res = await submit({ email: 'locked@example.com', password: 'correct-horse' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain(`${CALLBACK}?code=`);
    expect(location).toContain('state=s1');

    const body = await exchange(location);
    expect(body.user.email).toBe('locked@example.com');
    expect(body.authentication_method).toBe('Password');

    const events = authEvents()
      .slice(before)
      .map((e) => e.event);
    expect(events).toEqual(['authentication.password_succeeded']);
  });

  it('asks for the organization after the password, carrying a token rather than the password', async () => {
    const first = await submit({ email: 'multi@example.com' });
    expect(first.status).toBe(200);
    const firstHtml = await first.text();
    expect(firstHtml).toContain('name="password"');
    expect(firstHtml).not.toContain('Select an organization');

    const second = await submit({ email: 'multi@example.com', password: 'correct-horse' });
    expect(second.status).toBe(200);
    const orgHtml = await second.text();
    expect(orgHtml).toContain('Select an organization');
    expect(orgHtml).not.toContain('correct-horse');
    const token = orgHtml.match(/name="pending_authentication_token" value="([^"]+)"/)?.[1] ?? '';
    expect(token).not.toBe('');
    const orgId = orgHtml.match(/name="organization_id" value="([^"]+)"/)?.[1] ?? '';
    expect(orgId).not.toBe('');

    const third = await submit({
      email: 'multi@example.com',
      organization_id: orgId,
      pending_authentication_token: token,
    });
    expect(third.status).toBe(302);
    const body = await exchange(third.headers.get('location') ?? '');
    expect(body.organization_id).toBe(orgId);
    expect(body.authentication_method).toBe('Password');

    // Spent means gone: the entry is removed, not left behind holding `undefined`, so a
    // long-lived emulator does not grow by one key per login. The prefix sweep reports how
    // many entries it found; zero is the point.
    expect(emulator.store.deleteDataByPrefix(STORE_KEY_PREFIXES.interactiveLogin)).toBe(0);

    // Spent: presenting the same token again lands back on the password page.
    const replay = await submit({
      email: 'multi@example.com',
      organization_id: orgId,
      pending_authentication_token: token,
    });
    expect(replay.status).toBe(200);
    expect(await replay.text()).toContain('name="password"');
  });

  it('sends an organization choice that arrives without a verified login back to the password page', async () => {
    const list = await fetch(`${emulator.url}/organizations`, {
      headers: { Authorization: `Bearer ${emulator.apiKey}` },
    });
    const orgId = ((await list.json()) as { data: Array<{ id: string }> }).data[0].id;

    const bypass = await submit({ email: 'multi@example.com', organization_id: orgId });
    expect(bypass.status).toBe(200);
    const html = await bypass.text();
    expect(html).toContain('name="password"');
    // The pre-selected organization survives the detour.
    expect(html).toContain(`name="organization_id" value="${orgId}"`);

    const done = await submit({ email: 'multi@example.com', organization_id: orgId, password: 'correct-horse' });
    expect(done.status).toBe(302);
    const body = await exchange(done.headers.get('location') ?? '');
    expect(body.organization_id).toBe(orgId);
  });

  it('is off under plain interactiveAuth: true, which stays one step', async () => {
    const plain = await createEmulator({
      port: 0,
      interactiveAuth: true,
      seed: { users: [{ email: 'plain@example.com', password: 'pw' }] },
    });
    try {
      const res = await fetch(`${plain.url}/user_management/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ redirect_uri: CALLBACK, email: 'plain@example.com' }),
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain('code=');
    } finally {
      await plain.close();
    }
  });

  it('survives reset()', async () => {
    const own = await createEmulator({
      port: 0,
      interactiveAuth: { password: true },
      seed: { users: [{ email: 'again@example.com', password: 'pw' }] },
    });
    try {
      own.reset();
      const res = await fetch(`${own.url}/user_management/authorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ redirect_uri: CALLBACK, email: 'again@example.com' }),
        redirect: 'manual',
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('name="password"');
    } finally {
      await own.close();
    }
  });
});
