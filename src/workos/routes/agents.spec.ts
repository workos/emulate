import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap, type Store } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';
import { hashPassword } from '../helpers.js';

const apiKeys: ApiKeyMap = { sk_test_agents: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_agents', 'Content-Type': 'application/json' };

const BLUEPRINT_KEYS = [
  'object',
  'id',
  'name',
  'description',
  'permissions',
  'invocable_by',
  'session_settings',
  'created_at',
  'updated_at',
].sort();
const INSTANCE_KEYS = [
  'object',
  'id',
  'agent_blueprint_id',
  'organization_id',
  'organization_membership_id',
  'type',
  'created_at',
  'updated_at',
].sort();
const SESSION_KEYS = [
  'object',
  'id',
  'agent_instance_id',
  'status',
  'expires_at',
  'revoked_at',
  'created_at',
  'updated_at',
].sort();
const MINT_KEYS = [
  'access_token',
  'token_type',
  'expires_in',
  'refresh_token',
  'agent_instance_id',
  'new_instance',
  'agent_instance_session_id',
  'permissions',
].sort();

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

function decodeJwt(token: string): { header: Record<string, any>; payload: Record<string, any> } {
  const [h, p] = token.split('.');
  const decode = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
  return { header: decode(h!), payload: decode(p!) };
}

describe('Agent Auth routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let jwt: ReturnType<typeof createTestApp>['jwt'];
  let store: Store;
  const ws = () => getWorkOSStore(store);

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    jwt = server.jwt;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;
  const post = (path: string, body: unknown) => req(path, { method: 'POST', body: JSON.stringify(body) });
  const events = (name: string) =>
    ws()
      .events.all()
      .filter((e) => e.event === name);

  function seedOrg(name = 'Acme Corp') {
    return ws().organizations.insert({
      object: 'organization',
      name,
      allow_profiles_outside_organization: false,
      external_id: null,
      metadata: {},
      entitlements: [],
      stripe_customer_id: null,
    });
  }

  function seedPermission(slug: string) {
    return ws().permissions.insert({ object: 'permission', slug, name: slug, description: null });
  }

  function seedRole(slug: string, permissionSlugs: string[]) {
    const role = ws().roles.insert({
      object: 'role',
      slug,
      name: slug,
      description: null,
      type: 'EnvironmentRole',
      organization_id: null,
      is_default_role: false,
      priority: 0,
    });
    for (const p of permissionSlugs) {
      const permission = ws().permissions.findOneBy('slug', p) ?? seedPermission(p);
      ws().rolePermissions.insert({ role_id: role.id, permission_id: permission.id });
    }
    return role;
  }

  function seedUser(email = 'alice@acme.com', password = 'secret') {
    return ws().users.insert({
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
      password_hash: hashPassword(password),
      impersonator: null,
      oauth_provider: null,
    });
  }

  function seedMembership(organizationId: string, userId: string, roleSlug: string) {
    return ws().organizationMemberships.insert({
      object: 'organization_membership',
      organization_id: organizationId,
      user_id: userId,
      role: { slug: roleSlug },
      status: 'active',
      external_id: null,
      metadata: {},
    });
  }

  async function loginAs(email = 'alice@acme.com', password = 'secret') {
    const res = await app.request('/user_management/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email, password }),
    });
    expect(res.status).toBe(200);
    return json(res);
  }

  /** Org with a manager (crm:read, email:send) and a member (crm:read), plus a blueprint over both slugs. */
  async function seedWorld(blueprintOverrides: Record<string, unknown> = {}) {
    const org = seedOrg();
    seedRole('manager', ['crm:read', 'email:send']);
    seedRole('member', ['crm:read']);
    const alice = seedUser();
    const membership = seedMembership(org.id, alice.id, 'manager');
    const res = await post('/agents/blueprints', {
      name: 'Prospecting Agent',
      permissions: ['crm:read', 'email:send'],
      ...blueprintOverrides,
    });
    expect(res.status).toBe(201);
    const blueprint = await json(res);
    return { org, alice, membership, blueprint };
  }

  const mint = (blueprintId: string, body: unknown) => post(`/agents/blueprints/${blueprintId}/tokens`, body);

  async function mintOk(blueprintId: string, body: unknown) {
    const res = await mint(blueprintId, body);
    expect(res.status).toBe(200);
    return json(res);
  }

  async function expectError(res: Response, status: number, code: string) {
    expect(res.status).toBe(status);
    expect((await json(res)).code).toBe(code);
  }

  describe('blueprints', () => {
    it('creates a blueprint with defaults and the documented shape', async () => {
      seedPermission('crm:read');
      const res = await post('/agents/blueprints', { name: 'Reader', permissions: ['crm:read'] });
      expect(res.status).toBe(201);
      const body = await json(res);
      expect(Object.keys(body).sort()).toEqual(BLUEPRINT_KEYS);
      expect(body.id).toStartWith('agent_blueprint_');
      expect(body).toMatchObject({
        object: 'agent_blueprint',
        name: 'Reader',
        description: null,
        permissions: ['crm:read'],
        invocable_by: { role_slugs: [], organization_ids: [] },
        session_settings: { max_age_seconds: 3600, access_token_ttl_seconds: 300, refresh_token_ttl_seconds: 3600 },
      });
      expect(events('agent.blueprint.created')).toHaveLength(1);
      expect(Object.keys(events('agent.blueprint.created')[0]!.data).sort()).toEqual(BLUEPRINT_KEYS);
    });

    it('rejects a malformed body with field errors', async () => {
      const res = await post('/agents/blueprints', {
        description: '',
        permissions: 'crm:read',
        session_settings: { access_token_ttl_seconds: 3601, max_age_seconds: 0, refresh_token_ttl_seconds: 60 },
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.code).toBe('invalid_request');
      expect(body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
        'description',
        'name',
        'permissions',
        'session_settings.access_token_ttl_seconds',
        'session_settings.max_age_seconds',
      ]);
    });

    it('rejects on create what only update may send: a null description and partial settings', async () => {
      const nullDescription = await post('/agents/blueprints', { name: 'Example A', description: null });
      expect(nullDescription.status).toBe(400);
      expect((await json(nullDescription)).errors.map((e: { field: string }) => e.field)).toEqual(['description']);

      const partial = await post('/agents/blueprints', {
        name: 'Example B',
        session_settings: { access_token_ttl_seconds: 60 },
      });
      expect(partial.status).toBe(400);
      expect((await json(partial)).errors.map((e: { field: string }) => e.field).sort()).toEqual([
        'session_settings.max_age_seconds',
        'session_settings.refresh_token_ttl_seconds',
      ]);
      expect((await json(await req('/agents/blueprints'))).data).toHaveLength(0);

      const complete = await post('/agents/blueprints', {
        name: 'Example C',
        description: 'Full settings',
        session_settings: { max_age_seconds: 600, access_token_ttl_seconds: 60, refresh_token_ttl_seconds: 600 },
      });
      expect(complete.status).toBe(201);

      const { id } = await json(complete);
      const patched = await req(`/agents/blueprints/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: null, session_settings: { access_token_ttl_seconds: 30 } }),
      });
      expect(patched.status).toBe(200);
      expect(await json(patched)).toMatchObject({
        description: null,
        session_settings: { max_age_seconds: 600, access_token_ttl_seconds: 30, refresh_token_ttl_seconds: 600 },
      });
    });

    it('rejects unknown permissions, roles and organizations with 422 codes', async () => {
      await expectError(
        await post('/agents/blueprints', { name: 'A', permissions: ['nope'] }),
        422,
        'permission_not_found',
      );
      await expectError(
        await post('/agents/blueprints', { name: 'A', invocable_by: { role_slugs: ['nope'] } }),
        422,
        'role_not_found',
      );
      await expectError(
        await post('/agents/blueprints', { name: 'A', invocable_by: { organization_ids: ['org_nope'] } }),
        422,
        'organization_not_found',
      );
    });

    it('rejects a duplicate name with 409 on create and update', async () => {
      await post('/agents/blueprints', { name: 'One' });
      const two = await json(await post('/agents/blueprints', { name: 'Two' }));
      await expectError(await post('/agents/blueprints', { name: 'One' }), 409, 'name_already_in_use');
      await expectError(
        await req(`/agents/blueprints/${two.id}`, { method: 'PATCH', body: JSON.stringify({ name: 'One' }) }),
        409,
        'name_already_in_use',
      );
      // Renaming to its own name is not a conflict.
      const same = await req(`/agents/blueprints/${two.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: 'Two' }),
      });
      expect(same.status).toBe(200);
    });

    it('gets, lists with cursor pagination, and 404s a missing blueprint', async () => {
      for (const name of ['A', 'B', 'C']) await post('/agents/blueprints', { name });
      const page1 = await json(await req('/agents/blueprints?limit=2'));
      expect(page1.object).toBe('list');
      expect(page1.data).toHaveLength(2);
      expect(page1.list_metadata.after).toBeTruthy();
      const page2 = await json(await req(`/agents/blueprints?limit=2&after=${page1.list_metadata.after}`));
      expect(page2.data).toHaveLength(1);
      expect(page2.list_metadata.after).toBeNull();
      const ids = new Set([...page1.data, ...page2.data].map((b: { id: string }) => b.id));
      expect(ids.size).toBe(3);

      const one = await req(`/agents/blueprints/${page1.data[0].id}`);
      expect(one.status).toBe(200);
      expect((await json(one)).id).toBe(page1.data[0].id);
      expect((await req('/agents/blueprints/agent_blueprint_missing')).status).toBe(404);
    });

    it('patches fields individually, leaving the rest intact', async () => {
      const { org, blueprint } = await seedWorld();
      const res = await req(`/agents/blueprints/${blueprint.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          description: 'Finds prospects',
          invocable_by: { organization_ids: [org.id] },
          session_settings: { access_token_ttl_seconds: 60 },
        }),
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toMatchObject({
        name: 'Prospecting Agent',
        description: 'Finds prospects',
        permissions: ['crm:read', 'email:send'],
        invocable_by: { role_slugs: [], organization_ids: [org.id] },
        session_settings: { max_age_seconds: 3600, access_token_ttl_seconds: 60, refresh_token_ttl_seconds: 3600 },
      });
      expect(events('agent.blueprint.updated')).toHaveLength(1);
    });

    it('deletes a blueprint and tears down its instances and sessions', async () => {
      const { org, blueprint } = await seedWorld();
      const minted = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const res = await req(`/agents/blueprints/${blueprint.id}`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect((await req(`/agents/blueprints/${blueprint.id}`)).status).toBe(404);
      expect((await req(`/agents/instances/${minted.agent_instance_id}`)).status).toBe(404);
      expect((await req(`/agents/sessions/${minted.agent_instance_session_id}`)).status).toBe(404);
      expect(events('agent.blueprint.deleted')).toHaveLength(1);
      expect(events('agent.instance.deleted')).toHaveLength(1);
      expect(events('agent.instance.session.revoked')).toHaveLength(1);
      expect(events('agent.blueprint.deleted')[0]!.data).toMatchObject({ id: blueprint.id, name: 'Prospecting Agent' });
    });
  });

  describe('autonomous tokens', () => {
    it('mints a token carrying the blueprint ceiling and the documented claims', async () => {
      const { org, blueprint } = await seedWorld();
      const body = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id, intent: 'Find leads' });
      expect(Object.keys(body).sort()).toEqual(MINT_KEYS);
      expect(body).toMatchObject({
        token_type: 'Bearer',
        expires_in: 300,
        new_instance: true,
        permissions: ['crm:read', 'email:send'],
      });
      expect(body.agent_instance_id).toStartWith('agent_');
      expect(body.agent_instance_session_id).toStartWith('agent_session_');

      const { header, payload } = decodeJwt(body.access_token);
      expect(header.typ).toBe('at+jwt');
      expect(header.alg).toBe('RS256');
      expect(payload).toMatchObject({
        sub: body.agent_instance_id,
        sub_profile: 'ai_agent',
        sid: body.agent_instance_session_id,
        org_id: org.id,
        permissions: ['crm:read', 'email:send'],
        intent: { text: 'Find leads' },
        aud: 'workos-emulate',
      });
      expect(payload.act).toBeUndefined();
      expect(payload.auth_time).toBeUndefined();
      expect(payload.exp - payload.iat).toBe(300);

      const instance = await json(await req(`/agents/instances/${body.agent_instance_id}`));
      expect(Object.keys(instance).sort()).toEqual(INSTANCE_KEYS);
      expect(instance).toMatchObject({
        object: 'agent_instance',
        agent_blueprint_id: blueprint.id,
        organization_id: org.id,
        organization_membership_id: null,
        type: 'autonomous',
      });
      expect(events('agent.instance.created')).toHaveLength(1);
      const created = events('agent.instance.session.created');
      expect(created).toHaveLength(1);
      expect(created[0]!.data).toMatchObject({
        object: 'agent_instance_session',
        id: body.agent_instance_session_id,
        organization_id: org.id,
        revoked_at: null,
        permission_slugs: ['crm:read', 'email:send'],
      });
      expect(created[0]!.data).not.toHaveProperty('refresh_token');
    });

    it('reuses the instance for the same blueprint and organization', async () => {
      const { org, blueprint } = await seedWorld();
      const first = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const second = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      expect(second.agent_instance_id).toBe(first.agent_instance_id);
      expect(second.new_instance).toBe(false);
      expect(second.agent_instance_session_id).not.toBe(first.agent_instance_session_id);
      expect(events('agent.instance.created')).toHaveLength(1);
    });

    it('requires organization_id, an existing organization, and an invocable one', async () => {
      const { org, blueprint } = await seedWorld();
      const other = seedOrg('Other Inc');
      await expectError(await mint(blueprint.id, { type: 'autonomous' }), 400, 'invalid_request');
      expect((await mint(blueprint.id, { type: 'autonomous', organization_id: 'org_missing' })).status).toBe(404);
      await req(`/agents/blueprints/${blueprint.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ invocable_by: { organization_ids: [org.id] } }),
      });
      await expectError(
        await mint(blueprint.id, { type: 'autonomous', organization_id: other.id }),
        403,
        'organization_not_invocable',
      );
      expect((await mint(blueprint.id, { type: 'autonomous', organization_id: org.id })).status).toBe(200);
    });

    it('rejects an unknown grant type and a missing blueprint', async () => {
      const { blueprint } = await seedWorld();
      await expectError(await mint(blueprint.id, { type: 'client_credentials' }), 400, 'invalid_request');
      expect((await mint('agent_blueprint_missing', { type: 'autonomous', organization_id: 'x' })).status).toBe(404);
    });

    it('caps the access token TTL at the session lifetime', async () => {
      const { org, blueprint } = await seedWorld({
        session_settings: { max_age_seconds: 3600, access_token_ttl_seconds: 300, refresh_token_ttl_seconds: 120 },
      });
      const body = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      expect(body.expires_in).toBe(120);
    });
  });

  describe('user-delegated tokens', () => {
    it('mints a token scoped to the member and the intersection of permissions', async () => {
      const { org, alice, membership, blueprint } = await seedWorld({ permissions: ['crm:read'] });
      const login = await loginAs();
      const body = await mintOk(blueprint.id, {
        type: 'user_delegated',
        user_access_token: login.access_token,
        intent: 'Draft outreach',
      });
      expect(body.permissions).toEqual(['crm:read']);
      expect(body.new_instance).toBe(true);

      const { payload } = decodeJwt(body.access_token);
      const userClaims = decodeJwt(login.access_token).payload;
      expect(payload).toMatchObject({
        sub: body.agent_instance_id,
        sub_profile: 'ai_agent',
        org_id: org.id,
        permissions: ['crm:read'],
        act: { sub: alice.id, sub_profile: 'user' },
      });
      expect(payload.auth_time).toBe(
        Math.floor(new Date(ws().sessions.get(userClaims.sid)!.created_at).getTime() / 1000),
      );

      const instance = await json(await req(`/agents/instances/${body.agent_instance_id}`));
      expect(instance).toMatchObject({ type: 'delegated', organization_membership_id: membership.id });
    });

    it('narrows to what the role currently grants, not what the blueprint allows', async () => {
      const { org, blueprint } = await seedWorld();
      const bob = seedUser('bob@acme.com');
      seedMembership(org.id, bob.id, 'member');
      const login = await loginAs('bob@acme.com');
      const body = await mintOk(blueprint.id, { type: 'user_delegated', user_access_token: login.access_token });
      expect(body.permissions).toEqual(['crm:read']);
    });

    it('accepts a user token that names its subject profile explicitly', async () => {
      const { alice, blueprint } = await seedWorld({ permissions: ['crm:read'] });
      const login = await loginAs();
      const { sub, sid, org_id, aud } = decodeJwt(login.access_token).payload;
      const explicit = jwt.sign({ sub, sid, org_id, aud, sub_profile: 'user' });

      const body = await mintOk(blueprint.id, { type: 'user_delegated', user_access_token: explicit });
      expect(body.permissions).toEqual(['crm:read']);
      expect(decodeJwt(body.access_token).payload.act).toEqual({ sub: alice.id, sub_profile: 'user' });

      const other = jwt.sign({ sub, sid, org_id, aud, sub_profile: 'widget' });
      await expectError(
        await mint(blueprint.id, { type: 'user_delegated', user_access_token: other }),
        400,
        'invalid_user_access_token',
      );
    });

    it('rejects garbage, foreign and agent tokens as invalid_user_access_token', async () => {
      const { org, blueprint } = await seedWorld();
      await expectError(await mint(blueprint.id, { type: 'user_delegated' }), 400, 'invalid_request');
      await expectError(
        await mint(blueprint.id, { type: 'user_delegated', user_access_token: 'not.a.jwt' }),
        400,
        'invalid_user_access_token',
      );
      const agent = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      await expectError(
        await mint(blueprint.id, { type: 'user_delegated', user_access_token: agent.access_token }),
        400,
        'invalid_user_access_token',
      );
    });

    it('rejects a token whose user session has been revoked', async () => {
      const { blueprint } = await seedWorld();
      const login = await loginAs();
      const { sid } = decodeJwt(login.access_token).payload;
      await post('/user_management/sessions/revoke', { session_id: sid });
      await expectError(
        await mint(blueprint.id, { type: 'user_delegated', user_access_token: login.access_token }),
        400,
        'invalid_user_access_token',
      );
    });

    it('enforces membership, organization invocability and role invocability in that order', async () => {
      const { membership, blueprint } = await seedWorld();
      const login = await loginAs();
      const grant = { type: 'user_delegated', user_access_token: login.access_token };

      await req(`/agents/blueprints/${blueprint.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ invocable_by: { role_slugs: ['member'] } }),
      });
      await expectError(await mint(blueprint.id, grant), 403, 'role_not_invocable');

      const other = seedOrg('Other Inc');
      await req(`/agents/blueprints/${blueprint.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ invocable_by: { role_slugs: [], organization_ids: [other.id] } }),
      });
      await expectError(await mint(blueprint.id, grant), 403, 'organization_not_invocable');

      ws().organizationMemberships.update(membership.id, { status: 'inactive' });
      await expectError(await mint(blueprint.id, grant), 403, 'user_not_member_of_organization');
    });

    it('rejects a login older than max_age_seconds', async () => {
      const { blueprint } = await seedWorld({
        session_settings: { max_age_seconds: 60, access_token_ttl_seconds: 300, refresh_token_ttl_seconds: 3600 },
      });
      const login = await loginAs();
      const { sid } = decodeJwt(login.access_token).payload;
      ws().sessions.updateSilent(sid, { created_at: new Date(Date.now() - 120_000).toISOString() });
      await expectError(
        await mint(blueprint.id, { type: 'user_delegated', user_access_token: login.access_token }),
        400,
        'max_age_exceeded',
      );
    });

    it('revokes delegated agent sessions when the user session ends', async () => {
      const { blueprint } = await seedWorld();
      const login = await loginAs();
      const agent = await mintOk(blueprint.id, { type: 'user_delegated', user_access_token: login.access_token });
      const child = await mintOk(blueprint.id, { type: 'agent_delegated', agent_access_token: agent.access_token });

      const { sid } = decodeJwt(login.access_token).payload;
      await post('/user_management/sessions/revoke', { session_id: sid });

      for (const id of [agent.agent_instance_session_id, child.agent_instance_session_id]) {
        expect((await json(await req(`/agents/sessions/${id}`))).status).toBe('revoked');
      }
      expect(events('agent.instance.session.revoked')).toHaveLength(2);
      await expectError(
        await post(`/agents/blueprints/${blueprint.id}/tokens/validate`, { agent_access_token: agent.access_token }),
        400,
        'session_revoked',
      );
    });
  });

  describe('agent-delegated tokens', () => {
    it('chains a new session on the same instance and keeps the delegating user in act', async () => {
      const { alice, blueprint } = await seedWorld();
      const login = await loginAs();
      const root = await mintOk(blueprint.id, { type: 'user_delegated', user_access_token: login.access_token });
      const child = await mintOk(blueprint.id, {
        type: 'agent_delegated',
        agent_access_token: root.access_token,
        intent: 'Sub-task',
      });
      expect(child.agent_instance_id).toBe(root.agent_instance_id);
      expect(child.new_instance).toBe(false);
      expect(child.agent_instance_session_id).not.toBe(root.agent_instance_session_id);
      const { payload } = decodeJwt(child.access_token);
      expect(payload.act).toEqual({ sub: alice.id, sub_profile: 'user' });
      expect(payload.intent).toEqual({ text: 'Sub-task' });
      expect(typeof payload.auth_time).toBe('number');
    });

    it('rejects tokens from another blueprint, revoked sessions and non-agent tokens', async () => {
      const { org, blueprint } = await seedWorld();
      const otherRes = await post('/agents/blueprints', { name: 'Other Agent', permissions: ['crm:read'] });
      const other = await json(otherRes);
      const foreign = await mintOk(other.id, { type: 'autonomous', organization_id: org.id });
      await expectError(
        await mint(blueprint.id, { type: 'agent_delegated', agent_access_token: foreign.access_token }),
        400,
        'invalid_agent_access_token',
      );

      const login = await loginAs();
      await expectError(
        await mint(blueprint.id, { type: 'agent_delegated', agent_access_token: login.access_token }),
        400,
        'invalid_agent_access_token',
      );

      const own = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      await post(`/agents/sessions/${own.agent_instance_session_id}/revoke`, {});
      await expectError(
        await mint(blueprint.id, { type: 'agent_delegated', agent_access_token: own.access_token }),
        400,
        'invalid_agent_access_token',
      );
    });

    it('caps the chain depth at 32', async () => {
      const { org, blueprint } = await seedWorld();
      let token = (await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id })).access_token;
      for (let hop = 1; hop <= 32; hop++) {
        const res = await mint(blueprint.id, { type: 'agent_delegated', agent_access_token: token });
        expect(res.status).toBe(200);
        token = (await json(res)).access_token;
      }
      await expectError(
        await mint(blueprint.id, { type: 'agent_delegated', agent_access_token: token }),
        400,
        'chain_depth_exceeded',
      );
    });

    it('anchors every hop to the root session max-age window', async () => {
      const { org, blueprint } = await seedWorld({
        session_settings: { max_age_seconds: 600, access_token_ttl_seconds: 300, refresh_token_ttl_seconds: 3600 },
      });
      const root = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const rootRow = ws().agentInstanceSessions.get(root.agent_instance_session_id)!;
      const windowEnd = new Date(rootRow.created_at).getTime() + 600_000;

      const child = await mintOk(blueprint.id, { type: 'agent_delegated', agent_access_token: root.access_token });
      const childRow = ws().agentInstanceSessions.get(child.agent_instance_session_id)!;
      expect(new Date(childRow.expires_at).getTime()).toBe(windowEnd);

      ws().agentInstanceSessions.updateSilent(root.agent_instance_session_id, {
        created_at: new Date(Date.now() - 601_000).toISOString(),
      });
      await expectError(
        await mint(blueprint.id, { type: 'agent_delegated', agent_access_token: root.access_token }),
        400,
        'max_age_exceeded',
      );
    });
  });

  describe('refresh tokens', () => {
    it('rotates the refresh token and rejects a replay', async () => {
      const { org, blueprint } = await seedWorld();
      const first = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const second = await mintOk(blueprint.id, { type: 'refresh', refresh_token: first.refresh_token });
      expect(second.agent_instance_session_id).toBe(first.agent_instance_session_id);
      expect(second.refresh_token).not.toBe(first.refresh_token);
      expect(second.new_instance).toBe(false);
      await expectError(
        await mint(blueprint.id, { type: 'refresh', refresh_token: first.refresh_token }),
        400,
        'invalid_refresh_token',
      );
      const third = await mintOk(blueprint.id, { type: 'refresh', refresh_token: second.refresh_token });
      expect(third.agent_instance_session_id).toBe(first.agent_instance_session_id);
      // Rotation is not a new session and not a revocation.
      expect(events('agent.instance.session.created')).toHaveLength(1);
      expect(events('agent.instance.session.revoked')).toHaveLength(0);
    });

    it('rejects a refresh token presented to another blueprint', async () => {
      const { org, blueprint } = await seedWorld();
      const other = await json(await post('/agents/blueprints', { name: 'Other Agent' }));
      const minted = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      await expectError(
        await mint(other.id, { type: 'refresh', refresh_token: minted.refresh_token }),
        400,
        'invalid_refresh_token',
      );
    });

    it('reports revoked and expired sessions with their own codes', async () => {
      const { org, blueprint } = await seedWorld();
      const revoked = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      await post(`/agents/sessions/${revoked.agent_instance_session_id}/revoke`, {});
      await expectError(
        await mint(blueprint.id, { type: 'refresh', refresh_token: revoked.refresh_token }),
        400,
        'session_revoked',
      );

      const expired = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      ws().agentInstanceSessions.updateSilent(expired.agent_instance_session_id, {
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });
      await expectError(
        await mint(blueprint.id, { type: 'refresh', refresh_token: expired.refresh_token }),
        400,
        'session_expired',
      );
    });

    it('recomputes delegated permissions from the current role on refresh', async () => {
      const { membership, blueprint } = await seedWorld();
      const login = await loginAs();
      const first = await mintOk(blueprint.id, { type: 'user_delegated', user_access_token: login.access_token });
      expect(first.permissions).toEqual(['crm:read', 'email:send']);

      ws().organizationMemberships.update(membership.id, { role: { slug: 'member' } });
      const refreshed = await mintOk(blueprint.id, { type: 'refresh', refresh_token: first.refresh_token });
      expect(refreshed.permissions).toEqual(['crm:read']);
      expect(decodeJwt(refreshed.access_token).payload.permissions).toEqual(['crm:read']);
    });

    it('fails with user_session_ended once the delegating user session is gone', async () => {
      const { blueprint } = await seedWorld();
      const login = await loginAs();
      const minted = await mintOk(blueprint.id, { type: 'user_delegated', user_access_token: login.access_token });
      const { sid } = decodeJwt(login.access_token).payload;
      // Expire the user session in place; deleting it would cascade a revocation instead.
      ws().sessions.updateSilent(sid, { expires_at: new Date(Date.now() - 1000).toISOString() });
      await expectError(
        await mint(blueprint.id, { type: 'refresh', refresh_token: minted.refresh_token }),
        400,
        'user_session_ended',
      );
      await expectError(
        await post(`/agents/blueprints/${blueprint.id}/tokens/validate`, { agent_access_token: minted.access_token }),
        400,
        'user_session_ended',
      );
    });

    it('never extends a session past the root max-age window', async () => {
      const { org, blueprint } = await seedWorld({
        session_settings: { max_age_seconds: 600, access_token_ttl_seconds: 300, refresh_token_ttl_seconds: 3600 },
      });
      const minted = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const row = ws().agentInstanceSessions.get(minted.agent_instance_session_id)!;
      const windowEnd = new Date(row.created_at).getTime() + 600_000;
      const refreshed = await mintOk(blueprint.id, { type: 'refresh', refresh_token: minted.refresh_token });
      const rotated = ws().agentInstanceSessions.get(minted.agent_instance_session_id)!;
      expect(new Date(rotated.expires_at).getTime()).toBe(windowEnd);
      expect(refreshed.expires_in).toBe(300);
    });
  });

  describe('token validation', () => {
    it('validates a live token and reports its session', async () => {
      const { org, alice, blueprint } = await seedWorld();
      const login = await loginAs();
      const minted = await mintOk(blueprint.id, {
        type: 'user_delegated',
        user_access_token: login.access_token,
        intent: 'Qualify',
      });
      const res = await post(`/agents/blueprints/${blueprint.id}/tokens/validate`, {
        agent_access_token: minted.access_token,
      });
      expect(res.status).toBe(200);
      const body = await json(res);
      const row = ws().agentInstanceSessions.get(minted.agent_instance_session_id)!;
      expect(body).toEqual({
        valid: true,
        agent_instance_id: minted.agent_instance_id,
        agent_instance_session_id: minted.agent_instance_session_id,
        organization_id: org.id,
        permissions: ['crm:read', 'email:send'],
        intent: 'Qualify',
        acting_user_id: alice.id,
        session_expires_at: row.expires_at,
      });
    });

    it('reports null intent and acting user for an autonomous token', async () => {
      const { org, blueprint } = await seedWorld();
      const minted = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const body = await json(
        await post(`/agents/blueprints/${blueprint.id}/tokens/validate`, { agent_access_token: minted.access_token }),
      );
      expect(body).toMatchObject({ valid: true, intent: null, acting_user_id: null, organization_id: org.id });
    });

    it('rejects malformed, foreign-blueprint, revoked and expired tokens', async () => {
      const { org, blueprint } = await seedWorld();
      const validate = (id: string, token: unknown) =>
        post(`/agents/blueprints/${id}/tokens/validate`, { agent_access_token: token });
      await expectError(await validate(blueprint.id, undefined), 400, 'invalid_request');
      await expectError(await validate(blueprint.id, 'nope'), 400, 'invalid_agent_access_token');

      const other = await json(await post('/agents/blueprints', { name: 'Other Agent' }));
      const minted = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      await expectError(await validate(other.id, minted.access_token), 400, 'invalid_agent_access_token');

      ws().agentInstanceSessions.updateSilent(minted.agent_instance_session_id, {
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });
      await expectError(await validate(blueprint.id, minted.access_token), 400, 'session_expired');

      const second = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      await post(`/agents/sessions/${second.agent_instance_session_id}/revoke`, {});
      await expectError(await validate(blueprint.id, second.access_token), 400, 'session_revoked');
    });
  });

  describe('instances and sessions', () => {
    it('lists instances filtered by organization and blueprint', async () => {
      const { org, blueprint } = await seedWorld();
      const other = seedOrg('Other Inc');
      const second = await json(await post('/agents/blueprints', { name: 'Other Agent' }));
      await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      await mintOk(blueprint.id, { type: 'autonomous', organization_id: other.id });
      await mintOk(second.id, { type: 'autonomous', organization_id: org.id });

      expect((await json(await req('/agents/instances'))).data).toHaveLength(3);
      const byOrg = await json(await req(`/agents/instances?organization_id=${org.id}`));
      expect(byOrg.data).toHaveLength(2);
      const byBoth = await json(
        await req(`/agents/instances?organization_id=${org.id}&agent_blueprint_id=${blueprint.id}`),
      );
      expect(byBoth.data).toHaveLength(1);
      expect(Object.keys(byBoth.data[0]).sort()).toEqual(INSTANCE_KEYS);
      expect((await req('/agents/instances/agent_missing')).status).toBe(404);
    });

    it('deletes an instance, revoking then removing its sessions', async () => {
      const { org, blueprint } = await seedWorld();
      const minted = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const res = await req(`/agents/instances/${minted.agent_instance_id}`, { method: 'DELETE' });
      expect(res.status).toBe(204);
      expect((await req(`/agents/instances/${minted.agent_instance_id}`)).status).toBe(404);
      expect((await req(`/agents/sessions/${minted.agent_instance_session_id}`)).status).toBe(404);
      expect(events('agent.instance.deleted')).toHaveLength(1);
      expect(events('agent.instance.session.revoked')).toHaveLength(1);
      expect((await req(`/agents/instances/${minted.agent_instance_id}`, { method: 'DELETE' })).status).toBe(404);
    });

    it('lists sessions filtered by instance and blueprint with derived status', async () => {
      const { org, blueprint } = await seedWorld();
      const second = await json(await post('/agents/blueprints', { name: 'Other Agent' }));
      const a = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const b = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      await mintOk(second.id, { type: 'autonomous', organization_id: org.id });
      ws().agentInstanceSessions.updateSilent(b.agent_instance_session_id, {
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });

      expect((await json(await req('/agents/sessions'))).data).toHaveLength(3);
      const byBlueprint = await json(await req(`/agents/sessions?agent_blueprint_id=${blueprint.id}`));
      expect(byBlueprint.data).toHaveLength(2);
      const byInstance = await json(await req(`/agents/sessions?agent_instance_id=${a.agent_instance_id}`));
      expect(byInstance.data).toHaveLength(2);
      expect(Object.keys(byInstance.data[0]).sort()).toEqual(SESSION_KEYS);
      const statuses = Object.fromEntries(byInstance.data.map((s: { id: string; status: string }) => [s.id, s.status]));
      expect(statuses[a.agent_instance_session_id]).toBe('active');
      expect(statuses[b.agent_instance_session_id]).toBe('expired');
      expect((await req('/agents/sessions/agent_session_missing')).status).toBe(404);
    });

    it('revokes a session and everything chained from it, idempotently', async () => {
      const { org, blueprint } = await seedWorld();
      const root = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const child = await mintOk(blueprint.id, { type: 'agent_delegated', agent_access_token: root.access_token });
      const grandchild = await mintOk(blueprint.id, {
        type: 'agent_delegated',
        agent_access_token: child.access_token,
      });
      const sibling = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });

      const res = await post(`/agents/sessions/${child.agent_instance_session_id}/revoke`, {});
      expect(res.status).toBe(200);
      const body = await json(res);
      expect(body).toMatchObject({ id: child.agent_instance_session_id, status: 'revoked' });
      expect(body.revoked_at).toBeTruthy();

      const status = async (id: string) => (await json(await req(`/agents/sessions/${id}`))).status;
      expect(await status(root.agent_instance_session_id)).toBe('active');
      expect(await status(grandchild.agent_instance_session_id)).toBe('revoked');
      expect(await status(sibling.agent_instance_session_id)).toBe('active');

      const revokedEvents = events('agent.instance.session.revoked');
      expect(revokedEvents).toHaveLength(2);
      expect(Object.keys(revokedEvents[0]!.data).sort()).toEqual(
        [
          'object',
          'id',
          'agent_instance_id',
          'organization_id',
          'expires_at',
          'revoked_at',
          'created_at',
          'updated_at',
        ].sort(),
      );

      const again = await json(await post(`/agents/sessions/${child.agent_instance_session_id}/revoke`, {}));
      expect(again.revoked_at).toBe(body.revoked_at);
      expect(events('agent.instance.session.revoked')).toHaveLength(2);

      // A revoked ancestor poisons the chain below it for delegation and refresh.
      await expectError(
        await mint(blueprint.id, { type: 'agent_delegated', agent_access_token: grandchild.access_token }),
        400,
        'invalid_agent_access_token',
      );
      await expectError(
        await mint(blueprint.id, { type: 'refresh', refresh_token: grandchild.refresh_token }),
        400,
        'session_revoked',
      );
      expect((await post('/agents/sessions/agent_session_missing/revoke', {})).status).toBe(404);
    });

    it('leaves an already-expired session expired while still revoking its live descendants', async () => {
      const { org, blueprint } = await seedWorld();
      const root = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const child = await mintOk(blueprint.id, { type: 'agent_delegated', agent_access_token: root.access_token });
      const grandchild = await mintOk(blueprint.id, {
        type: 'agent_delegated',
        agent_access_token: child.access_token,
      });
      const expired = new Date(Date.now() - 1000).toISOString();
      ws().agentInstanceSessions.updateSilent(root.agent_instance_session_id, { expires_at: expired });
      ws().agentInstanceSessions.updateSilent(child.agent_instance_session_id, { expires_at: expired });

      const res = await post(`/agents/sessions/${root.agent_instance_session_id}/revoke`, {});
      expect(res.status).toBe(200);
      expect(await json(res)).toMatchObject({
        id: root.agent_instance_session_id,
        status: 'expired',
        revoked_at: null,
      });

      const session = async (id: string) => json(await req(`/agents/sessions/${id}`));
      expect(await session(child.agent_instance_session_id)).toMatchObject({ status: 'expired', revoked_at: null });
      expect(await session(grandchild.agent_instance_session_id)).toMatchObject({ status: 'revoked' });
      expect(events('agent.instance.session.revoked').map((e) => e.data.id)).toEqual([
        grandchild.agent_instance_session_id,
      ]);
    });
  });

  describe('cascades from the resources agents depend on', () => {
    const validate = (blueprintId: string, token: string) =>
      post(`/agents/blueprints/${blueprintId}/tokens/validate`, { agent_access_token: token });

    it('deleting an organization tears down its autonomous and delegated agents', async () => {
      const { org, blueprint } = await seedWorld();
      const other = seedOrg('Other Inc');
      const login = await loginAs();
      const autonomous = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const delegated = await mintOk(blueprint.id, {
        type: 'user_delegated',
        user_access_token: login.access_token,
      });
      const survivor = await mintOk(blueprint.id, { type: 'autonomous', organization_id: other.id });

      expect((await req(`/organizations/${org.id}`, { method: 'DELETE' })).status).toBe(204);

      for (const minted of [autonomous, delegated]) {
        expect((await req(`/agents/instances/${minted.agent_instance_id}`)).status).toBe(404);
        expect((await req(`/agents/sessions/${minted.agent_instance_session_id}`)).status).toBe(404);
        await expectError(await validate(blueprint.id, minted.access_token), 400, 'invalid_agent_access_token');
        await expectError(
          await mint(blueprint.id, { type: 'refresh', refresh_token: minted.refresh_token }),
          400,
          'invalid_refresh_token',
        );
      }
      expect((await json(await req('/agents/instances'))).data.map((i: { id: string }) => i.id)).toEqual([
        survivor.agent_instance_id,
      ]);
      expect((await json(await validate(blueprint.id, survivor.access_token))).valid).toBe(true);
      expect(events('agent.instance.deleted')).toHaveLength(2);
      expect(events('agent.instance.session.revoked')).toHaveLength(2);
    });

    it('deleting a membership deletes the instances delegated from it', async () => {
      const { org, membership, blueprint } = await seedWorld();
      const login = await loginAs();
      const delegated = await mintOk(blueprint.id, {
        type: 'user_delegated',
        user_access_token: login.access_token,
      });
      const autonomous = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });

      const res = await req(`/user_management/organization_memberships/${membership.id}`, { method: 'DELETE' });
      expect(res.status).toBe(204);

      expect((await req(`/agents/instances/${delegated.agent_instance_id}`)).status).toBe(404);
      await expectError(await validate(blueprint.id, delegated.access_token), 400, 'invalid_agent_access_token');
      expect((await json(await validate(blueprint.id, autonomous.access_token))).valid).toBe(true);
      expect(events('agent.instance.deleted')).toHaveLength(1);
      expect(events('agent.instance.session.revoked')).toHaveLength(1);
    });

    it('deleting a user deletes the instances delegated from its memberships', async () => {
      const { org, alice, blueprint } = await seedWorld();
      const login = await loginAs();
      const delegated = await mintOk(blueprint.id, {
        type: 'user_delegated',
        user_access_token: login.access_token,
      });
      const child = await mintOk(blueprint.id, { type: 'agent_delegated', agent_access_token: delegated.access_token });
      const autonomous = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });

      expect((await req(`/user_management/users/${alice.id}`, { method: 'DELETE' })).status).toBe(204);

      expect((await req(`/agents/instances/${delegated.agent_instance_id}`)).status).toBe(404);
      for (const minted of [delegated, child]) {
        expect((await req(`/agents/sessions/${minted.agent_instance_session_id}`)).status).toBe(404);
        await expectError(await validate(blueprint.id, minted.access_token), 400, 'invalid_agent_access_token');
      }
      expect((await json(await validate(blueprint.id, autonomous.access_token))).valid).toBe(true);
      expect(events('agent.instance.deleted').map((e) => e.data.id)).toEqual([delegated.agent_instance_id]);
      expect(events('agent.instance.session.revoked')).toHaveLength(2);
    });

    it('deactivating a membership revokes its delegated sessions but keeps the instance', async () => {
      const { membership, blueprint } = await seedWorld();
      const login = await loginAs();
      const root = await mintOk(blueprint.id, { type: 'user_delegated', user_access_token: login.access_token });
      const child = await mintOk(blueprint.id, { type: 'agent_delegated', agent_access_token: root.access_token });

      const res = await req(`/user_management/organization_memberships/${membership.id}/deactivate`, {
        method: 'PUT',
      });
      expect(res.status).toBe(200);

      for (const minted of [root, child]) {
        await expectError(await validate(blueprint.id, minted.access_token), 400, 'session_revoked');
        expect((await json(await req(`/agents/sessions/${minted.agent_instance_session_id}`))).status).toBe('revoked');
      }
      expect((await req(`/agents/instances/${root.agent_instance_id}`)).status).toBe(200);
      expect(events('agent.instance.session.revoked')).toHaveLength(2);
    });

    it('deleting a permission removes it from every blueprint ceiling', async () => {
      const { org, blueprint } = await seedWorld();
      const untouched = await json(await post('/agents/blueprints', { name: 'Reader', permissions: ['crm:read'] }));

      expect((await req('/authorization/permissions/email:send', { method: 'DELETE' })).status).toBe(204);

      expect((await json(await req(`/agents/blueprints/${blueprint.id}`))).permissions).toEqual(['crm:read']);
      const minted = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      expect(minted.permissions).toEqual(['crm:read']);
      expect(decodeJwt(minted.access_token).payload.permissions).toEqual(['crm:read']);
      const updated = events('agent.blueprint.updated');
      expect(updated.map((e) => e.data.id)).toEqual([blueprint.id]);
      expect(updated[0]!.data.permissions).toEqual(['crm:read']);
      expect((await json(await req(`/agents/blueprints/${untouched.id}`))).permissions).toEqual(['crm:read']);
    });

    it('treats a chained session whose parent is gone as revoked provenance', async () => {
      const { org, blueprint } = await seedWorld();
      const root = await mintOk(blueprint.id, { type: 'autonomous', organization_id: org.id });
      const child = await mintOk(blueprint.id, { type: 'agent_delegated', agent_access_token: root.access_token });
      ws().agentInstanceSessions.delete(root.agent_instance_session_id);

      await expectError(
        await mint(blueprint.id, { type: 'agent_delegated', agent_access_token: child.access_token }),
        400,
        'invalid_agent_access_token',
      );
      await expectError(
        await mint(blueprint.id, { type: 'refresh', refresh_token: child.refresh_token }),
        400,
        'session_revoked',
      );
      await expectError(await validate(blueprint.id, child.access_token), 400, 'session_revoked');
    });
  });
});
