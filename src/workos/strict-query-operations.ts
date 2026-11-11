import type { StrictQueryPipe, StrictQueryRule } from '../core/index.js';
import { QUERY_PARAMETERS, type QueryOperation } from './generated/query-params.js';

/**
 * The operations whose unknown query parameters production refuses.
 *
 * Production has no global validation pipe: each controller picks one per `@Query(...)`, and only
 * a pipe built with `forbidNonWhitelisted: true` turns a parameter its DTO does not declare into
 * a 422. The spec does not say which operations those are, so this table does, by hand: one entry
 * per `forbidNonWhitelisted` query pipe in production's `packages/api/src`, for the operations the
 * emulator serves. `controller` is the production file the pipe was read from, relative to that
 * directory, and `dto` the class it validates against.
 *
 * The parameters an operation accepts are not listed here. They come from the spec, through the
 * generated `QUERY_PARAMETERS` catalog, and `QUERY_PARAMETER_OVERRIDES` below records the places
 * production's DTO and the spec disagree.
 *
 * An operation that is absent is one whose query production does not police (a bare `@Query()`,
 * a named `@Query('name')`, or a pipe without `forbidNonWhitelisted`), or one the emulator does
 * not serve.
 */
interface StrictQueryOperation {
  controller: string;
  dto: string;
  /** Defaults to `validation`, production's `ValidationPipe`. */
  pipe?: StrictQueryPipe;
}

export const STRICT_QUERY_OPERATIONS: Partial<Record<QueryOperation, StrictQueryOperation>> = {
  'GET /agents/blueprints': {
    controller: 'agent-blueprints/agent-blueprints.controller.ts',
    dto: 'PaginationOptionsDto',
  },
  'GET /agents/instances': {
    controller: 'agent-blueprints/agent-instances.controller.ts',
    dto: 'ListAgentInstancesQueryDto',
  },
  'GET /agents/sessions': {
    controller: 'agent-blueprints/agent-instance-sessions.controller.ts',
    dto: 'ListAgentInstanceSessionsQueryDto',
  },
  'GET /audit_logs/actions': {
    controller: 'audit-log-validators/audit-log-validators.controller.ts',
    dto: 'AuditLogActionListQueryParams',
  },
  'GET /authorization/groups/{group_id}/role_assignments': {
    controller: 'authorization/authorization-group-role-assignments.controller.ts',
    dto: 'PaginationOptionsDto',
  },
  'GET /authorization/organization_memberships/{organization_membership_id}/resources': {
    controller: 'authorization/authorization.controller.ts',
    dto: 'ListResourcesForMembershipDto',
  },
  'GET /authorization/organization_memberships/{organization_membership_id}/resources/{resource_id}/permissions': {
    controller: 'authorization/authorization.controller.ts',
    dto: 'ListEffectivePermissionsDto',
  },
  'GET /authorization/organization_memberships/{organization_membership_id}/resources/{resource_type_slug}/{external_id}/permissions':
    {
      controller: 'authorization/authorization.controller.ts',
      dto: 'ListEffectivePermissionsDto',
    },
  'GET /authorization/organization_memberships/{organization_membership_id}/role_assignments': {
    controller: 'authorization/authorization-role-assignments.controller.ts',
    dto: 'ListMembershipRoleAssignmentsQueryDto',
  },
  'GET /authorization/organizations/{organization_id}/resources/{resource_type_slug}/{external_id}/organization_memberships':
    {
      controller: 'authorization-resources/authorization-resources-by-external-id.controller.ts',
      dto: 'ListOrganizationMembershipsForResourceDto',
    },
  'GET /authorization/organizations/{organization_id}/resources/{resource_type_slug}/{external_id}/role_assignments': {
    controller: 'authorization/authorization-role-assignments.controller.ts',
    dto: 'ListResourceRoleAssignmentsQueryDto',
  },
  'GET /authorization/permissions': {
    controller: 'authorization-permissions/authorization-permissions.controller.ts',
    dto: 'ListAuthorizationPermissionsQueryDto',
  },
  'GET /authorization/resources': {
    controller: 'authorization-resources/authorization-resources.controller.ts',
    dto: 'ListAuthorizationResourcesDto',
  },
  'DELETE /authorization/resources/{resource_id}': {
    controller: 'authorization-resources/authorization-resources.controller.ts',
    dto: 'DeleteAuthorizationResourceDto',
  },
  'GET /authorization/resources/{resource_id}/organization_memberships': {
    controller: 'authorization-resources/authorization-resources.controller.ts',
    dto: 'ListOrganizationMembershipsForResourceDto',
  },
  'GET /authorization/resources/{resource_id}/role_assignments': {
    controller: 'authorization/authorization-role-assignments.controller.ts',
    dto: 'ListResourceRoleAssignmentsQueryDto',
  },
  'GET /connect/applications': {
    controller: 'applications/applications.controller.ts',
    dto: 'ListApplicationsQueryDto',
  },
  'GET /connections': {
    controller: 'connections/connections.controller.ts',
    dto: 'ConnectionListQueryParams',
  },
  'GET /directories': {
    controller: 'directories/directories.controller.ts',
    dto: 'DirectoryListQueryParams',
  },
  'GET /directory_groups': {
    controller: 'directory-groups/directory-groups.controller.ts',
    dto: 'ListDirectoryGroupsOptionsDto',
  },
  'GET /directory_users': {
    controller: 'directory-users/directory-users.controller.ts',
    dto: 'ListDirectoryUsersOptionsDto',
  },
  'GET /events': {
    controller: 'events/events.controller.ts',
    dto: 'ListEventOptionsDto',
  },
  'GET /feature-flags': {
    controller: 'flags/flags.controller.ts',
    dto: 'ListFeatureFlagsQueryParams',
  },
  'GET /organizations': {
    controller: 'organizations/organizations.controller.ts',
    dto: 'ListOrganizationsOptionsDto',
  },
  'GET /organizations/{organizationId}/feature-flags': {
    controller: 'organization-feature-flags/organization-feature-flags.controller.ts',
    dto: 'OrganizationFeatureFlagListQueryParams',
  },
  'GET /organizations/{organizationId}/groups': {
    controller: 'groups/groups.controller.ts',
    dto: 'ListGroupsQueryDto',
  },
  'GET /organizations/{organizationId}/groups/{groupId}/organization-memberships': {
    controller: 'group-memberships/group-memberships.controller.ts',
    dto: 'PaginationOptionsDto',
  },
  'GET /organizations/{organization_id}/authorized_applications': {
    controller: 'application-consents/organization-authorized-applications.controller.ts',
    dto: 'ListAuthorizedApplicationsQueryDto',
  },
  'GET /user_management/authkit_oauth_resources': {
    controller: 'authkit-oauth-resources/authkit-oauth-resources.controller.ts',
    dto: 'PaginationOptionsDto',
  },
  'GET /user_management/invitations': {
    controller: 'userland-user-invites/userland-user-invites.controller.ts',
    dto: 'ListUserlandUserInvitesOptionsDto',
    pipe: 'validation_with_error_code',
  },
  'GET /user_management/organization_memberships': {
    controller: 'userland-user-organization-memberships/userland-user-organization-memberships.controller.ts',
    dto: 'ListUserlandUserOrganizationMembershipsOptionsDto',
  },
  'GET /user_management/organization_memberships/{omId}/groups': {
    controller: 'group-memberships/organization-membership-groups.controller.ts',
    dto: 'PaginationOptionsDto',
  },
  'GET /user_management/users': {
    controller: 'userland-users/userland-users.controller.ts',
    dto: 'ListUserlandUsersOptionsDto',
  },
  'GET /user_management/users/{id}/sessions': {
    controller: 'userland-users/userland-user-sessions.controller.ts',
    dto: 'DescOrderPaginationOptionsDto',
    pipe: 'validation_with_error_code',
  },
  'GET /user_management/users/{userId}/feature-flags': {
    controller: 'userland-user-feature-flags/userland-user-feature-flags.controller.ts',
    dto: 'UserlandUserFeatureFlagListQueryParams',
  },
  'GET /user_management/users/{user_id}/authorized_applications': {
    controller: 'application-consents/authorized-applications.controller.ts',
    dto: 'ListAuthorizedApplicationsQueryDto',
  },
  'GET /user_management/users/{userlandUserId}/auth_factors': {
    controller: 'userland-user-authentication-factors/userland-user-authentication-factors.controller.ts',
    dto: 'AuthenticationFactorListQueryParams',
  },
  'GET /webhook_endpoints': {
    controller: 'webhook-endpoints/webhook-endpoints.controller.ts',
    dto: 'ListWebhookEndpointsOptionsDto',
  },
};

/**
 * Where production's DTO and the spec disagree about an operation's query parameters, the DTO
 * wins, since the DTO is what the pipe checks against: `add` is a parameter the DTO declares and
 * the spec leaves out, `remove` one the spec lists and the DTO does not declare.
 */
export const QUERY_PARAMETER_OVERRIDES: Partial<
  Record<QueryOperation, { add?: readonly string[]; remove?: readonly string[] }>
> = {
  // `ConnectionListQueryParams.external_id` is validated (`@IsOptional() @IsString()
  // @IsNotEmpty()`) but hidden from the spec with `@ApiHideProperty()`.
  'GET /connections': { add: ['external_id'] },
};

/** The table above as rules for `strictQueryMiddleware`, each with the parameters it accepts. */
export function strictQueryRules(): StrictQueryRule[] {
  return (Object.keys(STRICT_QUERY_OPERATIONS) as QueryOperation[]).map((operation) => {
    const separator = operation.indexOf(' ');
    const override = QUERY_PARAMETER_OVERRIDES[operation];
    const declared: readonly string[] = QUERY_PARAMETERS[operation];
    return {
      method: operation.slice(0, separator),
      path: operation.slice(separator + 1),
      allowed: [...declared.filter((name) => !override?.remove?.includes(name)), ...(override?.add ?? [])],
      pipe: STRICT_QUERY_OPERATIONS[operation]?.pipe ?? 'validation',
    };
  });
}
