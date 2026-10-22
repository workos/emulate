import {
  type RouteContext,
  notFound,
  validationError,
  parseJsonBody,
  WorkOSApiError,
  parseListParams,
  parseArrayParam,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatMembership, formatListResponse, liveMembershipFor } from '../helpers.js';
import { invalidRole, membershipRoleFields, roleSlugsFromBody, undefinedRoleSlug } from '../membership-roles.js';
import { deleteAgentInstancesForMembership, revokeAgentSessionsForMembership } from '../agent-sessions.js';

export function membershipRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/user_management/organization_memberships', async (c) => {
    const body = await parseJsonBody(c);
    const organizationId = body.organization_id as string | undefined;
    const userId = body.user_id as string | undefined;

    if (!organizationId) {
      throw validationError('organization_id is required', [{ field: 'organization_id', code: 'required' }]);
    }
    if (!userId) {
      throw validationError('user_id is required', [{ field: 'user_id', code: 'required' }]);
    }

    const org = ws.organizations.get(organizationId);
    if (!org) throw notFound('Organization', organizationId);

    // Real WorkOS 404s an unknown user; validating here also guarantees the embedded
    // `user` in the response (and every later read) is always resolvable, never null.
    const user = ws.users.get(userId);
    if (!user) throw notFound('User', userId);

    // Production resolves the requested roles before it looks at any existing membership, and
    // a slug that names no role of this organization or of the environment is a 422.
    const requestedSlugs = roleSlugsFromBody(body);
    if (requestedSlugs && undefinedRoleSlug(ws, organizationId, requestedSlugs)) throw invalidRole(422);

    const existing = liveMembershipFor(ws, organizationId, userId);
    // The API reference: a pending membership is an unaccepted invitation, which the user has to
    // accept; creating over it is a 400. An active one is answered with the membership as it is,
    // role included — production does not 409 here, and the reference lists no 409 for this
    // endpoint.
    if (existing?.status === 'pending') {
      throw new WorkOSApiError(
        400,
        'A pending organization membership cannot be reactivated. The user needs to accept the invitation instead.',
        'cannot_reactivate_pending_organization_membership',
      );
    }
    if (existing) return c.json(formatMembership(existing, ws), 201);

    const roleFields = membershipRoleFields(ws, organizationId, requestedSlugs ?? ['member']);

    // The API reference: creating over an inactive membership activates it with the requested
    // role(s), so the user keeps one membership and its id rather than gaining a second.
    const inactive = ws.organizationMemberships
      .findBy('organization_id', organizationId)
      .find((m) => m.user_id === userId && m.status === 'inactive');
    if (inactive) {
      const reactivated = ws.organizationMemberships.update(inactive.id, { status: 'active', ...roleFields });
      return c.json(formatMembership(reactivated!, ws), 201);
    }

    const membership = ws.organizationMemberships.insert({
      object: 'organization_membership',
      organization_id: organizationId,
      user_id: userId,
      ...roleFields,
      status: 'active',
      external_id: (body.external_id as string) ?? null,
      metadata: (body.metadata as Record<string, string>) ?? {},
    });

    return c.json(formatMembership(membership, ws), 201);
  });

  app.get('/user_management/organization_memberships', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const orgFilter = url.searchParams.get('organization_id') ?? undefined;
    const userFilter = url.searchParams.get('user_id') ?? undefined;
    // Production lists memberships of a user, of an organization, or of both, never of the whole
    // environment.
    if (!orgFilter && !userFilter) {
      throw new WorkOSApiError(
        400,
        'At least one of organization_id or user_id must be provided.',
        'missing_user_id_or_organization_id',
      );
    }
    // Production returns only active memberships when the request names no status.
    const requestedStatuses = parseArrayParam(url, 'statuses');
    const statuses = requestedStatuses.length > 0 ? requestedStatuses : ['active'];

    const result = ws.organizationMemberships.list({
      ...params,
      filter: (m) => {
        if (orgFilter && m.organization_id !== orgFilter) return false;
        if (userFilter && m.user_id !== userFilter) return false;
        if (!statuses.includes(m.status)) return false;
        return true;
      },
    });

    return c.json(formatListResponse(result, (m) => formatMembership(m, ws)));
  });

  app.get('/user_management/organization_memberships/:id', (c) => {
    const m = ws.organizationMemberships.get(c.req.param('id'));
    if (!m) throw notFound('UserOrganizationMembership', c.req.param('id'));
    return c.json(formatMembership(m, ws));
  });

  app.put('/user_management/organization_memberships/:id', async (c) => {
    const m = ws.organizationMemberships.get(c.req.param('id'));
    if (!m) throw notFound('UserOrganizationMembership', c.req.param('id'));

    const body = await parseJsonBody(c);
    const updates: Record<string, unknown> = {};

    const roleSlugs = roleSlugsFromBody(body);
    if (roleSlugs) {
      if (undefinedRoleSlug(ws, m.organization_id, roleSlugs)) throw invalidRole(422);
      Object.assign(updates, membershipRoleFields(ws, m.organization_id, roleSlugs));
    }
    if ('external_id' in body) {
      updates.external_id = body.external_id ?? null;
    }
    if ('metadata' in body) {
      updates.metadata = body.metadata ?? {};
    }

    const updated = ws.organizationMemberships.update(m.id, updates);
    return c.json(formatMembership(updated!, ws));
  });

  app.delete('/user_management/organization_memberships/:id', (c) => {
    const m = ws.organizationMemberships.get(c.req.param('id'));
    if (!m) throw notFound('UserOrganizationMembership', c.req.param('id'));
    deleteAgentInstancesForMembership(ws, m.id);
    // Role assignments hang off the membership and go with it, as in production.
    ws.roleAssignments.deleteBy('organization_membership_id', m.id);
    ws.organizationMemberships.delete(m.id);
    return c.body(null, 204);
  });

  app.put('/user_management/organization_memberships/:id/deactivate', (c) => {
    const m = ws.organizationMemberships.get(c.req.param('id'));
    if (!m) throw notFound('UserOrganizationMembership', c.req.param('id'));
    // The API reference: a pending membership is an unaccepted invitation, revoked rather than
    // deactivated; an inactive one is a no-op that emits no event, so the store is not touched.
    if (m.status === 'pending') {
      throw new WorkOSApiError(
        400,
        'Pending organization memberships cannot be deactivated. The invite must be revoked instead.',
        'cannot_deactivate_pending_organization_membership',
      );
    }
    if (m.status === 'inactive') return c.json(formatMembership(m, ws));
    const updated = ws.organizationMemberships.update(m.id, {
      status: 'inactive',
    });
    revokeAgentSessionsForMembership(ws, m.id);
    return c.json(formatMembership(updated!, ws));
  });

  app.put('/user_management/organization_memberships/:id/reactivate', (c) => {
    const m = ws.organizationMemberships.get(c.req.param('id'));
    if (!m) throw notFound('UserOrganizationMembership', c.req.param('id'));
    // The API reference: a pending membership becomes active by accepting its invitation; an
    // active one is a no-op that emits no event.
    if (m.status === 'pending') {
      throw new WorkOSApiError(
        400,
        'A pending organization membership cannot be reactivated. The user needs to accept the invitation instead.',
        'cannot_reactivate_pending_organization_membership',
      );
    }
    if (m.status === 'active') return c.json(formatMembership(m, ws));
    const updated = ws.organizationMemberships.update(m.id, {
      status: 'active',
    });
    return c.json(formatMembership(updated!, ws));
  });
}
