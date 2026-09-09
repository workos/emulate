import type { WorkOSOrganization } from './entities.js';
import type { WorkOSStore } from './store.js';

/** Keep the implicit FGA root in sync with its owning organization. */
export function syncOrganizationResource(ws: WorkOSStore, organization: WorkOSOrganization): void {
  const root = ws.authorizationResources
    .findBy('organization_id', organization.id)
    .find((resource) => resource.resource_type_slug === 'organization');
  const values = {
    name: organization.name,
    external_id: organization.external_id ?? organization.id,
  };
  if (root) {
    ws.authorizationResources.update(root.id, values);
    for (const assignment of ws.roleAssignments.findBy('resource_id', root.id)) {
      ws.roleAssignments.update(assignment.id, { resource_external_id: values.external_id });
    }
  } else {
    ws.authorizationResources.insert({
      object: 'authorization_resource',
      organization_id: organization.id,
      resource_type_slug: 'organization',
      ...values,
      description: null,
      parent_resource_id: null,
      metadata: {},
    });
  }
}
