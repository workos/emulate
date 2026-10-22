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
      last_verified_at: new Date().toISOString(),
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

  const insertChallenge = (factor: { id: string; user_id: string }, code: string, expiresInMs = 600_000) =>
    getWorkOSStore(store).authChallenges.insert({
      object: 'authentication_challenge',
      user_id: factor.user_id,
      factor_id: factor.id,
      expires_at: new Date(Date.now() + expiresInMs).toISOString(),
      code,
      attempts: 0,
      verified_at: null,
    });
  const verify = (challengeId: string, code: string) =>
    req(`/auth/challenges/${challengeId}/verify`, { method: 'POST', body: JSON.stringify({ code }) });

  it('verifies a challenge with correct code', async () => {
    const { factor } = seedUserWithFactor();
    const challenge = insertChallenge(factor, '999999');

    const res = await verify(challenge.id, '999999');
    // 201, the Nest default for a POST, which is what production answers and the spec documents.
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.valid).toBe(true);
    expect(body.challenge.id).toBe(challenge.id);
  });

  // Production reports a wrong code as a verification that ran and answered no — `valid: false`
  // in the same 201 envelope — not as an error. Its errors are for a challenge that cannot be
  // verified at all.
  it('answers a wrong code with valid: false rather than an error', async () => {
    const { factor } = seedUserWithFactor();
    const challenge = insertChallenge(factor, '111111');

    const res = await verify(challenge.id, '000000');
    expect(res.status).toBe(201);
    expect(await json(res)).toMatchObject({ valid: false, challenge: { id: challenge.id } });
  });

  it('refuses an expired challenge with 422 authentication_challenge_expired', async () => {
    const { factor } = seedUserWithFactor();
    const challenge = insertChallenge(factor, '123456', -1000);

    const res = await verify(challenge.id, '123456');
    expect(res.status).toBe(422);
    expect(await json(res)).toEqual({
      code: 'authentication_challenge_expired',
      message: `The authentication challenge '${challenge.id}' has expired.`,
    });
  });

  it('refuses a challenge already verified with 422 authentication_challenge_previously_verified', async () => {
    const { factor } = seedUserWithFactor();
    const challenge = insertChallenge(factor, '123456');
    expect((await json(await verify(challenge.id, '123456'))).valid).toBe(true);

    // Right code or wrong, the challenge is spent: already-verified is checked before the code.
    for (const code of ['123456', '000000']) {
      const res = await verify(challenge.id, code);
      expect(res.status, code).toBe(422);
      expect(await json(res)).toEqual({
        code: 'authentication_challenge_previously_verified',
        message: `The authentication challenge '${challenge.id}' has already been verified.`,
      });
    }
  });

  it('locks the challenge after three wrong codes, even against the right one', async () => {
    const { factor } = seedUserWithFactor();
    const challenge = insertChallenge(factor, '123456');

    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await verify(challenge.id, '000000');
      expect(res.status, `attempt ${attempt}`).toBe(201);
      expect((await json(res)).valid, `attempt ${attempt}`).toBe(false);
    }

    // The fourth comparison never happens: production's verifier refuses the challenge outright,
    // with the authenticate grants' code at the 400 it keeps for compatibility.
    const res = await verify(challenge.id, '123456');
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      code: 'one_time_code_too_many_attempts',
      message: 'One-time code has had too many failed attempts.',
    });
  });

  // Each request reads the challenge only after its body has been read, so overlapping guesses
  // each see the misses before them: four at once still leave exactly one locked out.
  it('counts overlapping wrong codes separately', async () => {
    const { factor } = seedUserWithFactor();
    const challenge = insertChallenge(factor, '123456');

    const results = await Promise.all(Array.from({ length: 4 }, () => verify(challenge.id, '000000')));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 400]);
    expect(getWorkOSStore(store).authChallenges.get(challenge.id)!.attempts).toBe(3);
  });

  it('verifying a challenge is what verifies its factor', async () => {
    const { factor } = seedUserWithFactor();
    const ws = getWorkOSStore(store);
    ws.authFactors.update(factor.id, { last_verified_at: null });
    const challenge = insertChallenge(factor, '123456');

    await verify(challenge.id, '000000');
    expect(ws.authFactors.get(factor.id)!.last_verified_at).toBeNull();

    await verify(challenge.id, '123456');
    expect(ws.authFactors.get(factor.id)!.last_verified_at).toEqual(expect.any(String));
  });

  it('returns 404 for nonexistent factor', async () => {
    const res = await req('/auth/factors/auth_factor_bogus/challenge', {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
