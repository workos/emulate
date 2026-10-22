import type { Context } from 'hono';
import {
  type Entity,
  type RouteContext,
  type WidgetAuthContext,
  type WorkOSAppEnv,
  generateId,
  generateUlid,
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

/**
 * The scopes only an AuthKit user can hold — `AuthkitWidgetScopes` in production
 * (packages/api-entities-zod/src/entities/widget-session.ts). Requesting one without a
 * `user_id` is refused, since the session would have no user to grant it to.
 */
export const AUTHKIT_WIDGET_SCOPES: ReadonlySet<string> = new Set([
  'widgets:users-table:manage',
  'widgets:user-api-keys:manage-self',
  'widgets:user-api-keys:manage-all',
]);

/**
 * The scopes a widget session can be minted with: production's `WidgetSessionScope` enum —
 * the AuthKit scopes above plus the standalone ones, which need an organization but no user.
 */
export const WIDGET_SESSION_SCOPES: readonly string[] = [
  ...AUTHKIT_WIDGET_SCOPES,
  'widgets:domain-verification:manage',
  'widgets:sso:manage',
  WIDGET_SCOPE_API_KEYS_MANAGE,
  'widgets:dsync:manage',
  'widgets:audit-log-streaming:manage',
  'widgets:pipes:manage',
];

const isWidgetSessionScope = (scope: string): boolean => WIDGET_SESSION_SCOPES.includes(scope);

/**
 * Production's message for an unknown scope, verbatim — including the empty list after the
 * colon. Its `IsEnum` is handed the zod enum's `.options` array, and class-validator 0.14 builds
 * the list from the non-numeric keys of what it is given, of which an array has none.
 */
const INVALID_SCOPE_MESSAGE = 'each value in scopes must be one of the following values: ';

/**
 * The 400 Nest's `BadRequestException` renders from a bare message, and the one its default
 * `ValidationPipe` renders from a list of them: `{ message, error: 'Bad Request' }` with no
 * `code`, which is the shape the spec documents for this route and the only 400 it answers.
 */
function nestBadRequest(c: Context<WorkOSAppEnv>, message: string | string[]) {
  return c.json({ message, error: 'Bad Request' }, 400);
}

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

    // Production validates the body with Nest's default ValidationPipe, whose failure is the
    // `{ message: string[], error: 'Bad Request' }` body the spec documents for this route's
    // 400 — one class-validator message per failed field, in field order. An optional field
    // that is null or absent is skipped, so neither counts as a failure.
    const messages: string[] = [];
    const { organization_id: rawOrganizationId, user_id: rawUserId, scopes } = body;
    if (rawOrganizationId != null && typeof rawOrganizationId !== 'string') {
      messages.push('organization_id must be a string');
    }
    if (rawUserId != null && typeof rawUserId !== 'string') messages.push('user_id must be a string');
    if (scopes != null) {
      if (!Array.isArray(scopes)) {
        // Both constraints run on a non-array: `IsEnum` first (decorators register bottom-up),
        // which a scalar passes only by being a scope itself, then `IsArray`.
        if (!(typeof scopes === 'string' && isWidgetSessionScope(scopes))) messages.push(INVALID_SCOPE_MESSAGE);
        messages.push('scopes must be an array');
      } else if (!scopes.every((scope) => typeof scope === 'string' && isWidgetSessionScope(scope))) {
        messages.push(INVALID_SCOPE_MESSAGE);
      }
    }
    if (messages.length > 0) return nestBadRequest(c, messages);

    // Past validation each id is a string or absent, and an empty string reads as absent, as it
    // does to production's truthiness checks.
    const organizationId = typeof rawOrganizationId === 'string' && rawOrganizationId ? rawOrganizationId : undefined;
    const userId = typeof rawUserId === 'string' && rawUserId ? rawUserId : undefined;
    const requestedScopes: string[] = Array.isArray(scopes) ? scopes : [];

    if (requestedScopes.length > 0 && !organizationId) {
      return nestBadRequest(c, 'organization_id is required when scopes are provided');
    }
    if (!organizationId && !userId) {
      return nestBadRequest(c, 'You must provide an organization_id or a user_id');
    }

    // A widget session carries a user, an organization, or both: `sub` is the user when there is
    // one and the session id otherwise, as production mints it.
    const sessionId = generateId('widget_session');
    let subject: string;

    if (organizationId) {
      if (!ws.organizations.get(organizationId)) throw notFound('Organization', organizationId);

      // user_id is required when no scopes are requested (an AuthKit profile or org switcher
      // session) and when any AuthKit scope is, which only a user can hold.
      if (!userId) {
        const authkitScopes = requestedScopes.filter((scope) => AUTHKIT_WIDGET_SCOPES.has(scope));
        if (authkitScopes.length > 0) {
          return nestBadRequest(c, `user_id is required for these scopes: ${authkitScopes.join(', ')}`);
        }
        if (requestedScopes.length === 0) return nestBadRequest(c, 'You must provide scopes or a user_id');
        subject = sessionId;
      } else {
        // The user must hold an *active* membership in the organization; production never
        // looks the user up on its own here, so an unknown user fails the same way.
        const membership = ws.organizationMemberships
          .findBy('organization_id', organizationId)
          .find((m) => m.user_id === userId && m.status === 'active');
        if (!membership) throw notFound('UserOrganizationMembership', organizationId);
        subject = userId;
      }
    } else if (userId) {
      // A user-only session, for the widgets that need no organization context. Scopes are
      // necessarily empty here (any scope requires an organization), so the token carries none.
      if (!ws.users.get(userId)) throw notFound('User', userId);
      subject = userId;
    } else {
      // Already refused above; production re-checks here too, and so does the type narrowing.
      return nestBadRequest(c, 'You must provide an organization_id or a user_id');
    }

    // The widget client decodes this token itself: it refuses to render unless `permissions` is
    // an array holding the widget's scope, and schedules a refresh 30s before `exp`, which
    // `sign` always sets. The scopes therefore travel under `permissions` — the claim the
    // client reads — rather than a `scopes` claim nothing does.
    const token = jwt.sign({
      sub: subject,
      sid: sessionId,
      ...(organizationId ? { org_id: organizationId } : {}),
      aud: WIDGET_TOKEN_AUDIENCE,
      jti: generateUlid(),
      permissions: requestedScopes,
    });

    return c.json({ token }, 201);
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
    if (!record || apiKeyOrganizationId(record) !== widgetAuth(c).organizationId) throw notFound('API Key', apiKeyId);
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
    if (!ws.organizations.get(organizationId)) throw notFound('Organization', organizationId);
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
