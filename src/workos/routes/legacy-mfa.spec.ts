import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_org', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Legacy MFA routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  beforeEach(() => {
    app = createTestApp().app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('enrolls a TOTP factor', async () => {
    const res = await req('/auth/factors/enroll', {
      method: 'POST',
      body: JSON.stringify({ type: 'totp', totp_issuer: 'TestApp', totp_user: 'user@test.com' }),
    });
    expect(res.status).toBe(201);
    const factor = await json(res);
    expect(factor.object).toBe('authentication_factor');
    expect(factor.type).toBe('totp');
    expect(factor.id).toMatch(/^auth_factor_/);
    // Enrollment is the one response that shows the secrets; GET strips them.
    expect(factor.totp.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(factor.totp.qr_code).toStartWith('data:image/png;base64,');
    const got = await json(await req(`/auth/factors/${factor.id}`));
    expect(got.totp).toEqual({ issuer: 'TestApp', user: 'user@test.com' });
  });

  it('gets a factor by id', async () => {
    const createRes = await req('/auth/factors/enroll', {
      method: 'POST',
      body: JSON.stringify({ type: 'totp' }),
    });
    const factor = await json(createRes);

    const res = await req(`/auth/factors/${factor.id}`);
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe(factor.id);
  });

  it('returns 404 for nonexistent factor', async () => {
    const res = await req('/auth/factors/auth_factor_nonexistent');
    expect(res.status).toBe(404);
  });

  it('deletes a factor', async () => {
    const createRes = await req('/auth/factors/enroll', {
      method: 'POST',
      body: JSON.stringify({ type: 'totp' }),
    });
    const factor = await json(createRes);

    const delRes = await req(`/auth/factors/${factor.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const getRes = await req(`/auth/factors/${factor.id}`);
    expect(getRes.status).toBe(404);
  });

  it('creates and verifies a challenge', async () => {
    const factorRes = await req('/auth/factors/enroll', {
      method: 'POST',
      body: JSON.stringify({ type: 'totp' }),
    });
    const factor = await json(factorRes);

    const challengeRes = await req(`/auth/factors/${factor.id}/challenge`, { method: 'POST' });
    expect(challengeRes.status).toBe(201);
    const challenge = await json(challengeRes);
    expect(challenge.object).toBe('authentication_challenge');

    // The challenge withholds its code, so a guess is the only code this test has; production
    // answers a wrong one as a verification that ran and said no, not as an error.
    const verifyRes = await req(`/auth/challenges/${challenge.id}/verify`, {
      method: 'POST',
      body: JSON.stringify({ code: '000000' }),
    });
    expect(verifyRes.status).toBe(201);
    expect(await json(verifyRes)).toMatchObject({ valid: false, challenge: { id: challenge.id } });
  });

  it('returns 404 for nonexistent challenge', async () => {
    const res = await req('/auth/challenges/auth_challenge_nonexistent/verify', {
      method: 'POST',
      body: JSON.stringify({ code: '123456' }),
    });
    expect(res.status).toBe(404);
  });
});
