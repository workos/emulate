import type { Context } from 'hono';
import { type RouteContext, notFound, validationError, parseJsonBody, parseListParams } from '../../core/index.js';
import type { WorkOSAuthorizationResource } from '../entities.js';
import { getWorkOSStore } from '../store.js';
import { formatRoleAssignment, formatAuthorizationResource, formatListResponse, formatPermission } from '../helpers.js';
import { resolvePrimaryRole } from '../role-helpers.js';

/**
 * Gather all permission slugs for a given membership:
 * 1. From the membership's role (role.slug field)
 * 2. From any additional role assignments
 */
function getPermissionsForMembership(ws: ReturnType<typeof getWorkOSStore>, membershipId: string): Set<string> {
  const membership = ws.organizationMemberships.get(membershipId);
  if (!membership) return new Set();

  const permSlugs = new Set<string>();

  // Permissions from the membership's primary role
  const primaryRole = resolvePrimaryRole(ws, membership.organization_id, membership.role.slug);
  if (primaryRole) {
    const rps = ws.rolePermissions.findBy('role_id', primaryRole.id);
    for (const rp of rps) {
      const perm = ws.permissions.get(rp.permission_id);
      if (perm) permSlugs.add(perm.slug);
    }
  }

  // Permissions from additional role assignments
  const assignments = ws.roleAssignments.findBy('organization_membership_id', membershipId);
  for (const assignment of assignments) {
    const role = ws.roles.get(assignment.role_id);
    if (!role) continue;
    const rps = ws.rolePermissions.findBy('role_id', role.id);
    for (const rp of rps) {
      const perm = ws.permissions.get(rp.permission_id);
      if (perm) permSlugs.add(perm.slug);
    }
  }

  return permSlugs;
}

export function authorizationCheckRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  // Permission check
  app.post('/authorization/organization_memberships/:id/check', async (c) => {
    const membershipId = c.req.param('id');
    const membership = ws.organizationMemberships.get(membershipId);
    if (!membership) throw notFound('OrganizationMembership');

    const body = await parseJsonBody(c);
    const permission = body.permission as string;
    if (!permission) {
      throw validationError('permission is required', [{ field: 'permission', code: 'required' }]);
    }

    const permSlugs = getPermissionsForMembership(ws, membershipId);
    return c.json({ authorized: permSlugs.has(permission) });
  });

  // List resources accessible to a membership (all resources in the membership's org)
  app.get('/authorization/organization_memberships/:id/resources', (c) => {
    const membershipId = c.req.param('id');
    const membership = ws.organizationMemberships.get(membershipId);
    if (!membership) throw notFound('OrganizationMembership');

    const url = new URL(c.req.url);
    const params = parseListParams(url);

    const result = ws.authorizationResources.list({
      ...params,
      filter: (r) => r.organization_id === membership.organization_id,
    });

    return c.json(formatListResponse(result, formatAuthorizationResource));
  });

  // Effective permissions for a membership on a resource. The emulator has no
  // resource-scoped role assignments or ancestor inheritance, so the effective
  // set is the membership's full permission set; the resource only gates 404s.
  const listEffectivePermissions = (
    c: Context,
    membershipId: string,
    resource: WorkOSAuthorizationResource | undefined,
  ) => {
    const membership = ws.organizationMemberships.get(membershipId);
    if (!membership) throw notFound('OrganizationMembership');
    if (!resource || resource.organization_id !== membership.organization_id) throw notFound('Resource');

    const permSlugs = getPermissionsForMembership(ws, membershipId);

    const url = new URL(c.req.url);
    const params = parseListParams(url);

    const result = ws.permissions.list({
      ...params,
      filter: (p) => permSlugs.has(p.slug),
    });

    return c.json(formatListResponse(result, formatPermission));
  };

  // Production route used by the Node SDK's listEffectivePermissionsByExternalId()
  app.get('/authorization/organization_memberships/:id/resources/:resourceTypeSlug/:externalId/permissions', (c) => {
    const membership = ws.organizationMemberships.get(c.req.param('id'));
    const resource = membership
      ? ws.authorizationResources
          .findBy('external_id', c.req.param('externalId'))
          .find(
            (r) =>
              r.resource_type_slug === c.req.param('resourceTypeSlug') &&
              r.organization_id === membership.organization_id,
          )
      : undefined;
    return listEffectivePermissions(c, c.req.param('id'), resource);
  });

  // Production controller variant addressing the resource by id
  app.get('/authorization/organization_memberships/:id/resources/:resourceId/permissions', (c) => {
    const resource = ws.authorizationResources.get(c.req.param('resourceId'));
    return listEffectivePermissions(c, c.req.param('id'), resource);
  });

  // Resource-centric route used by the Node SDK's listEffectivePermissions()
  app.get('/authorization/resources/:resourceId/organization_memberships/:membershipId/permissions', (c) => {
    const resource = ws.authorizationResources.get(c.req.param('resourceId'));
    return listEffectivePermissions(c, c.req.param('membershipId'), resource);
  });

  // List role assignments for a membership
  app.get('/authorization/organization_memberships/:id/role_assignments', (c) => {
    const membershipId = c.req.param('id');
    const membership = ws.organizationMemberships.get(membershipId);
    if (!membership) throw notFound('OrganizationMembership');

    const url = new URL(c.req.url);
    const params = parseListParams(url);

    const result = ws.roleAssignments.list({
      ...params,
      filter: (ra) => ra.organization_membership_id === membershipId,
    });

    return c.json(formatListResponse(result, formatRoleAssignment));
  });

  // Create role assignment
  app.post('/authorization/organization_memberships/:id/role_assignments', async (c) => {
    const membershipId = c.req.param('id');
    const membership = ws.organizationMemberships.get(membershipId);
    if (!membership) throw notFound('OrganizationMembership');

    const body = await parseJsonBody(c);
    const roleSlug = body.role_slug as string | undefined;
    // role_id is not part of the production contract, but is accepted for
    // compatibility with earlier emulator releases.
    const roleId = body.role_id as string | undefined;
    if (!roleSlug && !roleId) {
      throw validationError('role_slug is required', [{ field: 'role_slug', code: 'required' }]);
    }

    const role = roleSlug
      ? resolvePrimaryRole(ws, membership.organization_id, roleSlug)
      : ws.roles.get(roleId as string);
    if (!role) throw notFound('Role');

    const resourceId = body.resource_id as string | undefined;
    const resourceExternalId = body.resource_external_id as string | undefined;
    const resourceTypeSlug = body.resource_type_slug as string | undefined;

    let resource: WorkOSAuthorizationResource | null = null;
    if (resourceId) {
      resource = ws.authorizationResources.get(resourceId) ?? null;
      if (!resource || resource.organization_id !== membership.organization_id) throw notFound('Resource');
    } else if (resourceExternalId) {
      if (!resourceTypeSlug) {
        throw validationError('resource_type_slug is required when resource_external_id is provided', [
          { field: 'resource_type_slug', code: 'required' },
        ]);
      }
      resource =
        ws.authorizationResources
          .findBy('external_id', resourceExternalId)
          .find((r) => r.resource_type_slug === resourceTypeSlug && r.organization_id === membership.organization_id) ??
        null;
      if (!resource) throw notFound('Resource');
    } else if (resourceTypeSlug) {
      throw validationError('resource_external_id is required when resource_type_slug is provided', [
        { field: 'resource_external_id', code: 'required' },
      ]);
    }

    const assignment = ws.roleAssignments.insert({
      object: 'role_assignment',
      organization_membership_id: membershipId,
      role_id: role.id,
      role_slug: role.slug,
      resource_id: resource?.id ?? null,
      resource_external_id: resource?.external_id ?? null,
      resource_type_slug: resource?.resource_type_slug ?? null,
    });

    return c.json(formatRoleAssignment(assignment), 201);
  });

  // Delete role assignment
  app.delete('/authorization/organization_memberships/:id/role_assignments/:assignmentId', (c) => {
    const membershipId = c.req.param('id');
    const assignmentId = c.req.param('assignmentId');

    const membership = ws.organizationMemberships.get(membershipId);
    if (!membership) throw notFound('OrganizationMembership');

    const assignment = ws.roleAssignments.get(assignmentId);
    if (!assignment || assignment.organization_membership_id !== membershipId) {
      throw notFound('RoleAssignment');
    }

    ws.roleAssignments.delete(assignmentId);
    return c.body(null, 204);
  });
}

export { getPermissionsForMembership };
