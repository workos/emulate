import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin, getWorkOSStore } from '../index.js';

const apiKeys: ApiKeyMap = { sk_test_ev: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_ev', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Events routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;
  const eventRow = { object: 'event', data: {}, organization_id: null, environment_id: null } as const;

  it('lists events', async () => {
    const ws = getWorkOSStore(store);
    ws.events.insert({ ...eventRow, event: 'user.created', data: { id: 'user_1' } });
    ws.events.insert({ ...eventRow, event: 'organization.created', data: { id: 'org_1' }, organization_id: 'org_1' });

    const res = await req('/events');
    expect(res.status).toBe(200);
    const list = await json(res);
    expect(list.object).toBe('list');
    expect(list.data).toHaveLength(2);
    expect(list.data[0].object).toBe('event');
  });

  it('filters events by type', async () => {
    const ws = getWorkOSStore(store);
    ws.events.insert({ ...eventRow, event: 'user.created' });
    ws.events.insert({ ...eventRow, event: 'user.updated' });
    ws.events.insert({ ...eventRow, event: 'organization.created' });

    const res = await req('/events?events[]=user.created&events[]=user.updated');
    const list = await json(res);
    expect(list.data).toHaveLength(2);
    expect(list.data.every((e: any) => e.event.startsWith('user.'))).toBe(true);
  });

  it('returns empty list when no events', async () => {
    const res = await req('/events');
    const list = await json(res);
    expect(list.data).toHaveLength(0);
  });

  // Every wire form an SDK encodes the `events` array as. Production's `qs` parser plus a
  // comma split accepts all of them; a poller whose form is not read here sees either every
  // event or none.
  it.each([
    ['comma-joined (spec form; python, kotlin, elixir, rust)', 'events=user.created,user.updated'],
    ['repeated (go, node, ruby)', 'events=user.created&events=user.updated'],
    ['bracketed (dotnet)', 'events[]=user.created&events[]=user.updated'],
    ['indexed (php)', 'events[0]=user.created&events[1]=user.updated'],
  ])('filters events by the %s events parameter', async (_form, query) => {
    const ws = getWorkOSStore(store);
    ws.events.insert({ ...eventRow, event: 'user.created' });
    ws.events.insert({ ...eventRow, event: 'user.updated' });
    ws.events.insert({ ...eventRow, event: 'organization.created' });

    const list = await json(await req(`/events?${query}`));
    expect(list.data).toHaveLength(2);
    expect(list.data.every((e: any) => e.event.startsWith('user.'))).toBe(true);
  });

  it('filters events by organization and range', async () => {
    const ws = getWorkOSStore(store);
    ws.events.insert({
      ...eventRow,
      event: 'dsync.user.created',
      data: { organization_id: 'org_1' },
      organization_id: 'org_1',
    });
    ws.events.insert({
      ...eventRow,
      event: 'dsync.user.created',
      data: { organization_id: 'org_2' },
      organization_id: 'org_2',
    });

    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();

    const kept = await json(await req(`/events?organization_id=org_1&range_start=${encodeURIComponent(past)}`));
    expect(kept.data).toHaveLength(1);
    expect(kept.data[0].data.organization_id).toBe('org_1');

    const later = await json(await req(`/events?range_start=${encodeURIComponent(future)}`));
    expect(later.data).toHaveLength(0);

    const ended = await json(await req(`/events?range_end=${encodeURIComponent(past)}`));
    expect(ended.data).toHaveLength(0);
  });

  // Scope is the organization an event occurred within, not whether its payload names one:
  // organization.* events carry the organization itself, group.member_* carry only ids, and
  // dsync.group.user_* nest theirs. An organization-scoped poller must see all of them.
  it('scopes organization and membership events to their organization', async () => {
    const post = async (path: string, body: Record<string, unknown>) =>
      json(await req(path, { method: 'POST', body: JSON.stringify(body) }));
    const org = await post('/organizations', { name: 'Acme' });
    const other = await post('/organizations', { name: 'Globex' });
    const user = await post('/user_management/users', { email: 'jane@acme.com' });
    const membership = await post('/user_management/organization_memberships', {
      user_id: user.id,
      organization_id: org.id,
    });
    const group = await post(`/organizations/${org.id}/groups`, { name: 'Engineering' });
    await post(`/organizations/${org.id}/groups/${group.id}/organization-memberships`, {
      organization_membership_id: membership.id,
    });

    const ws = getWorkOSStore(store);
    const directory = ws.directories.insert({
      object: 'directory',
      name: 'Okta',
      organization_id: org.id,
      domain: 'acme.com',
      type: 'okta scim v2.0',
      state: 'linked',
      external_key: 'ext_1',
    });
    const directoryGroup = ws.directoryGroups.insert({
      object: 'directory_group',
      directory_id: directory.id,
      organization_id: org.id,
      idp_id: 'idp_grp_1',
      name: 'Engineering',
      raw_attributes: {},
    });
    ws.directoryUsers.insert({
      object: 'directory_user',
      directory_id: directory.id,
      organization_id: org.id,
      idp_id: 'idp_usr_1',
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane@acme.com',
      username: 'jdoe',
      state: 'active',
      role: null,
      custom_attributes: {},
      raw_attributes: {},
      groups: [{ object: 'directory_group', id: directoryGroup.id, name: 'Engineering' }],
    });
    // Deleting the directory removes its users and groups; the removal it emits must still
    // land in the organization's history once nothing it refers to exists.
    await req(`/directories/${directory.id}`, { method: 'DELETE' });

    const scoped = await json(await req(`/events?organization_id=${org.id}&limit=100`));
    const types = scoped.data.map((e: any) => e.event);
    expect(types).toContain('organization.created');
    expect(types).toContain('group.member_added');
    expect(types).toContain('dsync.group.user_added');
    expect(types).toContain('dsync.group.user_removed');
    expect(types).not.toContain('user.created');
    // The scope is the emulator's, not the spec's: it never reaches the wire.
    expect(scoped.data.some((e: any) => 'organization_id' in e)).toBe(false);

    const others = await json(await req(`/events?organization_id=${other.id}`));
    expect(others.data.map((e: any) => e.event)).toEqual(['organization.created']);
  });

  it('event from user creation appears in events list', async () => {
    // Create a user which should trigger an event via collection hooks
    await req('/user_management/users', {
      method: 'POST',
      body: JSON.stringify({ email: 'test@example.com', password: 'password123' }),
    });

    const res = await req('/events');
    const list = await json(res);
    const userEvents = list.data.filter((e: any) => e.event === 'user.created');
    expect(userEvents.length).toBeGreaterThanOrEqual(1);
  });
});
