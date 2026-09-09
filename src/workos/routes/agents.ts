import {
  type JWTPayload,
  type RouteContext,
  WorkOSApiError,
  generateUlid,
  notFound,
  parseJsonBody,
  parseListParams,
} from '../../core/index.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';
import type {
  WorkOSAgentBlueprint,
  WorkOSAgentBlueprintInvocableBy,
  WorkOSAgentBlueprintSessionSettings,
  WorkOSAgentInstance,
  WorkOSAgentInstanceSession,
  WorkOSOrganizationMembership,
} from '../entities.js';
import {
  formatAgentBlueprint,
  formatAgentInstance,
  formatAgentInstanceSession,
  formatListResponse,
} from '../helpers.js';
import {
  AGENT_SESSION_SETTING_LIMITS,
  AGENT_SUBJECT_PROFILE,
  DEFAULT_AGENT_SESSION_SETTINGS,
  MAX_AGENT_CHAIN_DEPTH,
  USER_SUBJECT_PROFILE,
  deleteAgentBlueprint,
  deleteAgentInstance,
  findChainRoot,
  intersectPermissions,
  isOrganizationInvocable,
  isRoleInvocable,
  isUserSessionLive,
  membershipPermissionSlugs,
  revokeAgentSessionTree,
} from '../agent-sessions.js';

type FieldError = { field: string; code: string; message?: string };

function invalidRequest(message: string, errors?: FieldError[]): WorkOSApiError {
  return new WorkOSApiError(400, message, 'invalid_request', errors);
}

/** Mint-time failures carry stable codes; production reports authorization ones as 403. */
function tokenError(status: 400 | 403, code: string, message: string): WorkOSApiError {
  return new WorkOSApiError(status, message, code);
}

const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isNonEmptyString);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Shape-check a blueprint body. The limits are shared; the two modes differ the way
 * production's create and update schemas do. Create fills omitted fields with defaults and
 * so takes no `null` description and only a complete `session_settings`; update lets
 * `description: null` clear the field and merges a partial `session_settings` into the
 * existing one. Reports all problems at once, the way a schema validator would, rather than
 * the first one hit.
 */
function validateBlueprintBody(
  body: Record<string, unknown>,
  mode: 'create' | 'update',
  errors: FieldError[],
): {
  name?: string;
  description?: string | null;
  permissions?: string[];
  invocable_by?: Partial<WorkOSAgentBlueprintInvocableBy>;
  session_settings?: Partial<WorkOSAgentBlueprintSessionSettings>;
} {
  const out: ReturnType<typeof validateBlueprintBody> = {};

  if (body.name !== undefined) {
    if (!isNonEmptyString(body.name) || body.name.length > 255) {
      errors.push({ field: 'name', code: 'invalid', message: 'name must be a string of 1 to 255 characters' });
    } else {
      out.name = body.name;
    }
  }

  if (body.description !== undefined) {
    if (body.description === null && mode === 'update') {
      out.description = null;
    } else if (!isNonEmptyString(body.description) || body.description.length > 1000) {
      errors.push({
        field: 'description',
        code: 'invalid',
        message:
          mode === 'update'
            ? 'description must be a string of 1 to 1000 characters, or null'
            : 'description must be a string of 1 to 1000 characters',
      });
    } else {
      out.description = body.description;
    }
  }

  if (body.permissions !== undefined) {
    if (!isStringList(body.permissions) || body.permissions.length > 1000) {
      errors.push({
        field: 'permissions',
        code: 'invalid',
        message: 'permissions must be an array of at most 1000 permission slugs',
      });
    } else {
      out.permissions = [...new Set(body.permissions)];
    }
  }

  if (body.invocable_by !== undefined) {
    if (!isRecord(body.invocable_by)) {
      errors.push({ field: 'invocable_by', code: 'invalid', message: 'invocable_by must be an object' });
    } else {
      const invocable: Partial<WorkOSAgentBlueprintInvocableBy> = {};
      const lists = [
        ['role_slugs', 100],
        ['organization_ids', 1000],
      ] as const;
      for (const [key, max] of lists) {
        const value = body.invocable_by[key];
        if (value === undefined) continue;
        if (!isStringList(value) || value.length > max) {
          errors.push({
            field: `invocable_by.${key}`,
            code: 'invalid',
            message: `invocable_by.${key} must be an array of at most ${max} strings`,
          });
        } else {
          invocable[key] = [...new Set(value)];
        }
      }
      out.invocable_by = invocable;
    }
  }

  if (body.session_settings !== undefined) {
    if (!isRecord(body.session_settings)) {
      errors.push({ field: 'session_settings', code: 'invalid', message: 'session_settings must be an object' });
    } else {
      const settings: Partial<WorkOSAgentBlueprintSessionSettings> = {};
      for (const key of Object.keys(AGENT_SESSION_SETTING_LIMITS) as (keyof typeof AGENT_SESSION_SETTING_LIMITS)[]) {
        const value = body.session_settings[key];
        if (value === undefined) {
          if (mode === 'create') {
            errors.push({
              field: `session_settings.${key}`,
              code: 'required',
              message: `session_settings.${key} is required when session_settings is provided`,
            });
          }
          continue;
        }
        const max = AGENT_SESSION_SETTING_LIMITS[key];
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) {
          errors.push({
            field: `session_settings.${key}`,
            code: 'invalid',
            message: `session_settings.${key} must be a positive integer of at most ${max}`,
          });
        } else {
          settings[key] = value;
        }
      }
      out.session_settings = settings;
    }
  }

  return out;
}

/**
 * Every slug and id a blueprint names must exist, checked with production's 422 codes so a
 * seed typo surfaces at create time instead of as an inexplicably empty permission set at
 * mint time. Role slugs resolve against any role (environment or organization) with that
 * slug, since `invocable_by.role_slugs` is matched by slug when a member mints.
 */
function assertBlueprintReferences(
  ws: WorkOSStore,
  refs: { permissions?: string[]; role_slugs?: string[]; organization_ids?: string[] },
): void {
  for (const slug of refs.permissions ?? []) {
    if (ws.permissions.findBy('slug', slug).length === 0) {
      throw new WorkOSApiError(422, `Permission not found: ${slug}`, 'permission_not_found');
    }
  }
  for (const slug of refs.role_slugs ?? []) {
    if (ws.roles.findBy('slug', slug).length === 0) {
      throw new WorkOSApiError(422, `Role not found: ${slug}`, 'role_not_found');
    }
  }
  for (const id of refs.organization_ids ?? []) {
    if (!ws.organizations.get(id)) {
      throw new WorkOSApiError(422, `Organization not found: ${id}`, 'organization_not_found');
    }
  }
}

function assertNameAvailable(ws: WorkOSStore, name: string, exceptId?: string): void {
  if (ws.agentBlueprints.findBy('name', name).some((b) => b.id !== exceptId)) {
    throw new WorkOSApiError(409, `An agent blueprint named "${name}" already exists.`, 'name_already_in_use');
  }
}

function requireBlueprint(ws: WorkOSStore, id: string): WorkOSAgentBlueprint {
  const blueprint = ws.agentBlueprints.get(id);
  if (!blueprint) throw notFound('Agent blueprint');
  return blueprint;
}

function optionalIntent(body: Record<string, unknown>): string | undefined {
  if (body.intent === undefined) return undefined;
  if (!isNonEmptyString(body.intent) || body.intent.length > 255) {
    throw invalidRequest('intent must be a string of 1 to 255 characters', [
      { field: 'intent', code: 'invalid', message: 'intent must be a string of 1 to 255 characters' },
    ]);
  }
  return body.intent;
}

function requireBodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (!isNonEmptyString(value)) {
    throw invalidRequest(`${field} is required`, [{ field, code: 'required', message: `${field} is required` }]);
  }
  return value;
}

/** Instances are keyed by what they act as, so a repeat mint reuses the row and reports `new_instance: false`. */
function resolveInstance(
  ws: WorkOSStore,
  blueprint: WorkOSAgentBlueprint,
  organizationId: string,
  membership: WorkOSOrganizationMembership | null,
): { instance: WorkOSAgentInstance; created: boolean } {
  const existing = ws.agentInstances
    .findBy('agent_blueprint_id', blueprint.id)
    .find(
      (i) =>
        i.organization_id === organizationId &&
        i.organization_membership_id === (membership?.id ?? null) &&
        i.type === (membership ? 'delegated' : 'autonomous'),
    );
  if (existing) return { instance: existing, created: false };
  const instance = ws.agentInstances.insert({
    object: 'agent_instance',
    agent_blueprint_id: blueprint.id,
    organization_id: organizationId,
    organization_membership_id: membership?.id ?? null,
    type: membership ? 'delegated' : 'autonomous',
  });
  return { instance, created: true };
}

interface SessionAuthority {
  permissions: string[];
  act: { sub: string; sub_profile: string } | undefined;
}

/**
 * What an instance may do is derived from what it is, at every mint and refresh: an
 * autonomous instance holds the whole blueprint ceiling; a delegated one holds the ceiling
 * narrowed to its member's current role, and names the member in `act`. Authority the
 * member lost since the last mint does not survive into the next token.
 */
function resolveSessionAuthority(
  ws: WorkOSStore,
  blueprint: WorkOSAgentBlueprint,
  instance: WorkOSAgentInstance,
): SessionAuthority {
  if (instance.organization_membership_id === null) {
    return { permissions: [...blueprint.permissions], act: undefined };
  }
  const membership = ws.organizationMemberships.get(instance.organization_membership_id);
  if (!membership || membership.status !== 'active') {
    throw tokenError(403, 'user_not_member_of_organization', 'The user is not a member of the organization.');
  }
  if (!isRoleInvocable(blueprint, membership.role.slug)) {
    throw tokenError(
      403,
      'role_not_invocable',
      'The user does not hold a role allowed to invoke this agent blueprint.',
    );
  }
  const granted = membershipPermissionSlugs(ws, membership.organization_id, membership.role.slug);
  return {
    permissions: intersectPermissions(blueprint, granted),
    act: { sub: membership.user_id, sub_profile: USER_SUBJECT_PROFILE },
  };
}

function assertOrganizationInvocable(ws: WorkOSStore, blueprint: WorkOSAgentBlueprint, organizationId: string): void {
  if (!ws.organizations.get(organizationId)) throw notFound('Organization');
  if (!isOrganizationInvocable(blueprint, organizationId)) {
    throw tokenError(
      403,
      'organization_not_invocable',
      'The organization is not allowed to invoke this agent blueprint.',
    );
  }
}

/** `auth_time` for a delegated chain: the backing user session's sign-in, so refreshes keep the original value. */
function userSessionAuthTime(ws: WorkOSStore, userSessionId: string): number {
  const session = ws.sessions.get(userSessionId);
  if (!isUserSessionLive(session)) {
    throw tokenError(400, 'user_session_ended', 'The delegating user session has ended.');
  }
  return Math.floor(new Date(session.created_at).getTime() / 1000);
}

export function agentRoutes(ctx: RouteContext): void {
  const { app, store, jwt } = ctx;
  const ws = getWorkOSStore(store);

  // Production mints `aud: environment.clientId`. Nothing at the API-key-authenticated
  // token endpoint names a client, so the same placeholder the other unbound tokens use.
  const audience = 'workos-emulate';

  interface MintInput {
    instance: WorkOSAgentInstance;
    /** Session to mint the access token for; when refreshing, the row after rotation. */
    session: WorkOSAgentInstanceSession;
    authority: SessionAuthority;
    intent: string | undefined;
    authTime: number | undefined;
    accessTokenTtlSeconds: number;
    newInstance: boolean;
  }

  function mintResponse(input: MintInput): Record<string, unknown> {
    const { instance, session, authority, intent, authTime, accessTokenTtlSeconds } = input;
    const accessToken = jwt.sign(
      {
        sub: instance.id,
        sub_profile: AGENT_SUBJECT_PROFILE,
        sid: session.id,
        jti: generateUlid(),
        org_id: instance.organization_id,
        permissions: authority.permissions,
        intent: intent !== undefined ? { text: intent } : undefined,
        act: authority.act,
        auth_time: authTime,
        aud: audience,
      },
      { expiresIn: accessTokenTtlSeconds, typ: 'at+jwt' },
    );
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: accessTokenTtlSeconds,
      refresh_token: session.refresh_token,
      agent_instance_id: instance.id,
      new_instance: input.newInstance,
      agent_instance_session_id: session.id,
      permissions: authority.permissions,
    };
  }

  function createSession(
    instance: WorkOSAgentInstance,
    settings: WorkOSAgentBlueprintSessionSettings,
    authority: SessionAuthority,
    intent: string | undefined,
    provenance: { parentSessionId?: string; userSessionId?: string; notAfterMs?: number },
  ): WorkOSAgentInstanceSession {
    const expiresAtMs = Math.min(
      Date.now() + settings.refresh_token_ttl_seconds * 1000,
      ...(provenance.notAfterMs !== undefined ? [provenance.notAfterMs] : []),
    );
    return ws.agentInstanceSessions.insert({
      object: 'agent_instance_session',
      agent_instance_id: instance.id,
      expires_at: new Date(expiresAtMs).toISOString(),
      revoked_at: null,
      refresh_token: generateUlid(),
      parent_session_id: provenance.parentSessionId ?? null,
      user_session_id: provenance.userSessionId ?? null,
      permissions: authority.permissions,
      intent: intent ?? null,
    });
  }

  /** An access token never advertises validity past its session's own expiry. */
  const capAccessTokenTtl = (settings: WorkOSAgentBlueprintSessionSettings, session: WorkOSAgentInstanceSession) =>
    Math.min(
      settings.access_token_ttl_seconds,
      settings.refresh_token_ttl_seconds,
      Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000),
    );

  /**
   * Decode an agent access token to its live session. Signature, expiry, the `ai_agent`
   * profile, and the session's existence all fail the same way so a caller learns nothing
   * about sessions it does not hold a token for.
   */
  function resolveAgentToken(token: string): {
    payload: JWTPayload;
    session: WorkOSAgentInstanceSession;
    instance: WorkOSAgentInstance;
  } {
    const invalid = tokenError(400, 'invalid_agent_access_token', 'The provided agent access token is invalid.');
    let payload: JWTPayload;
    try {
      payload = jwt.verify(token);
    } catch {
      throw invalid;
    }
    if (payload.sub_profile !== AGENT_SUBJECT_PROFILE || typeof payload.sid !== 'string') throw invalid;
    const session = ws.agentInstanceSessions.get(payload.sid);
    if (!session || session.agent_instance_id !== payload.sub) throw invalid;
    const instance = ws.agentInstances.get(session.agent_instance_id);
    if (!instance) throw invalid;
    return { payload, session, instance };
  }

  function assertSessionLive(session: WorkOSAgentInstanceSession): void {
    if (session.revoked_at !== null) {
      throw tokenError(400, 'session_revoked', 'The session backing this token has been revoked.');
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      throw tokenError(400, 'session_expired', 'The session backing this token has expired.');
    }
  }

  // ---- Blueprints ----

  app.post('/agents/blueprints', async (c) => {
    const body = await parseJsonBody(c);
    const errors: FieldError[] = [];
    if (body.name === undefined) errors.push({ field: 'name', code: 'required', message: 'name is required' });
    const parsed = validateBlueprintBody(body, 'create', errors);
    if (errors.length > 0 || parsed.name === undefined) throw invalidRequest('Invalid request body', errors);

    const permissions = parsed.permissions ?? [];
    const invocable_by: WorkOSAgentBlueprintInvocableBy = {
      role_slugs: parsed.invocable_by?.role_slugs ?? [],
      organization_ids: parsed.invocable_by?.organization_ids ?? [],
    };
    assertBlueprintReferences(ws, { permissions, ...invocable_by });
    assertNameAvailable(ws, parsed.name);

    const blueprint = ws.agentBlueprints.insert({
      object: 'agent_blueprint',
      name: parsed.name,
      description: parsed.description ?? null,
      permissions,
      invocable_by,
      session_settings: { ...DEFAULT_AGENT_SESSION_SETTINGS, ...parsed.session_settings },
    });
    return c.json(formatAgentBlueprint(blueprint), 201);
  });

  app.get('/agents/blueprints', (c) => {
    const params = parseListParams(new URL(c.req.url));
    return c.json(formatListResponse(ws.agentBlueprints.list(params), formatAgentBlueprint));
  });

  app.get('/agents/blueprints/:id', (c) => c.json(formatAgentBlueprint(requireBlueprint(ws, c.req.param('id')))));

  app.patch('/agents/blueprints/:id', async (c) => {
    const blueprint = requireBlueprint(ws, c.req.param('id'));
    const body = await parseJsonBody(c);
    const errors: FieldError[] = [];
    const parsed = validateBlueprintBody(body, 'update', errors);
    if (errors.length > 0) throw invalidRequest('Invalid request body', errors);

    const invocable_by: WorkOSAgentBlueprintInvocableBy = {
      role_slugs: parsed.invocable_by?.role_slugs ?? blueprint.invocable_by.role_slugs,
      organization_ids: parsed.invocable_by?.organization_ids ?? blueprint.invocable_by.organization_ids,
    };
    assertBlueprintReferences(ws, {
      permissions: parsed.permissions,
      role_slugs: parsed.invocable_by?.role_slugs,
      organization_ids: parsed.invocable_by?.organization_ids,
    });
    if (parsed.name !== undefined) assertNameAvailable(ws, parsed.name, blueprint.id);

    const updated = ws.agentBlueprints.update(blueprint.id, {
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.description !== undefined ? { description: parsed.description } : {}),
      ...(parsed.permissions !== undefined ? { permissions: parsed.permissions } : {}),
      invocable_by,
      session_settings: { ...blueprint.session_settings, ...parsed.session_settings },
    })!;
    return c.json(formatAgentBlueprint(updated));
  });

  app.delete('/agents/blueprints/:id', (c) => {
    deleteAgentBlueprint(ws, requireBlueprint(ws, c.req.param('id')));
    return c.body(null, 204);
  });

  // ---- Tokens ----

  app.post('/agents/blueprints/:id/tokens', async (c) => {
    const blueprint = requireBlueprint(ws, c.req.param('id'));
    const body = await parseJsonBody(c);
    const intent = optionalIntent(body);
    const settings = blueprint.session_settings;

    switch (body.type) {
      case 'user_delegated': {
        const userAccessToken = requireBodyString(body, 'user_access_token');
        const invalid = tokenError(400, 'invalid_user_access_token', 'The provided user access token is invalid.');
        let payload: JWTPayload;
        try {
          payload = jwt.verify(userAccessToken);
        } catch {
          throw invalid;
        }
        // The presented token authenticates the user and names the organization; nothing
        // else on it is trusted. Authority comes from the live session and membership below.
        // User tokens carry `sub_profile: 'user'` or omit it; any other family is rejected.
        if (
          (payload.sub_profile !== undefined && payload.sub_profile !== USER_SUBJECT_PROFILE) ||
          typeof payload.sub !== 'string' ||
          typeof payload.org_id !== 'string' ||
          typeof payload.sid !== 'string' ||
          !ws.users.get(payload.sub)
        ) {
          throw invalid;
        }
        const userSession = ws.sessions.get(payload.sid);
        if (!userSession || userSession.user_id !== payload.sub) throw invalid;
        if (!isUserSessionLive(userSession)) {
          throw tokenError(400, 'user_session_ended', 'The delegating user session has ended.');
        }
        const organizationId = payload.org_id;
        if (!ws.organizations.get(organizationId)) throw notFound('Organization');

        // Membership before invocability, so a non-member cannot probe which organizations
        // a blueprint is invocable from.
        const membership = ws.organizationMemberships
          .findBy('organization_id', organizationId)
          .find((m) => m.user_id === payload.sub && m.status === 'active');
        if (!membership) {
          throw tokenError(403, 'user_not_member_of_organization', 'The user is not a member of the organization.');
        }
        assertOrganizationInvocable(ws, blueprint, organizationId);

        // max_age gates the mint only: a login older than the blueprint allows may not start
        // a delegated session. Once minted, the session lives by its own TTLs.
        const authTime = Math.floor(new Date(userSession.created_at).getTime() / 1000);
        if (Date.now() >= (authTime + settings.max_age_seconds) * 1000) {
          throw tokenError(
            400,
            'max_age_exceeded',
            "The delegating credential's authentication is older than the blueprint allows.",
          );
        }

        const { instance, created } = resolveInstance(ws, blueprint, organizationId, membership);
        const authority = resolveSessionAuthority(ws, blueprint, instance);
        const session = createSession(instance, settings, authority, intent, { userSessionId: userSession.id });
        return c.json(
          mintResponse({
            instance,
            session,
            authority,
            intent,
            authTime,
            accessTokenTtlSeconds: capAccessTokenTtl(settings, session),
            newInstance: created,
          }),
        );
      }

      case 'autonomous': {
        const organizationId = requireBodyString(body, 'organization_id');
        assertOrganizationInvocable(ws, blueprint, organizationId);
        const { instance, created } = resolveInstance(ws, blueprint, organizationId, null);
        const authority = resolveSessionAuthority(ws, blueprint, instance);
        const session = createSession(instance, settings, authority, intent, {});
        return c.json(
          mintResponse({
            instance,
            session,
            authority,
            intent,
            authTime: undefined,
            accessTokenTtlSeconds: capAccessTokenTtl(settings, session),
            newInstance: created,
          }),
        );
      }

      case 'agent_delegated': {
        const agentAccessToken = requireBodyString(body, 'agent_access_token');
        const invalid = tokenError(400, 'invalid_agent_access_token', 'The provided agent access token is invalid.');
        const { session: presenting, instance } = resolveAgentToken(agentAccessToken);
        // Self-chaining only: an agent cannot delegate to another blueprint or instance.
        if (instance.agent_blueprint_id !== blueprint.id) throw invalid;
        if (presenting.revoked_at !== null || new Date(presenting.expires_at).getTime() <= Date.now()) throw invalid;
        assertOrganizationInvocable(ws, blueprint, instance.organization_id);

        // Chains are anchored at their root: no hop may outlive root.created_at + max_age,
        // however many chains or refreshes happen in between.
        const { root, depth, ancestorRevoked } = findChainRoot(ws, presenting);
        if (ancestorRevoked) throw invalid;
        if (depth + 1 > MAX_AGENT_CHAIN_DEPTH) {
          throw tokenError(400, 'chain_depth_exceeded', 'The agent delegation chain is too deep.');
        }
        const windowEndsAtMs = new Date(root.created_at).getTime() + settings.max_age_seconds * 1000;
        if (windowEndsAtMs - Date.now() < 1000) {
          throw tokenError(
            400,
            'max_age_exceeded',
            "The delegating credential's authentication is older than the blueprint allows.",
          );
        }
        const authTime = root.user_session_id !== null ? userSessionAuthTime(ws, root.user_session_id) : undefined;
        const authority = resolveSessionAuthority(ws, blueprint, instance);
        const session = createSession(instance, settings, authority, intent, {
          parentSessionId: presenting.id,
          notAfterMs: windowEndsAtMs,
        });
        return c.json(
          mintResponse({
            instance,
            session,
            authority,
            intent,
            authTime,
            accessTokenTtlSeconds: capAccessTokenTtl(settings, session),
            newInstance: false,
          }),
        );
      }

      case 'refresh': {
        const refreshToken = requireBodyString(body, 'refresh_token');
        const session = ws.agentInstanceSessions.findBy('refresh_token', refreshToken)[0];
        const instance = session ? ws.agentInstances.get(session.agent_instance_id) : undefined;
        if (!session || !instance || instance.agent_blueprint_id !== blueprint.id) {
          throw tokenError(400, 'invalid_refresh_token', 'The provided refresh token is invalid.');
        }
        assertSessionLive(session);
        const { root, ancestorRevoked } = findChainRoot(ws, session);
        if (ancestorRevoked) {
          throw tokenError(400, 'session_revoked', 'The session backing this token has been revoked.');
        }
        const authTime = root.user_session_id !== null ? userSessionAuthTime(ws, root.user_session_id) : undefined;
        assertOrganizationInvocable(ws, blueprint, instance.organization_id);
        const authority = resolveSessionAuthority(ws, blueprint, instance);

        // A refresh never extends a session past its chain root's max_age window.
        const now = Date.now();
        const rotatedExpiresAtMs = Math.min(
          now + settings.refresh_token_ttl_seconds * 1000,
          new Date(root.created_at).getTime() + settings.max_age_seconds * 1000,
        );
        if (rotatedExpiresAtMs - now < 1000) {
          throw tokenError(400, 'session_expired', 'The session backing this token has expired.');
        }
        // Rotation is what makes the presented token single-use: the row's refresh_token
        // is replaced, so a replay no longer resolves to any session.
        const rotated = ws.agentInstanceSessions.updateSilent(session.id, {
          refresh_token: generateUlid(),
          expires_at: new Date(rotatedExpiresAtMs).toISOString(),
          permissions: authority.permissions,
          intent: intent ?? session.intent,
        })!;
        return c.json(
          mintResponse({
            instance,
            session: rotated,
            authority,
            intent: intent ?? rotated.intent ?? undefined,
            authTime,
            accessTokenTtlSeconds: capAccessTokenTtl(settings, rotated),
            newInstance: false,
          }),
        );
      }

      default:
        throw invalidRequest('type must be one of user_delegated, autonomous, agent_delegated, refresh', [
          { field: 'type', code: 'invalid' },
        ]);
    }
  });

  app.post('/agents/blueprints/:id/tokens/validate', async (c) => {
    const blueprint = requireBlueprint(ws, c.req.param('id'));
    const body = await parseJsonBody(c);
    const token = requireBodyString(body, 'agent_access_token');
    const { payload, session, instance } = resolveAgentToken(token);
    if (instance.agent_blueprint_id !== blueprint.id) {
      throw tokenError(400, 'invalid_agent_access_token', 'The provided agent access token is invalid.');
    }
    assertSessionLive(session);
    const { root, ancestorRevoked } = findChainRoot(ws, session);
    if (ancestorRevoked) {
      throw tokenError(400, 'session_revoked', 'The session backing this token has been revoked.');
    }
    if (root.user_session_id !== null && !isUserSessionLive(ws.sessions.get(root.user_session_id))) {
      throw tokenError(400, 'user_session_ended', 'The delegating user session has ended.');
    }
    const intent = payload.intent;
    return c.json({
      valid: true,
      agent_instance_id: instance.id,
      agent_instance_session_id: session.id,
      organization_id: instance.organization_id,
      permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
      intent: intent && typeof intent.text === 'string' ? intent.text : null,
      acting_user_id: payload.act?.sub ?? null,
      session_expires_at: session.expires_at,
    });
  });

  // ---- Instances ----

  app.get('/agents/instances', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const organizationId = url.searchParams.get('organization_id');
    const blueprintId = url.searchParams.get('agent_blueprint_id');
    const filter = (i: WorkOSAgentInstance) =>
      (!organizationId || i.organization_id === organizationId) &&
      (!blueprintId || i.agent_blueprint_id === blueprintId);
    return c.json(formatListResponse(ws.agentInstances.list({ ...params, filter }), formatAgentInstance));
  });

  app.get('/agents/instances/:id', (c) => {
    const instance = ws.agentInstances.get(c.req.param('id'));
    if (!instance) throw notFound('Agent instance');
    return c.json(formatAgentInstance(instance));
  });

  app.delete('/agents/instances/:id', (c) => {
    const instance = ws.agentInstances.get(c.req.param('id'));
    if (!instance) throw notFound('Agent instance');
    deleteAgentInstance(ws, instance);
    return c.body(null, 204);
  });

  // ---- Sessions ----

  app.get('/agents/sessions', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const instanceId = url.searchParams.get('agent_instance_id');
    const blueprintId = url.searchParams.get('agent_blueprint_id');
    const filter = (s: WorkOSAgentInstanceSession) =>
      (!instanceId || s.agent_instance_id === instanceId) &&
      (!blueprintId || ws.agentInstances.get(s.agent_instance_id)?.agent_blueprint_id === blueprintId);
    return c.json(formatListResponse(ws.agentInstanceSessions.list({ ...params, filter }), formatAgentInstanceSession));
  });

  app.get('/agents/sessions/:id', (c) => {
    const session = ws.agentInstanceSessions.get(c.req.param('id'));
    if (!session) throw notFound('Agent instance session');
    return c.json(formatAgentInstanceSession(session));
  });

  // Revocation cascades to every session chained from this one and is idempotent: an
  // already-revoked session answers 200 with its existing revoked_at, and an already-expired
  // one stays `expired` with a null revoked_at.
  app.post('/agents/sessions/:id/revoke', (c) => {
    const session = ws.agentInstanceSessions.get(c.req.param('id'));
    if (!session) throw notFound('Agent instance session');
    revokeAgentSessionTree(ws, session.id);
    return c.json(formatAgentInstanceSession(ws.agentInstanceSessions.get(session.id)!));
  });
}
