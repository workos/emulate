/**
 * Seeding AuthKit groups. Groups are nested under an organization, and their members
 * reference an organization membership by the user's email — the same join key
 * `memberships` use, since org membership ids are generated at startup. validateSeedConfig
 * rejects a member email that does not match a membership declared in the same org.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createEmulator, type Emulator } from '../index.js';
import { validateSeedConfig } from './config-validator.js';

describe('Seeding groups', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

  it('seeds a group and joins its members to memberships by email', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'admin@acme.com' }, { email: 'dev@acme.com' }],
        organizations: [
          {
            name: 'Acme Corp',
            memberships: [{ email: 'admin@acme.com', role: 'admin' }, { email: 'dev@acme.com' }],
            groups: [{ name: 'Engineering', description: 'The engineering team', members: ['dev@acme.com'] }],
          },
        ],
      },
    });

    // Resolve the org id through the organizations list, since it is generated at startup.
    const orgs = (await (
      await fetch(`${emulator.url}/organizations`, { headers: auth(emulator.apiKey) })
    ).json()) as any;
    const org = orgs.data[0];

    const groupList = (await (
      await fetch(`${emulator.url}/organizations/${org.id}/groups`, {
        headers: auth(emulator.apiKey),
      })
    ).json()) as any;
    expect(groupList.data).toHaveLength(1);
    const g = groupList.data[0];
    expect(g.name).toBe('Engineering');
    expect(g.description).toBe('The engineering team');

    const members = (await (
      await fetch(`${emulator.url}/organizations/${org.id}/groups/${g.id}/organization-memberships`, {
        headers: auth(emulator.apiKey),
      })
    ).json()) as any;
    expect(members.data).toHaveLength(1);
    expect(members.data[0].user_id).toMatch(/^user_/);
  });

  it('emits group.created and group.member_added for seeded groups', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'admin@acme.com' }],
        organizations: [
          {
            name: 'Acme Corp',
            memberships: [{ email: 'admin@acme.com' }],
            groups: [{ name: 'Engineering', members: ['admin@acme.com'] }],
          },
        ],
      },
    });

    const evts = (await (
      await fetch(`${emulator.url}/events?events[]=group.created&events[]=group.member_added`, {
        headers: auth(emulator.apiKey),
      })
    ).json()) as any;
    const types = new Set(evts.data.map((e: any) => e.event));
    expect(types.has('group.created')).toBe(true);
    expect(types.has('group.member_added')).toBe(true);
  });

  it('joins a group member to its membership case-insensitively', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'Admin@Acme.com' }],
        organizations: [
          {
            name: 'Acme Corp',
            memberships: [{ email: 'admin@acme.com' }],
            groups: [{ name: 'Eng', members: ['ADMIN@ACME.com'] }],
          },
        ],
      },
    });

    const orgs = (await (
      await fetch(`${emulator.url}/organizations`, { headers: auth(emulator.apiKey) })
    ).json()) as any;
    const groups = (await (
      await fetch(`${emulator.url}/organizations/${orgs.data[0].id}/groups`, {
        headers: auth(emulator.apiKey),
      })
    ).json()) as any;
    const members = (await (
      await fetch(
        `${emulator.url}/organizations/${orgs.data[0].id}/groups/${groups.data[0].id}/organization-memberships`,
        { headers: auth(emulator.apiKey) },
      )
    ).json()) as any;
    expect(members.data).toHaveLength(1);
  });

  it('rejects startup when a group member has no membership in the organization', async () => {
    await expect(
      createEmulator({
        port: 0,
        seed: {
          users: [{ email: 'admin@acme.com' }],
          organizations: [
            {
              name: 'Acme Corp',
              memberships: [{ email: 'admin@acme.com' }],
              // A user who exists but has no membership in this org.
              groups: [{ name: 'Eng', members: ['admin@acme.com', 'lonely@acme.com'] }],
            },
          ],
        },
      }),
    ).rejects.toThrow(/must match a membership defined in this organization/);
  });

  describe('seed config validation', () => {
    const findError = (config: Parameters<typeof validateSeedConfig>[0], pathFragment: string) => {
      const { valid, errors } = validateSeedConfig(config);
      expect(valid).toBe(false);
      const error = errors.find((e) => e.path.includes(pathFragment));
      expect(error, `expected an error at ${pathFragment}, got: ${JSON.stringify(errors)}`).toBeDefined();
      return error!;
    };

    const baseConfig = {
      users: [{ email: 'admin@acme.com' }],
      organizations: [
        {
          name: 'Acme',
          memberships: [{ email: 'admin@acme.com' }],
          groups: [{ name: 'Eng', members: ['admin@acme.com'] }],
        },
      ],
    };

    it('rejects groups without crashing when memberships is a truthy non-array', () => {
      // The memberships block records a structured error for this; the groups block must
      // not then call `.map()` on the invalid value and throw. Returns the memberships
      // error rather than crashing startup or `--validate-config`.
      const { valid, errors } = validateSeedConfig({
        organizations: [{ name: 'Acme', memberships: 'not-an-array' as never, groups: [{ name: 'Eng' }] }],
      });
      expect(valid).toBe(false);
      expect(
        errors.some((e) => e.path === 'organizations[0].memberships' && e.message.includes('must be an array')),
      ).toBe(true);
    });

    it('rejects a non-object group entry without crashing', () => {
      // `groups: [null]` (or any non-object entry) must record a structured error
      // rather than throw on `group.name` during startup or `--validate-config`.
      const { valid, errors } = validateSeedConfig({
        organizations: [{ name: 'Acme', groups: [null as never] }],
      });
      expect(valid).toBe(false);
      expect(
        errors.some(
          (e) => e.path === 'organizations[0].groups[0]' && e.message.includes('each group must be an object'),
        ),
      ).toBe(true);
    });

    it('rejects a group without a name', () => {
      const error = findError(
        {
          ...baseConfig,
          organizations: [
            { name: 'Acme', memberships: [{ email: 'admin@acme.com' }], groups: [{ description: 'no name' } as never] },
          ],
        },
        'organizations[0].groups[0].name',
      );
      expect(error.message).toContain('name is required');
    });

    it('rejects a non-string description', () => {
      const error = findError(
        {
          ...baseConfig,
          organizations: [
            {
              name: 'Acme',
              memberships: [{ email: 'admin@acme.com' }],
              groups: [{ name: 'Eng', description: 5 as never }],
            },
          ],
        },
        'organizations[0].groups[0].description',
      );
      expect(error.message).toContain('description must be a string or null');
    });

    it('rejects groups that is not an array', () => {
      const error = findError(
        {
          ...baseConfig,
          organizations: [{ name: 'Acme', memberships: [{ email: 'admin@acme.com' }], groups: 'nope' as never }],
        },
        'organizations[0].groups',
      );
      expect(error.message).toContain('groups must be an array');
    });

    it('rejects members that is not an array', () => {
      const error = findError(
        {
          ...baseConfig,
          organizations: [
            {
              name: 'Acme',
              memberships: [{ email: 'admin@acme.com' }],
              groups: [{ name: 'Eng', members: 'nope' as never }],
            },
          ],
        },
        'organizations[0].groups[0].members',
      );
      expect(error.message).toContain('members must be an array');
    });

    it('rejects a member email that could only be a typo', () => {
      const error = findError(
        {
          ...baseConfig,
          organizations: [
            { name: 'Acme', memberships: [{ email: 'admin@acme.com' }], groups: [{ name: 'Eng', members: ['nope'] }] },
          ],
        },
        'organizations[0].groups[0].members[0]',
      );
      expect(error.message).toContain('valid email address');
    });

    it('rejects a member email that matches no membership in the organization', () => {
      const error = findError(
        {
          users: [{ email: 'admin@acme.com' }, { email: 'other@acme.com' }],
          organizations: [
            {
              name: 'Acme',
              memberships: [{ email: 'admin@acme.com' }],
              groups: [{ name: 'Eng', members: ['other@acme.com'] }],
            },
          ],
        },
        'organizations[0].groups[0].members[0]',
      );
      expect(error.message).toContain('must match a membership defined in this organization');
    });

    it('accepts a member email differing from its membership only in case', () => {
      const { valid, errors } = validateSeedConfig({
        users: [{ email: 'Admin@Acme.com' }],
        organizations: [
          {
            name: 'Acme',
            memberships: [{ email: 'admin@acme.com' }],
            groups: [{ name: 'Eng', members: ['ADMIN@ACME.com'] }],
          },
        ],
      });
      expect(valid).toBe(true);
      expect(errors).toEqual([]);
    });

    it('accepts a group with no members', () => {
      const { valid, errors } = validateSeedConfig({
        users: [{ email: 'admin@acme.com' }],
        organizations: [{ name: 'Acme', memberships: [{ email: 'admin@acme.com' }], groups: [{ name: 'Eng' }] }],
      });
      expect(valid).toBe(true);
      expect(errors).toEqual([]);
    });
  });
});
