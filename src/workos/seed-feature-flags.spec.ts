/**
 * Seeding feature flags. Production has no create-flag endpoint — flags are made in the
 * dashboard — so a seed file is the only way one exists in the emulator at all. The two
 * surfaces a consumer reads them from are the `feature_flags` access-token claim and the
 * per-user / per-organization list endpoints an SDK polls.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createEmulator, type Emulator } from '../index.js';
import { validateSeedConfig } from './config-validator.js';

describe('Seeding feature flags', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  const decode = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8')) as Record<string, unknown>;

  const seed = {
    users: [
      { email: 'alice@acme.com', password: 'test123', email_verified: true },
      { email: 'bob@acme.com', password: 'test123', email_verified: true },
    ],
    organizations: [
      { name: 'Acme Corp', memberships: [{ email: 'alice@acme.com' }, { email: 'bob@acme.com' }] },
      { name: 'Other Inc' },
    ],
    featureFlags: [
      { slug: 'everyone', name: 'On For Everyone', default_value: true },
      { slug: 'alice-only', targets: { users: ['alice@acme.com'] } },
      { slug: 'acme-only', targets: { organizations: ['Acme Corp'] } },
      { slug: 'other-only', targets: { organizations: ['Other Inc'] } },
      { slug: 'switched-off', enabled: false, default_value: true },
      {
        slug: 'documented',
        description: 'Has every optional field set',
        tags: ['ui', 'beta'],
        owner: { email: 'jane@acme.com', first_name: 'Jane', last_name: 'Doe' },
        default_value: true,
      },
    ],
  };

  const signIn = async (email: string) => {
    const res = await fetch(`${emulator!.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email, password: 'test123', client_id: 'client_test' }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as { access_token: string; organization_id?: string; user: { id: string } };
  };

  const get = async (path: string) => {
    const res = await fetch(`${emulator!.url}${path}`, { headers: { Authorization: `Bearer ${emulator!.apiKey}` } });
    expect(res.status).toBe(200);
    return (await res.json()) as { data: Array<Record<string, unknown>> };
  };

  it('mints seeded flags into the access token claim, scoped to the session organization', async () => {
    emulator = await createEmulator({ port: 0, seed });

    const alice = await signIn('alice@acme.com');
    const flags = decode(alice.access_token).feature_flags as string[];
    // 'other-only' targets an org Alice is not in; 'switched-off' is disabled environment-wide.
    expect([...flags].sort()).toEqual(['acme-only', 'alice-only', 'documented', 'everyone']);
  });

  it('leaves a user-targeted flag off for a colleague in the same organization', async () => {
    emulator = await createEmulator({ port: 0, seed });

    const bob = await signIn('bob@acme.com');
    const flags = decode(bob.access_token).feature_flags as string[];
    expect(flags).toContain('acme-only');
    expect(flags).not.toContain('alice-only');
  });

  it('serves the same set over the user list endpoint an SDK polls', async () => {
    emulator = await createEmulator({ port: 0, seed });

    const alice = await signIn('alice@acme.com');
    const list = await get(`/user_management/users/${alice.user.id}/feature-flags`);
    expect(list.data.map((f) => f.slug).sort()).toEqual(['acme-only', 'alice-only', 'documented', 'everyone']);
  });

  it('carries every seeded field onto the flag object', async () => {
    emulator = await createEmulator({ port: 0, seed });

    const flags = await get('/feature-flags');
    const documented = flags.data.find((f) => f.slug === 'documented')!;
    expect(documented).toMatchObject({
      object: 'feature_flag',
      name: 'documented',
      description: 'Has every optional field set',
      tags: ['ui', 'beta'],
      owner: { email: 'jane@acme.com', first_name: 'Jane', last_name: 'Doe' },
      enabled: true,
      default_value: true,
    });
    expect(documented.id as string).toStartWith('flag_');
  });

  it('honours a pinned flag id', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: { featureFlags: [{ id: 'flag_01PINNED', slug: 'pinned' }] },
    });

    const flags = await get('/feature-flags');
    expect(flags.data[0].id).toBe('flag_01PINNED');
  });

  it('lists organization flags for the seeded organization only', async () => {
    emulator = await createEmulator({ port: 0, seed });

    const orgs = await get('/organizations');
    const acme = orgs.data.find((o) => o.name === 'Acme Corp')!;
    const list = await get(`/organizations/${acme.id}/feature-flags`);
    // No user targets apply to an organization, so 'alice-only' is absent here.
    expect(list.data.map((f) => f.slug).sort()).toEqual(['acme-only', 'documented', 'everyone']);
  });

  it('scopes the token claim to the session organization while the list endpoint unions all of them', async () => {
    // The one configuration where the two surfaces intentionally differ, and the reason the
    // README documents the scoping rather than claiming the three surfaces are identical.
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'multi@acme.com', password: 'test123', email_verified: true }],
        organizations: [
          { name: 'First Org', memberships: [{ email: 'multi@acme.com' }] },
          { name: 'Second Org', memberships: [{ email: 'multi@acme.com' }] },
        ],
        featureFlags: [{ slug: 'second-org-only', targets: { organizations: ['Second Org'] } }],
      },
    });

    // A user in two organizations must choose one before a session exists. The pending token is
    // single-use, so each selection starts its own sign-in.
    const startAuth = async () => {
      const res = await fetch(`${emulator!.url}/user_management/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'password',
          email: 'multi@acme.com',
          password: 'test123',
          client_id: 'client_test',
        }),
      });
      expect(res.status).toBe(403);
      return (await res.json()) as {
        pending_authentication_token: string;
        organizations: Array<{ id: string; name: string }>;
        user: { id: string };
      };
    };

    const claimFor = async (orgName: string) => {
      const pending = await startAuth();
      const org = pending.organizations.find((o) => o.name === orgName)!;
      const res = await fetch(`${emulator!.url}/user_management/authenticate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:workos:oauth:grant-type:organization-selection',
          pending_authentication_token: pending.pending_authentication_token,
          organization_id: org.id,
          client_id: 'client_test',
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { access_token: string };
      return (decode(body.access_token).feature_flags as string[] | undefined) ?? [];
    };

    expect(await claimFor('Second Org')).toEqual(['second-org-only']);
    // Same user, same flag, different session scope — the claim drops it.
    expect(await claimFor('First Org')).toEqual([]);

    const pending = await startAuth();

    // The list endpoint is not session-scoped, so it unions both memberships and keeps it.
    const list = await get(`/user_management/users/${pending.user.id}/feature-flags`);
    expect(list.data.map((f) => f.slug)).toEqual(['second-org-only']);
  });

  it('rejects two flags pinned to the same id', () => {
    const { valid, errors } = validateSeedConfig({
      featureFlags: [
        { id: 'flag_dup', slug: 'a' },
        { id: 'flag_dup', slug: 'b' },
      ],
    });
    expect(valid).toBe(false);
    expect(errors.find((e) => e.path === 'featureFlags[1].id')).toBeDefined();
  });

  it('rejects a pinned id that is not a plain identifier', () => {
    const { valid, errors } = validateSeedConfig({ featureFlags: [{ id: 'flag/../boom !', slug: 'a' }] });
    expect(valid).toBe(false);
    expect(errors.find((e) => e.path === 'featureFlags[0].id')).toBeDefined();
  });

  it('reports a non-array targets sub-field rather than throwing', () => {
    // A YAML author writing `users: alice@acme.com` instead of a list previously crashed the
    // validator with a raw TypeError, which --validate-config surfaced as a stack trace.
    const run = () =>
      validateSeedConfig({
        users: [{ email: 'alice@acme.com' }],
        featureFlags: [{ slug: 'a', targets: { users: 'alice@acme.com' as unknown as string[] } }],
      });
    expect(run).not.toThrow();
    const { valid, errors } = run();
    expect(valid).toBe(false);
    expect(errors.find((e) => e.path === 'featureFlags[0].targets.users')).toBeDefined();
  });

  it('rejects the same target listed twice', () => {
    const { valid, errors } = validateSeedConfig({
      users: [{ email: 'alice@acme.com' }],
      organizations: [{ name: 'Acme Corp' }],
      featureFlags: [
        {
          slug: 'a',
          targets: {
            users: ['alice@acme.com', 'ALICE@acme.com'],
            organizations: ['Acme Corp', 'Acme Corp'],
          },
        },
      ],
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.path)).toEqual([
      'featureFlags[0].targets.users[1]',
      'featureFlags[0].targets.organizations[1]',
    ]);
  });

  it('rejects a non-string name or description', () => {
    const { valid, errors } = validateSeedConfig({
      featureFlags: [{ slug: 'a', name: 42 as unknown as string, description: 7 as unknown as string }],
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.path).sort()).toEqual(['featureFlags[0].description', 'featureFlags[0].name']);
  });

  it('rejects a target naming a user or organization the config does not define', () => {
    const { valid, errors } = validateSeedConfig({
      users: [{ email: 'alice@acme.com' }],
      organizations: [{ name: 'Acme Corp' }],
      featureFlags: [{ slug: 'typo', targets: { users: ['alcie@acme.com'], organizations: ['Acme Crop'] } }],
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.path)).toEqual([
      'featureFlags[0].targets.users[0]',
      'featureFlags[0].targets.organizations[0]',
    ]);
  });

  it('reports a null feature-flag entry rather than throwing', () => {
    // An empty YAML list item parses as null; --validate-config must report it, not stack-trace.
    const run = () => validateSeedConfig({ featureFlags: [null as unknown as { slug: string }] });
    expect(run).not.toThrow();
    const { valid, errors } = run();
    expect(valid).toBe(false);
    expect(errors.find((e) => e.path === 'featureFlags[0]')).toBeDefined();
  });

  it('rejects a duplicate slug', () => {
    const { valid, errors } = validateSeedConfig({
      featureFlags: [{ slug: 'dupe' }, { slug: 'dupe' }],
    });
    expect(valid).toBe(false);
    expect(errors.find((e) => e.path === 'featureFlags[1].slug')).toBeDefined();
  });

  it('rejects a slug that is not URL-safe', () => {
    // Every route addresses a flag by slug in the path, so a slug needing percent-encoding
    // would seed fine and then be unreachable.
    const { valid, errors } = validateSeedConfig({
      featureFlags: [{ slug: 'beta/dashboard' }, { slug: 'has space' }, { slug: 'fine-slug_1.0~' }],
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.path)).toEqual(['featureFlags[0].slug', 'featureFlags[1].slug']);
  });

  it('reports a non-string organization target as a type error, not an unknown name', () => {
    const { valid, errors } = validateSeedConfig({
      organizations: [{ name: 'Acme Corp' }],
      featureFlags: [{ slug: 'a', targets: { organizations: [42 as unknown as string] } }],
    });
    expect(valid).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      path: 'featureFlags[0].targets.organizations[0]',
      message: 'targets.organizations entries must be names of organizations defined in `organizations`',
    });
  });

  it('rejects a non-boolean default_value', () => {
    const { valid, errors } = validateSeedConfig({
      featureFlags: [{ slug: 'typed', default_value: 'variant-a' as unknown as boolean }],
    });
    expect(valid).toBe(false);
    expect(errors.find((e) => e.path === 'featureFlags[0].default_value')).toBeDefined();
  });
});
