import {
  type RouteContext,
  isApiKeyEntryExpired,
  notFound,
  parseJsonBody,
  parseListParams,
  validationError,
  WorkOSApiError,
} from '../../core/index.js';
import type { ApiKeyMap } from '../../core/index.js';
import type { WorkOSApiKeyOwner } from '../entities.js';
import { formatApiKeyRecord, formatListResponse, generateVerificationToken } from '../helpers.js';
import { getWorkOSStore } from '../store.js';
import { STORE_KEYS } from '../constants.js';

export function apiKeyRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  const createApiKey = (body: Record<string, unknown>, owner: WorkOSApiKeyOwner, environment = 'test') => {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw validationError('name is required', [{ field: 'name', code: 'required' }]);
    if (
      body.permissions !== undefined &&
      (!Array.isArray(body.permissions) || !body.permissions.every((p) => typeof p === 'string'))
    ) {
      throw validationError('permissions must be an array of strings', [{ field: 'permissions', code: 'invalid' }]);
    }

    const expiresAt = body.expires_at;
    if (
      expiresAt !== undefined &&
      (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now())
    ) {
      throw validationError('expires_at must be a future ISO-8601 timestamp', [
        { field: 'expires_at', code: 'invalid' },
      ]);
    }

    const value = `sk_${environment === 'production' ? 'live' : 'test'}_${generateVerificationToken()}`;
    const record = ws.apiKeyRecords.insert({
      object: 'api_key',
      name,
      key: value,
      environment,
      owner,
      permissions: (body.permissions as string[] | undefined) ?? [],
      last_used_at: null,
      expires_at: (expiresAt as string | undefined) ?? null,
    });
    const apiKeyMap = store.getData<ApiKeyMap>(STORE_KEYS.apiKeyMap) ?? {};
    apiKeyMap[value] = { environment, expiresAt: record.expires_at };
    store.setData(STORE_KEYS.apiKeyMap, apiKeyMap);
    return { ...formatApiKeyRecord(record), value };
  };

  // Validate an API key. Request and response both follow the spec exactly
  // (`ValidateApiKeyDto` in, `ApiKeyValidationResponse` out): the caller sends `value`,
  // and a valid key returns the whole `api_key` object — including its `permissions`, so
  // permission-based authorization can be exercised locally. An invalid key is an
  // explicit `api_key: null`, not an error, matching production and what the SDKs read.
  app.post('/api_keys/validations', async (c) => {
    const body = await parseJsonBody(c);
    const value = body.value as string | undefined;
    const apiKeyMap = store.getData<ApiKeyMap>(STORE_KEYS.apiKeyMap) ?? {};
    const entry = value ? apiKeyMap[value] : undefined;
    // A key validates only if it is in the allow-list and not past its expiry — the same
    // test the auth middleware applies, so validation and real-request auth agree.
    const authorized = !!entry && !isApiKeyEntryExpired(entry);
    // The allow-list map form registers a value for authentication without creating a
    // resource; there is no ApiKey object to return for one, and inventing an owner or
    // permission set would report privileges the emulator does not actually hold.
    const record = authorized && value ? ws.apiKeyRecords.findOneBy('key', value) : undefined;
    return c.json({ api_key: record ? formatApiKeyRecord(record) : null });
  });

  // Delete an API key record
  app.delete('/api_keys/:id', (c) => {
    const record = ws.apiKeyRecords.get(c.req.param('id'));
    if (!record) throw notFound('ApiKey');
    ws.apiKeyRecords.delete(record.id);
    // Also drop the value from the auth allow-list (the same object the middleware holds
    // by reference) so a deleted key stops authenticating, not just stops resolving.
    const apiKeyMap = store.getData<ApiKeyMap>(STORE_KEYS.apiKeyMap);
    if (apiKeyMap) delete apiKeyMap[record.key];
    return c.body(null, 204);
  });

  app.post('/api_keys/:id/expire', async (c) => {
    const record = ws.apiKeyRecords.get(c.req.param('id'));
    if (!record) throw notFound('ApiKey');
    if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
      throw new WorkOSApiError(409, 'API key is already expired', 'api_key_already_expired');
    }

    const body = c.req.raw.body ? await parseJsonBody(c) : {};
    if (body.expires_at !== undefined && body.expires_at !== null && typeof body.expires_at !== 'string') {
      throw validationError('expires_at must be an ISO-8601 timestamp or null', [
        { field: 'expires_at', code: 'invalid' },
      ]);
    }
    if (typeof body.expires_at === 'string' && Number.isNaN(Date.parse(body.expires_at))) {
      throw validationError('expires_at must be an ISO-8601 timestamp or null', [
        { field: 'expires_at', code: 'invalid' },
      ]);
    }

    const expiresAt =
      body.expires_at === null
        ? null
        : typeof body.expires_at === 'string' && Date.parse(body.expires_at) > Date.now()
          ? body.expires_at
          : new Date().toISOString();
    const updated = ws.apiKeyRecords.update(record.id, { expires_at: expiresAt })!;
    const apiKeyMap = store.getData<ApiKeyMap>(STORE_KEYS.apiKeyMap);
    if (apiKeyMap?.[record.key]) apiKeyMap[record.key].expiresAt = expiresAt;
    return c.json(formatApiKeyRecord(updated));
  });

  // List API keys for an organization — scoped to the path organization so one org's
  // keys never leak into another org's listing. A key belongs to the org when it is
  // org-owned (owner.id) or user-owned within that org (owner.organization_id).
  app.get('/organizations/:orgId/api_keys', (c) => {
    const orgId = c.req.param('orgId');
    if (!ws.organizations.get(orgId)) throw notFound('Organization');
    const params = parseListParams(new URL(c.req.url));
    const result = ws.apiKeyRecords.list({
      ...params,
      filter: (k) => (k.owner.type === 'organization' ? k.owner.id : k.owner.organization_id) === orgId,
    });
    return c.json(formatListResponse(result, formatApiKeyRecord));
  });

  app.post('/organizations/:orgId/api_keys', async (c) => {
    const orgId = c.req.param('orgId');
    if (!ws.organizations.get(orgId)) throw notFound('Organization');
    return c.json(
      createApiKey(await parseJsonBody(c), { type: 'organization', id: orgId }, c.get('auth')?.environment),
      201,
    );
  });

  app.get('/user_management/users/:userId/api_keys', (c) => {
    const userId = c.req.param('userId');
    if (!ws.users.get(userId)) throw notFound('User');
    const url = new URL(c.req.url);
    const organizationId = url.searchParams.get('organization_id');
    const result = ws.apiKeyRecords.list({
      ...parseListParams(url),
      filter: (k) =>
        k.owner.type === 'user' &&
        k.owner.id === userId &&
        (!organizationId || k.owner.organization_id === organizationId),
    });
    return c.json(formatListResponse(result, formatApiKeyRecord));
  });

  app.post('/user_management/users/:userId/api_keys', async (c) => {
    const userId = c.req.param('userId');
    if (!ws.users.get(userId)) throw notFound('User');
    const body = await parseJsonBody(c);
    const organizationId = typeof body.organization_id === 'string' ? body.organization_id : '';
    if (!organizationId) {
      throw validationError('organization_id is required', [{ field: 'organization_id', code: 'required' }]);
    }
    if (!ws.organizations.get(organizationId)) throw notFound('Organization');
    const membership = ws.organizationMemberships
      .findBy('user_id', userId)
      .find((m) => m.organization_id === organizationId && m.status === 'active');
    if (!membership) throw validationError('User must have an active membership in the organization');
    return c.json(
      createApiKey(body, { type: 'user', id: userId, organization_id: organizationId }, c.get('auth')?.environment),
      201,
    );
  });
}
