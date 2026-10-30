import { describe, it, expect, beforeEach } from 'bun:test';
import { ConflictException } from '@workos-inc/node';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin, seedFromConfig } from '../index.js';
import { sdkClient } from '../sdk.test-utils.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_org', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Data Integrations routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];

  beforeEach(() => {
    ({ app, store } = createTestApp());
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('authorize redirects with code', async () => {
    const res = await app.request(
      '/data-integrations/salesforce/authorize?redirect_uri=http://localhost:3000/callback&state=xyz',
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).toContain('code=');
    expect(location).toContain('state=xyz');
  });

  it('authorize rejects missing redirect_uri', async () => {
    const res = await app.request('/data-integrations/salesforce/authorize');
    expect(res.status).toBe(400);
  });

  it('authorize rejects non-localhost redirect_uri', async () => {
    const res = await app.request('/data-integrations/salesforce/authorize?redirect_uri=https://evil.com/callback');
    expect(res.status).toBe(400);
  });

  it('exchanges code for token', async () => {
    // First authorize to get a code
    const authRes = await app.request(
      '/data-integrations/salesforce/authorize?redirect_uri=http://localhost:3000/callback',
      { redirect: 'manual' },
    );
    const location = authRes.headers.get('Location')!;
    const code = new URL(location).searchParams.get('code')!;

    // Exchange code
    const tokenRes = await req('/data-integrations/salesforce/token', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    expect(tokenRes.status).toBe(200);
    const data = await json(tokenRes);
    expect(data.access_token).toBeDefined();
    expect(data.token_type).toBe('bearer');
  });

  it('rejects invalid code', async () => {
    const res = await req('/data-integrations/salesforce/token', {
      method: 'POST',
      body: JSON.stringify({ code: 'invalid_code' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects code reuse', async () => {
    const authRes = await app.request(
      '/data-integrations/github/authorize?redirect_uri=http://localhost:3000/callback',
      { redirect: 'manual' },
    );
    const code = new URL(authRes.headers.get('Location')!).searchParams.get('code')!;

    // First use succeeds
    await req('/data-integrations/github/token', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });

    // Second use fails
    const res = await req('/data-integrations/github/token', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    expect(res.status).toBe(400);
  });

  describe('connected-account access tokens', () => {
    let userId: string;

    beforeEach(async () => {
      const user = await json(
        await req('/user_management/users', {
          method: 'POST',
          body: JSON.stringify({ email: 'pipes@acme.test' }),
        }),
      );
      userId = user.id;
    });

    async function importAccount(body: Record<string, unknown>, organizationId?: string) {
      const query = organizationId ? `?organization_id=${organizationId}` : '';
      const res = await req(`/user_management/users/${userId}/connected_accounts/github${query}`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
    }

    const token = (body: Record<string, unknown>) =>
      req('/data-integrations/github/token', { method: 'POST', body: JSON.stringify(body) });

    it('returns imported credentials in the shape decoded by @workos-inc/node', async () => {
      const expiresAt = new Date(Date.now() + 3_600_000);
      await importAccount({
        access_token: 'github_imported_token',
        refresh_token: 'private_refresh_token',
        expires_at: expiresAt.toISOString(),
        scopes: ['repo', 'user:email'],
      });

      const workos = sdkClient(app, 'sk_test_org');
      expect(await workos.pipes.getAccessToken({ provider: 'github', userId })).toEqual({
        active: true,
        accessToken: {
          object: 'access_token',
          accessToken: 'github_imported_token',
          expiresAt,
          scopes: ['repo', 'user:email'],
          missingScopes: [],
        },
      });
    });

    it('filters by organization_id: a lone account resolves unscoped, several must name one', async () => {
      const workos = sdkClient(app, 'sk_test_org');
      const org = await workos.organizations.createOrganization({ name: 'Acme' });
      const otherOrg = await workos.organizations.createOrganization({ name: 'Other' });
      const otherUser = await workos.userManagement.createUser({ email: 'other@acme.test' });
      await importAccount({ access_token: 'org_token' }, org.id);

      for (const organizationId of [undefined, null, org.id]) {
        expect(await workos.pipes.getAccessToken({ provider: 'github', userId, organizationId })).toMatchObject({
          active: true,
          accessToken: { accessToken: 'org_token', expiresAt: null, scopes: [] },
        });
      }
      for (const options of [
        { provider: 'github', userId: otherUser.id },
        { provider: 'slack', userId },
        { provider: 'github', userId, organizationId: otherOrg.id },
      ]) {
        expect(await workos.pipes.getAccessToken(options)).toEqual({ active: false, error: 'not_installed' });
      }

      // A second installation makes the unscoped lookup ambiguous: the spec's 409.
      await importAccount({ access_token: 'other_org_token' }, otherOrg.id);
      await expect(workos.pipes.getAccessToken({ provider: 'github', userId })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(
        await workos.pipes.getAccessToken({ provider: 'github', userId, organizationId: otherOrg.id }),
      ).toMatchObject({ active: true, accessToken: { accessToken: 'other_org_token' } });
    });

    it('returns not_installed for missing and disconnected accounts', async () => {
      const workos = sdkClient(app, 'sk_test_org');
      expect(await workos.pipes.getAccessToken({ provider: 'github', userId })).toEqual({
        active: false,
        error: 'not_installed',
      });
      await importAccount({ access_token: 'disconnected_token' });
      await req(`/user_management/users/${userId}/connected_accounts/github`, { method: 'DELETE' });
      expect(await workos.pipes.getAccessToken({ provider: 'github', userId })).toEqual({
        active: false,
        error: 'not_installed',
      });
    });

    it.each([
      { state: 'needs_reauthorization', access_token: 'stale_token' },
      { access_token: 'expired_token', expires_at: '2000-01-01T00:00:00.000Z' },
      { state: 'connected', access_token: 'expired_token', expires_at: '2000-01-01T00:00:00.000Z' },
    ])('requires reauthorization when the credentials cannot be refreshed: %j', async (account) => {
      await importAccount(account);
      const workos = sdkClient(app, 'sk_test_org');
      expect(await workos.pipes.getAccessToken({ provider: 'github', userId })).toEqual({
        active: false,
        error: 'needs_reauthorization',
      });
      // An account that was still `connected` flips, as production's failed refresh would.
      expect(await workos.pipes.getUserConnectedAccount({ userId, slug: 'github' })).toMatchObject({
        state: 'needs_reauthorization',
      });
    });

    it.each([
      { access_token: 'expired_token', refresh_token: 'refresh_token', expires_at: '2000-01-01T00:00:00.000Z' },
      { refresh_token: 'refresh_token' },
    ])('refreshes locally when a refresh token is present: %j', async (account) => {
      await importAccount({ ...account, scopes: ['repo'] });
      const workos = sdkClient(app, 'sk_test_org');
      const result = await workos.pipes.getAccessToken({ provider: 'github', userId });
      expect(result).toMatchObject({
        active: true,
        accessToken: { accessToken: expect.stringMatching(/^di_mock_github_/), scopes: ['repo'] },
      });
      const { expiresAt } = (result as Extract<typeof result, { active: true }>).accessToken;
      expect(expiresAt!.getTime()).toBeGreaterThan(Date.now());
      // The refreshed token is stored, so the next call returns the same one.
      expect(await workos.pipes.getAccessToken({ provider: 'github', userId })).toEqual(result);
    });

    it('exercises the reauthorization cycle: revoke through state, reconnect through a replacement token', async () => {
      await importAccount({
        access_token: 'old_token',
        refresh_token: 'refresh_token',
        expires_at: '2000-01-01T00:00:00.000Z',
      });
      const workos = sdkClient(app, 'sk_test_org');
      const getToken = () => workos.pipes.getAccessToken({ provider: 'github', userId });
      expect(await getToken()).toMatchObject({ active: true });

      // The emulator cannot see a provider revoke a grant; the account's state is how a test says so.
      await workos.pipes.updateUserConnectedAccount({ userId, slug: 'github', state: 'needs_reauthorization' });
      expect(await getToken()).toEqual({ active: false, error: 'needs_reauthorization' });

      // Re-authorizing replaces the token. Its expiry is the one sent with it — here none — not the
      // refreshed token's, which would otherwise expire the reconnected account an hour later.
      await workos.pipes.updateUserConnectedAccount({ userId, slug: 'github', accessToken: 'fresh_token' });
      expect(await getToken()).toMatchObject({
        active: true,
        accessToken: { accessToken: 'fresh_token', expiresAt: null },
      });
    });

    it('mints a non-expiring token for a connected account that was never given credentials', async () => {
      // Both a bare `state: connected` import and a seeded account store no tokens.
      await importAccount({ state: 'connected' });
      seedFromConfig(store, 'http://localhost:0', {
        users: [{ email: 'seeded@acme.test' }],
        connectedAccounts: [{ email: 'seeded@acme.test', provider: 'slack', scopes: ['chat:write'] }],
      });
      const workos = sdkClient(app, 'sk_test_org');
      const seeded = (await workos.userManagement.listUsers({ email: 'seeded@acme.test' })).data[0]!;

      for (const [provider, id, scopes] of [
        ['github', userId, []],
        ['slack', seeded.id, ['chat:write']],
      ] as const) {
        const result = await workos.pipes.getAccessToken({ provider, userId: id });
        expect(result).toMatchObject({
          active: true,
          accessToken: {
            accessToken: expect.stringMatching(new RegExp(`^di_mock_${provider}_`)),
            expiresAt: null,
            scopes,
          },
        });
        expect(await workos.pipes.getAccessToken({ provider, userId: id })).toEqual(result);
      }
    });

    it('requires user_id when no legacy code is given', async () => {
      const res = await token({});
      expect(res.status).toBe(422);
      expect(await json(res)).toMatchObject({ errors: [{ field: 'user_id', code: 'required' }] });
    });

    it('rejects nonexistent users and organizations', async () => {
      expect((await token({ user_id: 'user_missing' })).status).toBe(404);
      expect((await token({ user_id: userId, organization_id: 'org_missing' })).status).toBe(404);
    });

    it.each(['', 123, null])('rejects invalid user IDs: %j', async (userId) => {
      expect((await token({ user_id: userId })).status).toBe(422);
    });

    it.each(['', 123])('rejects invalid organization IDs: %j', async (organizationId) => {
      expect((await token({ user_id: userId, organization_id: organizationId })).status).toBe(422);
    });

    it('requires an API key', async () => {
      const res = await app.request('/data-integrations/github/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: userId }),
      });
      expect(res.status).toBe(401);
    });
  });

  describe('credentials', () => {
    let userId: string;
    let organizationId: string;

    beforeEach(async () => {
      const user = await json(
        await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'member@acme.test' }) }),
      );
      const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) }));
      userId = user.id;
      organizationId = org.id;
      const membership = await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, organization_id: organizationId }),
      });
      expect(membership.status).toBe(201);
    });

    const organizationOwner = () => ({
      connection_owner: 'organization',
      organization_id: organizationId,
      user_id: userId,
    });
    const credentials = (body: Record<string, unknown>) =>
      req('/data-integrations/google-calendar/credentials', { method: 'POST', body: JSON.stringify(body) });
    const organizationAccount = () => `/organizations/${organizationId}/connected_accounts/google-calendar`;

    it('vends the organization’s token, then reports reauthorization and disconnection', async () => {
      expect(await json(await credentials(organizationOwner()))).toEqual({ active: false, error: 'not_installed' });
      const imported = await req(organizationAccount(), {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, access_token: 'ya29.org', scopes: ['calendar'] }),
      });
      expect(imported.status).toBe(201);

      expect(await json(await credentials(organizationOwner()))).toEqual({
        active: true,
        credential: {
          object: 'credential',
          auth_method: 'oauth',
          value: 'ya29.org',
          expires_at: null,
          scopes: ['calendar'],
          missing_scopes: [],
          config: {},
        },
      });

      await req(organizationAccount(), {
        method: 'PUT',
        body: JSON.stringify({ user_id: userId, state: 'needs_reauthorization' }),
      });
      expect(await json(await credentials(organizationOwner()))).toEqual({
        active: false,
        error: 'needs_reauthorization',
      });

      expect((await req(organizationAccount(), { method: 'DELETE' })).status).toBe(204);
      expect(await json(await credentials(organizationOwner()))).toEqual({ active: false, error: 'not_installed' });
    });

    it('vends a user’s own token through the SDK, apart from the organization’s', async () => {
      await req(`/user_management/users/${userId}/connected_accounts/google-calendar`, {
        method: 'POST',
        body: JSON.stringify({ access_token: 'ya29.personal' }),
      });

      const workos = sdkClient(app, 'sk_test_org');
      const vended = await workos.pipes.createDataIntegrationCredential({ slug: 'google-calendar', userId });
      expect(vended).toMatchObject({ active: true, credential: { authMethod: 'oauth', value: 'ya29.personal' } });
      expect(await json(await credentials(organizationOwner()))).toEqual({ active: false, error: 'not_installed' });
    });

    it('requires an active membership of the organization named, for either owner', async () => {
      const outsider = await json(
        await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email: 'outsider@acme.test' }) }),
      );
      const refused = await credentials({ ...organizationOwner(), user_id: outsider.id });
      expect(refused.status).toBe(403);
      expect(await json(refused)).toEqual({
        message: `User '${outsider.id}' is not an active member of organization '${organizationId}'.`,
      });
      // An organization-scoped personal connection is held to the same rule.
      expect((await credentials({ user_id: outsider.id, organization_id: organizationId })).status).toBe(403);
    });

    it('requires the membership of a scoped personal account the request does not name', async () => {
      await req(
        `/user_management/users/${userId}/connected_accounts/google-calendar?organization_id=${organizationId}`,
        {
          method: 'POST',
          body: JSON.stringify({ access_token: 'ya29.scoped' }),
        },
      );
      expect((await json(await credentials({ user_id: userId }))).active).toBe(true);

      const memberships = await json(await req(`/user_management/organization_memberships?user_id=${userId}`));
      await req(`/user_management/organization_memberships/${memberships.data[0].id}/deactivate`, { method: 'PUT' });
      expect((await credentials({ user_id: userId })).status).toBe(403);
    });

    it.each([
      [{}, 'user_id must be a string'],
      [
        { user_id: 'user_x', connection_owner: 'team' },
        'connection_owner must be one of the following values: user, organization',
      ],
      [
        { user_id: 'user_x', connection_owner: 'organization' },
        'organization_id is required when connection_owner is organization',
      ],
      [{ user_id: 'user_x', organization_id: 7 }, 'organization_id must be a string'],
    ])('rejects a malformed owner: %j', async (body, message) => {
      const res = await credentials(body);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ message, error: 'Bad Request' });
    });

    it('404s an unknown user or organization', async () => {
      expect((await credentials({ user_id: 'user_missing' })).status).toBe(404);
      const res = await credentials({ ...organizationOwner(), organization_id: 'org_missing' });
      expect(res.status).toBe(404);
      expect(await json(res)).toMatchObject({ code: 'entity_not_found' });
    });

    it('requires an API key', async () => {
      const res = await app.request('/data-integrations/google-calendar/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(organizationOwner()),
      });
      expect(res.status).toBe(401);
    });
  });
});
