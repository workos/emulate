import type { Context } from 'hono';
import {
  type Entity,
  type RouteContext,
  type WidgetAuthContext,
  type WorkOSAppEnv,
  notFound,
  parseJsonBody,
  validationError,
  widgetForbidden,
  WIDGET_TOKEN_AUDIENCE,
} from '../../core/index.js';
import type { WorkOSApiKey, WorkOSPermission } from '../entities.js';
import { apiKeyOrganizationId, deleteApiKey, expireApiKey, issueApiKey, obfuscateApiKey } from '../helpers.js';
import { getWorkOSStore } from '../store.js';

/**
 * The scope the org-scope `<ApiKeys>` widget requires: `WidgetSessionTokenScopes.WidgetsApiKeysManage`
 * in the Node SDK, and the `permissions` entry the widget itself checks before it renders.
 */
export const WIDGET_SCOPE_API_KEYS_MANAGE = 'widgets:api-keys:manage';

interface WidgetListParams {
  limit: number;
  before?: string;
  after?: string;
  search?: string;
}

interface WidgetList<T> {
  data: T[];
  list_metadata: { before: string | null; after: string | null };
}

/** The `limit`, `before`, `after` and `search` query the widget client sends on its list calls. */
function parseWidgetListParams(url: URL): WidgetListParams {
  const query = (name: string) => url.searchParams.get(name)?.trim() || undefined;
  return {
    limit: parseInt(url.searchParams.get('limit') ?? '10') || 10,
    before: query('before'),
    after: query('after'),
    search: query('search'),
  };
}

/**
 * Cursor pagination in the convention the widgets' private API uses, which is the mirror image
 * of the public API's (`cursorPaginate`): records are newest-first, `before` is the cursor for
 * the *next* page — the records created before it — and `after` for the *previous* page. The
 * shipped `@workos-inc/widgets` tables wire their Next button to `list_metadata.before` and
 * Previous to `list_metadata.after`, so serving the public convention would page backwards.
 *
 * A `before` cursor yields the `limit` records that follow it; an `after` cursor yields the
 * `limit` records immediately preceding it, so stepping back from page three lands on page two.
 */
export function paginateForWidget<T extends Entity>(
  items: T[],
  params: Omit<WidgetListParams, 'search'>,
): WidgetList<T> {
  const sorted = [...items].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const limit = Math.max(1, Math.min(params.limit, 100));

  let start = 0;
  let end = sorted.length;
  if (params.before) {
    const index = sorted.findIndex((item) => item.id === params.before);
    if (index !== -1) start = index + 1;
  } else if (params.after) {
    const index = sorted.findIndex((item) => item.id === params.after);
    if (index !== -1) {
      end = index;
      start = Math.max(0, index - limit);
    }
  }

  const page = sorted.slice(start, Math.min(end, start + limit));
  const first = page[0];
  const last = page[page.length - 1];
  return {
    data: page,
    list_metadata: {
      before: last && start + page.length < sorted.length ? last.id : null,
      after: first && start > 0 ? first.id : null,
    },
  };
}

/** Case-insensitive substring match across the fields a search box would reasonably hit. */
function matchesSearch(search: string | undefined, ...fields: Array<string | null | undefined>): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  return fields.some((field) => field?.toLowerCase().includes(needle));
}

/**
 * The camelCase shape the `<ApiKeys>` widget renders. The list envelope stays `list_metadata`;
 * that mixed casing is the private API's contract, not an accident. The secret is never in it.
 */
function formatWidgetApiKey(k: WorkOSApiKey) {
  return {
    id: k.id,
    name: k.name,
    obfuscatedValue: obfuscateApiKey(k.key),
    createdAt: k.created_at,
    lastUsedAt: k.last_used_at,
    expiresAt: k.expires_at,
    permissions: k.permissions,
  };
}

function formatWidgetPermission(p: WorkOSPermission) {
  return { id: p.id, slug: p.slug, name: p.name, description: p.description };
}

/**
 * `expiresAt` as the widget sends it: absent, `null` for "never", or an ISO-8601 timestamp.
 * Creating a key rejects a timestamp already in the past, as the public route does; expiring
 * one accepts it, because that means "expire now".
 */
function parseExpiresAt(body: Record<string, unknown>, opts: { mustBeFuture: boolean }): string | null | undefined {
  const value = body.expiresAt;
  if (value === undefined || value === null) return value;
  const invalid =
    typeof value !== 'string' ||
    Number.isNaN(Date.parse(value)) ||
    (opts.mustBeFuture && Date.parse(value) <= Date.now());
  if (invalid) {
    throw validationError(
      opts.mustBeFuture
        ? 'expiresAt must be a future ISO-8601 timestamp or null'
        : 'expiresAt must be an ISO-8601 timestamp or null',
      [{ field: 'expiresAt', code: 'invalid' }],
    );
  }
  return value;
}

export function widgetRoutes(ctx: RouteContext): void {
  const { app, jwt, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/widgets/token', async (c) => {
    const body = await parseJsonBody(c);
    const organizationId = body.organization_id as string | undefined;
    const userId = body.user_id as string | undefined;
    const scopes = body.scopes;

    if (!organizationId) {
      throw validationError('organization_id is required', [{ field: 'organization_id', code: 'required' }]);
    }
    if (!userId) {
      throw validationError('user_id is required', [{ field: 'user_id', code: 'required' }]);
    }
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string')) {
      throw validationError('scopes is required', [{ field: 'scopes', code: 'required' }]);
    }

    // The widget client decodes this token itself: it refuses to render unless `permissions` is
    // an array holding the widget's scope, and schedules a refresh 30s before `exp`, which
    // `sign` always sets. The scopes therefore travel under `permissions` — the claim the
    // client reads — rather than a `scopes` claim nothing does.
    const token = jwt.sign({
      sub: userId,
      org_id: organizationId,
      aud: WIDGET_TOKEN_AUDIENCE,
      permissions: scopes as string[],
    });

    return c.json({ token });
  });

  // ---------------------------------------------------------------------------
  // /_widgets/ApiKeys — the private surface the org-scope <ApiKeys> widget calls.
  //
  // Requests reach these routes already authenticated by the server's widget-token middleware,
  // which is where the organization context comes from: no `/_widgets` path carries an org id.
  // Everything below is a translation layer over the same API-key store the public routes use,
  // so a key created here authenticates requests and a key created via the API shows up here.
  // ---------------------------------------------------------------------------

  const widgetAuth = (c: Context<WorkOSAppEnv>): WidgetAuthContext => {
    const auth = c.get('widgetAuth');
    // The server authenticates every /_widgets/* request before routing, so a missing context
    // is a wiring bug — still refused, in the status the widget client understands.
    if (!auth) throw widgetForbidden('Widget token is required');
    return auth;
  };

  // A token minted for another widget is a token problem, so this is the one business rule on
  // these routes that answers 403: the client then reports "incorrect permissions".
  app.use('/_widgets/ApiKeys/*', async (c, next) => {
    if (!widgetAuth(c).permissions.includes(WIDGET_SCOPE_API_KEYS_MANAGE)) {
      throw widgetForbidden(`Widget token lacks the ${WIDGET_SCOPE_API_KEYS_MANAGE} scope`);
    }
    await next();
  });

  // Keys are only ever addressed within the token's organization: another org's key is not
  // found, never forbidden, so a cross-org id cannot be told apart from an unknown one — and
  // cannot trip the client's token-refresh path.
  const findOrganizationApiKey = (c: Context<WorkOSAppEnv>, apiKeyId: string): WorkOSApiKey => {
    const record = ws.apiKeyRecords.get(apiKeyId);
    if (!record || apiKeyOrganizationId(record) !== widgetAuth(c).organizationId) throw notFound('ApiKey');
    return record;
  };

  app.get('/_widgets/ApiKeys/organization-api-keys', (c) => {
    const { organizationId } = widgetAuth(c);
    const params = parseWidgetListParams(new URL(c.req.url));
    const keys = ws.apiKeyRecords
      .all()
      .filter((k) => apiKeyOrganizationId(k) === organizationId && matchesSearch(params.search, k.name));
    const page = paginateForWidget(keys, params);
    return c.json({ data: page.data.map(formatWidgetApiKey), list_metadata: page.list_metadata });
  });

  app.post('/_widgets/ApiKeys/organization-api-keys', async (c) => {
    const { organizationId } = widgetAuth(c);
    // The token names the organization but nothing checked it exists — a token can be minted
    // for any id, and the org may have been deleted since. Issuing a key here would create a
    // live credential no organization route can reach, so refuse as the public route does.
    if (!ws.organizations.get(organizationId)) throw notFound('Organization');
    const body = await parseJsonBody(c);

    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) throw validationError('name is required', [{ field: 'name', code: 'required' }]);
    const permissions = body.permissions;
    if (!Array.isArray(permissions) || !permissions.every((p) => typeof p === 'string')) {
      throw validationError('permissions must be an array of strings', [{ field: 'permissions', code: 'invalid' }]);
    }
    const expiresAt = parseExpiresAt(body, { mustBeFuture: true }) ?? null;

    // A widget session carries no API environment, so a key issued here is a test key — the
    // same default the public create route falls back to for a request without one.
    const { record, value } = issueApiKey(store, ws, {
      name,
      owner: { type: 'organization', id: organizationId },
      permissions: permissions as string[],
      expiresAt,
      environment: 'test',
    });
    // `value` is the plaintext secret, returned here and nowhere else.
    return c.json({ ...formatWidgetApiKey(record), value }, 201);
  });

  app.delete('/_widgets/ApiKeys/:apiKeyId', (c) => {
    deleteApiKey(store, ws, findOrganizationApiKey(c, c.req.param('apiKeyId')));
    return c.json({ success: true });
  });

  // Not in the private widgets spec, but the shipped client's "Edit expiration" dialog calls it
  // with `{ expiresAt: string | null }` — `null` meaning the key should never expire.
  app.post('/_widgets/ApiKeys/:apiKeyId/expire', async (c) => {
    const record = findOrganizationApiKey(c, c.req.param('apiKeyId'));
    const body = c.req.raw.body ? await parseJsonBody(c) : {};
    const updated = expireApiKey(store, ws, record, parseExpiresAt(body, { mustBeFuture: false }));
    return c.json(formatWidgetApiKey(updated));
  });

  // The environment's permissions, which populate the create dialog's checklist and label the
  // slugs on an existing key. The widget degrades gracefully if this fails, but it should not.
  app.get('/_widgets/ApiKeys/permissions', (c) => {
    const params = parseWidgetListParams(new URL(c.req.url));
    const permissions = ws.permissions.all().filter((p) => matchesSearch(params.search, p.slug, p.name, p.description));
    const page = paginateForWidget(permissions, params);
    return c.json({ data: page.data.map(formatWidgetPermission), list_metadata: page.list_metadata });
  });
}
