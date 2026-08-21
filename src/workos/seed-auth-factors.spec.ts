/**
 * Seeding TOTP authentication factors. Every other authentication method a user can hold is
 * seedable (`password`, `oauth_provider`), and with in-memory state a factor enrolled over
 * HTTP after boot does not survive a restart while the seeded users do. `totp: true` writes
 * the same record `POST /user_management/users/{id}/auth_factors` writes, so ListAuthFactors
 * reports it and a password sign-in walks the spec's `mfa_challenge` step-up — no post-boot
 * enrollment calls.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createEmulator, type Emulator } from '../index.js';
import { getWorkOSStore } from './store.js';
import { validateSeedConfig } from './config-validator.js';

const PINNED_USER_ID = 'user_01SEEDTOTP0000000000000000';

describe('Seeding TOTP authentication factors', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

  it("reports the seeded factor with the enrollment route's shape", async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ id: PINNED_USER_ID, email: 'alice@acme.com', password: 'test123', totp: true }],
      },
    });

    const res = await fetch(`${emulator.url}/user_management/users/${PINNED_USER_ID}/auth_factors`, {
      headers: auth(emulator.apiKey),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(1);

    const factor = body.data[0];
    expect(factor.object).toBe('authentication_factor');
    expect(factor.id).toMatch(/^auth_factor_/);
    expect(factor.type).toBe('totp');
    expect(factor.totp.issuer).toBe('WorkOS Emulator');
    expect(factor.totp.user).toBe('alice@acme.com');
    expect(factor.totp.uri).toStartWith('otpauth://totp/');
  });

  it('drives the password grant through the mfa_challenge step-up', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'mfa@acme.com', password: 'test123', email_verified: true, totp: true }],
      },
    });

    // The seeded factor is an enrolled second factor: no session until it clears.
    const passwordRes = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'mfa@acme.com', password: 'test123' }),
    });
    expect(passwordRes.status).toBe(403);
    const challengeBody = (await passwordRes.json()) as any;
    expect(challengeBody.code).toBe('mfa_challenge');

    // The response withholds the one-time code, as production does; read it off the challenge.
    const ws = getWorkOSStore(emulator.store);
    const challengeCode = ws.authChallenges.get(challengeBody.authentication_challenge.id)!.code;

    const mfaRes = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:workos:oauth:grant-type:mfa-totp',
        code: challengeCode,
        pending_authentication_token: challengeBody.pending_authentication_token,
        authentication_challenge_id: challengeBody.authentication_challenge.id,
      }),
    });
    expect(mfaRes.status).toBe(200);
    const session = (await mfaRes.json()) as any;
    expect(session.user.email).toBe('mfa@acme.com');
    // The session reports the primary factor the pending token recorded.
    expect(session.authentication_method).toBe('Password');
  });

  it('does not enroll a factor for users the seed left alone', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [
          { id: PINNED_USER_ID, email: 'plain@acme.com', password: 'test123' },
          { email: 'enrolled@acme.com', totp: true },
        ],
      },
    });

    const res = await fetch(`${emulator.url}/user_management/users/${PINNED_USER_ID}/auth_factors`, {
      headers: auth(emulator.apiKey),
    });
    const body = (await res.json()) as any;
    expect(body.data).toEqual([]);
  });

  it('accepts a boolean totp and rejects anything else', () => {
    const ok = validateSeedConfig({ users: [{ email: 'a@b.co', totp: true }] });
    expect(ok.valid).toBe(true);

    const bad = validateSeedConfig({ users: [{ email: 'a@b.co', totp: 'yes' as unknown as boolean }] });
    expect(bad.valid).toBe(false);
    expect(bad.errors[0].path).toBe('users[0].totp');
  });
});
