/**
 * Seeding organization memberships. Seeded user ids are generated at startup, so
 * memberships reference users by email; validateSeedConfig rejects references that
 * don't resolve to a seeded user — a dangling membership could not serialize (the
 * membership serializer requires a resolvable embedded user).
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createEmulator, type Emulator } from '../index.js';
import { validateSeedConfig } from './config-validator.js';

describe('Seeding organization memberships', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

  /** The memberships of the one seeded organization — the list wants an organization or a user named. */
  async function listMemberships(e: Emulator): Promise<Response> {
    const headers = auth(e.apiKey);
    const orgs = (await (await fetch(`${e.url}/organizations`, { headers })).json()) as any;
    return fetch(`${e.url}/user_management/organization_memberships?organization_id=${orgs.data[0].id}`, { headers });
  }

  it('seeds a membership joined to its user by email', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'admin@acme.com', first_name: 'Admin', email_verified: true }],
        organizations: [
          {
            name: 'Acme Corp',
            memberships: [{ email: 'admin@acme.com', role: 'admin', status: 'active' }],
          },
        ],
      },
    });

    const res = await listMemberships(emulator);
    expect(res.status).toBe(200);
    const list = (await res.json()) as any;
    expect(list.data).toHaveLength(1);

    const m = list.data[0];
    // The stored membership carries the generated user id, not the email join key.
    expect(m.user_id).toMatch(/^user_/);
    expect(m.role).toEqual({ slug: 'admin' });
    expect(m.status).toBe('active');
    // The embedded user resolves — the guarantee the email join exists to protect.
    expect(m.directory_managed).toBe(false);
    expect(m.user).toMatchObject({ object: 'user', id: m.user_id, email: 'admin@acme.com' });
  });

  // The join resolves case-insensitively, like every other lookup by email, so a reference the
  // running emulator would honor is not rejected at startup on letter case alone.
  it('joins a membership to its user by any casing of the address', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'Admin@Acme.com' }],
        organizations: [{ name: 'Acme Corp', memberships: [{ email: 'admin@acme.com', role: 'admin' }] }],
      },
    });

    const res = await listMemberships(emulator);
    const list = (await res.json()) as any;
    expect(list.data).toHaveLength(1);
    // Stored under the case that seeded it, reached by the case the membership named.
    expect(list.data[0].user).toMatchObject({ email: 'Admin@Acme.com' });
  });

  // Seeding stores the trimmed address, so a padded seed is reachable by the address the caller
  // actually has — and the membership that named it joins the same account.
  it('stores a padded seeded address trimmed', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: '  padded@acme.com  ' }],
        organizations: [{ name: 'Acme Corp', memberships: [{ email: 'padded@acme.com', role: 'member' }] }],
      },
    });

    const res = await fetch(`${emulator.url}/user_management/users?email=padded%40acme.com`, {
      headers: auth(emulator.apiKey),
    });
    const list = (await res.json()) as any;
    expect(list.data).toHaveLength(1);
    expect(list.data[0].email).toBe('padded@acme.com');
  });

  it('rejects startup when a membership references an email with no seeded user', async () => {
    await expect(
      createEmulator({
        port: 0,
        seed: {
          users: [{ email: 'admin@acme.com' }],
          organizations: [{ name: 'Acme Corp', memberships: [{ email: 'ghost@acme.com', role: 'member' }] }],
        },
      }),
    ).rejects.toThrow(/email must match a user defined in users/);
  });

  // A seeded invitation provisions what `POST /user_management/invitations` does: the recipient's
  // pending membership, and their user when the address has no account yet.
  it('gives a seeded invitation its pending membership, creating the user it names', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'seeded@acme.com' }],
        organizations: [{ id: 'org_01SEEDEDINVITE', name: 'Acme Corp' }],
        invitations: [
          { email: 'seeded@acme.com', organization_id: 'org_01SEEDEDINVITE', role_slug: 'admin' },
          { email: 'new@acme.com', organization_id: 'org_01SEEDEDINVITE' },
        ],
      },
    });

    const res = await fetch(
      `${emulator.url}/user_management/organization_memberships?organization_id=org_01SEEDEDINVITE&statuses=pending`,
      { headers: auth(emulator.apiKey) },
    );
    const list = (await res.json()) as any;
    const byEmail = Object.fromEntries(list.data.map((m: any) => [m.user.email, m]));
    expect(Object.keys(byEmail).sort()).toEqual(['new@acme.com', 'seeded@acme.com']);
    expect(byEmail['seeded@acme.com'].role).toEqual({ slug: 'admin' });
    expect(byEmail['new@acme.com'].role).toEqual({ slug: 'member' });
  });

  // A seed may keep a deactivated membership beside the live one for the same user. The seeded
  // invitation must find the live membership, not revive the stale inactive row beside it.
  it('leaves a seeded member alone when an inactive membership sits beside the active one', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'returning@acme.com' }],
        organizations: [
          {
            id: 'org_01SEEDEDRETURN',
            name: 'Acme Corp',
            memberships: [
              { email: 'returning@acme.com', status: 'inactive' },
              { email: 'returning@acme.com', status: 'active', role: 'admin' },
            ],
          },
        ],
        invitations: [{ email: 'returning@acme.com', organization_id: 'org_01SEEDEDRETURN' }],
      },
    });

    const res = await fetch(
      `${emulator.url}/user_management/organization_memberships?organization_id=org_01SEEDEDRETURN&statuses=active,inactive,pending`,
      { headers: auth(emulator.apiKey) },
    );
    const statuses = ((await res.json()) as any).data.map((m: any) => `${m.status}:${m.role.slug}`).sort();
    expect(statuses).toEqual(['active:admin', 'inactive:member']);
  });

  describe('seed config validation', () => {
    const findError = (config: Parameters<typeof validateSeedConfig>[0], pathFragment: string) => {
      const { valid, errors } = validateSeedConfig(config);
      expect(valid).toBe(false);
      const error = errors.find((e) => e.path.includes(pathFragment));
      expect(error, `expected an error at ${pathFragment}, got: ${JSON.stringify(errors)}`).toBeDefined();
      return error!;
    };

    it('rejects a membership email that matches no seeded user', () => {
      const error = findError(
        {
          users: [{ email: 'admin@acme.com' }],
          organizations: [{ name: 'Acme', memberships: [{ email: 'ghost@acme.com' }] }],
        },
        'organizations[0].memberships[0].email',
      );
      expect(error.message).toContain('must match a user defined in users');
    });

    it('accepts a membership email differing from its user only in case', () => {
      const { valid } = validateSeedConfig({
        users: [{ email: 'Admin@Acme.com' }],
        organizations: [{ name: 'Acme', memberships: [{ email: 'admin@acme.com' }] }],
      });
      expect(valid).toBe(true);
    });

    it('rejects two seeded users with the same email', () => {
      const error = findError({ users: [{ email: 'dup@acme.com' }, { email: 'dup@acme.com' }] }, 'users[1].email');
      expect(error.message).toContain('unique across users');
    });

    // The uniqueness the API enforces: POST /user_management/users answers 409 for an address
    // differing only in case, so a seed that got two through would be the one remaining way to
    // manufacture the pair of accounts no lookup by email can tell apart.
    it('rejects two seeded users whose emails differ only in case', () => {
      const error = findError({ users: [{ email: 'Dup@Acme.com' }, { email: 'dup@acme.com' }] }, 'users[1].email');
      expect(error.message).toContain('unique across users');
    });

    // A seed is the one creation path with no route in front of it, so it is the remaining way to
    // write a user under an address no lookup by email resolves — the state the two routes' typo
    // guards exist to prevent.
    it('rejects a seeded user email that could only be a typo', () => {
      for (const email of ['   ', 'not-an-email', 'a b@acme.com', '@acme.com', 'nope@', 'two@at@acme.com']) {
        const error = findError({ users: [{ email }] }, 'users[0].email');
        expect(error.message).toMatch(/email (is required and must be a string|must be a valid email address)/);
      }
    });

    it('rejects a seeded invitation email that could only be a typo', () => {
      const error = findError({ invitations: [{ email: 'not-an-email' }] }, 'invitations[0].email');
      expect(error.message).toContain('must be a valid email address');
    });

    it('rejects a membership email that could only be a typo', () => {
      const error = findError(
        { users: [{ email: 'admin@acme.com' }], organizations: [{ name: 'Acme', memberships: [{ email: 'nope' }] }] },
        'organizations[0].memberships[0].email',
      );
      expect(error.message).toContain('must be a valid email address');
    });

    // Seeding trims, so the cross-reference has to: matching the raw value would reject a
    // membership that resolves fine once both addresses are stored the way the store stores them.
    it('accepts a membership email padded differently from its user', () => {
      const { valid } = validateSeedConfig({
        users: [{ email: '  admin@acme.com' }],
        organizations: [{ name: 'Acme', memberships: [{ email: 'admin@acme.com  ' }] }],
      });
      expect(valid).toBe(true);
    });

    it('rejects two seeded users whose emails differ only in padding', () => {
      const error = findError({ users: [{ email: 'dup@acme.com' }, { email: '  dup@acme.com  ' }] }, 'users[1].email');
      expect(error.message).toContain('unique across users');
    });

    it('rejects a membership when no users are defined at all', () => {
      findError(
        { organizations: [{ name: 'Acme', memberships: [{ email: 'admin@acme.com' }] }] },
        'organizations[0].memberships[0].email',
      );
    });

    it('rejects a membership with a missing email', () => {
      findError(
        { organizations: [{ name: 'Acme', memberships: [{ email: '' }] }] },
        'organizations[0].memberships[0].email',
      );
    });

    it('points the pre-rename user_id key at email', () => {
      const error = findError(
        {
          users: [{ email: 'admin@acme.com' }],
          organizations: [{ name: 'Acme', memberships: [{ user_id: 'user_01H_LITERAL_ID' } as never] }],
        },
        'organizations[0].memberships[0].user_id',
      );
      expect(error.message).toContain('use `email`');
    });

    it('rejects an invalid membership status', () => {
      const error = findError(
        {
          users: [{ email: 'admin@acme.com' }],
          organizations: [{ name: 'Acme', memberships: [{ email: 'admin@acme.com', status: 'suspended' as never }] }],
        },
        'organizations[0].memberships[0].status',
      );
      expect(error.message).toContain('"active", "inactive", or "pending"');
    });

    it('rejects duplicate user emails (the membership join key)', () => {
      const error = findError({ users: [{ email: 'admin@acme.com' }, { email: 'admin@acme.com' }] }, 'users[1].email');
      expect(error.message).toContain('unique');
    });

    // The invariant every membership lookup relies on: `POST
    // /user_management/organization_memberships` never adds a second non-inactive membership
    // (it answers with the existing active one, or a 400 for a pending one), so a seed that got
    // one through would leave every join by user id reading the first row and silently ignoring
    // the second.
    it('rejects two non-inactive memberships for one user in an organization', () => {
      const error = findError(
        {
          users: [{ email: 'admin@acme.com' }],
          organizations: [{ name: 'Acme', memberships: [{ email: 'admin@acme.com' }, { email: 'Admin@Acme.com' }] }],
        },
        'organizations[0].memberships[1].email',
      );
      expect(error.message).toContain('at most one membership per user that is not inactive');
    });

    it('accepts an inactive membership alongside a live one for the same user', () => {
      const result = validateSeedConfig({
        users: [{ email: 'admin@acme.com' }],
        organizations: [
          {
            name: 'Acme',
            memberships: [
              { email: 'admin@acme.com', status: 'inactive' },
              { email: 'admin@acme.com', status: 'active' },
            ],
          },
        ],
      });
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('accepts a membership referencing a seeded user by email', () => {
      const result = validateSeedConfig({
        users: [{ email: 'admin@acme.com' }],
        organizations: [{ name: 'Acme', memberships: [{ email: 'admin@acme.com', role: 'admin', status: 'active' }] }],
      });
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });

    it('rejects roles that are empty or paired with role', () => {
      const empty = validateSeedConfig({
        users: [{ email: 'admin@acme.com' }],
        organizations: [{ name: 'Acme', memberships: [{ email: 'admin@acme.com', roles: [] }] }],
      });
      expect(empty.errors.map((e) => e.path)).toEqual(['organizations[0].memberships[0].roles']);

      const both = validateSeedConfig({
        users: [{ email: 'admin@acme.com' }],
        organizations: [{ name: 'Acme', memberships: [{ email: 'admin@acme.com', role: 'admin', roles: ['admin'] }] }],
      });
      expect(both.errors.map((e) => e.message)).toEqual(['use either role or roles for a membership, not both']);
    });

    it('names the priority role on the creation event of a seeded membership', async () => {
      emulator = await createEmulator({
        port: 0,
        seed: {
          users: [{ email: 'ranked@acme.com' }],
          roles: [
            { slug: 'viewer', name: 'Viewer', priority: 1 },
            { slug: 'admin', name: 'Admin', priority: 0 },
          ],
          organizations: [
            { name: 'Acme Corp', memberships: [{ email: 'ranked@acme.com', roles: ['viewer', 'admin'] }] },
          ],
        },
      });

      const headers = auth(emulator.apiKey);
      const m = ((await (await listMemberships(emulator)).json()) as any).data[0];
      expect(m.role).toEqual({ slug: 'admin' });
      expect(m.roles).toEqual([{ slug: 'admin' }, { slug: 'viewer' }]);

      const events = (await (
        await fetch(`${emulator.url}/events?events[]=organization_membership.created`, { headers })
      ).json()) as any;
      const event = events.data.find((e: any) => e.data.id === m.id);
      expect(event.data.role).toEqual({ slug: 'admin' });
      expect(event.data.roles).toEqual([{ slug: 'admin' }, { slug: 'viewer' }]);
    });

    it('seeds a membership holding several roles, the first as primary', async () => {
      emulator = await createEmulator({
        port: 0,
        seed: {
          users: [{ email: 'multi@acme.com' }],
          organizations: [
            { name: 'Acme Corp', memberships: [{ email: 'multi@acme.com', roles: ['admin', 'analyst'] }] },
          ],
        },
      });

      const res = await listMemberships(emulator);
      const m = ((await res.json()) as any).data[0];
      expect(m.role).toEqual({ slug: 'admin' });
      expect(m.roles).toEqual([{ slug: 'admin' }, { slug: 'analyst' }]);
    });
  });
});
