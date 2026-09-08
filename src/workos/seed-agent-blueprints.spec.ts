/**
 * Seeding agent blueprints. Blueprints have a create route too, but a seed is how a test
 * environment boots with one already in place; instances and sessions are never seeded and
 * only come from minting.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createEmulator, type Emulator } from '../index.js';
import { validateSeedConfig } from './config-validator.js';

describe('Seeding agent blueprints', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  const seed = {
    users: [{ email: 'alice@acme.com', password: 'test123', email_verified: true }],
    permissions: [
      { slug: 'crm:read', name: 'Read CRM' },
      { slug: 'email:send', name: 'Send email' },
    ],
    roles: [
      { slug: 'manager', name: 'Manager', permissions: ['crm:read', 'email:send'] },
      { slug: 'member', name: 'Member', permissions: ['crm:read'] },
    ],
    organizations: [
      { name: 'Acme Corp', memberships: [{ email: 'alice@acme.com', role: 'manager' }] },
      { name: 'Other Inc' },
    ],
    agentBlueprints: [
      {
        id: 'agent_blueprint_01PINNED',
        name: 'Prospecting Agent',
        description: 'Finds prospects',
        permissions: ['crm:read', 'email:send'],
        invocable_by: { role_slugs: ['manager'], organizations: ['Acme Corp'] },
        session_settings: { access_token_ttl_seconds: 60 },
      },
      { name: 'Minimal Agent' },
    ],
  };

  const api = async (path: string, init?: RequestInit) => {
    const res = await fetch(`${emulator!.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${emulator!.apiKey}`, 'Content-Type': 'application/json', ...init?.headers },
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  it('seeds blueprints with defaults, a pinned id, and organizations resolved by name', async () => {
    emulator = await createEmulator({ port: 0, seed });

    const orgs = await api('/organizations');
    const acme = orgs.body.data.find((o: { name: string }) => o.name === 'Acme Corp')!;

    const list = await api('/agents/blueprints');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(2);

    const pinned = await api('/agents/blueprints/agent_blueprint_01PINNED');
    expect(pinned.status).toBe(200);
    expect(pinned.body).toMatchObject({
      name: 'Prospecting Agent',
      description: 'Finds prospects',
      permissions: ['crm:read', 'email:send'],
      invocable_by: { role_slugs: ['manager'], organization_ids: [acme.id] },
      session_settings: { max_age_seconds: 3600, access_token_ttl_seconds: 60, refresh_token_ttl_seconds: 3600 },
    });

    const minimal = list.body.data.find((b: { name: string }) => b.name === 'Minimal Agent');
    expect(minimal).toMatchObject({
      description: null,
      permissions: [],
      invocable_by: { role_slugs: [], organization_ids: [] },
      session_settings: { max_age_seconds: 3600, access_token_ttl_seconds: 300, refresh_token_ttl_seconds: 3600 },
    });
    expect(minimal.id).toStartWith('agent_blueprint_');
  });

  it('mints from a seeded blueprint with the seeded member', async () => {
    emulator = await createEmulator({ port: 0, seed });

    const login = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'alice@acme.com', password: 'test123' }),
    });
    expect(login.status).toBe(200);
    const { access_token } = (await login.json()) as { access_token: string };

    const minted = await api('/agents/blueprints/agent_blueprint_01PINNED/tokens', {
      method: 'POST',
      body: JSON.stringify({ type: 'user_delegated', user_access_token: access_token }),
    });
    expect(minted.status).toBe(200);
    expect(minted.body.permissions).toEqual(['crm:read', 'email:send']);
    expect(minted.body.expires_in).toBe(60);
  });

  it('accepts the sample config', () => {
    expect(validateSeedConfig(seed)).toEqual({ valid: true, errors: [] });
  });

  it('rejects unknown permission, role and organization references', () => {
    const { valid, errors } = validateSeedConfig({
      ...seed,
      agentBlueprints: [
        {
          name: 'Broken',
          permissions: ['nope'],
          invocable_by: { role_slugs: ['nope'], organizations: ['Nope Inc'] },
        },
      ],
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.path).sort()).toEqual([
      'agentBlueprints[0].invocable_by.organizations[0]',
      'agentBlueprints[0].invocable_by.role_slugs[0]',
      'agentBlueprints[0].permissions[0]',
    ]);
  });

  it('rejects duplicate names and ids, and out-of-range session settings', () => {
    const { valid, errors } = validateSeedConfig({
      agentBlueprints: [
        { id: 'agent_blueprint_dup', name: 'Same' },
        { id: 'agent_blueprint_dup', name: 'Same', session_settings: { access_token_ttl_seconds: 3601 } },
        { name: 'Bad Settings', session_settings: { max_age_seconds: 0, refresh_token_ttl_seconds: 1.5 } },
      ],
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.path).sort()).toEqual([
      'agentBlueprints[1].id',
      'agentBlueprints[1].name',
      'agentBlueprints[1].session_settings.access_token_ttl_seconds',
      'agentBlueprints[2].session_settings.max_age_seconds',
      'agentBlueprints[2].session_settings.refresh_token_ttl_seconds',
    ]);
  });

  it('reports a non-array sub-field rather than throwing', () => {
    const run = () =>
      validateSeedConfig({
        agentBlueprints: [
          {
            name: 'a',
            permissions: 'crm:read' as unknown as string[],
            invocable_by: { role_slugs: 'manager' as unknown as string[] },
          },
        ],
      });
    expect(run).not.toThrow();
    const { valid, errors } = run();
    expect(valid).toBe(false);
    expect(errors.map((e) => e.path).sort()).toEqual([
      'agentBlueprints[0].invocable_by.role_slugs',
      'agentBlueprints[0].permissions',
    ]);
  });
});
