import type { Context } from 'hono';
import {
  type RouteContext,
  type WorkOSAppEnv,
  notFound,
  validationError,
  parseJsonBody,
  WorkOSApiError,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatConnectedAccount, dataIntegrationIdFor } from '../helpers.js';
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

// All four verbs live on the one spec path; naming it once keeps the param typing exact.
const ACCOUNT_PATH = '/user_management/users/:user_id/connected_accounts/:slug';

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

export function connectedAccountRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  /**
   * The account a request addresses. The user in the path and the organization in the query
   * (when given) must both exist — the spec 404s on either before the account itself — and the
   * account is keyed by (user, slug, organization): a connection made without an organization
   * scope is a different account from one made with it, so the lookups never cross.
   */
  function resolveTarget(c: Context<WorkOSAppEnv, typeof ACCOUNT_PATH>): {
    userId: string;
    slug: string;
    organizationId: string | null;
    account: WorkOSConnectedAccount | undefined;
  } {
    const user = ws.users.get(c.req.param('user_id'));
    if (!user) throw notFound('User');

    const slug = c.req.param('slug');
    const organizationId = new URL(c.req.url).searchParams.get('organization_id');
    if (organizationId && !ws.organizations.get(organizationId)) throw notFound('Organization');

    const account = ws.connectedAccounts
      .findBy('user_id', user.id)
      .find((a) => a.provider === slug && a.organization_id === (organizationId ?? null));
    return { userId: user.id, slug, organizationId: organizationId ?? null, account };
  }

  app.get(ACCOUNT_PATH, (c) => {
    const { account } = resolveTarget(c);
    if (!account) throw notFound('Connected Account');
    return c.json(formatConnectedAccount(account));
  });

  app.post(ACCOUNT_PATH, async (c) => {
    const { userId, slug, organizationId, account } = resolveTarget(c);
    if (account) {
      throw new WorkOSApiError(
        409,
        `Connected account already exists for provider '${slug}'${organizationId ? ` in organization '${organizationId}'` : ''}`,
        'conflict',
      );
    }

    const dto = parseDto(await parseJsonBody(c));
    const state = deriveState(dto);

    const created = ws.connectedAccounts.insert({
      object: 'connected_account',
      user_id: userId,
      organization_id: organizationId,
      provider: slug,
      data_integration_id: dataIntegrationIdFor(ws, slug),
      scopes: dto.scopes ?? [],
      auth_method: 'oauth',
      api_key_last_4: null,
      state,
      access_token: dto.access_token ?? null,
      refresh_token: dto.refresh_token ?? null,
      token_expires_at: dto.expires_at ?? null,
    });
    return c.json(formatConnectedAccount(created), 201);
  });

  app.put(ACCOUNT_PATH, async (c) => {
    const { account } = resolveTarget(c);
    if (!account) throw notFound('Connected Account');

    const dto = parseDto(await parseJsonBody(c));
    // Without an explicit state, an update touching the credentials re-derives it from the
    // merged token set — the DTO alone cannot see a retained refresh token — while a
    // scopes-only update must not silently reconnect a needs_reauthorization account.
    const credentialsTouched =
      dto.access_token !== undefined || dto.refresh_token !== undefined || dto.expires_at !== undefined;
    const merged: ConnectedAccountDto = {
      access_token: dto.access_token ?? account.access_token ?? undefined,
      refresh_token: dto.refresh_token ?? account.refresh_token ?? undefined,
      // An expiry describes its access token: a replacement token sent without one is unexpired.
      expires_at:
        dto.expires_at ?? (dto.access_token === undefined ? (account.token_expires_at ?? undefined) : undefined),
    };
    const canDerive = merged.access_token !== undefined || merged.refresh_token !== undefined;
    const state = dto.state ?? (credentialsTouched && canDerive ? deriveState(merged) : account.state);

    const updated = ws.connectedAccounts.update(account.id, {
      ...(dto.scopes !== undefined ? { scopes: dto.scopes } : {}),
      ...(dto.access_token !== undefined ? { access_token: dto.access_token } : {}),
      ...(dto.refresh_token !== undefined ? { refresh_token: dto.refresh_token } : {}),
      ...(dto.expires_at !== undefined ? { token_expires_at: dto.expires_at } : {}),
      state,
    });
    return c.json(formatConnectedAccount(updated!));
  });

  app.delete(ACCOUNT_PATH, (c) => {
    const { account } = resolveTarget(c);
    if (!account) throw notFound('Connected Account');
    // Deleting is what "disconnects": the row (and the tokens the spec says are removed with
    // it) goes away, so a later import is a fresh 201 rather than a 409 against a dead link.
    // The pipes.connected_account.disconnected event is emitted by the collection hook.
    ws.connectedAccounts.delete(account.id);
    return c.body(null, 204);
  });
}
