import type { Context } from 'hono';
import { type RouteContext, notFound, validationError, parseJsonBody, parseListParams } from '../../core/index.js';
import type { WorkOSAuthorizationResource } from '../entities.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';
import { formatRoleAssignment, formatAuthorizationResource, formatListResponse, formatPermission } from '../helpers.js';
import { resolvePrimaryRole } from '../role-helpers.js';

// The resource itself plus every ancestor reachable through parent_resource_id.
// Role assignments on an ancestor grant their permissions on all descendants.
function resourceAncestry(ws: WorkOSStore, resource: WorkOSAuthorizationResource): Set<string> {
  const ids = new Set<string>();
  let current: WorkOSAuthorizationResource | undefined = resource;
  while (current && !ids.has(current.id)) {
    ids.add(current.id);
    current = current.parent_resource_id ? ws.authorizationResources.get(current.parent_resource_id) : undefined;
  }
  return ids;
}

/**
 * Gather the permission slugs a membership holds, from:
 * 1. The membership's primary role (organization-wide)
 * 2. Additional role assignments — organization-wide ones always apply;
 *    resource-scoped ones apply only when checking against that resource or
 *    one of its descendants.
 *
 * When no resource is given the set is membership-wide (every assignment
 * counts, matching pre-0.11 behavior); production always scopes to a resource.
 */
function getPermissionsForMembership(
  ws: WorkOSStore,
  membershipId: string,
  resource?: WorkOSAuthorizationResource,
): Set<string> {
  const membership = ws.organizationMemberships.get(membershipId);
  if (!membership) return new Set();

  const permSlugs = new Set<string>();
  const addRolePermissions = (roleId: string) => {
    for (const rp of ws.rolePermissions.findBy('role_id', roleId)) {
      const perm = ws.permissions.get(rp.permission_id);
      if (perm) permSlugs.add(perm.slug);
    }
  };

  // Permissions from the membership's primary role
  const primaryRole = resolvePrimaryRole(ws, membership.organization_id, membership.role.slug);
  if (primaryRole) addRolePermissions(primaryRole.id);

  // Permissions from additional role assignments
  const scopeIds = resource ? resourceAncestry(ws, resource) : null;
  const assignments = ws.roleAssignments.findBy('organization_membership_id', membershipId);
  for (const assignment of assignments) {
    if (scopeIds && assignment.resource_id !== null && !scopeIds.has(assignment.resource_id)) continue;
    const role = ws.roles.get(assignment.role_id);
    if (role) addRolePermissions(role.id);
  }

  return permSlugs;
}

// Resolve the resource a request body targets: resource_id, or
// resource_external_id + resource_type_slug. Returns null when the body names
// no resource at all.
function resolveResourceTarget(
  ws: WorkOSStore,
  body: Record<string, unknown>,
  organizationId: string,
): WorkOSAuthorizationResource | null {
  const resourceId = body.resource_id as string | undefined;
  const resourceExternalId = body.resource_external_id as string | undefined;
  const resourceTypeSlug = body.resource_type_slug as string | undefined;

  if (resourceId) {
    const resource = ws.authorizationResources.get(resourceId);
    if (!resource || resource.organization_id !== organizationId) throw notFound('Resource');
    return resource;
  }

  if (resourceExternalId) {
    if (!resourceTypeSlug) {
      throw validationError('resource_type_slug is required when resource_external_id is provided', [
        { field: 'resource_type_slug', code: 'required' },
      ]);
    }
    const resource = ws.authorizationResources
      .findBy('external_id', resourceExternalId)
      .find((r) => r.resource_type_slug === resourceTypeSlug && r.organization_id === organizationId);
    if (!resource) throw notFound('Resource');
    return resource;
  }

  if (resourceTypeSlug) {
    throw validationError('resource_external_id is required when resource_type_slug is provided', [
      { field: 'resource_external_id', code: 'required' },
    ]);
  }

  return null;
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
    // permission_slug is the production field (what the SDKs send);
    // `permission` is kept for compatibility with pre-0.11 emulator releases.
    const permission = (body.permission_slug ?? body.permission) as string | undefined;
    if (!permission) {
      throw validationError('permission_slug is required', [{ field: 'permission_slug', code: 'required' }]);
    }

    // Production requires a resource target; a check without one stays
    // membership-wide for compatibility with pre-0.11 emulator releases.
    const resource = resolveResourceTarget(ws, body, membership.organization_id);

    const permSlugs = getPermissionsForMembership(ws, membershipId, resource ?? undefined);
    return c.json({ authorized: permSlugs.has(permission) });
  });

  // List resources accessible to a membership. Production semantics: child
  // resources of a required parent where the membership holds a required
  // permission_slug. Without any of those params (pre-0.11 emulator behavior)
  // every resource in the membership's organization is returned.
  app.get('/authorization/organization_memberships/:id/resources', (c) => {
    const membershipId = c.req.param('id');
    const membership = ws.organizationMemberships.get(membershipId);
    if (!membership) throw notFound('OrganizationMembership');

    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const permissionSlug = url.searchParams.get('permission_slug');
    const parentId = url.searchParams.get('parent_resource_id');
    const parentTypeSlug = url.searchParams.get('parent_resource_type_slug');
    const parentExternalId = url.searchParams.get('parent_resource_external_id');

    if (!permissionSlug && !parentId && !parentTypeSlug && !parentExternalId) {
      const result = ws.authorizationResources.list({
        ...params,
        filter: (r) => r.organization_id === membership.organization_id,
      });
      return c.json(formatListResponse(result, formatAuthorizationResource));
    }

    if (!permissionSlug) {
      throw validationError('permission_slug is required', [{ field: 'permission_slug', code: 'required' }]);
    }
    const parent = resolveResourceTarget(
      ws,
      { resource_id: parentId, resource_external_id: parentExternalId, resource_type_slug: parentTypeSlug },
      membership.organization_id,
    );
    if (!parent) {
      throw validationError(
        'parent_resource_id or parent_resource_external_id + parent_resource_type_slug is required',
        [{ field: 'parent_resource_id', code: 'required' }],
      );
    }

    const result = ws.authorizationResources.list({
      ...params,
      filter: (r) =>
        r.parent_resource_id === parent.id && getPermissionsForMembership(ws, membershipId, r).has(permissionSlug),
    });

    return c.json(formatListResponse(result, formatAuthorizationResource));
  });

  // Effective permissions for a membership on a resource: the membership's
  // organization-wide roles plus role assignments scoped to the resource or
  // any of its ancestors.
  const listEffectivePermissions = (
    c: Context,
    membershipId: string,
    resource: WorkOSAuthorizationResource | undefined,
  ) => {
    const membership = ws.organizationMemberships.get(membershipId);
    if (!membership) throw notFound('OrganizationMembership');
    if (!resource || resource.organization_id !== membership.organization_id) throw notFound('Resource');

    const permSlugs = getPermissionsForMembership(ws, membershipId, resource);

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
    // Whichever way it was addressed, the role must belong to the membership's
    // organization or the environment — never to another organization.
    if (role.organization_id !== null && role.organization_id !== membership.organization_id) {
      throw notFound('Role');
    }

    const resource = resolveResourceTarget(ws, body, membership.organization_id);

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
