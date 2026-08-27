import { beforeEach, describe, expect, it } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';

const apiKeys: ApiKeyMap = {
  sk_test_vault: { environment: 'test' },
  sk_live_vault: { environment: 'production' },
};
const headers = { Authorization: 'Bearer sk_test_vault', 'Content-Type': 'application/json' };
const liveHeaders = { Authorization: 'Bearer sk_live_vault', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys }).app;
}

describe('Vault object routes', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    app = createTestApp();
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;
  const create = () =>
    req('/vault/v1/kv', {
      method: 'POST',
      body: JSON.stringify({
        name: 'database-password',
        value: 'secret',
        key_context: { organization_id: 'org_123' },
      }),
    });

  it('creates, lists, and reads an object with key context', async () => {
    const created = await create();
    expect(created.status).toBe(201);
    const metadata = await json(created);
    expect(metadata.context).toEqual({ organization_id: 'org_123' });
    expect(metadata.version_id).toBeTruthy();

    const byId = await req(`/vault/v1/kv/${metadata.id}`);
    expect(byId.status).toBe(200);
    expect(await json(byId)).toMatchObject({
      id: metadata.id,
      name: 'database-password',
      value: 'secret',
      metadata: { context: { organization_id: 'org_123' } },
    });

    const byName = await req('/vault/v1/kv/name/database-password');
    expect(byName.status).toBe(200);
    expect((await json(byName)).id).toBe(metadata.id);

    const listed = await req('/vault/v1/kv?search=database');
    expect(listed.status).toBe(200);
    expect((await json(listed)).data).toEqual([
      expect.objectContaining({ id: metadata.id, name: 'database-password' }),
    ]);

    const described = await req(`/vault/v1/kv/${metadata.id}/metadata`);
    expect(described.status).toBe(200);
    expect((await json(described)).value).toBeUndefined();
  });

  it('updates, versions, and deletes an object with optimistic locking', async () => {
    const original = await json(await create());
    const updatedResponse = await req(`/vault/v1/kv/${original.id}`, {
      method: 'PUT',
      body: JSON.stringify({ value: 'new-secret', version_check: original.version_id }),
    });
    expect(updatedResponse.status).toBe(201);
    const updated = await json(updatedResponse);
    expect(updated.metadata.version_id).not.toBe(original.version_id);

    const staleUpdate = await req(`/vault/v1/kv/${original.id}`, {
      method: 'PUT',
      body: JSON.stringify({ value: 'wrong', version_check: original.version_id }),
    });
    expect(staleUpdate.status).toBe(409);

    const versions = await json(await req(`/vault/v1/kv/${original.id}/versions`));
    expect(versions.data).toHaveLength(2);
    expect(versions.data[0]).toMatchObject({ id: updated.metadata.version_id, current_version: true });
    expect(versions.data[1].current_version).toBe(false);

    expect(
      (await req(`/vault/v1/kv/${original.id}?version_check=${original.version_id}`, { method: 'DELETE' })).status,
    ).toBe(409);
    const deleted = await req(`/vault/v1/kv/${original.id}?version_check=${updated.metadata.version_id}`, {
      method: 'DELETE',
    });
    expect(deleted.status).toBe(200);
    expect(await json(deleted)).toEqual({ success: true, name: 'database-password' });
    expect((await req(`/vault/v1/kv/${original.id}`)).status).toBe(404);
  });

  it('isolates objects by authenticated environment', async () => {
    const testObject = await json(await create());
    const liveReq = (path: string, init?: RequestInit) => app.request(path, { headers: liveHeaders, ...init });

    expect((await json(await liveReq('/vault/v1/kv'))).data).toEqual([]);
    for (const path of [
      `/vault/v1/kv/${testObject.id}`,
      `/vault/v1/kv/${testObject.id}/metadata`,
      `/vault/v1/kv/${testObject.id}/versions`,
      '/vault/v1/kv/name/database-password',
    ]) {
      expect((await liveReq(path)).status).toBe(404);
    }
    expect(
      (
        await liveReq(`/vault/v1/kv/${testObject.id}`, {
          method: 'PUT',
          body: JSON.stringify({ value: 'overwritten' }),
        })
      ).status,
    ).toBe(404);
    expect((await liveReq(`/vault/v1/kv/${testObject.id}`, { method: 'DELETE' })).status).toBe(404);

    const liveObject = await liveReq('/vault/v1/kv', {
      method: 'POST',
      body: JSON.stringify({
        name: 'database-password',
        value: 'live-secret',
        key_context: { organization_id: 'org_live' },
      }),
    });
    expect(liveObject.status).toBe(201);
    expect((await json(await liveReq('/vault/v1/kv/name/database-password'))).value).toBe('live-secret');
    expect((await json(await req(`/vault/v1/kv/${testObject.id}`))).value).toBe('secret');
  });

  it('rejects missing key context and duplicate names', async () => {
    const invalid = await req('/vault/v1/kv', {
      method: 'POST',
      body: JSON.stringify({ name: 'missing-context', value: 'secret' }),
    });
    expect(invalid.status).toBe(422);

    expect((await create()).status).toBe(201);
    expect((await create()).status).toBe(409);
  });
});
