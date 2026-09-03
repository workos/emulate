import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap, type Store } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';
import { RESPONSE_SHAPE_REQUIREMENTS } from '../generated/response-shapes.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_org', 'Content-Type': 'application/json' };

/**
 * Every key the spec marks required on a `Flag`, from the generated catalog rather than a
 * hand-copied list: a strict SDK deserializer faults on any omission, and a spec change to
 * `Flag` must fail here rather than drift past a literal.
 */
const FLAG_KEYS = RESPONSE_SHAPE_REQUIREMENTS.feature_flag.required;

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Feature Flags routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  function seedFlag(slug = 'dark-mode', opts?: { enabled?: boolean; default_value?: boolean }) {
    return getWorkOSStore(store).featureFlags.insert({
      object: 'feature_flag',
      slug,
      name: 'Dark Mode',
      description: 'Enable dark mode',
      owner: null,
      tags: [],
      enabled: opts?.enabled ?? true,
      default_value: opts?.default_value ?? true,
    });
  }

  function seedUser(email = 'flag@test.com') {
    return getWorkOSStore(store).users.insert({
      object: 'user',
      email,
      name: null,
      first_name: null,
      last_name: null,
      email_verified: true,
      profile_picture_url: null,
      last_sign_in_at: null,
      external_id: null,
      metadata: {},
      locale: null,
      password_hash: null,
      impersonator: null,
      oauth_provider: null,
    });
  }

  function seedMembership(
    organizationId: string,
    userId: string,
    status: 'active' | 'inactive' | 'pending' = 'active',
  ) {
    return getWorkOSStore(store).organizationMemberships.insert({
      object: 'organization_membership',
      organization_id: organizationId,
      user_id: userId,
      role: { slug: 'member' },
      status,
      external_id: null,
      metadata: {},
    });
  }

  function seedOrg(name = 'Flag Corp') {
    return getWorkOSStore(store).organizations.insert({
      object: 'organization',
      name,
      allow_profiles_outside_organization: false,
      external_id: null,
      metadata: {},
      entitlements: [],
      stripe_customer_id: null,
    });
  }

  describe('flag objects', () => {
    it('lists feature flags with the documented shape', async () => {
      seedFlag();
      const res = await req('/feature-flags');
      expect(res.status).toBe(200);
      const list = await json(res);
      expect(list.object).toBe('list');
      expect(list.list_metadata).toEqual({ before: null, after: null });
      expect(list.data).toHaveLength(1);
      expect(Object.keys(list.data[0]).sort()).toEqual([...FLAG_KEYS].sort());
      expect(list.data[0].object).toBe('feature_flag');
      expect(list.data[0].id).toStartWith('flag_');
    });

    it('gets a flag by slug', async () => {
      seedFlag();
      const res = await req('/feature-flags/dark-mode');
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({ slug: 'dark-mode', enabled: true, tags: [], owner: null });
    });

    it('returns 404 for a nonexistent flag', async () => {
      expect((await req('/feature-flags/nonexistent')).status).toBe(404);
    });
  });

  describe('enable / disable', () => {
    // PUT is the spec's verb; POST is kept as an alias for callers written against the
    // emulator's earlier shape.
    for (const method of ['PUT', 'POST']) {
      it(`enables a flag via ${method}`, async () => {
        seedFlag('test-flag', { enabled: false });
        const res = await req('/feature-flags/test-flag/enable', { method });
        expect(res.status).toBe(200);
        expect((await json(res)).enabled).toBe(true);
      });

      it(`disables a flag via ${method}`, async () => {
        seedFlag('test-flag');
        const res = await req('/feature-flags/test-flag/disable', { method });
        expect(res.status).toBe(200);
        expect((await json(res)).enabled).toBe(false);
      });
    }

    it('returns 404 enabling a nonexistent flag', async () => {
      expect((await req('/feature-flags/nope/enable', { method: 'PUT' })).status).toBe(404);
    });

    it('does not emit flag.updated when the flag is already in the requested state', async () => {
      seedFlag('test-flag');
      await req('/feature-flags/test-flag/enable', { method: 'PUT' });
      const updates = getWorkOSStore(store)
        .events.all()
        .filter((e) => e.event === 'flag.updated');
      expect(updates).toHaveLength(0);
    });

    it('gives flag lifecycle events the base context only', async () => {
      seedFlag('test-flag', { enabled: false });
      await req('/feature-flags/test-flag/enable', { method: 'PUT' });
      const updated = getWorkOSStore(store)
        .events.all()
        .find((e) => e.event === 'flag.updated')!;
      expect(updated.context).toEqual({
        client_id: 'workos-emulate',
        actor: { id: 'api_key_emulator', source: 'api', name: 'Emulator API key' },
      });
      // access_type / configured_targets are defined on flag.rule_updated alone.
      expect(updated.context).not.toHaveProperty('access_type');
      expect(updated.data).toMatchObject({ slug: 'test-flag', enabled: true });
      expect(updated.data.environment_id).toBe('environment_test');
    });
  });

  describe('targets', () => {
    it('creates a target with no body and answers 204', async () => {
      seedFlag('beta', { default_value: false });
      const user = seedUser();

      const res = await req(`/feature-flags/beta/targets/${user.id}`, { method: 'POST' });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');

      const targets = getWorkOSStore(store).flagTargets.findBy('flag_slug', 'beta');
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ resource_id: user.id, resource_type: 'user', enabled: true });
    });

    it('infers organization targets from the id prefix', async () => {
      seedFlag('beta', { default_value: false });
      const org = seedOrg();

      expect((await req(`/feature-flags/beta/targets/${org.id}`, { method: 'POST' })).status).toBe(204);
      expect(getWorkOSStore(store).flagTargets.findBy('flag_slug', 'beta')[0].resource_type).toBe('organization');
    });

    it('accepts PUT as an alias for POST', async () => {
      seedFlag('beta', { default_value: false });
      const user = seedUser();
      expect((await req(`/feature-flags/beta/targets/${user.id}`, { method: 'PUT' })).status).toBe(204);
      expect(getWorkOSStore(store).flagTargets.all()).toHaveLength(1);
    });

    it('is idempotent — a repeated create does not duplicate the target', async () => {
      seedFlag('beta', { default_value: false });
      const user = seedUser();
      await req(`/feature-flags/beta/targets/${user.id}`, { method: 'POST' });
      expect((await req(`/feature-flags/beta/targets/${user.id}`, { method: 'POST' })).status).toBe(204);
      expect(getWorkOSStore(store).flagTargets.all()).toHaveLength(1);
    });

    it('rejects a resource id with no user_/org_ prefix', async () => {
      seedFlag('beta');
      const res = await req('/feature-flags/beta/targets/whatever_123', { method: 'POST' });
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ code: 'invalid_resource_id_format' });
    });

    it('returns 404 for a target user or organization that does not exist', async () => {
      seedFlag('beta');
      expect((await req('/feature-flags/beta/targets/user_missing', { method: 'POST' })).status).toBe(404);
      expect((await req('/feature-flags/beta/targets/org_missing', { method: 'POST' })).status).toBe(404);
    });

    it('returns 404 deleting a target for a user or organization that does not exist', async () => {
      seedFlag('beta');
      // Symmetry with POST: a typo'd id must not be swallowed as a successful removal.
      expect((await req('/feature-flags/beta/targets/user_missing', { method: 'DELETE' })).status).toBe(404);
      expect((await req('/feature-flags/beta/targets/org_missing', { method: 'DELETE' })).status).toBe(404);
    });

    it('rejects a malformed resource id on delete', async () => {
      seedFlag('beta');
      const res = await req('/feature-flags/beta/targets/whatever_123', { method: 'DELETE' });
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ code: 'invalid_resource_id_format' });
    });

    it('removes a target, and a repeat delete still succeeds', async () => {
      seedFlag('beta', { default_value: false });
      const user = seedUser();
      await req(`/feature-flags/beta/targets/${user.id}`, { method: 'POST' });

      expect((await req(`/feature-flags/beta/targets/${user.id}`, { method: 'DELETE' })).status).toBe(204);
      expect(getWorkOSStore(store).flagTargets.all()).toHaveLength(0);
      // The spec's 404 covers an unknown flag/user/org, not an already-removed target.
      expect((await req(`/feature-flags/beta/targets/${user.id}`, { method: 'DELETE' })).status).toBe(204);
    });

    const ruleEvents = () =>
      getWorkOSStore(store)
        .events.all()
        .filter((e) => e.event === 'flag.rule_updated');

    it('emits flag.rule_updated when targeting changes', async () => {
      seedFlag('beta', { default_value: false });
      const org = seedOrg('Acme');
      await req(`/feature-flags/beta/targets/${org.id}`, { method: 'POST' });

      const events = ruleEvents();
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ object: 'feature_flag', slug: 'beta' });
      expect(events[0].data.environment_id).toBeString();
      expect(events[0].context).toMatchObject({
        access_type: 'some',
        configured_targets: { organizations: [{ id: org.id, name: 'Acme' }], users: [] },
      });
      // The spec marks previous_attributes required on this event; before the target existed
      // the flag reached nobody. Only the rule changed, so `data` is absent rather than
      // restating the flag's unchanged attributes as "previous".
      expect(events[0].context!.previous_attributes).toEqual({
        context: { access_type: 'none', configured_targets: { organizations: [], users: [] } },
      });
    });

    it('emits a second flag.rule_updated on removal, with access_type back to none', async () => {
      seedFlag('beta', { default_value: false });
      const org = seedOrg('Acme');
      await req(`/feature-flags/beta/targets/${org.id}`, { method: 'POST' });
      await req(`/feature-flags/beta/targets/${org.id}`, { method: 'DELETE' });

      const events = ruleEvents();
      expect(events).toHaveLength(2);
      expect(events[1].context).toMatchObject({
        access_type: 'none',
        configured_targets: { organizations: [], users: [] },
        previous_attributes: { context: { access_type: 'some' } },
      });
    });

    it('does not emit flag.rule_updated for a target that already exists', async () => {
      seedFlag('beta', { default_value: false });
      const user = seedUser();
      await req(`/feature-flags/beta/targets/${user.id}`, { method: 'POST' });
      await req(`/feature-flags/beta/targets/${user.id}`, { method: 'POST' });
      expect(ruleEvents()).toHaveLength(1);
    });

    it('reports access_type all when default_value carries every resource', async () => {
      seedFlag('beta', { default_value: true });
      const org = seedOrg('Acme');
      await req(`/feature-flags/beta/targets/${org.id}`, { method: 'POST' });
      expect(ruleEvents()[0].context).toMatchObject({ access_type: 'all' });
    });

    it('names the calling API key as the flag.rule_updated actor when the key has a record', async () => {
      seedFlag('beta', { default_value: false });
      const org = seedOrg('Acme');
      const record = getWorkOSStore(store).apiKeyRecords.insert({
        object: 'api_key',
        name: 'CI key',
        key: 'sk_test_org',
        environment: 'test',
        owner: { type: 'organization', id: org.id },
        permissions: [],
        last_used_at: null,
        expires_at: null,
      });

      await req(`/feature-flags/beta/targets/${org.id}`, { method: 'POST' });
      expect(ruleEvents()[0].context).toMatchObject({
        client_id: 'workos-emulate',
        actor: { id: record.id, source: 'api', name: 'CI key' },
      });
    });

    it('falls back to the placeholder actor when the calling key has no record', async () => {
      // A map-form apiKeys entry authenticates but has no api_key resource behind it.
      seedFlag('beta', { default_value: false });
      const org = seedOrg('Acme');
      await req(`/feature-flags/beta/targets/${org.id}`, { method: 'POST' });
      expect(ruleEvents()[0].context).toMatchObject({
        actor: { id: 'api_key_emulator', source: 'api', name: 'Emulator API key' },
      });
    });

    it("drops a user's targets when the user is deleted", async () => {
      seedFlag('beta', { default_value: false });
      const user = seedUser();
      await req(`/feature-flags/beta/targets/${user.id}`, { method: 'POST' });

      expect((await req(`/user_management/users/${user.id}`, { method: 'DELETE' })).status).toBe(204);
      expect(getWorkOSStore(store).flagTargets.all()).toEqual([]);
      const body = await json(await req('/sdk/feature-flags'));
      expect(body.beta.targets.users).toEqual([]);
    });

    it("drops an organization's targets when the organization is deleted", async () => {
      seedFlag('beta', { default_value: false });
      const org = seedOrg();
      await req(`/feature-flags/beta/targets/${org.id}`, { method: 'POST' });

      expect((await req(`/organizations/${org.id}`, { method: 'DELETE' })).status).toBe(204);
      expect(getWorkOSStore(store).flagTargets.all()).toEqual([]);
    });
  });

  describe('GET /sdk/feature-flags (runtime client polling)', () => {
    it('returns a bare slug-keyed map of every flag, including disabled ones', async () => {
      seedFlag('on-by-default');
      seedFlag('switched-off', { enabled: false });
      const res = await req('/sdk/feature-flags');
      expect(res.status).toBe(200);

      const body = await json(res);
      // A map, not a list envelope — the SDK assigns the response body straight into its store.
      expect(Object.keys(body).sort()).toEqual(['on-by-default', 'switched-off']);
      expect(body['on-by-default']).toEqual({
        slug: 'on-by-default',
        enabled: true,
        default_value: true,
        targets: { users: [], organizations: [] },
      });
      expect(body['switched-off'].enabled).toBe(false);
    });

    it('reports targets split by kind, each marked enabled', async () => {
      seedFlag('beta', { default_value: false });
      const user = seedUser();
      const org = seedOrg();
      await req(`/feature-flags/beta/targets/${user.id}`, { method: 'POST' });
      await req(`/feature-flags/beta/targets/${org.id}`, { method: 'POST' });

      const body = await json(await req('/sdk/feature-flags'));
      // The SDK's evaluator skips any target whose `enabled` is not true.
      expect(body.beta.targets).toEqual({
        users: [{ id: user.id, enabled: true }],
        organizations: [{ id: org.id, enabled: true }],
      });
    });

    it('agrees with the server-side evaluation the list endpoints use', async () => {
      seedFlag('user-targeted', { default_value: false });
      seedFlag('org-targeted', { default_value: false });
      seedFlag('everyone');
      seedFlag('off', { enabled: false, default_value: true });
      seedFlag('nobody', { default_value: false });
      const user = seedUser();
      const org = seedOrg();
      seedMembership(org.id, user.id);
      await req(`/feature-flags/user-targeted/targets/${user.id}`, { method: 'POST' });
      await req(`/feature-flags/org-targeted/targets/${org.id}`, { method: 'POST' });

      // A transcription of the SDK's own Evaluator.evaluate(): disabled -> false, any matching
      // enabled target -> true, otherwise default_value. Both target kinds are in the context,
      // so an org-inherited flag missing from the poll map would fail here.
      const poll = await json(await req('/sdk/feature-flags'));
      const evaluate = (entry: any) => {
        if (!entry.enabled) return false;
        if (entry.targets.users.some((t: any) => t.id === user.id && t.enabled)) return true;
        if (entry.targets.organizations.some((t: any) => t.id === org.id && t.enabled)) return true;
        return entry.default_value;
      };
      const onPerPoll = Object.keys(poll)
        .filter((slug) => evaluate(poll[slug]))
        .sort();

      const list = await json(await req(`/user_management/users/${user.id}/feature-flags`));
      expect(onPerPoll).toEqual(['everyone', 'org-targeted', 'user-targeted']);
      expect(onPerPoll).toEqual(list.data.map((f: any) => f.slug).sort());
    });
  });

  describe('evaluation', () => {
    it('returns enabled flags for an organization as whole Flag objects', async () => {
      seedFlag('on-by-default');
      seedFlag('targeted', { default_value: false });
      seedFlag('off', { enabled: false });
      const org = seedOrg();
      await req(`/feature-flags/targeted/targets/${org.id}`, { method: 'POST' });

      const res = await req(`/organizations/${org.id}/feature-flags`);
      expect(res.status).toBe(200);
      const list = await json(res);
      expect(list.data.map((f: any) => f.slug).sort()).toEqual(['on-by-default', 'targeted']);
      expect(Object.keys(list.data[0]).sort()).toEqual([...FLAG_KEYS].sort());
    });

    it('excludes a flag targeted only at a different organization', async () => {
      seedFlag('targeted', { default_value: false });
      const org = seedOrg('Mine');
      const other = seedOrg('Theirs');
      await req(`/feature-flags/targeted/targets/${other.id}`, { method: 'POST' });

      expect((await json(await req(`/organizations/${org.id}/feature-flags`))).data).toEqual([]);
    });

    it('returns enabled flags for a user, including those from their organizations', async () => {
      seedFlag('user-targeted', { default_value: false });
      seedFlag('org-targeted', { default_value: false });
      seedFlag('untargeted', { default_value: false });
      const user = seedUser();
      const org = seedOrg();
      seedMembership(org.id, user.id);
      await req(`/feature-flags/user-targeted/targets/${user.id}`, { method: 'POST' });
      await req(`/feature-flags/org-targeted/targets/${org.id}`, { method: 'POST' });

      const list = await json(await req(`/user_management/users/${user.id}/feature-flags`));
      expect(list.data.map((f: any) => f.slug).sort()).toEqual(['org-targeted', 'user-targeted']);
    });

    for (const status of ['inactive', 'pending'] as const) {
      it(`does not inherit organization targets through a ${status} membership`, async () => {
        seedFlag('org-targeted', { default_value: false });
        const user = seedUser();
        const org = seedOrg();
        seedMembership(org.id, user.id, status);
        await req(`/feature-flags/org-targeted/targets/${org.id}`, { method: 'POST' });

        // authenticate refuses to scope a session to a non-active membership, so a flag
        // reported here could never appear in that user's token claim.
        expect((await json(await req(`/user_management/users/${user.id}/feature-flags`))).data).toEqual([]);
        // The organization itself still sees it — only the inheritance is gated.
        const orgList = await json(await req(`/organizations/${org.id}/feature-flags`));
        expect(orgList.data.map((f: any) => f.slug)).toEqual(['org-targeted']);
      });
    }

    it('omits a disabled flag even from a resource it targets', async () => {
      seedFlag('disabled-flag', { enabled: false, default_value: true });
      const user = seedUser();
      // Target it while enabled, then switch the flag off environment-wide.
      await req('/feature-flags/disabled-flag/enable', { method: 'PUT' });
      await req(`/feature-flags/disabled-flag/targets/${user.id}`, { method: 'POST' });
      await req('/feature-flags/disabled-flag/disable', { method: 'PUT' });

      expect((await json(await req(`/user_management/users/${user.id}/feature-flags`))).data).toEqual([]);
    });

    it('paginates the evaluation lists', async () => {
      for (let i = 0; i < 3; i++) seedFlag(`flag-${i}`);
      const org = seedOrg();

      const first = await json(await req(`/organizations/${org.id}/feature-flags?limit=2`));
      expect(first.data).toHaveLength(2);
      expect(first.list_metadata.after).toBeString();

      const second = await json(
        await req(`/organizations/${org.id}/feature-flags?limit=2&after=${first.list_metadata.after}`),
      );
      expect(second.data).toHaveLength(1);
    });

    it('returns 404 for an unknown organization or user', async () => {
      expect((await req('/organizations/org_missing/feature-flags')).status).toBe(404);
      expect((await req('/user_management/users/user_missing/feature-flags')).status).toBe(404);
    });
  });
});
