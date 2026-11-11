import {
  type RouteContext,
  notFound,
  WorkOSApiError,
  validationError,
  parseJsonBody,
  parseListParams,
  cursorPaginate,
  PlainApiError,
} from '../../core/index.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';
import { formatGroup, formatMembershipBase, formatListResponse } from '../helpers.js';

/** Production's `MAX_GROUP_NAME_LENGTH` and `MAX_GROUP_DESCRIPTION_LENGTH` (`api/src/constants.ts`). */
export const MAX_GROUP_NAME_LENGTH = 256;
export const MAX_GROUP_DESCRIPTION_LENGTH = 150;
/** Production's `DEFAULT_MAX_MEMBERS_PER_GROUP` (`group-memberships.service.ts`), its feature flag's default. */
export const MAX_MEMBERS_PER_GROUP = 500;

/**
 * The `name` a request body carries, held to production's DTO: a non-empty string of at most
 * 256 characters. `required` is whether the body must carry one at all (creation) or may leave
 * it out (update).
 */
function groupName(body: Record<string, unknown>, required: boolean): string | undefined {
  if (!('name' in body) && !required) return undefined;
  const name = body.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw validationError('Name must be a non-empty string.', [{ field: 'name', code: 'required' }]);
  }
  if (name.length > MAX_GROUP_NAME_LENGTH) {
    throw validationError(`name cannot be more than ${MAX_GROUP_NAME_LENGTH} characters`, [
      { field: 'name', code: 'invalid' },
    ]);
  }
  return name;
}

/**
 * The `description` a request body carries, held to production's DTO: absent or null clears it,
 * otherwise a non-empty string of at most 150 characters. Undefined when the body omits it.
 */
function groupDescription(body: Record<string, unknown>): string | null | undefined {
  if (!('description' in body)) return undefined;
  const description = body.description;
  if (description === null) return null;
  if (typeof description !== 'string' || description.length === 0) {
    throw validationError('Description must be a non-empty string.', [{ field: 'description', code: 'invalid' }]);
  }
  if (description.length > MAX_GROUP_DESCRIPTION_LENGTH) {
    throw validationError(`description cannot be more than ${MAX_GROUP_DESCRIPTION_LENGTH} characters`, [
      { field: 'description', code: 'invalid' },
    ]);
  }
  return description;
}

/**
 * Production keeps group names unique within an organization with a database constraint and
 * reports a collision as a bare 409 — the message alone, with no `code`.
 */
function assertGroupNameFree(ws: WorkOSStore, organizationId: string, name: string, exceptGroupId?: string): void {
  const taken = ws.groups
    .findBy('organization_id', organizationId)
    .some((g) => g.name === name && g.id !== exceptGroupId);
  if (taken) {
    throw new PlainApiError(
      409,
      `A group with name: ${name} already exists in the organization.`,
      'group_name_conflict',
      {
        error: 'Conflict',
      },
    );
  }
}

/**
 * AuthKit Groups (`/organizations/{organizationId}/groups`) — the org-scoped groups product
 * described at https://workos.com/docs/authkit/groups. A group belongs to one organization;
 * its members are organization memberships of that org, joined through `groupMemberships`.
 *
 * Events (`group.created` / `updated` / `deleted`, `group.member_added` / `member_removed`)
 * are emitted by collection hooks registered in `workosPlugin.register`, not inline here, so
 * seeded groups and API-created ones fire the same events.
 */
export function groupRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  // Create a group
  app.post('/organizations/:organizationId/groups', async (c) => {
    const organizationId = c.req.param('organizationId');
    if (!ws.organizations.get(organizationId)) throw notFound('Organization', organizationId);

    const body = await parseJsonBody(c);
    const name = groupName(body, true)!;
    const description = groupDescription(body) ?? null;
    assertGroupNameFree(ws, organizationId, name);

    const group = ws.groups.insert({
      object: 'group',
      organization_id: organizationId,
      name,
      description,
    });

    return c.json(formatGroup(group), 201);
  });

  // List groups in an organization
  app.get('/organizations/:organizationId/groups', (c) => {
    const organizationId = c.req.param('organizationId');
    if (!ws.organizations.get(organizationId)) throw notFound('Organization', organizationId);

    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const result = ws.groups.list({
      ...params,
      filter: (g) => g.organization_id === organizationId,
    });

    return c.json(formatListResponse(result, formatGroup));
  });

  // Get a group
  app.get('/organizations/:organizationId/groups/:groupId', (c) => {
    const group = ws.groups.get(c.req.param('groupId'));
    if (!group || group.organization_id !== c.req.param('organizationId'))
      throw notFound('Group', c.req.param('groupId'));
    return c.json(formatGroup(group));
  });

  // Update a group
  app.patch('/organizations/:organizationId/groups/:groupId', async (c) => {
    const group = ws.groups.get(c.req.param('groupId'));
    if (!group || group.organization_id !== c.req.param('organizationId'))
      throw notFound('Group', c.req.param('groupId'));

    const body = await parseJsonBody(c);
    const updates: Record<string, unknown> = {};

    const name = groupName(body, false);
    if (name !== undefined) {
      assertGroupNameFree(ws, group.organization_id, name, group.id);
      updates.name = name;
    }
    const description = groupDescription(body);
    if (description !== undefined) updates.description = description;

    const updated = ws.groups.update(group.id, updates);
    return c.json(formatGroup(updated!));
  });

  // Delete a group
  app.delete('/organizations/:organizationId/groups/:groupId', (c) => {
    const group = ws.groups.get(c.req.param('groupId'));
    if (!group || group.organization_id !== c.req.param('organizationId'))
      throw notFound('Group', c.req.param('groupId'));

    // Join rows are left in place rather than deleted here: deleting them would fire a
    // `group.member_removed` event per member, but a group deletion is one event
    // (`group.deleted`). The dangling rows are harmless — every read resolves the
    // group or membership and skips a miss (see the list endpoints below).
    ws.groupRoleAssignments.deleteBy('group_id', group.id);
    ws.groups.delete(group.id);
    return c.body(null, 204);
  });

  // Add an organization membership to a group
  app.post('/organizations/:organizationId/groups/:groupId/organization-memberships', async (c) => {
    const group = ws.groups.get(c.req.param('groupId'));
    if (!group || group.organization_id !== c.req.param('organizationId'))
      throw notFound('Group', c.req.param('groupId'));

    const body = await parseJsonBody(c);
    const omId = body.organization_membership_id;
    if (typeof omId !== 'string' || omId.length === 0) {
      throw validationError('organization_membership_id is required', [
        { field: 'organization_membership_id', code: 'required' },
      ]);
    }

    const membership = ws.organizationMemberships.get(omId);
    if (!membership) throw notFound('UserOrganizationMembership', omId);

    if (membership.organization_id !== group.organization_id) {
      throw validationError('Organization Membership does not belong to this organization', [
        { field: 'organization_membership_id', code: 'invalid' },
      ]);
    }

    // Production checks the group's size before it looks for the member, so a full group refuses
    // even a member it already holds. Rows whose membership is gone (a deleted user leaves them
    // behind, see the list endpoint) are not members and do not count.
    const rows = ws.groupMemberships.findBy('group_id', group.id);
    const memberCount = rows.filter((gm) => ws.organizationMemberships.get(gm.organization_membership_id)).length;
    if (memberCount >= MAX_MEMBERS_PER_GROUP) {
      throw new WorkOSApiError(
        400,
        `Group '${group.id}' cannot have more than ${MAX_MEMBERS_PER_GROUP} members.`,
        'group_membership_limit_exceeded',
      );
    }

    // Idempotent: adding an existing member returns the group rather than erroring, matching
    // production's tolerant re-add.
    const existing = rows.find((gm) => gm.organization_membership_id === omId);
    if (!existing) {
      ws.groupMemberships.insert({ group_id: group.id, organization_membership_id: omId });
    }

    return c.json(formatGroup(group));
  });

  // List the organization memberships in a group
  app.get('/organizations/:organizationId/groups/:groupId/organization-memberships', (c) => {
    const group = ws.groups.get(c.req.param('groupId'));
    if (!group || group.organization_id !== c.req.param('organizationId'))
      throw notFound('Group', c.req.param('groupId'));

    const url = new URL(c.req.url);
    const params = parseListParams(url);

    // Resolve join rows to memberships, skipping any whose membership was deleted (user
    // deletion cascades memberships but not join rows) so a dangling id never surfaces.
    const memberships = ws.groupMemberships
      .findBy('group_id', group.id)
      .map((gm) => ws.organizationMemberships.get(gm.organization_membership_id))
      .filter((m): m is NonNullable<typeof m> => m !== undefined);

    const result = cursorPaginate(memberships, params);
    return c.json(formatListResponse(result, formatMembershipBase));
  });

  // Remove an organization membership from a group
  app.delete('/organizations/:organizationId/groups/:groupId/organization-memberships/:omId', (c) => {
    const group = ws.groups.get(c.req.param('groupId'));
    if (!group || group.organization_id !== c.req.param('organizationId'))
      throw notFound('Group', c.req.param('groupId'));

    const omId = c.req.param('omId');
    const gm = ws.groupMemberships.findBy('group_id', group.id).find((row) => row.organization_membership_id === omId);
    // Production's GroupMembershipNotFoundException (api-services group-memberships) is a plain
    // Nest 404 with its own code rather than an entity_not_found.
    if (!gm) {
      throw new WorkOSApiError(
        404,
        `Group membership not found for organization membership '${omId}' in group '${group.id}'.`,
        'membership_not_found',
      );
    }

    ws.groupMemberships.delete(gm.id);
    return c.body(null, 204);
  });

  // List the groups an organization membership belongs to
  app.get('/user_management/organization_memberships/:omId/groups', (c) => {
    const omId = c.req.param('omId');
    if (!ws.organizationMemberships.get(omId)) throw notFound('UserOrganizationMembership', omId);

    const url = new URL(c.req.url);
    const params = parseListParams(url);

    const groups = ws.groupMemberships
      .findBy('organization_membership_id', omId)
      .map((gm) => ws.groups.get(gm.group_id))
      .filter((g): g is NonNullable<typeof g> => g !== undefined);

    const result = cursorPaginate(groups, params);
    return c.json(formatListResponse(result, formatGroup));
  });
}
