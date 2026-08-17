/**
 * Pipes connected accounts. The spec models them on
 * `/user_management/users/{user_id}/connected_accounts/{slug}` with all four verbs: GET,
 * POST (import with OAuth tokens), PUT (update tokens/scopes/state), DELETE (disconnect).
 * Accounts are keyed by (user, slug, organization scope), can be seeded, and state
 * transitions emit the spec's `pipes.connected_account.*` events.
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

    it('keys an org-scoped seed by the organization_id query parameter', async () => {
      seed({
        users: [{ email: 'scoped@acme.test' }],
        organizations: [{ name: 'Acme' }],
        connectedAccounts: [{ email: 'scoped@acme.test', provider: 'slack', organization: 'Acme' }],
      });
      const ws = getWorkOSStore(store);
      const user = ws.users.findOneBy('email', 'scoped@acme.test')!;
      const org = ws.organizations.findOneBy('name', 'Acme')!;

      // The scope is part of the key: an unscoped lookup does not resolve an org-scoped account.
      expect((await req(`/user_management/users/${user.id}/connected_accounts/slack`)).status).toBe(404);

      const res = await req(`/user_management/users/${user.id}/connected_accounts/slack?organization_id=${org.id}`);
      expect(res.status).toBe(200);
      expect((await json(res)).organization_id).toBe(org.id);
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

    it('rejects references and states the emulator could not honour', () => {
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
  });

  describe('GET', () => {
    it('404s on an unknown user, a missing account, and an unknown organization', async () => {
      expect((await req('/user_management/users/user_none/connected_accounts/github')).status).toBe(404);

      const user = await createUser('bare@test.com');
      expect((await req(`/user_management/users/${user.id}/connected_accounts/github`)).status).toBe(404);

      const res = await req(`/user_management/users/${user.id}/connected_accounts/github?organization_id=org_none`);
      expect(res.status).toBe(404);
      expect((await json(res)).message).toBe('Organization not found');
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

    it('honours an explicit state over derivation', async () => {
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

    it('keeps org-scoped and unscoped accounts of one provider apart, sharing the integration', async () => {
      seed({ organizations: [{ name: 'Acme' }] });
      const ws = getWorkOSStore(store);
      const org = ws.organizations.findOneBy('name', 'Acme')!;
      const user = await createUser('both@test.com');

      const post = (qs: string) =>
        req(`/user_management/users/${user.id}/connected_accounts/github${qs}`, {
          method: 'POST',
          body: JSON.stringify({ access_token: 'gho_x' }),
        });
      expect((await post('')).status).toBe(201);
      expect((await post(`?organization_id=${org.id}`)).status).toBe(201);

      const unscoped = await json(await req(`/user_management/users/${user.id}/connected_accounts/github`));
      const scoped = await json(
        await req(`/user_management/users/${user.id}/connected_accounts/github?organization_id=${org.id}`),
      );
      expect(unscoped.id).not.toBe(scoped.id);
      expect(unscoped.organization_id).toBeNull();
      expect(scoped.organization_id).toBe(org.id);

      // One provider, one integration: both installations install the same data integration.
      const rows = ws.connectedAccounts.findBy('user_id', user.id);
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
    });

    it('404s an update for an account that does not exist', async () => {
      const user = await createUser('noacct@test.com');
      const res = await req(`/user_management/users/${user.id}/connected_accounts/github`, {
        method: 'PUT',
        body: JSON.stringify({ state: 'connected' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE (disconnect)', () => {
    it('removes the account so a fresh import succeeds, and emits disconnected', async () => {
      const user = await createUser('disconnect@test.com');
      const path = `/user_management/users/${user.id}/connected_accounts/github`;
      await req(path, { method: 'POST', body: JSON.stringify({ access_token: 'gho_x' }) });

      expect((await req(path, { method: 'DELETE' })).status).toBe(204);
      expect((await req(path)).status).toBe(404);
      expect((await req(path, { method: 'DELETE' })).status).toBe(404);

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
});
