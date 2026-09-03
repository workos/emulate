import type { Context } from 'hono';
import {
  type RouteContext,
  WorkOSApiError,
  notFound,
  validationError,
  parseJsonBody,
  parseListParams,
} from '../core/index.js';
import type { WorkOSStore } from './store.js';
import type { WorkOSRole, WorkOSPermission } from './entities.js';
import { getWorkOSStore } from './store.js';
import { DEFAULT_RESOURCE_TYPE_SLUG, isValidResourceTypeSlug } from './constants.js';
import { formatRole, formatPermission, formatListResponse } from './helpers.js';

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

export function requireEnvRole(ws: WorkOSStore, slug: string): WorkOSRole {
  const role = findEnvRole(ws, slug);
  if (!role) throw notFound('Role');
  return role;
}

export function requireOrgRole(ws: WorkOSStore, orgId: string, slug: string): WorkOSRole {
  const role = findOrgRole(ws, orgId, slug);
  if (!role) throw notFound('Role');
  return role;
}

export function getRolePermissions(ws: WorkOSStore, roleId: string): WorkOSPermission[] {
  const rps = ws.rolePermissions.findBy('role_id', roleId);
  return rps.map((rp) => ws.permissions.get(rp.permission_id)).filter(Boolean) as WorkOSPermission[];
}

/**
 * Replace a role's permission set. Every slug is resolved before the join
 * table is touched, so an unknown slug answers 404 and leaves the current set
 * intact rather than half-applied. Returns whether the set actually changed,
 * which is what decides whether a role.updated event is due, as in production.
 */
export function replaceRolePermissions(ws: WorkOSStore, roleId: string, permissionSlugs: string[]): boolean {
  const next = new Map<string, WorkOSPermission>();
  for (const permSlug of permissionSlugs) {
    const perm = ws.permissions.findOneBy('slug', permSlug);
    if (!perm) throw notFound('Permission');
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

export interface RoleRouteConfig {
  pathPrefix: string;
  roleType: 'EnvironmentRole' | 'OrganizationRole';
  requireRole: (ws: WorkOSStore, c: Context) => WorkOSRole;
  findRole: (ws: WorkOSStore, c: Context, slug: string) => WorkOSRole | undefined;
  listFilter: (c: Context) => (r: WorkOSRole) => boolean;
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
    config.validateBeforeCreate?.(ws, c);

    const body = await parseJsonBody(c);
    const slug = body.slug as string;
    const name = body.name as string;
    const resourceTypeSlug = body.resource_type_slug;

    if (!slug || typeof slug !== 'string') {
      throw validationError('slug is required', [{ field: 'slug', code: 'required' }]);
    }
    if (!name || typeof name !== 'string') {
      throw validationError('name is required', [{ field: 'name', code: 'required' }]);
    }
    // Resource types are not modeled by the emulator (no registry, no endpoint),
    // so any non-empty slug is accepted, and a role's permissions are not checked
    // against its scope. Production requires a defined type and matching scopes.
    if (!isValidResourceTypeSlug(resourceTypeSlug)) {
      throw validationError('resource_type_slug must be a non-empty string', [
        { field: 'resource_type_slug', code: 'invalid' },
      ]);
    }

    const existing = config.findRole(ws, c, slug);
    if (existing) {
      // Production answers a taken slug with 409, not a 422 field error.
      throw new WorkOSApiError(409, config.duplicateMessage, config.duplicateCode);
    }

    const defaults = config.insertDefaults(c);
    const role = ws.roles.insert({
      object: 'role',
      slug,
      name,
      description: (body.description as string) ?? null,
      type: config.roleType,
      organization_id: defaults.organization_id ?? null,
      is_default_role: Boolean(body.is_default_role),
      priority: typeof body.priority === 'number' ? body.priority : 0,
      resource_type_slug: resourceTypeSlug ?? DEFAULT_RESOURCE_TYPE_SLUG,
    });

    return c.json(formatRole(role, ws), 201);
  });

  app.get(pathPrefix, (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);

    const result = ws.roles.list({
      ...params,
      filter: config.listFilter(c),
    });

    return c.json(formatListResponse(result, (r) => formatRole(r, ws)));
  });

  app.get(`${pathPrefix}/:slug`, (c) => {
    const role = config.requireRole(ws, c);
    return c.json(formatRole(role, ws));
  });

  // The spec (and every SDK) updates a role with PATCH; there is no PUT.
  app.patch(`${pathPrefix}/:slug`, async (c) => {
    const role = config.requireRole(ws, c);

    const body = await parseJsonBody(c);
    const updates: Record<string, unknown> = {};
    if ('name' in body) updates.name = body.name;
    if ('description' in body) updates.description = body.description ?? null;
    if ('is_default_role' in body) updates.is_default_role = Boolean(body.is_default_role);
    if ('priority' in body) updates.priority = body.priority;

    const updated = ws.roles.update(role.id, updates);
    return c.json(formatRole(updated!, ws));
  });

  app.delete(`${pathPrefix}/:slug`, (c) => {
    const role = config.requireRole(ws, c);

    ws.rolePermissions.deleteBy('role_id', role.id);
    ws.roleAssignments.deleteBy('role_id', role.id);

    ws.roles.delete(role.id);
    return c.body(null, 204);
  });

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
    const role = config.requireRole(ws, c);

    const body = await parseJsonBody(c);
    const permissionSlugs = body.permissions;
    if (!Array.isArray(permissionSlugs) || permissionSlugs.some((slug) => typeof slug !== 'string')) {
      throw validationError('permissions must be an array of slugs', [{ field: 'permissions', code: 'invalid' }]);
    }

    replaceRolePermissions(ws, role.id, permissionSlugs as string[]);
    return c.json(formatRole(role, ws));
  });

  app.post(`${pathPrefix}/:slug/permissions`, async (c) => {
    const role = config.requireRole(ws, c);

    const body = await parseJsonBody(c);
    const slug = body.slug;
    if (!slug || typeof slug !== 'string') {
      throw validationError('slug is required', [{ field: 'slug', code: 'required' }]);
    }
    const permission = ws.permissions.findOneBy('slug', slug);
    if (!permission) throw notFound('Permission');

    // Re-attaching is a no-op rather than a duplicate join row.
    const attached = ws.rolePermissions.findBy('role_id', role.id).some((rp) => rp.permission_id === permission.id);
    if (!attached) ws.rolePermissions.insert({ role_id: role.id, permission_id: permission.id });

    return c.json(formatRole(role, ws));
  });
}
