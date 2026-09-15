/**
 * The wire contract every backend SDK derives from the spec (workos/emulate#110): enrollment
 * answers `{ authentication_factor, authentication_challenge }` with the factor's TOTP secrets,
 * and only enrollment does — GET and LIST strip them.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';

const apiKeys: ApiKeyMap = { sk_test_mfa: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_mfa', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Auth factor routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let userId: string;

  beforeEach(async () => {
    app = createTestApp().app;
    const res = await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'mfa@test.com', password: 'a strong enough passphrase', email_verified: true }),
    });
    userId = (await json(res)).id;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;
  const enroll = (body: Record<string, unknown> = { type: 'totp' }) =>
    req(`/user_management/users/${userId}/auth_factors`, { method: 'POST', body: JSON.stringify(body) });

  it('enrolls inside the spec envelope, with the secrets and the enrollment challenge', async () => {
    const res = await enroll({ type: 'totp', totp_issuer: 'Acme', totp_user: 'alice' });
    expect(res.status).toBe(201);
    const { authentication_factor: factor, authentication_challenge: challenge, ...rest } = await json(res);
    expect(rest).toEqual({});

    expect(factor.object).toBe('authentication_factor');
    expect(factor.type).toBe('totp');
    expect(factor.user_id).toBe(userId);
    expect(factor.totp.issuer).toBe('Acme');
    expect(factor.totp.user).toBe('alice');
    // 32 Base32 characters: what authenticator apps and TOTP libraries accept verbatim.
    expect(factor.totp.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(factor.totp.uri).toBe(`otpauth://totp/Acme:alice?secret=${factor.totp.secret}&issuer=Acme`);
    expect(factor.totp.qr_code).toStartWith('data:image/png;base64,');

    expect(challenge.object).toBe('authentication_challenge');
    expect(challenge.authentication_factor_id).toBe(factor.id);
    expect(challenge.expires_at).toBeTruthy();
    expect(challenge).not.toHaveProperty('code');
  });

  it('honors a caller-supplied Base32 secret and rejects one that is not', async () => {
    const ok = await enroll({ type: 'totp', totp_secret: 'JBSWY3DPEHPK3PXP' });
    expect(ok.status).toBe(201);
    const { authentication_factor: factor } = await json(ok);
    expect(factor.totp.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(factor.totp.uri).toContain('secret=JBSWY3DPEHPK3PXP');

    for (const totp_secret of ['not base32!', 234567]) {
      const bad = await enroll({ type: 'totp', totp_secret });
      expect(bad.status, `totp_secret ${JSON.stringify(totp_secret)}`).toBe(422);
      expect((await json(bad)).code).toBe('invalid_totp_secret');
    }
  });

  it('defaults the TOTP account name to the user email', async () => {
    const { authentication_factor: factor } = await json(await enroll());
    expect(factor.totp.user).toBe('mfa@test.com');
  });

  it('lists factors without their secrets', async () => {
    await enroll();
    const res = await req(`/user_management/users/${userId}/auth_factors`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toHaveLength(1);
    expect(body.data[0].totp).toEqual({ issuer: 'WorkOS Emulator', user: 'mfa@test.com' });
  });

  it('answers 404 for an unknown user', async () => {
    const res = await req('/user_management/users/user_nope/auth_factors', {
      method: 'POST',
      body: JSON.stringify({ type: 'totp' }),
    });
    expect(res.status).toBe(404);
  });
});
