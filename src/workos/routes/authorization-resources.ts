import type { Context } from 'hono';
import {
  type RouteContext,
  WorkOSApiError,
  notFound,
  validationError,
  parseJsonBody,
  parseListParams,
} from '../../core/index.js';
import type { WorkOSAuthorizationResource } from '../entities.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';
import { formatAuthorizationResource, formatMembership, formatListResponse } from '../helpers.js';
import { getPermissionsForMembership } from './authorization-checks.js';

function findResourceByExternalId(
  ws: WorkOSStore,
  organizationId: string,
  resourceTypeSlug: string,
  externalId: string,
): WorkOSAuthorizationResource | undefined {
  return ws.authorizationResources
    .findBy('external_id', externalId)
    .find((r) => r.resource_type_slug === resourceTypeSlug && r.organization_id === organizationId);
}

// The resource plus every resource beneath it, walking parent_resource_id
// downward. Used to keep hierarchies acyclic and to cascade deletes.
function collectSubtree(ws: WorkOSStore, rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  const queue = [rootId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const child of ws.authorizationResources.findBy('parent_resource_id', parentId)) {
      if (!ids.has(child.id)) {
        ids.add(child.id);
        queue.push(child.id);
      }
    }
  }
  return ids;
}

// Resolve the parent named by a create/update body: parent_resource_id XOR
// parent_resource_external_id + parent_resource_type_slug. Returns null when
// no parent field is present.
function resolveParentResource(
  ws: WorkOSStore,
  body: Record<string, unknown>,
  organizationId: string,
): WorkOSAuthorizationResource | null {
  const parentId = body.parent_resource_id as string | null | undefined;
  const parentExternalId = body.parent_resource_external_id as string | undefined;
  const parentTypeSlug = body.parent_resource_type_slug as string | undefined;

  if (parentId) {
    if (parentExternalId || parentTypeSlug) {
      throw validationError(
        'parent_resource_id is mutually exclusive with parent_resource_external_id and parent_resource_type_slug',
        [{ field: 'parent_resource_id', code: 'mutually_exclusive' }],
      );
    }
    const parent = ws.authorizationResources.get(parentId);
    if (!parent || parent.organization_id !== organizationId) throw notFound('Resource');
    return parent;
  }

  if (parentExternalId || parentTypeSlug) {
    if (!parentExternalId || !parentTypeSlug) {
      const missing = parentExternalId ? 'parent_resource_type_slug' : 'parent_resource_external_id';
      throw validationError('parent_resource_external_id and parent_resource_type_slug must be provided together', [
        { field: missing, code: 'required' },
      ]);
    }
    const parent = findResourceByExternalId(ws, organizationId, parentTypeSlug, parentExternalId);
    if (!parent) throw notFound('Resource');
    return parent;
  }

  return null;
}

export function authorizationResourceRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/authorization/resources', async (c) => {
    const body = await parseJsonBody(c);

    const resourceTypeSlug = body.resource_type_slug as string;
    const externalId = body.external_id as string;
    const organizationId = body.organization_id as string;
    const name = body.name as string | undefined;

    if (!resourceTypeSlug) {
      throw validationError('resource_type_slug is required', [{ field: 'resource_type_slug', code: 'required' }]);
    }
    if (!externalId) {
      throw validationError('external_id is required', [{ field: 'external_id', code: 'required' }]);
    }
    if (!organizationId) {
      throw validationError('organization_id is required', [{ field: 'organization_id', code: 'required' }]);
    }
    if (!name) {
      throw validationError('name is required', [{ field: 'name', code: 'required' }]);
    }

    if (findResourceByExternalId(ws, organizationId, resourceTypeSlug, externalId)) {
      throw new WorkOSApiError(
        409,
        `A resource with external_id '${externalId}' already exists for resource type '${resourceTypeSlug}'.`,
        'authorization_resource_external_id_conflict',
      );
    }

    const parent = resolveParentResource(ws, body, organizationId);

    const resource = ws.authorizationResources.insert({
      object: 'authorization_resource',
      resource_type_slug: resourceTypeSlug,
      external_id: externalId,
      organization_id: organizationId,
      name,
      description: (body.description as string | null | undefined) ?? null,
      parent_resource_id: parent?.id ?? null,
      metadata: (body.metadata as Record<string, string>) ?? {},
    });

    return c.json(formatAuthorizationResource(resource), 201);
  });

  app.get('/authorization/resources', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const organizationId = url.searchParams.get('organization_id') ?? undefined;
    const resourceTypeSlug = url.searchParams.get('resource_type_slug') ?? undefined;
    const resourceExternalId = url.searchParams.get('resource_external_id') ?? undefined;
    const parentResourceId = url.searchParams.get('parent_resource_id') ?? undefined;
    // This list endpoint names the pair parent_resource_type_slug +
    // parent_external_id (not parent_resource_external_id) in production.
    const parentTypeSlug = url.searchParams.get('parent_resource_type_slug') ?? undefined;
    const parentExternalId = url.searchParams.get('parent_external_id') ?? undefined;

    const result = ws.authorizationResources.list({
      ...params,
      filter: (r) => {
        if (organizationId && r.organization_id !== organizationId) return false;
        if (resourceTypeSlug && r.resource_type_slug !== resourceTypeSlug) return false;
        if (resourceExternalId && r.external_id !== resourceExternalId) return false;
        if (parentResourceId && r.parent_resource_id !== parentResourceId) return false;
        if (parentTypeSlug || parentExternalId) {
          const parent = r.parent_resource_id ? ws.authorizationResources.get(r.parent_resource_id) : undefined;
          if (!parent) return false;
          if (parentTypeSlug && parent.resource_type_slug !== parentTypeSlug) return false;
          if (parentExternalId && parent.external_id !== parentExternalId) return false;
        }
        return true;
      },
    });

    return c.json(formatListResponse(result, formatAuthorizationResource));
  });

  app.get('/authorization/resources/:resource_id', (c) => {
    const resourceId = c.req.param('resource_id');
    const resource = ws.authorizationResources.get(resourceId);
    if (!resource) throw notFound('AuthorizationResource');
    return c.json(formatAuthorizationResource(resource));
  });

  app.put('/authorization/resources/:resource_id', async (c) => {
    const resourceId = c.req.param('resource_id');
    const resource = ws.authorizationResources.get(resourceId);
    if (!resource) throw notFound('AuthorizationResource');

    const body = await parseJsonBody(c);
    const updates: Record<string, unknown> = {};
    if ('metadata' in body) updates.metadata = body.metadata;
    if ('name' in body) updates.name = body.name ?? null;
    if ('description' in body) updates.description = body.description ?? null;
    if ('parent_resource_id' in body || 'parent_resource_external_id' in body || 'parent_resource_type_slug' in body) {
      // Explicit parent_resource_id: null detaches the resource from its parent.
      const nextParentId =
        body.parent_resource_id === null && !body.parent_resource_external_id && !body.parent_resource_type_slug
          ? null
          : (resolveParentResource(ws, body, resource.organization_id)?.id ?? null);

      // Re-parenting under the resource itself or one of its descendants would
      // make the two resources each other's ancestor, so a role assignment
      // scoped to either would grant permissions on both.
      if (nextParentId && collectSubtree(ws, resourceId).has(nextParentId)) {
        throw validationError(
          nextParentId === resourceId
            ? 'A resource cannot be its own parent'
            : 'A resource cannot be parented to one of its own descendants',
          [{ field: 'parent_resource_id', code: 'invalid' }],
        );
      }

      updates.parent_resource_id = nextParentId;
    }

    const updated = ws.authorizationResources.update(resourceId, updates);
    return c.json(formatAuthorizationResource(updated!));
  });

  // Deleting a resource takes its descendants and their role assignments with
  // it. Without cascade_delete=true a resource that has either is refused,
  // rather than leaving children pointing at an id that no longer resolves.
  app.delete('/authorization/resources/:resource_id', (c) => {
    const resourceId = c.req.param('resource_id');
    const resource = ws.authorizationResources.get(resourceId);
    if (!resource) throw notFound('AuthorizationResource');

    const subtree = collectSubtree(ws, resourceId);
    const assignments = [...subtree].flatMap((id) => ws.roleAssignments.findBy('resource_id', id));

    if (new URL(c.req.url).searchParams.get('cascade_delete') !== 'true' && (subtree.size > 1 || assignments.length)) {
      throw new WorkOSApiError(
        409,
        `Resource '${resourceId}' has descendant resources or role assignments. Retry with cascade_delete=true to delete them.`,
        'resource_has_dependents',
      );
    }

    for (const assignment of assignments) ws.roleAssignments.delete(assignment.id);
    for (const id of subtree) ws.authorizationResources.delete(id);
    return c.body(null, 204);
  });

  // Memberships that hold a permission on a resource. Production requires
  // permission_slug; without it (pre-0.11 emulator behavior) every membership
  // in the resource's organization is returned.
  const listMembershipsForResource = (c: Context, resource: WorkOSAuthorizationResource | undefined) => {
    if (!resource) throw notFound('AuthorizationResource');

    const permissionSlug = new URL(c.req.url).searchParams.get('permission_slug');
    const memberships = ws.organizationMemberships
      .findBy('organization_id', resource.organization_id)
      .filter((m) => !permissionSlug || getPermissionsForMembership(ws, m.id, resource).has(permissionSlug));
    return c.json({
      object: 'list',
      data: memberships.map((m) => formatMembership(m, ws)),
      list_metadata: { before: null, after: null },
    });
  };

  // Memberships with access to a resource (by resource ID)
  app.get('/authorization/resources/:resource_id/organization_memberships', (c) => {
    return listMembershipsForResource(c, ws.authorizationResources.get(c.req.param('resource_id')));
  });

  // Get resource by type + external ID within an org
  app.get('/authorization/organizations/:orgId/resources/:type_slug/:external_id', (c) => {
    const orgId = c.req.param('orgId');
    const typeSlug = c.req.param('type_slug');
    const externalId = c.req.param('external_id');

    const resource = ws.authorizationResources
      .findBy('organization_id', orgId)
      .find((r) => r.resource_type_slug === typeSlug && r.external_id === externalId);
    if (!resource) throw notFound('AuthorizationResource');
    return c.json(formatAuthorizationResource(resource));
  });

  // Memberships for resource by type + external ID within an org
  app.get('/authorization/organizations/:orgId/resources/:type_slug/:external_id/organization_memberships', (c) => {
    const resource = findResourceByExternalId(
      ws,
      c.req.param('orgId'),
      c.req.param('type_slug'),
      c.req.param('external_id'),
    );
    return listMembershipsForResource(c, resource);
  });
}
