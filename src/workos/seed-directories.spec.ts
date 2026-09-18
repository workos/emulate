/**
 * Seeding directories. Production connects a directory through the dashboard, so there is
 * no POST route to emulate and seeding is the only way to create one. A directory joins its
 * organization by name — the same key `connections` uses — and its users join the
 * directory's own groups by name, since group ids are generated at startup.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createEmulator, type Emulator } from '../index.js';
import { validateSeedConfig } from './config-validator.js';

describe('Seeding directories', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

  const get = async (url: string, apiKey: string) =>
    (await (await fetch(url, { headers: auth(apiKey) })).json()) as any;

  it('seeds a directory against its organization, with defaults', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        directories: [{ name: 'Acme Okta', organization: 'Acme Corp' }],
      },
    });

    const orgs = await get(`${emulator.url}/organizations`, emulator.apiKey);
    const org = orgs.data[0];

    const list = await get(`${emulator.url}/directories?organization_id=${org.id}`, emulator.apiKey);
    expect(list.data).toHaveLength(1);
    expect(list.data[0].name).toBe('Acme Okta');
    expect(list.data[0].organization_id).toBe(org.id);
    expect(list.data[0].state).toBe('linked');
    expect(list.data[0].type).toBe('generic scim v2.0');
  });

  it('seeds groups and joins users to them by name', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        directories: [
          {
            name: 'Acme Okta',
            organization: 'Acme Corp',
            type: 'okta scim v2.0',
            domain: 'acme.com',
            groups: ['Engineering', 'Sales'],
            users: [
              { email: 'dev@acme.com', first_name: 'Dev', last_name: 'Eloper', groups: ['Engineering'] },
              { email: 'rep@acme.com', state: 'inactive' },
            ],
          },
        ],
      },
    });

    const dirs = await get(`${emulator.url}/directories`, emulator.apiKey);
    const directory = dirs.data[0];
    expect(directory.type).toBe('okta scim v2.0');
    expect(directory.domain).toBe('acme.com');

    const groups = await get(`${emulator.url}/directory_groups?directory=${directory.id}`, emulator.apiKey);
    expect(groups.data.map((g: any) => g.name).sort()).toEqual(['Engineering', 'Sales']);

    const users = await get(`${emulator.url}/directory_users?directory=${directory.id}`, emulator.apiKey);
    expect(users.data).toHaveLength(2);

    const dev = users.data.find((u: any) => u.email === 'dev@acme.com');
    expect(dev.first_name).toBe('Dev');
    expect(dev.state).toBe('active');
    expect(dev.idp_id).toMatch(/^idp_/);
    expect(dev.groups).toHaveLength(1);
    expect(dev.groups[0].name).toBe('Engineering');
    // The embedded group carries the generated id, so it resolves against the group list.
    expect(groups.data.some((g: any) => g.id === dev.groups[0].id)).toBe(true);

    const rep = users.data.find((u: any) => u.email === 'rep@acme.com');
    expect(rep.state).toBe('inactive');
    expect(rep.groups).toHaveLength(0);

    const byGroup = await get(`${emulator.url}/directory_users?group=${dev.groups[0].id}`, emulator.apiKey);
    expect(byGroup.data).toHaveLength(1);
    expect(byGroup.data[0].email).toBe('dev@acme.com');
  });

  it('emits dsync.activated and dsync.user.created for seeded directories', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        directories: [{ name: 'Acme Okta', organization: 'Acme Corp', users: [{ email: 'dev@acme.com' }] }],
      },
    });

    const evts = await get(
      `${emulator.url}/events?events[]=dsync.activated&events[]=dsync.user.created`,
      emulator.apiKey,
    );
    const names = evts.data.map((e: any) => e.event);
    expect(names).toContain('dsync.activated');
    expect(names).toContain('dsync.user.created');
  });

  it('maps a group to a role, on the directory user and the organization membership', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'dev@acme.com' }, { email: 'boss@acme.com' }, { email: 'temp@acme.com' }],
        organizations: [
          {
            name: 'Acme Corp',
            memberships: [{ email: 'dev@acme.com' }, { email: 'boss@acme.com' }, { email: 'temp@acme.com' }],
          },
        ],
        directories: [
          {
            name: 'Acme Okta',
            organization: 'Acme Corp',
            // Declaration order is the priority order: Admins wins for a user in both.
            groups: [{ name: 'Admins', role: 'admin' }, { name: 'Engineering', role: 'member' }, 'Contractors'],
            users: [
              { email: 'dev@acme.com', groups: ['Engineering'] },
              { email: 'boss@acme.com', groups: ['Engineering', 'Admins'] },
              { email: 'temp@acme.com', groups: ['Contractors'] },
            ],
          },
        ],
      },
    });

    const users = await get(`${emulator.url}/directory_users`, emulator.apiKey);
    const roleOf = (email: string) => users.data.find((u: any) => u.email === email).role;
    expect(roleOf('dev@acme.com')).toEqual({ slug: 'member' });
    expect(roleOf('boss@acme.com')).toEqual({ slug: 'admin' });
    // An unmapped group leaves the user without a role, as an unmapped group does upstream.
    expect(roleOf('temp@acme.com')).toBeNull();

    // The mapped role reaches the organization membership, which is what an app reads.
    const orgs = await get(`${emulator.url}/organizations`, emulator.apiKey);
    const memberships = await get(
      `${emulator.url}/user_management/organization_memberships?organization_id=${orgs.data[0].id}`,
      emulator.apiKey,
    );
    const membershipRole = (email: string) => memberships.data.find((m: any) => m.user.email === email)?.role?.slug;
    expect(membershipRole('dev@acme.com')).toBe('member');
    expect(membershipRole('boss@acme.com')).toBe('admin');
    // Unmapped, so the membership keeps the role its own seed gave it.
    expect(membershipRole('temp@acme.com')).toBe('member');
  });

  it('lets an explicit user role override the group mapping', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        directories: [
          {
            name: 'Acme Okta',
            organization: 'Acme Corp',
            groups: [{ name: 'Engineering', role: 'member' }],
            users: [{ email: 'dev@acme.com', groups: ['Engineering'], role: 'admin' }],
          },
        ],
      },
    });

    const users = await get(`${emulator.url}/directory_users`, emulator.apiKey);
    expect(users.data[0].role).toEqual({ slug: 'admin' });
  });

  it('reports malformed entries instead of throwing', () => {
    const cases: Array<[string, unknown, string]> = [
      ['a null directory', { directories: [null] }, 'directories[0]'],
      [
        'a scalar groups value',
        { organizations: [{ name: 'A' }], directories: [{ name: 'D', organization: 'A', groups: 'Engineering' }] },
        'directories[0].groups',
      ],
      [
        'a null group entry',
        { organizations: [{ name: 'A' }], directories: [{ name: 'D', organization: 'A', groups: [null] }] },
        'directories[0].groups[0]',
      ],
      [
        'a null user',
        { organizations: [{ name: 'A' }], directories: [{ name: 'D', organization: 'A', users: [null] }] },
        'directories[0].users[0]',
      ],
      [
        'a scalar user groups value',
        {
          organizations: [{ name: 'A' }],
          directories: [{ name: 'D', organization: 'A', users: [{ email: 'a@b.com', groups: 'Engineering' }] }],
        },
        'directories[0].users[0].groups',
      ],
      [
        'an unsupported user state',
        {
          organizations: [{ name: 'A' }],
          directories: [{ name: 'D', organization: 'A', users: [{ email: 'a@b.com', state: 'suspended' }] }],
        },
        'directories[0].users[0].state',
      ],
    ];

    for (const [name, config, expectedPath] of cases) {
      const result = validateSeedConfig(config as never);
      expect(result.valid, name).toBe(false);
      expect(
        result.errors.map((e) => e.path),
        name,
      ).toContain(expectedPath);
    }
  });

  it('rejects a user group that the directory does not declare', () => {
    const result = validateSeedConfig({
      organizations: [{ name: 'Acme Corp' }],
      directories: [
        {
          name: 'Acme Okta',
          organization: 'Acme Corp',
          groups: ['Engineering'],
          users: [{ email: 'dev@acme.com', groups: ['Marketing'] }],
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'directories[0].users[0].groups')).toBe(true);
  });

  it('rejects a directory whose organization is not declared', () => {
    const result = validateSeedConfig({
      organizations: [{ name: 'Acme Corp' }],
      directories: [{ name: 'Acme Okta', organization: 'Acme Corpp' }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'directories[0].organization')).toBe(true);
  });

  it('rejects duplicate group names', () => {
    const result = validateSeedConfig({
      organizations: [{ name: 'Acme Corp' }],
      directories: [{ name: 'Acme Okta', organization: 'Acme Corp', groups: ['Engineering', 'Engineering'] }],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'directories[0].groups')).toBe(true);
  });

  it('rejects a directory with no name or organization, and an unknown state', () => {
    const result = validateSeedConfig({
      directories: [{ state: 'pending' } as never],
    });

    expect(result.valid).toBe(false);
    const paths = result.errors.map((e) => e.path);
    expect(paths).toContain('directories[0].name');
    expect(paths).toContain('directories[0].organization');
    expect(paths).toContain('directories[0].state');
  });
});
