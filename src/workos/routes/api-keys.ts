import { type RouteContext, notFound, parseJsonBody, parseListParams, isApiKeyEntryExpired } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatApiKeyRecord, formatListResponse } from '../helpers.js';
import type { ApiKeyMap } from '../../core/index.js';
import { STORE_KEYS } from '../constants.js';

export function apiKeyRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  // Validate an API key
  app.post('/api_keys/validations', async (c) => {
    const body = await parseJsonBody(c);
    const key = body.key as string | undefined;
    const apiKeyMap = store.getData<ApiKeyMap>(STORE_KEYS.apiKeyMap) ?? {};
    const entry = key ? apiKeyMap[key] : undefined;
    // A key is valid only if it is in the allow-list and not past its expiry — the same
    // test the auth middleware applies, so validation and real-request auth agree.
    const valid = !!entry && !isApiKeyEntryExpired(entry);
    return c.json({ valid });
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

  // List API keys for an organization — scoped to the path organization so one org's
  // keys never leak into another org's listing. A key belongs to the org when it is
  // org-owned (owner.id) or user-owned within that org (owner.organization_id).
  app.get('/organizations/:orgId/api_keys', (c) => {
    const orgId = c.req.param('orgId');
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const result = ws.apiKeyRecords.list({
      ...params,
      filter: (k) => (k.owner.type === 'organization' ? k.owner.id : k.owner.organization_id) === orgId,
    });
    return c.json(formatListResponse(result, formatApiKeyRecord));
  });
}
