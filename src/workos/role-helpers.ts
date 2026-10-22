import type { Context } from 'hono';
import {
  type RouteContext,
  type Store,
  ID_PREFIXES,
  WorkOSApiError,
  generateId,
  notFound,
  parseJsonBody,
} from '../core/index.js';
import type { WorkOSStore } from './store.js';
import type { WorkOSRole, WorkOSPermission } from './entities.js';
import type { EventBus } from './event-bus.js';
import { getWorkOSStore } from './store.js';
import { DEFAULT_RESOURCE_TYPE_SLUG, EVENTS, STORE_KEYS } from './constants.js';
import { formatRole, formatPermission } from './helpers.js';
import { membershipRoleSlugs } from './membership-roles.js';
import {
  type BodyRules,
  ROLE_PERMISSION_ADD_RULES,
  ROLE_PERMISSIONS_SET_RULES,
  ROLE_UPDATE_RULES,
  validateBody,
} from './authorization-validation.js';

export function findEnvRole(ws: WorkOSStore, slug: string): WorkOSRole | undefined {
  // An environment role is unowned by definition; seeded roles can carry an
  // organization_id while their type defaulted to EnvironmentRole, and those
  // must never resolve as environment roles for another organization.
  return ws.roles.findBy('slug', slug).find((r) => r.type === 'EnvironmentRole' && r.organization_id === null);
}

export function findOrgRole(ws: WorkOSStore, orgId: string, slug: string): WorkOSRole | undefined {
  return ws.roles.findBy('organization_id', orgId).find((r) => r.slug === slug && r.type === 'OrganizationRole');
}

/**
 * Resolve the role a membership's role slug refers to within an organization.
 * An organization role shadows an environment role with the same slug. Matches
 * on organization_id rather than type: seeded roles can carry an organization_id
 * with the type defaulted to EnvironmentRole — which is also why the environment
 * fallback requires a null organization_id, so another organization's seeded
 * role can never leak across the boundary.
 */
export function resolvePrimaryRole(ws: WorkOSStore, organizationId: string, slug: string): WorkOSRole | undefined {
  const candidates = ws.roles.findBy('slug', slug);
  return (
    candidates.find((r) => r.organization_id === organizationId) ??
    candidates.find((r) => r.type === 'EnvironmentRole' && r.organization_id === null)
  );
}

/**
 * The roles that apply to an organization, the way production lists them: every environment
 * role plus the organization's own, an organization role shadowing an environment role with
 * the same slug, in priority order. Equal priorities keep environment roles ahead of the
 * organization's, each in insertion order, since Array.prototype.sort is stable. The
 * organization's roles are matched on organization_id, as resolvePrimaryRole does: a seeded
 * role can carry an organization_id with its type defaulted to EnvironmentRole, and it is
 * still that organization's override.
 */
export function rolesApplyingTo(ws: WorkOSStore, organizationId: string): WorkOSRole[] {
  const own = ws.roles.findBy('organization_id', organizationId);
  const shadowed = new Set(own.map((r) => r.slug));
  const environment = environmentRoles(ws).filter((r) => !shadowed.has(r.slug));
  return [...environment, ...own].sort((a, b) => a.priority - b.priority);
}

/** Every environment role, in priority order: what `GET /authorization/roles` lists. */
export function environmentRoles(ws: WorkOSStore): WorkOSRole[] {
  return ws.roles
    .all()
    .filter((r) => r.type === 'EnvironmentRole' && r.organization_id === null)
    .sort((a, b) => a.priority - b.priority);
}

export function requireEnvRole(ws: WorkOSStore, slug: string): WorkOSRole {
  const role = findEnvRole(ws, slug);
  if (!role) throw notFound('Role', slug);
  return role;
}

export function requireOrgRole(ws: WorkOSStore, orgId: string, slug: string): WorkOSRole {
  const role = findOrgRole(ws, orgId, slug);
  if (!role) throw notFound('Organization Role', slug);
  return role;
}

export function getRolePermissions(ws: WorkOSStore, roleId: string): WorkOSPermission[] {
  const rps = ws.rolePermissions.findBy('role_id', roleId);
  return rps.map((rp) => ws.permissions.get(rp.permission_id)).filter(Boolean) as WorkOSPermission[];
}

/**
 * The permission slugs a membership's roles grant together: each slug resolves the way the
 * authorization endpoints resolve it (an organization role shadows an environment role) and
 * the union is deduplicated in role order. Undefined when no slug names a defined role, so a
 * token's `permissions` claim is omitted rather than minted empty.
 */
export function permissionsForRoles(
  ws: WorkOSStore,
  organizationId: string,
  slugs: readonly string[],
): string[] | undefined {
  const roles = slugs
    .map((slug) => resolvePrimaryRole(ws, organizationId, slug))
    .filter((role): role is WorkOSRole => role !== undefined);
  if (roles.length === 0) return undefined;
  return [...new Set(roles.flatMap((role) => getRolePermissions(ws, role.id).map((p) => p.slug)))];
}

/**
 * The permission a role-permissions body names. Production resolves the slug before it
 * touches the role and answers an unknown one with 422 `invalid_permission_slug` (the
 * role-permissions controllers map PermissionSlugNotFoundException onto it), not 404.
 */
export function requirePermissionBySlug(ws: WorkOSStore, slug: string): WorkOSPermission {
  const permission = ws.permissions.findOneBy('slug', slug);
  if (!permission) {
    throw new WorkOSApiError(422, `Permission not found: '${slug}'.`, 'invalid_permission_slug');
  }
  return permission;
}

/**
 * Replace a role's permission set. Every slug is resolved before the join
 * table is touched, so an unknown slug answers 422 and leaves the current set
 * intact rather than half-applied. Returns whether the set actually changed,
 * which is what decides whether a role.updated event is due, as in production.
 */
export function replaceRolePermissions(ws: WorkOSStore, roleId: string, permissionSlugs: string[]): boolean {
  const next = new Map<string, WorkOSPermission>();
  for (const permSlug of permissionSlugs) {
    const perm = requirePermissionBySlug(ws, permSlug);
    next.set(perm.id, perm);
  }

  const current = new Set(ws.rolePermissions.findBy('role_id', roleId).map((rp) => rp.permission_id));
  const changed = current.size !== next.size || [...next.keys()].some((id) => !current.has(id));
  if (!changed) return false;

  ws.rolePermissions.deleteBy('role_id', roleId);
  for (const perm of next.values()) {
    ws.rolePermissions.insert({ role_id: roleId, permission_id: perm.id });
  }
  return true;
}

/**
 * Production emits `role.updated` (or `organization_role.updated`) when a
 * role's permission set changes through the permissions endpoints without
 * touching the role row, so this goes to the bus directly rather than through
 * the collection hooks.
 */
export function emitRolePermissionsUpdated(store: Store, ws: WorkOSStore, role: WorkOSRole): void {
  store.getData<EventBus>(STORE_KEYS.eventBus)?.emit({
    event: role.type === 'OrganizationRole' ? EVENTS.organizationRoleUpdated : EVENTS.roleUpdated,
    data: formatRole(role, ws),
  });
}

/**
 * Whether any membership still holds the role, which is what production's
 * `userRolesService.findAllByRoleId` answers before an organization role may be deleted:
 * a membership's organization-level roles (held by slug, which resolves to this role
 * because an organization role shadows an environment role), its resource-scoped
 * assignments, and the ones a native group's grant derives for each of the group's members.
 * The emulator materializes those derived assignments when they are read rather than
 * storing them, so a group grant counts while its group still has a live member: a deleted
 * membership leaves its group link behind, and a link to nothing derives nothing.
 */
export function roleHasAssignments(ws: WorkOSStore, role: WorkOSRole): boolean {
  if (ws.roleAssignments.findBy('role_id', role.id).length > 0) return true;
  const heldThroughGroup = ws.groupRoleAssignments
    .findBy('role_id', role.id)
    .some(
      (grant) =>
        ws.groups.get(grant.group_id) &&
        ws.groupMemberships
          .findBy('group_id', grant.group_id)
          .some((link) => ws.organizationMemberships.get(link.organization_membership_id) !== undefined),
    );
  if (heldThroughGroup) return true;
  if (role.organization_id === null) return false;
  return ws.organizationMemberships
    .findBy('organization_id', role.organization_id)
    .some((m) => membershipRoleSlugs(ws, m).includes(role.slug));
}

/**
 * The priority a newly created role takes: production appends it to the end of the
 * priority order, so it sorts after every role that already exists.
 */
export function nextRolePriority(ws: WorkOSStore): number {
  return ws.roles.all().reduce((max, r) => Math.max(max, r.priority), -1) + 1;
}

const SLUG_SUFFIX_LENGTH = 6;
const MAX_GENERATED_SLUG_LENGTH = 48;
const MAX_NAME_SLUG_LENGTH = MAX_GENERATED_SLUG_LENGTH - SLUG_SUFFIX_LENGTH - 1;

/**
 * The slug production generates for an organization role created without one
 * (api-services/src/roles/slug-generation.ts): the name slugified, cut to fit, and the last
 * six characters of the role's ULID appended in lowercase. It does not carry the `org-`
 * prefix an explicit slug must.
 */
export function generateRoleSlug(name: string, roleId: string): string {
  const nameSlug = name
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, MAX_NAME_SLUG_LENGTH)
    .replace(/[-_]+$/, '');
  const suffix = roleId.slice(-SLUG_SUFFIX_LENGTH).toLowerCase();
  return nameSlug ? `${nameSlug}-${suffix}` : suffix;
}

export interface RoleRouteConfig {
  pathPrefix: string;
  roleType: 'EnvironmentRole' | 'OrganizationRole';
  /** Resolves the role a write names: an organization route only ever writes its own roles. */
  requireRole: (ws: WorkOSStore, c: Context) => WorkOSRole;
  /**
   * Resolves the role a GET names. Defaults to requireRole; production's organization GET
   * also answers the environment roles that apply to the organization.
   */
  readRole?: (ws: WorkOSStore, c: Context) => WorkOSRole;
  findRole: (ws: WorkOSStore, c: Context, slug: string) => WorkOSRole | undefined;
  /** The body rules production's create DTO enforces for this role type. */
  createRules: BodyRules;
  /** The slug a validated create body gives the role; `roleId` is the id the role will take. */
  slugFor: (body: Record<string, unknown>, roleId: string) => string;
  /** The whole list the GET answers with: the spec's RoleList is unpaged and in priority order. */
  listRoles: (ws: WorkOSStore, c: Context) => WorkOSRole[];
  insertDefaults: (c: Context) => Partial<WorkOSRole>;
  duplicateMessage: string;
  /** Spec error code for a taken slug: `role_slug_conflict` or `organization_role_slug_conflict`. */
  duplicateCode: string;
  validateBeforeCreate?: (ws: WorkOSStore, c: Context) => void;
}

export function registerRoleRoutes(ctx: RouteContext, config: RoleRouteConfig): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);
  const { pathPrefix } = config;

  app.post(pathPrefix, async (c) => {
    // The validation pipe runs before the organization is resolved, so a malformed body
    // is a 422 even for an unknown organization.
    const body = await parseJsonBody(c);
    validateBody(body, config.createRules);
    config.validateBeforeCreate?.(ws, c);

    const name = body.name as string;
    const id = generateId(ID_PREFIXES.role);
    const slug = config.slugFor(body, id);

    const existing = config.findRole(ws, c, slug);
    if (existing) {
      // Production answers a taken slug with 409, not a 422 field error.
      throw new WorkOSApiError(409, config.duplicateMessage, config.duplicateCode);
    }

    // Resource types are not modeled by the emulator (no registry, no endpoint), so any
    // well-formed slug is accepted, and a role's permissions are not checked against its
    // scope. Production requires a defined type and matching scopes.
    const defaults = config.insertDefaults(c);
    const role = ws.roles.insert({
      id,
      object: 'role',
      slug,
      name,
      description: (body.description as string | null | undefined) ?? null,
      type: config.roleType,
      organization_id: defaults.organization_id ?? null,
      // Production's role carries no default flag or numeric priority of its own: the
      // default role lives on the role config, and a new role joins the end of the
      // priority order. Both stay seed-only here.
      is_default_role: false,
      priority: nextRolePriority(ws),
      resource_type_slug: (body.resource_type_slug as string | undefined) ?? DEFAULT_RESOURCE_TYPE_SLUG,
    });

    return c.json(formatRole(role, ws), 201);
  });

  app.get(pathPrefix, (c) =>
    c.json({
      object: 'list',
      data: config.listRoles(ws, c).map((r) => formatRole(r, ws)),
      list_metadata: { before: null, after: null },
    }),
  );

  app.get(`${pathPrefix}/:slug`, (c) => {
    const role = (config.readRole ?? config.requireRole)(ws, c);
    return c.json(formatRole(role, ws));
  });

  // The spec (and every SDK) updates a role with PATCH; there is no PUT. Only the name and
  // description are updatable; production refuses any other property, the slug included.
  app.patch(`${pathPrefix}/:slug`, async (c) => {
    const body = await parseJsonBody(c);
    validateBody(body, ROLE_UPDATE_RULES);
    const role = config.requireRole(ws, c);

    const updates: Record<string, unknown> = {};
    // A null name keeps the current one, as production's `payload.name ?? role.name` does.
    if (typeof body.name === 'string') updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description ?? null;

    const updated = ws.roles.update(role.id, updates);
    return c.json(formatRole(updated!, ws));
  });

  // No DELETE here: production has no route that deletes an environment role (its
  // controller is @Post, @Get, @Get(':slug') and @Patch(':slug') only), so the organization
  // role routes register their own, with production's conflict rules.

  // Not in the spec — production inlines permission slugs on the role instead.
  // Kept as the only way to read the full permission objects for a role.
  app.get(`${pathPrefix}/:slug/permissions`, (c) => {
    const role = config.requireRole(ws, c);
    const permissions = getRolePermissions(ws, role.id);

    return c.json({
      object: 'list',
      data: permissions.map((p) => formatPermission(p)),
      list_metadata: { before: null, after: null },
    });
  });

  // Spec: PUT replaces the whole set, POST attaches one; both answer with the role.
  app.put(`${pathPrefix}/:slug/permissions`, async (c) => {
    const body = await parseJsonBody(c);
    validateBody(body, ROLE_PERMISSIONS_SET_RULES);
    const role = config.requireRole(ws, c);

    if (replaceRolePermissions(ws, role.id, body.permissions as string[])) {
      emitRolePermissionsUpdated(store, ws, role);
    }
    return c.json(formatRole(role, ws));
  });

  app.post(`${pathPrefix}/:slug/permissions`, async (c) => {
    const body = await parseJsonBody(c);
    validateBody(body, ROLE_PERMISSION_ADD_RULES);
    const role = config.requireRole(ws, c);
    const permission = requirePermissionBySlug(ws, body.slug as string);

    // Re-attaching is a no-op rather than a duplicate join row, and emits nothing.
    const attached = ws.rolePermissions.findBy('role_id', role.id).some((rp) => rp.permission_id === permission.id);
    if (!attached) {
      ws.rolePermissions.insert({ role_id: role.id, permission_id: permission.id });
      emitRolePermissionsUpdated(store, ws, role);
    }

    return c.json(formatRole(role, ws));
  });
}
