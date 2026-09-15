import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';
import type { Store } from '../../core/index.js';

const apiKeys: ApiKeyMap = { sk_test_mfa: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_mfa', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Auth challenge routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  function seedUserWithFactor() {
    const ws = getWorkOSStore(store);
    const user = ws.users.insert({
      object: 'user',
      name: null,
      email: 'mfa@test.com',
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
    const factor = ws.authFactors.insert({
      object: 'authentication_factor',
      user_id: user.id,
      type: 'totp',
      totp: { issuer: 'Test', user: user.email, secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://totp/test' },
    });
    return { user, factor };
  }

  it('creates a challenge for a factor', async () => {
    const { factor } = seedUserWithFactor();

    const res = await req(`/auth/factors/${factor.id}/challenge`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.object).toBe('authentication_challenge');
    expect(body.authentication_factor_id).toBe(factor.id);
    // The store's join columns are not part of the spec's challenge.
    expect(body).not.toHaveProperty('factor_id');
    expect(body).not.toHaveProperty('user_id');
    expect(body).not.toHaveProperty('code');
  });

  it('verifies a challenge with correct code', async () => {
    const { factor } = seedUserWithFactor();
    const ws = getWorkOSStore(store);

    // Create a challenge directly
    const challenge = ws.authChallenges.insert({
      object: 'authentication_challenge',
      user_id: factor.user_id,
      factor_id: factor.id,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      code: '999999',
    });

    const res = await req(`/auth/challenges/${challenge.id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ code: '999999' }),
    });
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.valid).toBe(true);
  });

  it('rejects invalid code', async () => {
    const { factor } = seedUserWithFactor();
    const ws = getWorkOSStore(store);

    const challenge = ws.authChallenges.insert({
      object: 'authentication_challenge',
      user_id: factor.user_id,
      factor_id: factor.id,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      code: '111111',
    });

    const res = await req(`/auth/challenges/${challenge.id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ code: '000000' }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('invalid_one_time_code');
  });

  it('rejects expired challenge', async () => {
    const { factor } = seedUserWithFactor();
    const ws = getWorkOSStore(store);

    const challenge = ws.authChallenges.insert({
      object: 'authentication_challenge',
      user_id: factor.user_id,
      factor_id: factor.id,
      expires_at: new Date(Date.now() - 1000).toISOString(), // expired
      code: '123456',
    });

    const res = await req(`/auth/challenges/${challenge.id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ code: '123456' }),
    });
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('expired_challenge');
  });

  it('returns 404 for nonexistent factor', async () => {
    const res = await req('/auth/factors/auth_factor_bogus/challenge', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
