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

    const res = await fetch(`${emulator.url}/user_management/organization_memberships`, {
      headers: auth(emulator.apiKey),
    });
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
  // running emulator would honour is not rejected at startup on letter case alone.
  it('joins a membership to its user by any casing of the address', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'Admin@Acme.com' }],
        organizations: [{ name: 'Acme Corp', memberships: [{ email: 'admin@acme.com', role: 'admin' }] }],
      },
    });

    const res = await fetch(`${emulator.url}/user_management/organization_memberships`, {
      headers: auth(emulator.apiKey),
    });
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

    it('accepts a membership referencing a seeded user by email', () => {
      const result = validateSeedConfig({
        users: [{ email: 'admin@acme.com' }],
        organizations: [{ name: 'Acme', memberships: [{ email: 'admin@acme.com', role: 'admin', status: 'active' }] }],
      });
      expect(result.errors).toEqual([]);
      expect(result.valid).toBe(true);
    });
  });
});
