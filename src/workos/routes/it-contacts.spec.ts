import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_org', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('IT contacts', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];
  let organizationId: string;

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  beforeEach(async () => {
    const testApp = createTestApp();
    app = testApp.app;
    store = testApp.store;
    const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Acme' }) }));
    organizationId = org.id;
  });

  const create = (email: string) =>
    req(`/organizations/${organizationId}/it_contacts`, { method: 'POST', body: JSON.stringify({ email }) });
  const invite = (contactId: string, intents: unknown = ['sso']) =>
    req(`/organizations/${organizationId}/it_contacts/${contactId}/invite`, {
      method: 'POST',
      body: JSON.stringify({ intents }),
    });

  it('creates a contact with the spec shape', async () => {
    const res = await create('it@acme.com');
    expect(res.status).toBe(201);
    const contact = await json(res);
    expect(contact.object).toBe('it_contact');
    expect(contact.id).toMatch(/^it_contact_/);
    expect(contact.email).toBe('it@acme.com');
    // The owning organization is addressed by route, not carried on the resource.
    expect(contact.organization_id).toBeUndefined();
  });

  it('lists contacts newest first, as every other list route does', async () => {
    const first = await json(await create('first@acme.com'));
    const second = await json(await create('second@acme.com'));
    // Back-dated so creation order and insertion order disagree: without the sort the ids
    // alone would already come back in the asserted order.
    getWorkOSStore(store).itContacts.updateSilent(second.id, { created_at: '2020-01-01T00:00:00.000Z' });

    const res = await req(`/organizations/${organizationId}/it_contacts`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.object).toBe('list');
    expect(body.data.map((c: any) => c.id)).toEqual([first.id, second.id]);
  });

  it('lists the whole set under null cursors, scoped to the organization', async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) ids.push((await json(await create(`c${n}@acme.com`))).id);
    // Another organization's contacts must not leak into the list.
    const other = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Other' }) }));
    await req(`/organizations/${other.id}/it_contacts`, {
      method: 'POST',
      body: JSON.stringify({ email: 'elsewhere@other.com' }),
    });

    const list = await json(await req(`/organizations/${organizationId}/it_contacts`));
    expect(list.data.map((c: any) => c.id).sort()).toEqual([...ids].sort());
    expect(list.list_metadata).toEqual({ before: null, after: null });

    // Production reads no query parameters here: a `limit` neither trims the set nor mints a
    // cursor.
    const limited = await json(await req(`/organizations/${organizationId}/it_contacts?limit=1`));
    expect(limited.data).toHaveLength(3);
    expect(limited.list_metadata).toEqual({ before: null, after: null });
  });

  it('rejects a duplicate email within the organization, case-insensitively', async () => {
    expect((await create('dupe@acme.com')).status).toBe(201);
    const conflict = await create('DUPE@acme.com');
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).code).toBe('it_contact_already_exists');
  });

  it('lowercases the address, so a mixed-case copy is the same contact', async () => {
    // Production lowercases before it stores or compares, and its e2e suite asserts exactly
    // this round trip.
    const contact = await json(await create('IT-Contact@Example.com'));
    expect(contact.email).toBe('it-contact@example.com');
    expect(getWorkOSStore(store).itContacts.get(contact.id)!.email).toBe('it-contact@example.com');
    const listed = (await json(await req(`/organizations/${organizationId}/it_contacts`))).data[0];
    expect(listed.email).toBe('it-contact@example.com');

    for (const spelling of ['it-contact@example.com', 'IT-Contact@Example.com']) {
      const conflict = await create(spelling);
      expect(conflict.status, spelling).toBe(409);
      expect((await json(conflict)).code).toBe('it_contact_already_exists');
    }
  });

  it('caps an organization at 20 contacts, and deleting one reopens the slot', async () => {
    for (let n = 1; n <= 20; n++) expect((await create(`c${n}@acme.com`)).status, `contact ${n}`).toBe(201);

    const overflow = await create('c21@acme.com');
    expect(overflow.status).toBe(422);
    expect(await json(overflow)).toMatchObject({
      code: 'too_many_it_contacts',
      message: 'An organization can have at most 20 IT contacts.',
    });

    // The cap counts contacts, not creations: removing one makes room for another.
    const first = getWorkOSStore(store).itContacts.findOneBy('email', 'c1@acme.com')!;
    expect((await req(`/organizations/${organizationId}/it_contacts/${first.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await create('c21@acme.com')).status).toBe(201);
  });

  it('allows the same email in a different organization', async () => {
    await create('shared@acme.com');
    const other = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Other' }) }));
    const res = await req(`/organizations/${other.id}/it_contacts`, {
      method: 'POST',
      body: JSON.stringify({ email: 'shared@acme.com' }),
    });
    expect(res.status).toBe(201);
  });

  it('trims the address, and a padded copy is the same contact', async () => {
    const contact = await json(await create('  it@acme.com  '));
    expect(contact.email).toBe('it@acme.com');
    expect((await create('it@acme.com')).status).toBe(409);
  });

  it('rejects a missing or malformed email', async () => {
    const post = (body: unknown) =>
      req(`/organizations/${organizationId}/it_contacts`, { method: 'POST', body: JSON.stringify(body) });
    expect((await post({})).status).toBe(422);
    expect((await post({ email: '   ' })).status).toBe(422);
    expect((await post({ email: 'not-an-email' })).status).toBe(422);
    for (const malformed of ['@acme.com', 'it@', 'a@b@c', 'it there@acme.com']) {
      expect((await post({ email: malformed })).status, malformed).toBe(422);
    }
    // A non-string names the type, as every other CRUD route does.
    const typed = await post({ email: 123 });
    expect(typed.status).toBe(422);
    expect((await json(typed)).errors[0].code).toBe('invalid_type');
  });

  it('invites a contact and records the invitation', async () => {
    const contact = await json(await create('it@acme.com'));
    const res = await invite(contact.id, ['sso', 'directory_sync']);
    expect(res.status).toBe(204);

    // None of the invitation state is on the wire; the spec documents no such fields.
    const stored = getWorkOSStore(store).itContacts.get(contact.id)!;
    expect(stored.invited_at).not.toBeNull();
    expect(stored.invite_intents).toEqual(['sso', 'directory_sync']);
    expect(stored.invite_setup_link).toContain(contact.id);
    const listed = (await json(await req(`/organizations/${organizationId}/it_contacts`))).data[0];
    expect(Object.keys(listed).sort()).toEqual(['created_at', 'email', 'id', 'object', 'updated_at']);
  });

  it('allows only one active invitation per organization', async () => {
    const first = await json(await create('first@acme.com'));
    const second = await json(await create('second@acme.com'));

    expect((await invite(first.id)).status).toBe(204);
    // Another contact, and the same contact again, are the same conflict.
    const conflict = await invite(second.id);
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).code).toBe('it_contact_invitation_already_active');

    // Revoking frees the slot, and clears the whole invitation rather than just the flag.
    expect(
      (await req(`/organizations/${organizationId}/it_contacts/${first.id}/revoke`, { method: 'POST' })).status,
    ).toBe(204);
    const revoked = getWorkOSStore(store).itContacts.get(first.id)!;
    expect(revoked.invited_at).toBeNull();
    expect(revoked.invite_intents).toBeNull();
    expect(revoked.invite_setup_link).toBeNull();

    expect((await invite(second.id)).status).toBe(204);
    // The slot moved rather than being held by both.
    expect(getWorkOSStore(store).itContacts.get(first.id)!.invited_at).toBeNull();
    expect(getWorkOSStore(store).itContacts.get(second.id)!.invited_at).not.toBeNull();
  });

  it('conflicts on re-inviting the holder, as production does', async () => {
    const first = await json(await create('first@acme.com'));
    await invite(first.id, ['sso']);
    const before = getWorkOSStore(store).itContacts.get(first.id)!;

    // Production counts every active link in the organization, holder included, so a resend
    // is the same 409 and the invitation is left exactly as it was.
    const conflict = await invite(first.id, ['directory_sync']);
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).code).toBe('it_contact_invitation_already_active');
    expect(getWorkOSStore(store).itContacts.get(first.id)).toEqual(before);

    // Revoke first, and the resend goes through.
    expect(
      (await req(`/organizations/${organizationId}/it_contacts/${first.id}/revoke`, { method: 'POST' })).status,
    ).toBe(204);
    expect((await invite(first.id, ['directory_sync'])).status).toBe(204);
    expect(getWorkOSStore(store).itContacts.get(first.id)!.invite_intents).toEqual(['directory_sync']);
  });

  it("revokes the organization's invitation through a contact that does not hold it", async () => {
    const holder = await json(await create('holder@acme.com'));
    const other = await json(await create('other@acme.com'));
    await invite(holder.id);

    // No route reports which contact holds the invitation, so revoking through any of them
    // has to clear it — otherwise the caller gets a 204 and stays wedged.
    const res = await req(`/organizations/${organizationId}/it_contacts/${other.id}/revoke`, { method: 'POST' });
    expect(res.status).toBe(204);
    expect(getWorkOSStore(store).itContacts.get(holder.id)?.invited_at).toBeNull();
    expect((await invite(other.id)).status).toBe(204);
  });

  it('leaves updated_at alone: invitation state never reaches the wire', async () => {
    const contact = await json(await create('it@acme.com'));
    const contacts = getWorkOSStore(store).itContacts;
    // Pinned to a known value, because create and revoke otherwise land in the same
    // millisecond and comparing live timestamps would pass however the route writes.
    const STAMP = '2020-01-01T00:00:00.000Z';
    contacts.updateSilent(contact.id, { updated_at: STAMP });

    const revoke = () => req(`/organizations/${organizationId}/it_contacts/${contact.id}/revoke`, { method: 'POST' });
    expect((await revoke()).status).toBe(204);
    expect(contacts.get(contact.id)!.updated_at).toBe(STAMP);

    // A real invitation, and revoking it, are equally invisible on the resource.
    expect((await invite(contact.id)).status).toBe(204);
    expect(contacts.get(contact.id)!.updated_at).toBe(STAMP);
    expect((await revoke()).status).toBe(204);
    expect(contacts.get(contact.id)!.updated_at).toBe(STAMP);
  });

  it('rejects invalid intents', async () => {
    const contact = await json(await create('it@acme.com'));
    expect((await invite(contact.id, [])).status).toBe(422);
    expect((await invite(contact.id, 'sso')).status).toBe(422);
    expect((await invite(contact.id, ['nonsense'])).status).toBe(422);
    expect((await invite(contact.id, ['sso', 'sso'])).status).toBe(422);
  });

  it('deleting a contact frees the organization invitation slot', async () => {
    const first = await json(await create('first@acme.com'));
    const second = await json(await create('second@acme.com'));
    await invite(first.id);

    const del = await req(`/organizations/${organizationId}/it_contacts/${first.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(getWorkOSStore(store).itContacts.get(first.id)).toBeUndefined();
    expect((await invite(second.id)).status).toBe(204);
  });

  it('404s an unknown organization, contact, or a contact from another organization', async () => {
    const contact = await json(await create('it@acme.com'));
    const other = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Other' }) }));

    expect((await req('/organizations/org_nope/it_contacts')).status).toBe(404);
    expect(
      (await req(`/organizations/${organizationId}/it_contacts/it_contact_nope`, { method: 'DELETE' })).status,
    ).toBe(404);
    // Addressable only through its own organization, on every sub-route — not just DELETE.
    for (const path of [
      `/organizations/${other.id}/it_contacts/${contact.id}`,
      `/organizations/${organizationId}/it_contacts/it_contact_nope`,
    ]) {
      expect((await req(path, { method: 'DELETE' })).status, path).toBe(404);
      expect(
        (await req(`${path}/invite`, { method: 'POST', body: JSON.stringify({ intents: ['sso'] }) })).status,
        path,
      ).toBe(404);
      expect((await req(`${path}/revoke`, { method: 'POST' })).status, path).toBe(404);
    }
    // And creating against an organization that does not exist.
    expect(
      (await req('/organizations/org_nope/it_contacts', { method: 'POST', body: JSON.stringify({ email: 'a@b.com' }) }))
        .status,
    ).toBe(404);
  });

  it('drops contacts with the organization', async () => {
    const contact = await json(await create('it@acme.com'));
    expect((await req(`/organizations/${organizationId}`, { method: 'DELETE' })).status).toBe(204);
    expect(getWorkOSStore(store).itContacts.get(contact.id)).toBeUndefined();
  });
});
