import { createHash, randomUUID } from 'node:crypto';
import { type RouteContext, parseJsonBody, parseListParams } from '../../core/index.js';
import type { WorkOSVaultObject, WorkOSVaultObjectVersion } from '../entities.js';
import { getWorkOSStore } from '../store.js';

const error = (message: string) => ({ error: message });

function makeVersion(value: string): WorkOSVaultObjectVersion {
  return {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    current_version: true,
    size: Buffer.byteLength(value),
    etag: createHash('sha256').update(value).digest('hex'),
  };
}

function metadata(object: WorkOSVaultObject) {
  return {
    id: object.id,
    environment_id: object.environment_id,
    key_id: object.key_id,
    updated_by: object.updated_by,
    updated_at: object.updated_at,
    context: object.key_context,
    version_id: object.version_id,
  };
}

function withoutValue(object: WorkOSVaultObject) {
  return { id: object.id, name: object.name, metadata: metadata(object) };
}

function withValue(object: WorkOSVaultObject) {
  return { ...withoutValue(object), value: object.value };
}

export function vaultRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);
  const environmentIdFor = (environment?: string) => `environment_${environment ?? 'test'}`;
  const findById = (id: string, environment?: string) => {
    const object = ws.vaultObjects.get(id);
    return object?.environment_id === environmentIdFor(environment) ? object : undefined;
  };
  const findByName = (name: string, environment?: string) =>
    ws.vaultObjects.findBy('name', name).find((object) => object.environment_id === environmentIdFor(environment));
  const actorFor = (apiKey?: string) => {
    const record = apiKey ? ws.apiKeyRecords.findOneBy('key', apiKey) : undefined;
    return { id: record?.id ?? 'api_key_emulator', name: record?.name ?? 'Emulator API key' };
  };

  app.get('/vault/v1/kv', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const search = url.searchParams.get('search')?.toLowerCase();
    const updatedAfter = url.searchParams.get('updatedAfter');
    if (updatedAfter && Number.isNaN(Date.parse(updatedAfter))) {
      return c.json(error('updatedAfter must be an ISO-8601 timestamp'), 400);
    }

    const result = ws.vaultObjects.list({
      ...params,
      filter: (object) =>
        object.environment_id === environmentIdFor(c.get('auth')?.environment) &&
        (!search || object.name.toLowerCase().includes(search)) &&
        (!updatedAfter || Date.parse(object.updated_at) > Date.parse(updatedAfter)),
      sort: (a, b) =>
        params.order === 'asc'
          ? a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id)
          : b.updated_at.localeCompare(a.updated_at) || b.id.localeCompare(a.id),
    });
    return c.json({
      data: result.data.map(({ id, name, updated_at }) => ({ id, name, updated_at })),
      list_metadata: result.list_metadata,
    });
  });

  app.post('/vault/v1/kv', async (c) => {
    const body = await parseJsonBody(c);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const keyContext = body.key_context;
    if (!name || name.length > 200) return c.json(error('name is required and must be at most 200 characters'), 422);
    if (typeof body.value !== 'string') return c.json(error('value is required'), 422);
    if (
      !keyContext ||
      typeof keyContext !== 'object' ||
      Array.isArray(keyContext) ||
      Object.keys(keyContext).length > 10 ||
      !Object.values(keyContext).every((value) => typeof value === 'string' && value.length <= 500)
    ) {
      return c.json(error('key_context must contain at most 10 string values'), 422);
    }
    const environment = c.get('auth')?.environment;
    if (findByName(name, environment)) return c.json(error('An object with this name already exists'), 409);

    const version = makeVersion(body.value);
    const object = ws.vaultObjects.insert({
      id: randomUUID(),
      name,
      value: body.value,
      key_context: keyContext as Record<string, string>,
      environment_id: environmentIdFor(environment),
      key_id: randomUUID(),
      updated_by: actorFor(c.get('auth')?.apiKey),
      version_id: version.id,
      versions: [version],
    });
    return c.json(metadata(object), 201);
  });

  app.get('/vault/v1/kv/name/:name', (c) => {
    const object = findByName(c.req.param('name'), c.get('auth')?.environment);
    return object ? c.json(withValue(object)) : c.json(error('Object not found'), 404);
  });

  app.get('/vault/v1/kv/:id/metadata', (c) => {
    const object = findById(c.req.param('id'), c.get('auth')?.environment);
    return object ? c.json(withoutValue(object)) : c.json(error('Object not found'), 404);
  });

  app.get('/vault/v1/kv/:id/versions', (c) => {
    const object = findById(c.req.param('id'), c.get('auth')?.environment);
    if (!object) return c.json(error('Object not found'), 404);
    return c.json({ data: object.versions.slice().reverse(), list_metadata: { before: null, after: null } });
  });

  app.get('/vault/v1/kv/:id', (c) => {
    const object = findById(c.req.param('id'), c.get('auth')?.environment);
    return object ? c.json(withValue(object)) : c.json(error('Object not found'), 404);
  });

  app.put('/vault/v1/kv/:id', async (c) => {
    const object = findById(c.req.param('id'), c.get('auth')?.environment);
    if (!object) return c.json(error('Object not found'), 404);
    const body = await parseJsonBody(c);
    if (typeof body.value !== 'string') return c.json(error('value is required'), 400);
    if (body.version_check !== undefined && body.version_check !== null && typeof body.version_check !== 'string') {
      return c.json(error('version_check must be a string or null'), 400);
    }
    if (typeof body.version_check === 'string' && body.version_check !== object.version_id) {
      return c.json(error('Version mismatch'), 409);
    }

    const version = makeVersion(body.value);
    const updated = ws.vaultObjects.update(object.id, {
      value: body.value,
      updated_by: actorFor(c.get('auth')?.apiKey),
      version_id: version.id,
      versions: [...object.versions.map((v) => ({ ...v, current_version: false })), version],
    })!;
    return c.json(withoutValue(updated), 201);
  });

  app.delete('/vault/v1/kv/:id', (c) => {
    const object = findById(c.req.param('id'), c.get('auth')?.environment);
    if (!object) return c.json(error('Object not found'), 404);
    const versionCheck = new URL(c.req.url).searchParams.get('version_check');
    if (versionCheck && versionCheck !== object.version_id) return c.json(error('Version mismatch'), 409);
    ws.vaultObjects.delete(object.id);
    return c.json({ success: true, name: object.name });
  });
}
