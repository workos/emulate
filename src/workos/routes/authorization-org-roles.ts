import { type RouteContext, EntityNotFoundError, WorkOSApiError, notFound, parseJsonBody } from '../../core/index.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';
import { formatRole } from '../helpers.js';
import {
  ORGANIZATION_ROLE_CREATE_RULES,
  ROLE_PRIORITY_ORDER_RULES,
  validateBody,
} from '../authorization-validation.js';
import {
  emitRolePermissionsUpdated,
  findOrgRole,
  generateRoleSlug,
  requireOrgRole,
  registerRoleRoutes,
  resolvePrimaryRole,
  roleHasAssignments,
  rolesApplyingTo,
} from '../role-helpers.js';

function requireOrganization(ws: WorkOSStore, orgId: string): void {
  if (!ws.organizations.get(orgId)) throw notFound('Organization', orgId);
}

export function authorizationOrgRoleRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);
  const prefix = '/authorization/organizations/:orgId/roles';

  // Priority ordering — must be registered before :slug routes. Excluded from the spec
  // (@ApiExcludeEndpoint), so the body and errors follow the controller: `role_priority_order`
  // names every role that applies to the organization, environment roles included, each once.
  app.put(`${prefix}/priority`, async (c) => {
    const orgId = c.req.param('orgId');
    const body = await parseJsonBody(c);
    validateBody(body, ROLE_PRIORITY_ORDER_RULES);
    requireOrganization(ws, orgId);

    const slugs = body.role_priority_order as string[];
    if (new Set(slugs).size !== slugs.length) {
      throw new WorkOSApiError(400, 'Priority order contains duplicate role slugs', 'duplicate_role_slugs');
    }

    // A slug resolves the way the list does: the organization's own role shadows an
    // environment role with the same slug, so the shadowed one cannot be named.
    const applying = rolesApplyingTo(ws, orgId);
    const bySlug = new Map(applying.map((r) => [r.slug, r]));
    const unknown = slugs.find((slug) => !bySlug.has(slug));
    if (unknown !== undefined) {
      throw new WorkOSApiError(400, `Unknown role slug: ${unknown}`, 'unknown_role_slugs');
    }
    // Every known slug is distinct, so a shorter list leaves some applying role unplaced,
    // which production's role config refuses rather than guessing a position for it.
    if (slugs.length !== applying.length) {
      throw new WorkOSApiError(400, 'Error updating role priority order due to invalid priority list', 'bad_request');
    }

    // Production keeps the order on the organization's role config, not on the roles, so
    // no role.updated event accompanies a reorder. The emulator stores one priority per
    // role; an environment role reordered here is reordered for every organization.
    slugs.forEach((slug, index) => ws.roles.updateSilent(bySlug.get(slug)!.id, { priority: index }));

    return c.json({
      object: 'list',
      data: rolesApplyingTo(ws, orgId).map((r) => formatRole(r, ws)),
      list_metadata: { before: null, after: null },
    });
  });

  registerRoleRoutes(ctx, {
    pathPrefix: prefix,
    roleType: 'OrganizationRole',
    requireRole: (ws, c) => requireOrgRole(ws, c.req.param('orgId')!, c.req.param('slug')!),
    // The spec: "This can return either an environment role or a custom role." The
    // organization is resolved first, so an unknown one is a 404 rather than an environment role.
    readRole: (ws, c) => {
      const orgId = c.req.param('orgId')!;
      requireOrganization(ws, orgId);
      const slug = c.req.param('slug')!;
      const role = resolvePrimaryRole(ws, orgId, slug);
      // Production's OrganizationRoleNotFoundException, whatever kind of role the slug missed.
      if (!role) throw notFound('Organization Role', slug);
      return role;
    },
    findRole: (ws, c, slug) => findOrgRole(ws, c.req.param('orgId')!, slug),
    createRules: ORGANIZATION_ROLE_CREATE_RULES,
    slugFor: (body, roleId) => (body.slug as string | undefined) ?? generateRoleSlug(body.name as string, roleId),
    // The spec: "all roles that apply to an organization. This includes both environment roles
    // and custom roles, returned in priority order." Production resolves the organization first,
    // so an unknown one answers 404 rather than the environment's roles.
    listRoles: (ws, c) => {
      const orgId = c.req.param('orgId')!;
      requireOrganization(ws, orgId);
      return rolesApplyingTo(ws, orgId);
    },
    insertDefaults: (c) => ({ organization_id: c.req.param('orgId')! }),
    duplicateMessage: 'Role with this slug already exists in this organization',
    duplicateCode: 'organization_role_slug_conflict',
    validateBeforeCreate: (ws, c) => requireOrganization(ws, c.req.param('orgId')!),
  });

  // Only an organization role can be deleted, and only while nothing holds it: production
  // answers 409 `role_has_assignments` while a membership still has the role, directly or
  // through a native group it belongs to, and 409 `role_has_group_role_mappings` while a
  // directory group maps to it. The emulator resolves directory group mappings onto
  // memberships when it seeds them and keeps no mapping rows, so only the first conflict can
  // arise here.
  app.delete(`${prefix}/:slug`, (c) => {
    const orgId = c.req.param('orgId');
    requireOrganization(ws, orgId);
    const role = requireOrgRole(ws, orgId, c.req.param('slug'));

    if (roleHasAssignments(ws, role)) {
      throw new WorkOSApiError(
        409,
        `Role '${role.slug}' cannot be deleted because it has user role assignments.`,
        'role_has_assignments',
      );
    }

    // The role row goes first so the deleted event, emitted from the collection hook, can
    // still resolve the role's permissions; the joins cascade after. A native group's grant
    // with no members left no assignment to conflict on, so it goes with the role.
    ws.roles.delete(role.id);
    ws.rolePermissions.deleteBy('role_id', role.id);
    ws.groupRoleAssignments.deleteBy('role_id', role.id);

    return c.body(null, 204);
  });

  // Org-specific: remove a single permission from a role. An unknown permission is a 404;
  // one the role does not hold is a no-op that still answers with the role, and emits nothing.
  app.delete(`${prefix}/:slug/permissions/:permissionSlug`, (c) => {
    const role = requireOrgRole(ws, c.req.param('orgId'), c.req.param('slug'));

    const permissionSlug = c.req.param('permissionSlug');
    const perm = ws.permissions.findOneBy('slug', permissionSlug);
    // The one production 404 that adds `entity_type` and words the message differently
    // (api authorization-organization-role-permissions controller, on PermissionSlugNotFoundException).
    if (!perm) {
      throw new EntityNotFoundError('Permission', permissionSlug, {
        message: `Permission '${permissionSlug}' not found.`,
        extra: { entity_type: 'Permission' },
      });
    }

    const rp = ws.rolePermissions.findBy('role_id', role.id).find((rp) => rp.permission_id === perm.id);
    if (rp) {
      ws.rolePermissions.delete(rp.id);
      emitRolePermissionsUpdated(store, ws, role);
    }
    // The spec answers with the updated role, not an empty 204.
    return c.json(formatRole(role, ws));
  });
}
