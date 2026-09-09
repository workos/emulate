import type { WorkOSAuthorizationResource, WorkOSOrganization } from './entities.js';
import type { WorkOSStore } from './store.js';

// Production names the root after the organization and gives it the
// organization's external_id, falling back to the organization id.
function organizationResourceValues(organization: WorkOSOrganization) {
  return { name: organization.name, external_id: organization.external_id ?? organization.id };
}

/**
 * The organization's implicit FGA root, created on first use. Mirrors production's
 * findOrCreateOrganizationResource: every path that needs the root resolves it this way, so an
 * organization that reached the store without passing through the routes or the seed still
 * gets one instead of leaving its resources parentless.
 */
export function findOrCreateOrganizationResource(
  ws: WorkOSStore,
  organization: WorkOSOrganization,
): WorkOSAuthorizationResource {
  const existing = ws.authorizationResources
    .findBy('organization_id', organization.id)
    .find((resource) => resource.resource_type_slug === 'organization');
  if (existing) return existing;
  return ws.authorizationResources.insert({
    object: 'authorization_resource',
    organization_id: organization.id,
    resource_type_slug: 'organization',
    ...organizationResourceValues(organization),
    description: null,
    parent_resource_id: null,
    metadata: {},
  });
}

/** Keep the implicit FGA root in sync with its owning organization. */
export function syncOrganizationResource(ws: WorkOSStore, organization: WorkOSOrganization): void {
  const root = findOrCreateOrganizationResource(ws, organization);
  const values = organizationResourceValues(organization);
  if (root.name !== values.name || root.external_id !== values.external_id) {
    ws.authorizationResources.update(root.id, values);
  }
  // Role assignments denormalize the resource's external_id, where production reads it
  // through a join, so grants on a renamed root must show its current external_id.
  for (const assignment of ws.roleAssignments.findBy('resource_id', root.id)) {
    if (assignment.resource_external_id !== values.external_id) {
      ws.roleAssignments.update(assignment.id, { resource_external_id: values.external_id });
    }
  }
}
