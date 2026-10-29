import type { Context } from 'hono';
import {
  type RouteContext,
  type WorkOSAppEnv,
  notFound,
  validationError,
  parseJsonBody,
  WorkOSApiError,
} from '../../core/index.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';
import {
  formatConnectedAccount,
  findConnectedAccount,
  insertConnectedAccount,
  findOrganizationConnectedAccount,
  assertActiveMember,
} from '../helpers.js';
import type { ConnectedAccountState, WorkOSConnectedAccount } from '../entities.js';

/**
 * The spec's ConnectedAccountDto, shared by import (POST) and update (PUT). Every field is
 * optional in the schema; which combinations are usable is decided per verb.
 */
interface ConnectedAccountDto {
  access_token?: string;
  refresh_token?: string;
  expires_at?: string;
  scopes?: string[];
  state?: ConnectedAccountState;
}

const DTO_STATES: ConnectedAccountState[] = ['connected', 'needs_reauthorization'];

// All four verbs live on each spec path; naming them once keeps the param typing exact.
const ACCOUNT_PATH = '/user_management/users/:user_id/connected_accounts/:slug';
const ORGANIZATION_ACCOUNT_PATH = '/organizations/:organization_id/connected_accounts/:slug';

function parseDto(body: Record<string, unknown>): ConnectedAccountDto {
  const dto: ConnectedAccountDto = {};
  for (const field of ['access_token', 'refresh_token'] as const) {
    const value = body[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length === 0) {
      throw validationError(`${field} must be a non-empty string`, [{ field, code: 'invalid' }]);
    }
    dto[field] = value;
  }
  if (body.expires_at !== undefined) {
    if (typeof body.expires_at !== 'string' || Number.isNaN(Date.parse(body.expires_at))) {
      throw validationError('expires_at must be an ISO-8601 timestamp', [{ field: 'expires_at', code: 'invalid' }]);
    }
    dto.expires_at = body.expires_at;
  }
  if (body.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || body.scopes.some((s) => typeof s !== 'string')) {
      throw validationError('scopes must be an array of strings', [{ field: 'scopes', code: 'invalid' }]);
    }
    dto.scopes = body.scopes as string[];
  }
  if (body.state !== undefined) {
    if (!DTO_STATES.includes(body.state as ConnectedAccountState)) {
      throw validationError(`state must be one of: ${DTO_STATES.join(', ')}`, [{ field: 'state', code: 'invalid' }]);
    }
    dto.state = body.state as ConnectedAccountState;
  }
  return dto;
}

/**
 * The spec derives an omitted `state` "from the token combination provided": a token that still
 * works — unexpired, or expired but refreshable — is `connected`; an expired access token with
 * no refresh token means the user must step back through the provider. A DTO carrying neither a
 * state nor any token is the invalid combination its 422 describes.
 */
function deriveState(dto: ConnectedAccountDto): ConnectedAccountState {
  if (dto.state) return dto.state;
  if (dto.access_token) {
    const expired = dto.expires_at !== undefined && Date.parse(dto.expires_at) <= Date.now();
    return expired && !dto.refresh_token ? 'needs_reauthorization' : 'connected';
  }
  if (dto.refresh_token) return 'connected';
  throw validationError('a state or at least one token is required');
}

/** POST on either path: the account fields an import takes from its DTO. */
function importedFields(
  dto: ConnectedAccountDto,
): Pick<WorkOSConnectedAccount, 'scopes' | 'state' | 'access_token' | 'refresh_token' | 'token_expires_at'> {
  return {
    scopes: dto.scopes ?? [],
    state: deriveState(dto),
    access_token: dto.access_token ?? null,
    refresh_token: dto.refresh_token ?? null,
    token_expires_at: dto.expires_at ?? null,
  };
}

/** PUT on either path: merge the DTO into the account, re-deriving its state as described inline. */
function updateAccount(
  ws: WorkOSStore,
  account: WorkOSConnectedAccount,
  dto: ConnectedAccountDto,
): WorkOSConnectedAccount {
  // Without an explicit state, an update touching the credentials re-derives it from the
  // merged token set — the DTO alone cannot see a retained refresh token — while a
  // scopes-only update must not silently reconnect a needs_reauthorization account.
  const credentialsTouched =
    dto.access_token !== undefined || dto.refresh_token !== undefined || dto.expires_at !== undefined;
  // An expiry describes its access token: a replacement token sent without one is unexpired, and
  // the previous token's expiry must not linger on the row to expire it later.
  const tokenExpiresAt = dto.expires_at ?? (dto.access_token === undefined ? account.token_expires_at : null);
  const merged: ConnectedAccountDto = {
    access_token: dto.access_token ?? account.access_token ?? undefined,
    refresh_token: dto.refresh_token ?? account.refresh_token ?? undefined,
    expires_at: tokenExpiresAt ?? undefined,
  };
  const canDerive = merged.access_token !== undefined || merged.refresh_token !== undefined;
  const state = dto.state ?? (credentialsTouched && canDerive ? deriveState(merged) : account.state);

  return ws.connectedAccounts.update(account.id, {
    ...(dto.scopes !== undefined ? { scopes: dto.scopes } : {}),
    ...(dto.access_token !== undefined ? { access_token: dto.access_token } : {}),
    ...(dto.refresh_token !== undefined ? { refresh_token: dto.refresh_token } : {}),
    token_expires_at: tokenExpiresAt,
    state,
  })!;
}

export function connectedAccountRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  /**
   * The account a request addresses. The user in the path and the organization in the query
   * (when given) must both exist — the spec 404s on either before the account itself. Import
   * keys the account by (user, slug, organization) exactly, since that key decides 201 vs 409;
   * the other verbs treat `organization_id` as a filter (see `findConnectedAccount`).
   */
  function resolveTarget(
    c: Context<WorkOSAppEnv, typeof ACCOUNT_PATH>,
    { exact = false } = {},
  ): {
    userId: string;
    slug: string;
    organizationId: string | null;
    account: WorkOSConnectedAccount | undefined;
  } {
    const user = ws.users.get(c.req.param('user_id'));
    if (!user) throw notFound('User', c.req.param('user_id'));

    const slug = c.req.param('slug');
    const organizationId = new URL(c.req.url).searchParams.get('organization_id');
    if (organizationId && !ws.organizations.get(organizationId)) throw notFound('Organization', organizationId);

    const account = exact
      ? ws.connectedAccounts
          .findBy('user_id', user.id)
          .find((a) => a.provider === slug && a.organization_id === (organizationId ?? null))
      : findConnectedAccount(ws, user.id, slug, organizationId ?? null);
    return { userId: user.id, slug, organizationId: organizationId ?? null, account };
  }

  // Production looks an account up by the triple and names the whole triple in its 404
  // (api data-integrations.user-management.controller.ts, DataInstallationNotFoundException).
  const requireAccount = (target: ReturnType<typeof resolveTarget>): WorkOSConnectedAccount => {
    if (target.account) return target.account;
    throw notFound(
      'Data Installation',
      `slug=${target.slug} userland_user_id=${target.userId} organization_id=${target.organizationId}`,
    );
  };

  app.get(ACCOUNT_PATH, (c) => {
    const account = requireAccount(resolveTarget(c));
    return c.json(formatConnectedAccount(account));
  });

  app.post(ACCOUNT_PATH, async (c) => {
    const { userId, slug, organizationId, account } = resolveTarget(c, { exact: true });
    if (account) {
      throw new WorkOSApiError(
        409,
        `Connected account already exists for provider '${slug}'${organizationId ? ` in organization '${organizationId}'` : ''}`,
        'conflict',
      );
    }

    const dto = parseDto(await parseJsonBody(c));
    const created = insertConnectedAccount(ws, {
      user_id: userId,
      organization_id: organizationId,
      provider: slug,
      established_by_user_id: null,
      ...importedFields(dto),
    });
    return c.json(formatConnectedAccount(created), 201);
  });

  app.put(ACCOUNT_PATH, async (c) => {
    const account = requireAccount(resolveTarget(c));

    const dto = parseDto(await parseJsonBody(c));
    const updated = updateAccount(ws, account, dto);
    return c.json(formatConnectedAccount(updated));
  });

  app.delete(ACCOUNT_PATH, (c) => {
    const account = requireAccount(resolveTarget(c));
    // Deleting is what "disconnects": the row (and the tokens the spec says are removed with
    // it) goes away, so a later import is a fresh 201 rather than a 409 against a dead link.
    // The pipes.connected_account.disconnected event is emitted by the collection hook.
    ws.connectedAccounts.delete(account.id);
    return c.body(null, 204);
  });

  // Organization-owned accounts: one per (organization, slug), with no `user_id` of their own.

  function resolveOrganizationTarget(c: Context<WorkOSAppEnv, typeof ORGANIZATION_ACCOUNT_PATH>): {
    organizationId: string;
    slug: string;
    account: WorkOSConnectedAccount | undefined;
  } {
    const organizationId = c.req.param('organization_id');
    if (!ws.organizations.get(organizationId)) throw notFound('Organization', organizationId);
    const slug = c.req.param('slug');
    return { organizationId, slug, account: findOrganizationConnectedAccount(ws, organizationId, slug) };
  }

  const requireOrganizationAccount = (target: ReturnType<typeof resolveOrganizationTarget>): WorkOSConnectedAccount => {
    if (target.account) return target.account;
    throw notFound('Data Installation', `slug=${target.slug} organization_id=${target.organizationId}`);
  };

  /** Import and update name the member acting for the organization; they must be an active one. */
  function actingMember(body: Record<string, unknown>, organizationId: string): string {
    if (body.user_id === undefined) {
      throw validationError('user_id is required', [{ field: 'user_id', code: 'required' }]);
    }
    if (typeof body.user_id !== 'string' || !body.user_id) {
      throw validationError('user_id must be a non-empty string', [{ field: 'user_id', code: 'invalid' }]);
    }
    if (!ws.users.get(body.user_id)) throw notFound('User', body.user_id);
    assertActiveMember(ws, organizationId, body.user_id);
    return body.user_id;
  }

  app.get(ORGANIZATION_ACCOUNT_PATH, (c) => {
    const account = requireOrganizationAccount(resolveOrganizationTarget(c));
    return c.json(formatConnectedAccount(account));
  });

  // Both read the account after awaiting the body, so an overlapping request's write is seen.
  app.post(ORGANIZATION_ACCOUNT_PATH, async (c) => {
    const body = await parseJsonBody(c);
    const { organizationId, slug, account } = resolveOrganizationTarget(c);
    const userId = actingMember(body, organizationId);
    if (account) {
      throw new WorkOSApiError(
        409,
        `Connected account already exists for provider '${slug}' in organization '${organizationId}'`,
        'conflict',
      );
    }

    const dto = parseDto(body);
    const created = insertConnectedAccount(ws, {
      user_id: null,
      organization_id: organizationId,
      provider: slug,
      established_by_user_id: userId,
      ...importedFields(dto),
    });
    return c.json(formatConnectedAccount(created), 201);
  });

  app.put(ORGANIZATION_ACCOUNT_PATH, async (c) => {
    const body = await parseJsonBody(c);
    const target = resolveOrganizationTarget(c);
    actingMember(body, target.organizationId);
    const account = requireOrganizationAccount(target);

    const dto = parseDto(body);
    const updated = updateAccount(ws, account, dto);
    return c.json(formatConnectedAccount(updated));
  });

  app.delete(ORGANIZATION_ACCOUNT_PATH, (c) => {
    const account = requireOrganizationAccount(resolveOrganizationTarget(c));
    ws.connectedAccounts.delete(account.id);
    return c.body(null, 204);
  });
}
