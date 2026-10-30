/**
 * Pipes connected accounts. The spec models them on
 * `/user_management/users/{user_id}/connected_accounts/{slug}` and
 * `/organizations/{organization_id}/connected_accounts/{slug}`, each with all four verbs: GET,
 * POST (import with OAuth tokens), PUT (update tokens/scopes/state), DELETE (disconnect).
 * A user's accounts are keyed by (user, slug, organization scope) and an organization's by
 * (organization, slug). Both can be seeded, and state transitions emit the spec's
 * `pipes.connected_account.*` events.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin, seedFromConfig, type WorkOSSeedConfig } from '../index.js';
import { getWorkOSStore } from '../store.js';
import { validateSeedConfig } from '../config-validator.js';

const apiKeys: ApiKeyMap = { sk_test_ca: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_ca', 'Content-Type': 'application/json' };

// The spec's ConnectedAccount, exactly: no envelope, no provider (the URL names it), no tokens.
const RESPONSE_KEYS = [
  'api_key_last_4',
  'auth_method',
  'created_at',
  'established_by_user_id',
  'id',
  'object',
  'organization_id',
  'scopes',
  'state',
  'updated_at',
  'user_id',
];

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Connected account routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];

  beforeEach(() => {
    const result = createTestApp();
    app = result.app;
    store = result.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;
  const seed = (config: WorkOSSeedConfig) => seedFromConfig(store, 'http://localhost:0', config);
  const eventsNamed = (name: string) =>
    getWorkOSStore(store)
      .events.all()
      .filter((e) => e.event === name);

  async function createUser(email: string) {
    return json(await req('/user_management/users', { method: 'POST', body: JSON.stringify({ email }) }));
  }

  describe('seeding', () => {
    it('answers the endpoint from a seeded account, in the spec shape', async () => {
      seed({
        users: [{ email: 'pipes@acme.test' }],
        connectedAccounts: [{ email: 'pipes@acme.test', provider: 'github', scopes: ['repo', 'user:email'] }],
      });
      const user = getWorkOSStore(store).users.findOneBy('email', 'pipes@acme.test')!;

      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`);
      expect(res.status).toBe(200);
      const account = await json(res);
      expect(Object.keys(account).sort()).toEqual(RESPONSE_KEYS);
      expect(account.object).toBe('connected_account');
      expect(account.id).toStartWith('data_installation_');
      expect(account.user_id).toBe(user.id);
      expect(account.organization_id).toBeNull();
      expect(account.scopes).toEqual(['repo', 'user:email']);
      expect(account.auth_method).toBe('oauth');
      expect(account.api_key_last_4).toBeNull();
      expect(account.state).toBe('connected');
    });

    it('resolves an org-scoped seed with or without its organization_id named', async () => {
      seed({
        users: [{ email: 'scoped@acme.test' }],
        organizations: [{ name: 'Acme' }, { name: 'Other' }],
        connectedAccounts: [{ email: 'scoped@acme.test', provider: 'slack', organization: 'Acme' }],
      });
      const ws = getWorkOSStore(store);
      const user = ws.users.findOneBy('email', 'scoped@acme.test')!;
      const org = ws.organizations.findOneBy('name', 'Acme')!;
      const other = ws.organizations.findOneBy('name', 'Other')!;

      // organization_id filters rather than keys: the lone account is the match either way.
      for (const qs of ['', `?organization_id=${org.id}`]) {
        const res = await req(`/user_management/users/${user.id}/connected_accounts/slack${qs}`);
        expect(res.status).toBe(200);
        expect((await json(res)).organization_id).toBe(org.id);
      }
      expect(
        (await req(`/user_management/users/${user.id}/connected_accounts/slack?organization_id=${other.id}`)).status,
      ).toBe(404);
    });

    it('preserves a seeded needs_reauthorization state and emits its event', async () => {
      seed({
        users: [{ email: 'stale@acme.test' }],
        connectedAccounts: [{ email: 'stale@acme.test', provider: 'github', state: 'needs_reauthorization' }],
      });
      const user = getWorkOSStore(store).users.findOneBy('email', 'stale@acme.test')!;

      const account = await json(await req(`/user_management/users/${user.id}/connected_accounts/github`));
      expect(account.state).toBe('needs_reauthorization');

      const events = eventsNamed('pipes.connected_account.reauthorization_needed');
      expect(events).toHaveLength(1);
    });

    it('emits pipes.connected_account.connected with the event-only fields', async () => {
      seed({
        users: [{ email: 'events@acme.test' }],
        connectedAccounts: [{ email: 'events@acme.test', provider: 'notion' }],
      });

      const events = eventsNamed('pipes.connected_account.connected');
      expect(events).toHaveLength(1);
      const data = events[0].data as Record<string, unknown>;
      expect(data.provider_slug).toBe('notion');
      expect(data.data_integration_id).toStartWith('data_integration_');
      expect(data.state).toBe('connected');
      // No leakage of internal storage into the event either.
      expect(data).not.toContainKey('provider');
      expect(data).not.toContainKey('access_token');
    });

    it('rejects references and states the emulator could not honor', () => {
      const base = { users: [{ email: 'known@acme.test' }] };

      const unknownUser = validateSeedConfig({
        ...base,
        connectedAccounts: [{ email: 'ghost@acme.test', provider: 'github' }],
      });
      expect(unknownUser.valid).toBe(false);
      expect(unknownUser.errors[0].path).toBe('connectedAccounts[0].email');

      const unknownOrg = validateSeedConfig({
        ...base,
        connectedAccounts: [{ email: 'known@acme.test', provider: 'github', organization: 'Nowhere' }],
      });
      expect(unknownOrg.valid).toBe(false);
      expect(unknownOrg.errors[0].path).toBe('connectedAccounts[0].organization');

      const badState = validateSeedConfig({
        ...base,
        connectedAccounts: [{ email: 'known@acme.test', provider: 'github', state: 'disconnected' as never }],
      });
      expect(badState.valid).toBe(false);
      expect(badState.errors[0].path).toBe('connectedAccounts[0].state');

      const duplicate = validateSeedConfig({
        ...base,
        connectedAccounts: [
          { email: 'known@acme.test', provider: 'github' },
          { email: 'known@acme.test', provider: 'github' },
        ],
      });
      expect(duplicate.valid).toBe(false);
      expect(duplicate.errors[0].path).toBe('connectedAccounts[1]');
    });

    it('seeds an organization-owned account, with or without who established it', async () => {
      seed({
        users: [{ email: 'admin@acme.test' }],
        organizations: [{ name: 'Acme' }, { name: 'Globex' }],
        connectedAccounts: [
          { owner: 'organization', organization: 'Acme', provider: 'google-calendar', email: 'admin@acme.test' },
          {
            owner: 'organization',
            organization: 'Globex',
            provider: 'google-calendar',
            state: 'needs_reauthorization',
          },
        ],
      });
      const ws = getWorkOSStore(store);
      const [acme, globex] = ['Acme', 'Globex'].map((name) => ws.organizations.findOneBy('name', name)!);
      const read = async (orgId: string) =>
        json(await req(`/organizations/${orgId}/connected_accounts/google-calendar`));

      expect(await read(acme.id)).toMatchObject({
        user_id: null,
        established_by_user_id: ws.users.findOneBy('email', 'admin@acme.test')!.id,
        state: 'connected',
      });
      expect(await read(globex.id)).toMatchObject({ established_by_user_id: null, state: 'needs_reauthorization' });
    });

    it('validates organization-owned seed entries', () => {
      const base = { users: [{ email: 'admin@acme.test' }], organizations: [{ name: 'Acme' }] };
      const errors = (connectedAccounts: unknown[]) =>
        validateSeedConfig({ ...base, connectedAccounts } as WorkOSSeedConfig).errors.map((e) => [e.path, e.message]);

      expect(errors([{ owner: 'organization', organization: 'Acme', provider: 'google-calendar' }])).toEqual([]);
      expect(errors([{ owner: 'organization', provider: 'google-calendar' }])).toEqual([
        ['connectedAccounts[0].organization', 'organization is required when owner is "organization"'],
      ]);
      expect(errors([{ owner: 'team', email: 'admin@acme.test', provider: 'google-calendar' }])).toEqual([
        ['connectedAccounts[0].owner', 'owner must be "user" or "organization" if provided'],
      ]);
      expect(
        errors([
          { owner: 'organization', organization: 'Acme', provider: 'google-calendar' },
          { owner: 'organization', organization: 'Acme', provider: 'google-calendar', email: 'admin@acme.test' },
          { email: 'admin@acme.test', organization: 'Acme', provider: 'google-calendar' },
        ]),
      ).toEqual([
        ['connectedAccounts[1]', 'duplicate organization-owned connected account for this provider and organization'],
      ]);
    });
  });

  describe('GET', () => {
    it('404s on an unknown user, a missing account, and an unknown organization', async () => {
      expect((await req('/user_management/users/user_none/connected_accounts/github')).status).toBe(404);

      const user = await createUser('bare@test.com');
      const missing = await req(`/user_management/users/${user.id}/connected_accounts/github`);
      expect(missing.status).toBe(404);
      // Production names the whole lookup triple as the entity id.
      expect(await json(missing)).toEqual({
        message: `Data Installation not found: 'slug=github userland_user_id=${user.id} organization_id=null'.`,
        code: 'entity_not_found',
        entity_id: `slug=github userland_user_id=${user.id} organization_id=null`,
      });

      const res = await req(`/user_management/users/${user.id}/connected_accounts/github?organization_id=org_none`);
      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({
        message: "Organization not found: 'org_none'.",
        code: 'entity_not_found',
        entity_id: 'org_none',
      });
    });
  });

  describe('POST (import)', () => {
    it('imports an account from an access token and derives connected', async () => {
      const user = await createUser('import@test.com');
      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'POST',
        body: JSON.stringify({ access_token: 'gho_abc123', scopes: ['repo'] }),
      });
      expect(res.status).toBe(201);
      const account = await json(res);
      expect(Object.keys(account).sort()).toEqual(RESPONSE_KEYS);
      expect(account.state).toBe('connected');
      expect(account.scopes).toEqual(['repo']);

      const found = await json(await req(`/user_management/users/${user.id}/connected_accounts/github`));
      expect(found.id).toBe(account.id);

      expect(eventsNamed('pipes.connected_account.connected')).toHaveLength(1);
    });

    it('derives needs_reauthorization from an expired token with no refresh token', async () => {
      const user = await createUser('expired@test.com');
      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'POST',
        body: JSON.stringify({ access_token: 'gho_old', expires_at: '2020-01-01T00:00:00.000Z' }),
      });
      expect((await json(res)).state).toBe('needs_reauthorization');
      expect(eventsNamed('pipes.connected_account.reauthorization_needed')).toHaveLength(1);
    });

    it('derives connected from an expired token that can refresh', async () => {
      const user = await createUser('refresh@test.com');
      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'POST',
        body: JSON.stringify({
          access_token: 'gho_old',
          refresh_token: 'ghr_new',
          expires_at: '2020-01-01T00:00:00.000Z',
        }),
      });
      expect((await json(res)).state).toBe('connected');
    });

    it('honors an explicit state over derivation', async () => {
      const user = await createUser('explicit@test.com');
      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'POST',
        body: JSON.stringify({ access_token: 'gho_fresh', state: 'needs_reauthorization' }),
      });
      expect((await json(res)).state).toBe('needs_reauthorization');
    });

    it('422s an import that carries neither a state nor a token', async () => {
      const user = await createUser('empty@test.com');
      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'POST',
        body: JSON.stringify({ scopes: ['repo'] }),
      });
      expect(res.status).toBe(422);
    });

    it('409s a second import for the same user, provider, and scope', async () => {
      const user = await createUser('dupe@test.com');
      const body = { method: 'POST', body: JSON.stringify({ access_token: 'gho_x' }) };
      expect((await req(`/user_management/users/${user.id}/connected_accounts/github`, body)).status).toBe(201);
      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, body);
      expect(res.status).toBe(409);
    });

    it('keeps one provider’s installations apart by scope, and 409s an unscoped lookup across several', async () => {
      seed({ organizations: [{ name: 'Acme' }, { name: 'Other' }] });
      const ws = getWorkOSStore(store);
      const org = ws.organizations.findOneBy('name', 'Acme')!;
      const other = ws.organizations.findOneBy('name', 'Other')!;
      const user = await createUser('both@test.com');

      const post = (qs: string) =>
        req(`/user_management/users/${user.id}/connected_accounts/github${qs}`, {
          method: 'POST',
          body: JSON.stringify({ access_token: 'gho_x' }),
        });
      // Import keys by exact scope, so a second organization is a new account, not a 409.
      expect((await post(`?organization_id=${org.id}`)).status).toBe(201);
      expect((await post(`?organization_id=${other.id}`)).status).toBe(201);

      const scoped = await json(
        await req(`/user_management/users/${user.id}/connected_accounts/github?organization_id=${org.id}`),
      );
      expect(scoped.organization_id).toBe(org.id);

      // Several installations match the user and provider: the spec says one must be named.
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
          method,
          ...(method === 'PUT' ? { body: JSON.stringify({ scopes: ['repo'] }) } : {}),
        });
        expect(res.status).toBe(409);
      }

      // One provider, one integration: both installations install the same data integration.
      const rows = ws.connectedAccounts.findBy('user_id', user.id);
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((r) => r.data_integration_id)).size).toBe(1);
    });
  });

  describe('PUT (update)', () => {
    it('updates scopes without touching state or emitting a transition event', async () => {
      const user = await createUser('scopes@test.com');
      await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'POST',
        body: JSON.stringify({ access_token: 'gho_old', expires_at: '2020-01-01T00:00:00.000Z' }),
      });

      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'PUT',
        body: JSON.stringify({ scopes: ['repo', 'workflow'] }),
      });
      expect(res.status).toBe(200);
      const account = await json(res);
      expect(account.scopes).toEqual(['repo', 'workflow']);
      expect(account.state).toBe('needs_reauthorization');

      // Import emitted one reauthorization event; the scopes-only update must not add another.
      expect(eventsNamed('pipes.connected_account.reauthorization_needed')).toHaveLength(1);
      expect(eventsNamed('pipes.connected_account.connected')).toHaveLength(0);
    });

    it('reconnects a needs_reauthorization account given a fresh token, emitting connected', async () => {
      const user = await createUser('reconnect@test.com');
      await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'POST',
        body: JSON.stringify({ access_token: 'gho_old', expires_at: '2020-01-01T00:00:00.000Z' }),
      });

      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'PUT',
        body: JSON.stringify({ access_token: 'gho_new' }),
      });
      expect((await json(res)).state).toBe('connected');
      expect(eventsNamed('pipes.connected_account.connected')).toHaveLength(1);

      // The replacement was sent without an expiry, so the old token's must not linger on the row.
      const row = getWorkOSStore(store).connectedAccounts.findBy('user_id', user.id)[0]!;
      expect(row).toMatchObject({ access_token: 'gho_new', token_expires_at: null });
    });

    it('keeps a retained refresh token in view when an update re-derives state', async () => {
      const user = await createUser('retained@test.com');
      await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'POST',
        body: JSON.stringify({ access_token: 'gho_1', refresh_token: 'ghr_1' }),
      });

      // The replacement access token is already expired, but the stored refresh token still refreshes it.
      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'PUT',
        body: JSON.stringify({ access_token: 'gho_2', expires_at: '2020-01-01T00:00:00.000Z' }),
      });
      expect((await json(res)).state).toBe('connected');
      expect(eventsNamed('pipes.connected_account.reauthorization_needed')).toHaveLength(0);
    });

    it('derives needs_reauthorization from an expiry-only update that leaves no working token', async () => {
      const user = await createUser('expiry@test.com');
      await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'POST',
        body: JSON.stringify({ access_token: 'gho_1' }),
      });

      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'PUT',
        body: JSON.stringify({ expires_at: '2020-01-01T00:00:00.000Z' }),
      });
      expect((await json(res)).state).toBe('needs_reauthorization');
      expect(eventsNamed('pipes.connected_account.reauthorization_needed')).toHaveLength(1);
    });

    it('404s an update for an account that does not exist', async () => {
      const user = await createUser('noacct@test.com');
      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'PUT',
        body: JSON.stringify({ state: 'connected' }),
      });
      expect(res.status).toBe(404);
      expect((await json(res)).entity_id).toBe(`slug=github userland_user_id=${user.id} organization_id=null`);
    });
  });

  describe('DELETE (disconnect)', () => {
    it('removes the account so a fresh import succeeds, and emits disconnected', async () => {
      const user = await createUser('disconnect@test.com');
      const path = `/user_management/users/${user.id}/connected_accounts/github`;
      await req(path, { method: 'POST', body: JSON.stringify({ access_token: 'gho_x' }) });

      expect((await req(path, { method: 'DELETE' })).status).toBe(204);
      expect((await req(path)).status).toBe(404);
      const again = await req(path, { method: 'DELETE' });
      expect(again.status).toBe(404);
      expect(await json(again)).toEqual({
        message: `Data Installation not found: 'slug=github userland_user_id=${user.id} organization_id=null'.`,
        code: 'entity_not_found',
        entity_id: `slug=github userland_user_id=${user.id} organization_id=null`,
      });

      const events = eventsNamed('pipes.connected_account.disconnected');
      expect(events).toHaveLength(1);
      expect((events[0].data as Record<string, unknown>).state).toBe('disconnected');

      // Disconnecting removed the account, not the right to reconnect.
      expect((await req(path, { method: 'POST', body: JSON.stringify({ access_token: 'gho_y' }) })).status).toBe(201);
    });

    it('disconnects all of a deleted user’s accounts', async () => {
      const user = await createUser('cascade@test.com');
      await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'POST',
        body: JSON.stringify({ access_token: 'gho_x' }),
      });

      expect((await req(`/user_management/users/${user.id}`, { method: 'DELETE' })).status).toBe(204);
      expect(getWorkOSStore(store).connectedAccounts.findBy('user_id', user.id)).toHaveLength(0);
      expect(eventsNamed('pipes.connected_account.disconnected')).toHaveLength(1);
    });
  });

  describe('organization-owned accounts', () => {
    let userId: string;
    let organizationId: string;
    let path: string;

    beforeEach(async () => {
      userId = (await createUser('admin@acme.test')).id;
      organizationId = (
        await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) }))
      ).id;
      await req('/user_management/organization_memberships', {
        method: 'POST',
        body: JSON.stringify({ user_id: userId, organization_id: organizationId }),
      });
      path = `/organizations/${organizationId}/connected_accounts/google-calendar`;
    });

    const send = (method: string, body: Record<string, unknown>) => req(path, { method, body: JSON.stringify(body) });

    it('imports, reads, updates, and deletes the organization’s account', async () => {
      const created = await send('POST', { user_id: userId, access_token: 'ya29.org', scopes: ['calendar'] });
      expect(created.status).toBe(201);
      const account = await json(created);
      expect(Object.keys(account).sort()).toEqual(RESPONSE_KEYS);
      expect(account).toMatchObject({
        user_id: null,
        organization_id: organizationId,
        established_by_user_id: userId,
        scopes: ['calendar'],
        state: 'connected',
      });
      expect(eventsNamed('pipes.connected_account.connected')).toHaveLength(1);

      expect(await json(await req(path))).toEqual(account);

      const updated = await send('PUT', { user_id: userId, state: 'needs_reauthorization' });
      expect(updated.status).toBe(200);
      expect((await json(updated)).state).toBe('needs_reauthorization');
      expect(eventsNamed('pipes.connected_account.reauthorization_needed')).toHaveLength(1);

      expect((await req(path, { method: 'DELETE' })).status).toBe(204);
      expect(eventsNamed('pipes.connected_account.disconnected')).toHaveLength(1);
      const gone = await req(path);
      expect(gone.status).toBe(404);
      expect(await json(gone)).toEqual({
        message: `Data Installation not found: 'slug=google-calendar organization_id=${organizationId}'.`,
        code: 'entity_not_found',
        entity_id: `slug=google-calendar organization_id=${organizationId}`,
      });
      expect((await req(path, { method: 'DELETE' })).status).toBe(404);
    });

    it('holds one account per organization and provider, apart from its members’ own', async () => {
      await req(
        `/user_management/users/${userId}/connected_accounts/google-calendar?organization_id=${organizationId}`,
        {
          method: 'POST',
          body: JSON.stringify({ access_token: 'ya29.personal' }),
        },
      );
      expect((await req(path)).status).toBe(404);

      expect((await send('POST', { user_id: userId, access_token: 'ya29.org' })).status).toBe(201);
      const again = await send('POST', { user_id: userId, access_token: 'ya29.org2' });
      expect(again.status).toBe(409);
      expect((await json(again)).code).toBe('conflict');
    });

    it('creates one account from overlapping imports', async () => {
      const statuses = await Promise.all(
        ['ya29.a', 'ya29.b'].map(
          async (token) => (await send('POST', { user_id: userId, access_token: token })).status,
        ),
      );
      expect(statuses.sort()).toEqual([201, 409]);
      expect(getWorkOSStore(store).connectedAccounts.all()).toHaveLength(1);
    });

    it('requires the acting user to be an active member', async () => {
      const outsider = await createUser('outsider@acme.test');
      const missing = await send('POST', { access_token: 'ya29.org' });
      expect(missing.status).toBe(422);
      expect((await json(missing)).errors).toEqual([{ field: 'user_id', code: 'required' }]);
      expect((await send('POST', { user_id: 'user_missing', access_token: 'ya29.org' })).status).toBe(404);
      const refused = await send('POST', { user_id: outsider.id, access_token: 'ya29.org' });
      expect(refused.status).toBe(403);
      expect(await json(refused)).toEqual({
        message: `User '${outsider.id}' is not an active member of organization '${organizationId}'.`,
      });

      await send('POST', { user_id: userId, access_token: 'ya29.org' });
      expect((await send('PUT', { user_id: outsider.id, scopes: [] })).status).toBe(403);
    });

    it('stops naming the establishing member once they are deleted', async () => {
      await send('POST', { user_id: userId, access_token: 'ya29.org' });
      expect((await req(`/user_management/users/${userId}`, { method: 'DELETE' })).status).toBe(204);
      expect(await json(await req(path))).toMatchObject({ user_id: null, established_by_user_id: null });
    });

    it('404s an unknown organization before the account', async () => {
      const res = await req('/organizations/org_missing/connected_accounts/google-calendar');
      expect(res.status).toBe(404);
      expect((await json(res)).message).toBe("Organization not found: 'org_missing'.");
    });

    it('disconnects the organization’s accounts and its members’ scoped to it when it is deleted', async () => {
      await send('POST', { user_id: userId, access_token: 'ya29.org' });
      await req(
        `/user_management/users/${userId}/connected_accounts/google-calendar?organization_id=${organizationId}`,
        { method: 'POST', body: JSON.stringify({ access_token: 'ya29.personal' }) },
      );
      expect(getWorkOSStore(store).connectedAccounts.all()).toHaveLength(2);

      expect((await req(`/organizations/${organizationId}`, { method: 'DELETE' })).status).toBe(204);
      expect(getWorkOSStore(store).connectedAccounts.all()).toHaveLength(0);
      expect(eventsNamed('pipes.connected_account.disconnected')).toHaveLength(2);
    });
  });
});
