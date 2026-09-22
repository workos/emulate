import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore } from '../store.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_org', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

describe('Connect routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: ReturnType<typeof createTestApp>['store'];

  beforeEach(() => {
    const testApp = createTestApp();
    app = testApp.app;
    store = testApp.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  it('creates an application', async () => {
    const res = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'My App', redirect_uris: ['http://localhost:3000/callback'] }),
    });
    expect(res.status).toBe(201);
    const app = await json(res);
    expect(app.object).toBe('connect_application');
    expect(app.name).toBe('My App');
    expect(app.client_id).toBeDefined();
    expect(app.id).toMatch(/^conn_app_/);
  });

  it('stores the emulator-only login_url without adding it to the API response', async () => {
    const res = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'Standalone', login_url: 'http://localhost:3000/login' }),
    });
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created.login_url).toBeUndefined();
    expect(getWorkOSStore(store).connectApplications.get(created.id)?.login_url).toBe('http://localhost:3000/login');
    expect((await json(await req(`/connect/applications/${created.id}`))).login_url).toBeUndefined();
  });

  it('rejects a non-string login_url', async () => {
    const res = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'Standalone', login_url: 123 }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects empty name', async () => {
    const res = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects a non-array scopes value', async () => {
    const res = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bad Scopes', scopes: 'admin:all' }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects scopes whose elements are not strings', async () => {
    const res = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'Bad Scope Els', scopes: [123, {}] }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects an m2m application without an organization_id', async () => {
    const res = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'M2M App', application_type: 'm2m' }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects an m2m application whose organization_id does not exist', async () => {
    const res = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'M2M App', application_type: 'm2m', organization_id: 'org_does_not_exist' }),
    });
    expect(res.status).toBe(422);
  });

  it('creates an m2m application for an existing organization', async () => {
    const orgRes = await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'M2M Org' }) });
    const org = await json(orgRes);

    const res = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'M2M App', application_type: 'm2m', organization_id: org.id }),
    });
    expect(res.status).toBe(201);
    const created = await json(res);
    expect(created.application_type).toBe('m2m');
    expect(created.organization_id).toBe(org.id);
  });

  it('gets an application by id', async () => {
    const createRes = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'Get Test' }),
    });
    const created = await json(createRes);

    const res = await req(`/connect/applications/${created.id}`);
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe('Get Test');
  });

  it('gets an application by client_id', async () => {
    const createRes = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'Client ID Get Test' }),
    });
    const created = await json(createRes);

    const res = await req(`/connect/applications/${created.client_id}`);
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe(created.id);
  });

  it('prefers an application id over another application client_id with the same value', async () => {
    const idOwner = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'ID Owner' }),
      }),
    );
    const clientIdOwner = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'Client ID Owner' }),
      }),
    );
    getWorkOSStore(store).connectApplications.update(clientIdOwner.id, { client_id: idOwner.id });
    // Sanity-check the collision is real: the client_id index now resolves to the other app.
    expect(getWorkOSStore(store).connectApplications.findOneBy('client_id', idOwner.id)?.id).toBe(clientIdOwner.id);

    const res = await req(`/connect/applications/${idOwner.id}`);
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe('ID Owner');
  });

  it('returns 404 for nonexistent application', async () => {
    const res = await req('/connect/applications/conn_app_nonexistent');
    expect(res.status).toBe(404);
  });

  it('returns 404 for nonexistent client_id', async () => {
    const res = await req('/connect/applications/client_nonexistent');
    expect(res.status).toBe(404);
  });

  it('lists applications', async () => {
    await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'App 1' }),
    });
    await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'App 2' }),
    });

    const res = await req('/connect/applications');
    expect(res.status).toBe(200);
    const list = await json(res);
    expect(list.object).toBe('list');
    expect(list.data).toHaveLength(2);
  });

  it('creates and revokes a client secret', async () => {
    const appRes = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'Secret Test' }),
    });
    const application = await json(appRes);

    const secretRes = await req(`/connect/applications/${application.id}/client_secrets`, {
      method: 'POST',
    });
    expect(secretRes.status).toBe(201);
    const secret = await json(secretRes);
    expect(secret.object).toBe('connect_application_secret');
    expect(secret.secret).toBeDefined();
    expect(secret.secret).toBe(getWorkOSStore(store).clientSecrets.get(secret.id)?.value);
    expect(secret.secret_hint).toBe(secret.secret.slice(-4));
    expect(secret.last_used_at).toBeNull();
    // The owner is the emulator's foreign key, not a spec field.
    expect(secret.application_id).toBeUndefined();

    const delRes = await req(`/connect/client_secrets/${secret.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);
  });

  it('creates a client secret for an application referenced by client_id', async () => {
    const application = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'Client ID Secret Test' }),
      }),
    );

    const res = await req(`/connect/applications/${application.client_id}/client_secrets`, { method: 'POST' });
    expect(res.status).toBe(201);
    const secret = await json(res);
    expect(secret.object).toBe('connect_application_secret');
    expect(getWorkOSStore(store).clientSecrets.get(secret.id)?.application_id).toBe(application.id);
  });

  it('lists client secrets oldest first, without the plaintext value', async () => {
    const application = await json(
      await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'Secret List' }) }),
    );
    const first = await json(await req(`/connect/applications/${application.id}/client_secrets`, { method: 'POST' }));
    const second = await json(await req(`/connect/applications/${application.id}/client_secrets`, { method: 'POST' }));
    // Back-dated so insertion order and creation order disagree: without the sort, ids alone
    // would already come back in the asserted order and the assertion could never fail.
    getWorkOSStore(store).clientSecrets.updateSilent(second.id, { created_at: '2020-01-01T00:00:00.000Z' });

    const res = await req(`/connect/applications/${application.id}/client_secrets`);
    expect(res.status).toBe(200);
    const secrets = await json(res);
    // A bare array, not the `list` envelope the other collection routes return.
    expect(Array.isArray(secrets)).toBe(true);
    expect(secrets.map((s: any) => s.id)).toEqual([second.id, first.id]);
    expect(secrets[1].object).toBe('connect_application_secret');
    expect(secrets[1].secret).toBeUndefined();
    // Pinned against the stored plaintext, not against the response's own hint.
    expect(secrets[1].secret_hint).toBe(getWorkOSStore(store).clientSecrets.get(first.id)!.value.slice(-4));
  });

  it('lists client secrets for an application referenced by client_id', async () => {
    const application = await json(
      await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'Secret List By Client' }) }),
    );
    await req(`/connect/applications/${application.id}/client_secrets`, { method: 'POST' });

    const res = await req(`/connect/applications/${application.client_id}/client_secrets`);
    expect(res.status).toBe(200);
    expect(await json(res)).toHaveLength(1);
  });

  it('returns an empty array for an application with no client secrets', async () => {
    const application = await json(
      await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'No Secrets' }) }),
    );
    expect(await json(await req(`/connect/applications/${application.id}/client_secrets`))).toEqual([]);
  });

  it('404s listing client secrets for an unknown application', async () => {
    expect((await req('/connect/applications/conn_app_nope/client_secrets')).status).toBe(404);
  });

  it('updates name, description and scopes', async () => {
    const application = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'Before', description: 'old', scopes: ['openid'] }),
      }),
    );

    const res = await req(`/connect/applications/${application.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: '  After  ', description: null, scopes: ['openid', 'profile'] }),
    });
    expect(res.status).toBe(200);
    const updated = await json(res);
    expect(updated.name).toBe('After');
    expect(updated.description).toBeNull();
    expect(updated.scopes).toEqual(['openid', 'profile']);
    expect(updated.id).toBe(application.id);
    expect(updated.client_id).toBe(application.client_id);

    // The update response is a merge of the patch, so re-read to prove it landed in the store.
    const reread = await json(await req(`/connect/applications/${application.id}`));
    expect(reread).toEqual(updated);
  });

  it('leaves omitted fields untouched', async () => {
    const application = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'Keep', description: 'kept', scopes: ['openid'] }),
      }),
    );

    const updated = await json(
      await req(`/connect/applications/${application.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Renamed' }),
      }),
    );
    expect(updated.description).toBe('kept');
    expect(updated.scopes).toEqual(['openid']);
  });

  it('updates redirect_uris in both the spec and string forms', async () => {
    const application = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'Redirects', redirect_uris: ['http://localhost:3000/a'] }),
      }),
    );

    const specForm = await json(
      await req(`/connect/applications/${application.id}`, {
        method: 'PUT',
        body: JSON.stringify({ redirect_uris: [{ uri: 'http://localhost:3000/b', default: true }] }),
      }),
    );
    expect(specForm.redirect_uris).toEqual([{ uri: 'http://localhost:3000/b', default: false }]);

    const stringForm = await json(
      await req(`/connect/applications/${application.id}`, {
        method: 'PUT',
        body: JSON.stringify({ redirect_uris: ['http://localhost:3000/c'] }),
      }),
    );
    expect(stringForm.redirect_uris).toEqual([{ uri: 'http://localhost:3000/c', default: false }]);
  });

  it('accepts the spec redirect_uris form on create', async () => {
    const created = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'Spec Redirects', redirect_uris: [{ uri: 'http://localhost:3000/cb' }] }),
      }),
    );
    expect(created.redirect_uris).toEqual([{ uri: 'http://localhost:3000/cb', default: false }]);
    expect(getWorkOSStore(store).connectApplications.get(created.id)?.redirect_uris).toEqual([
      'http://localhost:3000/cb',
    ]);
  });

  it('clears list fields on an explicit null', async () => {
    const application = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'Clear', scopes: ['openid'], redirect_uris: ['http://localhost:3000/a'] }),
      }),
    );

    const updated = await json(
      await req(`/connect/applications/${application.id}`, {
        method: 'PUT',
        body: JSON.stringify({ scopes: null, redirect_uris: null }),
      }),
    );
    expect(updated.scopes).toEqual([]);
    expect(updated.redirect_uris).toEqual([]);
  });

  it('updates an application referenced by client_id', async () => {
    const application = await json(
      await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'By Client ID' }) }),
    );

    const updated = await json(
      await req(`/connect/applications/${application.client_id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: 'Updated By Client ID' }),
      }),
    );
    expect(updated.id).toBe(application.id);
    expect(updated.name).toBe('Updated By Client ID');
  });

  it('rejects redirect_uris on an m2m application', async () => {
    const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'M2M Org' }) }));
    const application = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'M2M', application_type: 'm2m', organization_id: org.id }),
      }),
    );

    const res = await req(`/connect/applications/${application.id}`, {
      method: 'PUT',
      body: JSON.stringify({ redirect_uris: ['http://localhost:3000/cb'] }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects invalid update payloads', async () => {
    const application = await json(
      await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'Validation' }) }),
    );
    const put = (body: unknown) =>
      req(`/connect/applications/${application.id}`, { method: 'PUT', body: JSON.stringify(body) });

    expect((await put({ name: '   ' })).status).toBe(422);
    expect((await put({ name: null })).status).toBe(422);
    expect((await put({ description: 42 })).status).toBe(422);
    expect((await put({ scopes: 'openid' })).status).toBe(422);
    expect((await put({ scopes: [1] })).status).toBe(422);
    expect((await put({ redirect_uris: 'http://localhost:3000/cb' })).status).toBe(422);
    expect((await put({ redirect_uris: [{ default: true }] })).status).toBe(422);
  });

  it('404s updating an unknown application', async () => {
    const res = await req('/connect/applications/conn_app_nope', {
      method: 'PUT',
      body: JSON.stringify({ name: 'Nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('deletes an application and its client secrets', async () => {
    const application = await json(
      await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'Doomed' }) }),
    );
    const secret = await json(await req(`/connect/applications/${application.id}/client_secrets`, { method: 'POST' }));

    const res = await req(`/connect/applications/${application.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect((await req(`/connect/applications/${application.id}`)).status).toBe(404);
    expect(getWorkOSStore(store).clientSecrets.get(secret.id)).toBeUndefined();
  });

  it('deletes an application referenced by client_id', async () => {
    const application = await json(
      await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'Doomed By Client ID' }) }),
    );
    expect((await req(`/connect/applications/${application.client_id}`, { method: 'DELETE' })).status).toBe(204);
    expect(getWorkOSStore(store).connectApplications.get(application.id)).toBeUndefined();
  });

  it('404s deleting an unknown application', async () => {
    expect((await req('/connect/applications/conn_app_nope', { method: 'DELETE' })).status).toBe(404);
  });

  // The spec's oauth application is a oneOf on how the application came to exist, and each arm
  // carries a different field set. The generated shape catalog models one flat shape per object,
  // so it cannot express this — these pin the arms instead.
  it('reports a first-party oauth application without an owner', async () => {
    const created = await json(
      await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'First Party' }) }),
    );
    expect(created.is_first_party).toBe(true);
    expect(created.organization_id).toBeUndefined();
    expect(created.was_dynamically_registered).toBeUndefined();
    expect(created.uses_pkce).toBe(false);
  });

  it('reports a third-party oauth application with its owning organization', async () => {
    const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Owner' }) }));
    const created = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'Third Party', is_first_party: false, organization_id: org.id, uses_pkce: true }),
      }),
    );
    expect(created.is_first_party).toBe(false);
    expect(created.was_dynamically_registered).toBe(false);
    expect(created.organization_id).toBe(org.id);
    expect(created.uses_pkce).toBe(true);
  });

  it('requires an organization for a third-party oauth application', async () => {
    const res = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ownerless', is_first_party: false }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects redirect_uris on an m2m application at create', async () => {
    const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'M2M Org' }) }));
    const res = await req('/connect/applications', {
      method: 'POST',
      body: JSON.stringify({
        name: 'M2M',
        application_type: 'm2m',
        organization_id: org.id,
        redirect_uris: ['http://localhost:3000/cb'],
      }),
    });
    expect(res.status).toBe(422);
  });

  it('rejects blank redirect_uris on create and update', async () => {
    const blank = { name: 'Blank', redirect_uris: [''] };
    expect((await req('/connect/applications', { method: 'POST', body: JSON.stringify(blank) })).status).toBe(422);

    const application = await json(
      await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'Blank Update' }) }),
    );
    const res = await req(`/connect/applications/${application.id}`, {
      method: 'PUT',
      body: JSON.stringify({ redirect_uris: ['   '] }),
    });
    expect(res.status).toBe(422);
  });

  it('treats an empty update body as a no-op rather than a parse error', async () => {
    const application = await json(
      await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'No Body' }) }),
    );
    const res = await req(`/connect/applications/${application.id}`, { method: 'PUT' });
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe('No Body');
  });

  it('ignores identity fields sent in an update body', async () => {
    const application = await json(
      await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'Immutable' }) }),
    );
    const updated = await json(
      await req(`/connect/applications/${application.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          id: 'conn_app_evil',
          client_id: 'client_evil',
          object: 'evil',
          application_type: 'm2m',
          is_first_party: false,
          name: 'Renamed',
        }),
      }),
    );
    expect(updated.id).toBe(application.id);
    expect(updated.client_id).toBe(application.client_id);
    expect(updated.object).toBe('connect_application');
    expect(updated.application_type).toBe('oauth');
    expect(updated.is_first_party).toBe(true);
    expect(updated.name).toBe('Renamed');
  });

  it('updates the emulator-only login_url', async () => {
    const application = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'Login URL', login_url: 'http://localhost:3000/login' }),
      }),
    );
    const res = await req(`/connect/applications/${application.id}`, {
      method: 'PUT',
      body: JSON.stringify({ login_url: 'http://localhost:3000/signin' }),
    });
    expect(res.status).toBe(200);
    expect(getWorkOSStore(store).connectApplications.get(application.id)?.login_url).toBe(
      'http://localhost:3000/signin',
    );
  });

  it('filters the list by organization and registration type', async () => {
    const org = await json(
      await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Filter Org' }) }),
    );
    const mine = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'Mine', is_first_party: false, organization_id: org.id }),
      }),
    );
    await req('/connect/applications', { method: 'POST', body: JSON.stringify({ name: 'Theirs' }) });

    const filtered = await json(await req(`/connect/applications?organization_id=${org.id}`));
    expect(filtered.data.map((a: any) => a.id)).toEqual([mine.id]);

    // "Defaults to `authenticated` only when not specified" — nothing here was dynamically
    // registered, so asking for dynamic alone must come back empty.
    expect((await json(await req('/connect/applications?registration_types=dynamic'))).data).toEqual([]);
    expect((await json(await req('/connect/applications?registration_types=dynamic,authenticated'))).data).toHaveLength(
      2,
    );
    expect((await req('/connect/applications?registration_types=nonsense')).status).toBe(422);
  });

  it('stops the m2m grant when the application is deleted', async () => {
    const org = await json(
      await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Grant Org' }) }),
    );
    const application = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({ name: 'Grant', application_type: 'm2m', organization_id: org.id }),
      }),
    );
    const secret = await json(await req(`/connect/applications/${application.id}/client_secrets`, { method: 'POST' }));

    const exchange = () =>
      app.request('/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${application.client_id}&client_secret=${secret.secret}`,
      });
    expect((await exchange()).status).toBe(200);

    await req(`/connect/applications/${application.id}`, { method: 'DELETE' });
    expect((await exchange()).status).toBe(401);
  });

  it('records last_used_at only when an exchange produces a token', async () => {
    const org = await json(await req('/organizations', { method: 'POST', body: JSON.stringify({ name: 'Used Org' }) }));
    const application = await json(
      await req('/connect/applications', {
        method: 'POST',
        body: JSON.stringify({
          name: 'Used',
          application_type: 'm2m',
          organization_id: org.id,
          scopes: ['posts:read'],
        }),
      }),
    );
    const secret = await json(await req(`/connect/applications/${application.id}/client_secrets`, { method: 'POST' }));
    const exchange = (extra: string) =>
      app.request('/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=client_credentials&client_id=${application.client_id}&client_secret=${secret.secret}${extra}`,
      });
    const listed = async () => (await json(await req(`/connect/applications/${application.id}/client_secrets`)))[0];

    // A rejected exchange presented the secret but never produced a token.
    expect((await exchange('&scope=posts:write')).status).toBe(400);
    expect((await listed()).last_used_at).toBeNull();

    expect((await exchange('')).status).toBe(200);
    expect((await listed()).last_used_at).not.toBeNull();
    // Using a secret is not an edit to it.
    expect((await listed()).updated_at).toBe(getWorkOSStore(store).clientSecrets.get(secret.id)!.created_at);
  });
});
