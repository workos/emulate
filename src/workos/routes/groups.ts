import {
  type RouteContext,
  notFound,
  validationError,
  parseJsonBody,
  parseListParams,
  cursorPaginate,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatGroup, formatMembershipBase, formatListResponse } from '../helpers.js';

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
    if (!ws.organizations.get(organizationId)) throw notFound('Organization');

    const body = await parseJsonBody(c);
    const name = body.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw validationError('name is required', [{ field: 'name', code: 'required' }]);
    }

    const group = ws.groups.insert({
      object: 'group',
      organization_id: organizationId,
      name,
      description: typeof body.description === 'string' ? body.description : null,
    });

    return c.json(formatGroup(group), 201);
  });

  // List groups in an organization
  app.get('/organizations/:organizationId/groups', (c) => {
    const organizationId = c.req.param('organizationId');
    if (!ws.organizations.get(organizationId)) throw notFound('Organization');

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
    if (!group || group.organization_id !== c.req.param('organizationId')) throw notFound('Group');
    return c.json(formatGroup(group));
  });

  // Update a group
  app.patch('/organizations/:organizationId/groups/:groupId', async (c) => {
    const group = ws.groups.get(c.req.param('groupId'));
    if (!group || group.organization_id !== c.req.param('organizationId')) throw notFound('Group');

    const body = await parseJsonBody(c);
    const updates: Record<string, unknown> = {};

    if ('name' in body) {
      if (typeof body.name !== 'string' || body.name.length === 0) {
        throw validationError('name must be a non-empty string', [{ field: 'name', code: 'invalid' }]);
      }
      updates.name = body.name;
    }
    if ('description' in body) {
      updates.description = typeof body.description === 'string' ? body.description : null;
    }

    const updated = ws.groups.update(group.id, updates);
    return c.json(formatGroup(updated!));
  });

  // Delete a group
  app.delete('/organizations/:organizationId/groups/:groupId', (c) => {
    const group = ws.groups.get(c.req.param('groupId'));
    if (!group || group.organization_id !== c.req.param('organizationId')) throw notFound('Group');

    // Join rows are left in place rather than deleted here: deleting them would fire a
    // `group.member_removed` event per member, but a group deletion is one event
    // (`group.deleted`). The dangling rows are harmless — every read resolves the
    // group or membership and skips a miss (see the list endpoints below).
    ws.groups.delete(group.id);
    return c.body(null, 204);
  });

  // Add an organization membership to a group
  app.post('/organizations/:organizationId/groups/:groupId/organization-memberships', async (c) => {
    const group = ws.groups.get(c.req.param('groupId'));
    if (!group || group.organization_id !== c.req.param('organizationId')) throw notFound('Group');

    const body = await parseJsonBody(c);
    const omId = body.organization_membership_id;
    if (typeof omId !== 'string' || omId.length === 0) {
      throw validationError('organization_membership_id is required', [
        { field: 'organization_membership_id', code: 'required' },
      ]);
    }

    const membership = ws.organizationMemberships.get(omId);
    if (!membership) throw notFound('Organization Membership');

    if (membership.organization_id !== group.organization_id) {
      throw validationError('Organization Membership does not belong to this organization', [
        { field: 'organization_membership_id', code: 'invalid' },
      ]);
    }

    // Idempotent: adding an existing member returns the group rather than erroring, matching
    // production's tolerant re-add.
    const existing = ws.groupMemberships
      .findBy('group_id', group.id)
      .find((gm) => gm.organization_membership_id === omId);
    if (!existing) {
      ws.groupMemberships.insert({ group_id: group.id, organization_membership_id: omId });
    }

    return c.json(formatGroup(group));
  });

  // List the organization memberships in a group
  app.get('/organizations/:organizationId/groups/:groupId/organization-memberships', (c) => {
    const group = ws.groups.get(c.req.param('groupId'));
    if (!group || group.organization_id !== c.req.param('organizationId')) throw notFound('Group');

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
    if (!group || group.organization_id !== c.req.param('organizationId')) throw notFound('Group');

    const omId = c.req.param('omId');
    const gm = ws.groupMemberships.findBy('group_id', group.id).find((row) => row.organization_membership_id === omId);
    if (!gm) throw notFound('Organization Membership');

    ws.groupMemberships.delete(gm.id);
    return c.body(null, 204);
  });

  // List the groups an organization membership belongs to
  app.get('/user_management/organization_memberships/:omId/groups', (c) => {
    const omId = c.req.param('omId');
    if (!ws.organizationMemberships.get(omId)) throw notFound('Organization Membership');

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
