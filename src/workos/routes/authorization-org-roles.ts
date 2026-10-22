import { type RouteContext, EntityNotFoundError, notFound, validationError, parseJsonBody } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatRole } from '../helpers.js';
import {
  emitRolePermissionsUpdated,
  findOrgRole,
  requireOrgRole,
  registerRoleRoutes,
  rolesApplyingTo,
} from '../role-helpers.js';

export function authorizationOrgRoleRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);
  const prefix = '/authorization/organizations/:orgId/roles';

  // Priority ordering — must be registered before :slug routes
  app.put(`${prefix}/priority`, async (c) => {
    const orgId = c.req.param('orgId');
    const body = await parseJsonBody(c);
    const slugs = body.slugs as string[];

    if (!Array.isArray(slugs)) {
      throw validationError('slugs must be an array', [{ field: 'slugs', code: 'invalid' }]);
    }

    // Fetch once, build slug map for O(1) lookups
    const orgRoles = ws.roles.findBy('organization_id', orgId).filter((r) => r.type === 'OrganizationRole');
    const rolesBySlug = new Map(orgRoles.map((r) => [r.slug, r]));

    for (let i = 0; i < slugs.length; i++) {
      const role = rolesBySlug.get(slugs[i]!);
      if (!role) throw notFound('Organization Role', slugs[i]!);
      ws.roles.update(role.id, { priority: i });
    }

    // Re-fetch for updated priority values
    const updated = ws.roles
      .findBy('organization_id', orgId)
      .filter((r) => r.type === 'OrganizationRole')
      .sort((a, b) => a.priority - b.priority);

    return c.json({
      object: 'list',
      data: updated.map((r) => formatRole(r, ws)),
      list_metadata: { before: null, after: null },
    });
  });

  registerRoleRoutes(ctx, {
    pathPrefix: prefix,
    roleType: 'OrganizationRole',
    requireRole: (ws, c) => requireOrgRole(ws, c.req.param('orgId')!, c.req.param('slug')!),
    findRole: (ws, c, slug) => findOrgRole(ws, c.req.param('orgId')!, slug),
    // The spec: "all roles that apply to an organization. This includes both environment roles
    // and custom roles, returned in priority order." Production resolves the organization first,
    // so an unknown one answers 404 rather than the environment's roles.
    listRoles: (ws, c) => {
      const orgId = c.req.param('orgId')!;
      if (!ws.organizations.get(orgId)) throw notFound('Organization', orgId);
      return rolesApplyingTo(ws, orgId);
    },
    insertDefaults: (c) => ({ organization_id: c.req.param('orgId')! }),
    duplicateMessage: 'Role with this slug already exists in this organization',
    duplicateCode: 'organization_role_slug_conflict',
    validateBeforeCreate: (ws, c) => {
      const org = ws.organizations.get(c.req.param('orgId')!);
      if (!org) throw notFound('Organization', c.req.param('orgId')!);
    },
  });

  // Org-specific: delete single permission from role
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
    if (!rp) throw notFound('RolePermission', permissionSlug);

    ws.rolePermissions.delete(rp.id);
    emitRolePermissionsUpdated(store, ws, role);
    // The spec answers with the updated role, not an empty 204.
    return c.json(formatRole(role, ws));
  });
}
