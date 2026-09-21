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

  it('emits dsync.activated, dsync.group.created and dsync.user.created for seeded directories', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        directories: [
          { name: 'Acme Okta', organization: 'Acme Corp', groups: ['Engineering'], users: [{ email: 'dev@acme.com' }] },
        ],
      },
    });

    const evts = await get(
      `${emulator.url}/events?events[]=dsync.activated&events[]=dsync.group.created&events[]=dsync.user.created`,
      emulator.apiKey,
    );
    const names = evts.data.map((e: any) => e.event);
    expect(names).toContain('dsync.activated');
    expect(names).toContain('dsync.group.created');
    expect(names).toContain('dsync.user.created');
  });

  it('emits dsync.activated only for a linked directory', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        directories: [
          { name: 'Linked', organization: 'Acme Corp' },
          { name: 'Unlinked', organization: 'Acme Corp', state: 'unlinked' },
          { name: 'Broken', organization: 'Acme Corp', state: 'invalid_credentials' },
        ],
      },
    });

    // Activation is what `linked` means; the other two states have not activated, the same
    // way an inactive connection does not emit connection.activated.
    const evts = await get(`${emulator.url}/events?events[]=dsync.activated`, emulator.apiKey);
    expect(evts.data).toHaveLength(1);
    expect(evts.data[0].data.name).toBe('Linked');
  });

  it('maps a group to a role, on the directory user and the organization membership', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [
          { email: 'dev@acme.com' },
          { email: 'boss@acme.com' },
          { email: 'temp@acme.com' },
          { email: 'local@acme.com' },
        ],
        organizations: [
          {
            name: 'Acme Corp',
            memberships: [
              { email: 'dev@acme.com' },
              { email: 'boss@acme.com' },
              { email: 'temp@acme.com' },
              { email: 'local@acme.com' },
            ],
            groups: [{ name: 'Platform', members: ['dev@acme.com'] }],
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

    // The flag says directory sync owns the membership, not that a role mapped: an
    // unmapped group still counts. Only someone the directory does not list is app-managed.
    const managedOf = (email: string) => memberships.data.find((m: any) => m.user.email === email)?.directory_managed;
    expect(managedOf('dev@acme.com')).toBe(true);
    expect(managedOf('temp@acme.com')).toBe(true);
    expect(managedOf('local@acme.com')).toBe(false);

    // A group's member listing serializes the same stored flag, not a hardcoded false.
    const groups = await get(`${emulator.url}/organizations/${orgs.data[0].id}/groups`, emulator.apiKey);
    const members = await get(
      `${emulator.url}/organizations/${orgs.data[0].id}/groups/${groups.data[0].id}/organization-memberships`,
      emulator.apiKey,
    );
    expect(members.data).toHaveLength(1);
    expect(members.data[0].directory_managed).toBe(true);
  });

  it('writes a claimed membership once, and the event carries the flag', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'dev@acme.com' }],
        organizations: [{ name: 'Acme Corp', memberships: [{ email: 'dev@acme.com' }] }],
        directories: [
          { name: 'Acme Okta', organization: 'Acme Corp', users: [{ email: 'dev@acme.com' }] },
          { name: 'Acme Jumpcloud', organization: 'Acme Corp', users: [{ email: 'dev@acme.com' }] },
        ],
      },
    });

    // The second directory changes nothing — already managed, no role to hand over — so it
    // must not bump updated_at or announce an update that says nothing.
    const evts = await get(`${emulator.url}/events?events[]=organization_membership.updated`, emulator.apiKey);
    expect(evts.data).toHaveLength(1);
    expect(evts.data[0].data.directory_managed).toBe(true);
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

  it('gives the membership role to the first directory that maps it', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'dev@acme.com' }],
        organizations: [{ name: 'Acme Corp', memberships: [{ email: 'dev@acme.com' }] }],
        directories: [
          {
            name: 'Acme Okta',
            organization: 'Acme Corp',
            groups: [{ name: 'Engineering', role: 'admin' }],
            users: [{ email: 'dev@acme.com', groups: ['Engineering'] }],
          },
          {
            name: 'Acme Jumpcloud',
            organization: 'Acme Corp',
            groups: [{ name: 'Contractors', role: 'member' }],
            users: [{ email: 'dev@acme.com', groups: ['Contractors'] }],
          },
        ],
      },
    });

    const orgs = await get(`${emulator.url}/organizations`, emulator.apiKey);
    const memberships = await get(
      `${emulator.url}/user_management/organization_memberships?organization_id=${orgs.data[0].id}`,
      emulator.apiKey,
    );
    expect(memberships.data.find((m: any) => m.user.email === 'dev@acme.com').role.slug).toBe('admin');
  });

  it('rejects the same person listed twice in one directory', () => {
    const result = validateSeedConfig({
      organizations: [{ name: 'Acme Corp' }],
      directories: [
        {
          name: 'Acme Okta',
          organization: 'Acme Corp',
          users: [{ email: 'dev@acme.com' }, { email: 'DEV@acme.com' }],
        },
      ],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === 'directories[0].users[1].email')).toBe(true);
  });

  it('releases the memberships it managed when the directory is deleted', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'dev@acme.com' }],
        organizations: [{ name: 'Acme Corp', memberships: [{ email: 'dev@acme.com' }] }],
        directories: [
          {
            name: 'Acme Okta',
            organization: 'Acme Corp',
            groups: [{ name: 'Engineering', role: 'admin' }],
            users: [{ email: 'dev@acme.com', groups: ['Engineering'] }],
          },
        ],
      },
    });

    const orgs = await get(`${emulator.url}/organizations`, emulator.apiKey);
    const dirs = await get(`${emulator.url}/directories`, emulator.apiKey);
    const membershipsUrl = `${emulator.url}/user_management/organization_memberships?organization_id=${orgs.data[0].id}`;
    expect((await get(membershipsUrl, emulator.apiKey)).data[0].directory_managed).toBe(true);

    await fetch(`${emulator.url}/directories/${dirs.data[0].id}`, {
      method: 'DELETE',
      headers: auth(emulator.apiKey),
    });

    expect((await get(membershipsUrl, emulator.apiKey)).data[0].directory_managed).toBe(false);
  });

  it('stores every optional field, and a non-default state', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        directories: [
          {
            name: 'Acme Okta',
            organization: 'Acme Corp',
            state: 'unlinked',
            external_key: 'ext_acme',
            groups: ['Engineering'],
            users: [
              {
                email: 'dev@acme.com',
                username: 'dev',
                idp_id: 'idp_pinned',
                state: 'inactive',
                custom_attributes: { department: 'Platform' },
                groups: ['Engineering'],
              },
            ],
          },
        ],
      },
    });

    const directory = (await get(`${emulator.url}/directories`, emulator.apiKey)).data[0];
    expect(directory.state).toBe('unlinked');
    expect(directory.external_key).toBe('ext_acme');

    const user = (await get(`${emulator.url}/directory_users`, emulator.apiKey)).data[0];
    expect(user.username).toBe('dev');
    expect(user.idp_id).toBe('idp_pinned');
    expect(user.state).toBe('inactive');
    expect(user.custom_attributes).toEqual({ department: 'Platform' });
  });

  it('stores a padded email trimmed, so the email filter finds it', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        directories: [{ name: 'Acme Okta', organization: 'Acme Corp', users: [{ email: '  dev@acme.com  ' }] }],
      },
    });

    const filtered = await get(`${emulator.url}/directory_users?email=dev@acme.com`, emulator.apiKey);
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0].email).toBe('dev@acme.com');
  });

  it('seeds several directories for one organization', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }, { name: 'Other Ltd' }],
        directories: [
          { name: 'Acme Okta', organization: 'Acme Corp' },
          { name: 'Acme Jumpcloud', organization: 'Acme Corp' },
          { name: 'Other Okta', organization: 'Other Ltd' },
        ],
      },
    });

    const orgs = await get(`${emulator.url}/organizations`, emulator.apiKey);
    const acme = orgs.data.find((o: any) => o.name === 'Acme Corp');
    const scoped = await get(`${emulator.url}/directories?organization_id=${acme.id}`, emulator.apiKey);
    expect(scoped.data.map((d: any) => d.name).sort()).toEqual(['Acme Jumpcloud', 'Acme Okta']);
    expect((await get(`${emulator.url}/directories`, emulator.apiKey)).data).toHaveLength(3);
  });

  it('keeps directory_managed when a surviving directory still lists the user', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'dev@acme.com' }, { email: 'solo@acme.com' }],
        organizations: [{ name: 'Acme Corp', memberships: [{ email: 'dev@acme.com' }, { email: 'solo@acme.com' }] }],
        directories: [
          {
            name: 'Acme Okta',
            organization: 'Acme Corp',
            users: [{ email: 'dev@acme.com' }, { email: 'solo@acme.com' }],
          },
          { name: 'Acme Jumpcloud', organization: 'Acme Corp', users: [{ email: 'dev@acme.com' }] },
        ],
      },
    });

    const orgs = await get(`${emulator.url}/organizations`, emulator.apiKey);
    const membershipsUrl = `${emulator.url}/user_management/organization_memberships?organization_id=${orgs.data[0].id}`;
    const okta = (await get(`${emulator.url}/directories`, emulator.apiKey)).data.find(
      (d: any) => d.name === 'Acme Okta',
    );

    await fetch(`${emulator.url}/directories/${okta.id}`, { method: 'DELETE', headers: auth(emulator.apiKey) });

    const after = await get(membershipsUrl, emulator.apiKey);
    const managedOf = (email: string) => after.data.find((m: any) => m.user.email === email)?.directory_managed;
    // Jumpcloud still lists dev, so their membership stays directory-managed.
    expect(managedOf('dev@acme.com')).toBe(true);
    expect(managedOf('solo@acme.com')).toBe(false);
  });

  it('hands the role to the surviving directory when the mapping directory is deleted', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'dev@acme.com' }],
        organizations: [{ name: 'Acme Corp', memberships: [{ email: 'dev@acme.com' }] }],
        directories: [
          {
            name: 'Acme Okta',
            organization: 'Acme Corp',
            groups: [{ name: 'Admins', role: 'admin' }],
            users: [{ email: 'dev@acme.com', groups: ['Admins'] }],
          },
          {
            name: 'Acme Jumpcloud',
            organization: 'Acme Corp',
            groups: [{ name: 'Staff', role: 'member' }],
            users: [{ email: 'dev@acme.com', groups: ['Staff'] }],
          },
        ],
      },
    });

    const orgs = await get(`${emulator.url}/organizations`, emulator.apiKey);
    const membershipsUrl = `${emulator.url}/user_management/organization_memberships?organization_id=${orgs.data[0].id}`;
    // First-wins at seed time: Okta declared first, so admin.
    expect((await get(membershipsUrl, emulator.apiKey)).data[0].role.slug).toBe('admin');

    const okta = (await get(`${emulator.url}/directories`, emulator.apiKey)).data.find(
      (d: any) => d.name === 'Acme Okta',
    );
    await fetch(`${emulator.url}/directories/${okta.id}`, { method: 'DELETE', headers: auth(emulator.apiKey) });

    // Only Jumpcloud is left, so its mapping owns the role now.
    const after = (await get(membershipsUrl, emulator.apiKey)).data[0];
    expect(after.role.slug).toBe('member');
    expect(after.directory_managed).toBe(true);
  });

  it('emits dsync.deleted when the directory is deleted', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        directories: [{ name: 'Acme Okta', organization: 'Acme Corp' }],
      },
    });

    const directory = (await get(`${emulator.url}/directories`, emulator.apiKey)).data[0];
    await fetch(`${emulator.url}/directories/${directory.id}`, {
      method: 'DELETE',
      headers: auth(emulator.apiKey),
    });

    const evts = await get(`${emulator.url}/events?events[]=dsync.deleted`, emulator.apiKey);
    expect(evts.data.map((e: any) => e.event)).toContain('dsync.deleted');
  });

  it('maps a role for a directory user with no AuthKit membership', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        directories: [
          {
            name: 'Acme Okta',
            organization: 'Acme Corp',
            groups: [{ name: 'Engineering', role: 'admin' }],
            users: [{ email: 'nobody@acme.com', groups: ['Engineering'] }],
          },
        ],
      },
    });

    const user = (await get(`${emulator.url}/directory_users`, emulator.apiKey)).data[0];
    expect(user.role).toEqual({ slug: 'admin' });
  });

  it('leaves an application-owned membership alone when an unrelated directory is deleted', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        directories: [
          {
            name: 'Acme Okta',
            organization: 'Acme Corp',
            groups: [{ name: 'Admins', role: 'admin' }],
            users: [{ email: 'late@acme.com', groups: ['Admins'] }],
          },
          { name: 'Acme Jumpcloud', organization: 'Acme Corp', users: [{ email: 'late@acme.com' }] },
        ],
      },
    });

    // Created after seeding, so no directory ever claimed this membership.
    const orgs = await get(`${emulator.url}/organizations`, emulator.apiKey);
    const created = await fetch(`${emulator.url}/user_management/users`, {
      method: 'POST',
      headers: auth(emulator.apiKey),
      body: JSON.stringify({ email: 'late@acme.com' }),
    });
    const user = (await created.json()) as any;
    await fetch(`${emulator.url}/user_management/organization_memberships`, {
      method: 'POST',
      headers: auth(emulator.apiKey),
      body: JSON.stringify({ user_id: user.id, organization_id: orgs.data[0].id, role_slug: 'member' }),
    });

    const okta = (await get(`${emulator.url}/directories`, emulator.apiKey)).data.find(
      (d: any) => d.name === 'Acme Okta',
    );
    await fetch(`${emulator.url}/directories/${okta.id}`, { method: 'DELETE', headers: auth(emulator.apiKey) });

    const membership = (
      await get(
        `${emulator.url}/user_management/organization_memberships?organization_id=${orgs.data[0].id}`,
        emulator.apiKey,
      )
    ).data.find((m: any) => m.user.email === 'late@acme.com');
    expect(membership.directory_managed).toBe(false);
    expect(membership.role.slug).toBe('member');
  });

  it('leaves the role with the first-declared survivor, not the last', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'dev@acme.com' }],
        organizations: [{ name: 'Acme Corp', memberships: [{ email: 'dev@acme.com' }] }],
        directories: [
          {
            name: 'A admin',
            organization: 'Acme Corp',
            groups: [{ name: 'Admins', role: 'admin' }],
            users: [{ email: 'dev@acme.com', groups: ['Admins'] }],
          },
          {
            name: 'B member',
            organization: 'Acme Corp',
            groups: [{ name: 'Staff', role: 'member' }],
            users: [{ email: 'dev@acme.com', groups: ['Staff'] }],
          },
          { name: 'C no mapping', organization: 'Acme Corp', users: [{ email: 'dev@acme.com' }] },
        ],
      },
    });

    const orgs = await get(`${emulator.url}/organizations`, emulator.apiKey);
    const membershipsUrl = `${emulator.url}/user_management/organization_memberships?organization_id=${orgs.data[0].id}`;
    const c = (await get(`${emulator.url}/directories`, emulator.apiKey)).data.find(
      (d: any) => d.name === 'C no mapping',
    );
    await fetch(`${emulator.url}/directories/${c.id}`, { method: 'DELETE', headers: auth(emulator.apiKey) });

    // A and B both survive and both map a role; declaration order gives it to A.
    const after = (await get(membershipsUrl, emulator.apiKey)).data[0];
    expect(after.role.slug).toBe('admin');
    expect(after.directory_managed).toBe(true);
  });

  it('skips a role-less survivor when handing over the role', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'dev@acme.com' }],
        organizations: [{ name: 'Acme Corp', memberships: [{ email: 'dev@acme.com' }] }],
        directories: [
          { name: 'A no mapping', organization: 'Acme Corp', users: [{ email: 'dev@acme.com' }] },
          {
            name: 'B admin',
            organization: 'Acme Corp',
            groups: [{ name: 'Admins', role: 'admin' }],
            users: [{ email: 'dev@acme.com', groups: ['Admins'] }],
          },
          {
            name: 'C member',
            organization: 'Acme Corp',
            groups: [{ name: 'Staff', role: 'member' }],
            users: [{ email: 'dev@acme.com', groups: ['Staff'] }],
          },
        ],
      },
    });

    const orgs = await get(`${emulator.url}/organizations`, emulator.apiKey);
    const membershipsUrl = `${emulator.url}/user_management/organization_memberships?organization_id=${orgs.data[0].id}`;
    expect((await get(membershipsUrl, emulator.apiKey)).data[0].role.slug).toBe('admin');

    const b = (await get(`${emulator.url}/directories`, emulator.apiKey)).data.find((d: any) => d.name === 'B admin');
    await fetch(`${emulator.url}/directories/${b.id}`, { method: 'DELETE', headers: auth(emulator.apiKey) });

    // A survives but maps nothing, so C owns the role — not A by virtue of being first.
    const after = (await get(membershipsUrl, emulator.apiKey)).data[0];
    expect(after.role.slug).toBe('member');
    expect(after.directory_managed).toBe(true);
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
      [
        'a non-string directory domain',
        { organizations: [{ name: 'A' }], directories: [{ name: 'D', organization: 'A', domain: 123 }] },
        'directories[0].domain',
      ],
      [
        'a non-string user role',
        {
          organizations: [{ name: 'A' }],
          directories: [{ name: 'D', organization: 'A', users: [{ email: 'a@b.com', role: 123 }] }],
        },
        'directories[0].users[0].role',
      ],
      [
        'a scalar custom_attributes value',
        {
          organizations: [{ name: 'A' }],
          directories: [{ name: 'D', organization: 'A', users: [{ email: 'a@b.com', custom_attributes: 'x' }] }],
        },
        'directories[0].users[0].custom_attributes',
      ],
      [
        'a null user group entry',
        {
          organizations: [{ name: 'A' }],
          directories: [
            { name: 'D', organization: 'A', groups: ['Engineering'], users: [{ email: 'a@b.com', groups: [null] }] },
          ],
        },
        'directories[0].users[0].groups[0]',
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
