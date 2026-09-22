import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_org', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Client API token', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let jwt: ReturnType<typeof createTestApp>['jwt'];
  let organizationId: string;
  let userId: string;

  beforeEach(async () => {
    const testApp = createTestApp();
    app = testApp.app;
    jwt = testApp.jwt;

    // Created through the API rather than the store, so the fixtures stay valid as the
    // organization and user entities gain fields.
    const create = async (path: string, body: unknown) => {
      const res = await app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
      return (await res.json()) as any;
    };
    organizationId = (await create('/organizations', { name: 'Acme' })).id;
    userId = (await create('/user_management/users', { email: 'alice@acme.com' })).id;
  });

  const post = (body: unknown) => app.request('/client/token', { method: 'POST', headers, body: JSON.stringify(body) });
  const json = (res: Response) => res.json() as Promise<any>;

  it('mints a token scoped to the organization and user', async () => {
    const res = await post({ organization_id: organizationId, user_id: userId });
    expect(res.status).toBe(201);

    const body = await json(res);
    expect(Object.keys(body)).toEqual(['token']);

    const claims = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
    expect(claims.sub).toBe(userId);
    expect(claims.org_id).toBe(organizationId);
    expect(claims.aud).toBe('client');
    expect(claims.exp - claims.iat).toBe(300);
  });

  it('signs with the emulator key, so the token verifies', async () => {
    const { token } = await json(await post({ organization_id: organizationId, user_id: userId }));
    expect(jwt.verify(token).sub).toBe(userId);
  });

  it('requires organization_id and user_id', async () => {
    expect((await post({ user_id: userId })).status).toBe(422);
    expect((await post({ organization_id: organizationId })).status).toBe(422);
    expect((await post({ organization_id: '', user_id: userId })).status).toBe(422);
    expect((await post({ organization_id: organizationId, user_id: 42 })).status).toBe(422);
  });

  it('404s an unknown organization or user', async () => {
    expect((await post({ organization_id: 'org_nope', user_id: userId })).status).toBe(404);
    expect((await post({ organization_id: organizationId, user_id: 'user_nope' })).status).toBe(404);
  });
});
