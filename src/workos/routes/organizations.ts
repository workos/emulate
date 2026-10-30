import {
  type RouteContext,
  notFound,
  validationError,
  parseJsonBody,
  parseListParams,
  WorkOSApiError,
} from '../../core/index.js';
import { syncOrganizationResource } from '../organization-resource.js';
import { getWorkOSStore } from '../store.js';
import {
  formatOrganization,
  formatListResponse,
  formatAuthorizedApplication,
  revokeApiKeysForOwner,
} from '../helpers.js';
import type { WorkOSOrganization, WorkOSOrganizationDomain } from '../entities.js';
import { deleteAgentInstancesForOrganization } from '../agent-sessions.js';
import {
  type DomainDataEntry,
  insertOrganizationDomain,
  parseDomainData,
  rejectConsumerDomains,
} from '../domain-helpers.js';

/** Production's `external_id` uniqueness failure, the same 400 on create and update. */
function externalIdAlreadyUsed(): WorkOSApiError {
  return new WorkOSApiError(
    400,
    'The external_id provided has already been assigned to another organization.',
    'external_id_already_used',
  );
}

export function organizationRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/organizations', async (c) => {
    const body = await parseJsonBody(c);
    const name = body.name as string | undefined;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw validationError('Name is required', [{ field: 'name', code: 'required' }]);
    }

    // Production's order: the payload is validated, then the external_id is checked against the
    // environment, then the domains are created — where a consumer domain fails the transaction.
    // Everything is checked before the organization is written so no `organization.created`
    // precedes a rejection.
    const domainData = parseDomainData(body);
    const externalId = (body.external_id as string | null | undefined) ?? null;
    if (externalId !== null && ws.organizations.findOneBy('external_id', externalId)) {
      throw externalIdAlreadyUsed();
    }
    if (domainData) rejectConsumerDomains(domainData.map((d) => d.domain));

    const org = ws.organizations.insert({
      object: 'organization',
      name: name.trim(),
      external_id: externalId,
      metadata: (body.metadata as Record<string, string>) ?? {},
      stripe_customer_id: null,
      allow_profiles_outside_organization: false,
      // Not in the spec's create shape; entitlements are seeded, not set over the API.
      entitlements: [],
    });

    syncOrganizationResource(ws, org);

    for (const entry of domainData ?? []) {
      insertOrganizationDomain(ws, org.id, entry);
    }

    return c.json(formatOrganization(org, ws), 201);
  });

  app.get('/organizations', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const search = url.searchParams.get('search') ?? undefined;
    const domainsFilter = url.searchParams.get('domains') ?? undefined;

    const result = ws.organizations.list({
      ...params,
      filter: (org) => {
        if (search && !org.name.toLowerCase().includes(search.toLowerCase())) {
          return false;
        }
        if (domainsFilter) {
          const orgDomains = ws.organizationDomains.findBy('organization_id', org.id);
          if (!orgDomains.some((d) => d.domain === domainsFilter)) {
            return false;
          }
        }
        return true;
      },
    });

    // Pre-fetch all domains once to avoid N+1 lookups per org
    const allDomains = ws.organizationDomains.all();
    const domainsByOrg = new Map<string, WorkOSOrganizationDomain[]>();
    for (const d of allDomains) {
      const list = domainsByOrg.get(d.organization_id) ?? [];
      list.push(d);
      domainsByOrg.set(d.organization_id, list);
    }

    return c.json(
      formatListResponse(result, (org) => formatOrganization(org, ws, { domains: domainsByOrg.get(org.id) ?? [] })),
    );
  });

  app.get('/organizations/:id', (c) => {
    const org = ws.organizations.get(c.req.param('id'));
    if (!org) throw notFound('Organization', c.req.param('id'));
    return c.json(formatOrganization(org, ws));
  });

  app.get('/organizations/:id/authorized_applications', (c) => {
    const org = ws.organizations.get(c.req.param('id'));
    if (!org) throw notFound('Organization', c.req.param('id'));

    // An organization's authorized applications are the ones granted by its
    // members. The spec item carries a `user_id`, so we filter the shared
    // authorized-applications collection by org membership — mirroring the
    // user-level endpoint's simplified model.
    const memberUserIds = new Set(ws.organizationMemberships.findBy('organization_id', org.id).map((m) => m.user_id));
    const apps = ws.authorizedApplications.all().filter((a) => memberUserIds.has(a.user_id));
    return c.json({
      object: 'list',
      data: apps.map(formatAuthorizedApplication),
      list_metadata: { before: null, after: null },
    });
  });

  app.get('/organizations/external_id/:external_id', (c) => {
    const org = ws.organizations.findOneBy('external_id', c.req.param('external_id'));
    if (!org) throw notFound('Organization', c.req.param('external_id'));
    return c.json(formatOrganization(org, ws));
  });

  app.put('/organizations/:id', async (c) => {
    const body = await parseJsonBody(c);
    // Looked up after the body has been read: the unchanged-field check below must compare against
    // the organization as it stands now, not as it stood before the request body arrived.
    const org = ws.organizations.get(c.req.param('id'));
    if (!org) throw notFound('Organization', c.req.param('id'));

    const updates: Record<string, unknown> = {};

    if ('name' in body) {
      if (!body.name || typeof body.name !== 'string' || (body.name as string).trim().length === 0) {
        throw validationError('Name is required', [{ field: 'name', code: 'required' }]);
      }
      updates.name = (body.name as string).trim();
    }
    const domainData = parseDomainData(body);
    if ('external_id' in body) {
      const externalId = (body.external_id as string | null | undefined) ?? null;
      if (externalId !== null) {
        const holder = ws.organizations.findOneBy('external_id', externalId);
        if (holder && holder.id !== org.id) throw externalIdAlreadyUsed();
      }
      updates.external_id = externalId;
    }
    if ('metadata' in body) updates.metadata = body.metadata ?? {};
    if ('allow_profiles_outside_organization' in body) {
      updates.allow_profiles_outside_organization = Boolean(body.allow_profiles_outside_organization);
    }

    // Production sets the domains with `recreateExistingDomainsWithDifferentState`: a row survives
    // only when the payload repeats both its domain and its state, so a pending domain resent as
    // verified is deleted and recreated verified under a new id, while a domain resent unchanged
    // keeps its row, token and all. The consumer-domain check covers only what will be created,
    // and runs before the organization is written so no `organization.updated` precedes a 422.
    let domainChanges: { remove: WorkOSOrganizationDomain[]; add: DomainDataEntry[] } | undefined;
    if (domainData) {
      const existing = ws.organizationDomains.findBy('organization_id', org.id);
      const same = (a: { domain: string; state: string }, b: { domain: string; state: string }) =>
        a.domain === b.domain && a.state === b.state;
      domainChanges = {
        remove: existing.filter((d) => !domainData.some((e) => same(d, e))),
        add: domainData.filter((e) => !existing.some((d) => same(d, e))),
      };
      rejectConsumerDomains(domainChanges.add.map((e) => e.domain));
    }

    // Production writes the organization first and emits `organization.updated` from that write
    // (creator-updater `update`), only when a field actually changed and with the domains as they
    // stand at that moment; the domain writes follow and report themselves through their own
    // events. So a domain-only update emits no `organization.updated`, and one that also changes a
    // field carries the pre-change domains in that event while the response carries the new ones.
    const changed = Object.fromEntries(
      Object.entries(updates).filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(org[key as keyof WorkOSOrganization]),
      ),
    );
    let updated = org;
    if (Object.keys(changed).length > 0) {
      updated = ws.organizations.update(org.id, changed)!;
      syncOrganizationResource(ws, updated);
    }

    if (domainChanges) {
      for (const d of domainChanges.remove) ws.organizationDomains.delete(d.id);
      for (const entry of domainChanges.add) insertOrganizationDomain(ws, org.id, entry);
    }

    return c.json(formatOrganization(updated, ws));
  });

  app.delete('/organizations/:id', (c) => {
    const org = ws.organizations.get(c.req.param('id'));
    if (!org) throw notFound('Organization', c.req.param('id'));

    ws.organizationDomains.deleteBy('organization_id', org.id);
    ws.itContacts.deleteBy('organization_id', org.id);
    for (const membership of ws.organizationMemberships.findBy('organization_id', org.id)) {
      ws.roleAssignments.deleteBy('organization_membership_id', membership.id);
    }
    // Before the memberships: delegated instances reference them, and tearing the instances
    // down first is what fires their deleted and session-revoked events.
    deleteAgentInstancesForOrganization(ws, org.id);
    ws.organizationMemberships.deleteBy('organization_id', org.id);
    // Same as the user cascade: an organization target with no organization behind it is
    // unreachable through the target routes.
    ws.flagTargets.deleteBy('resource_id', org.id);
    // As in the user cascade, each emits disconnected through the delete hook: the
    // organization's own accounts and its members' accounts scoped to it.
    ws.connectedAccounts.deleteBy('organization_id', org.id);
    ws.dataIntegrationAuthorizations.deleteBy('organization_id', org.id);
    // Both kinds of key scoped to this org go with it — the org's own, and members' keys
    // issued inside it, which the membership deletion above has just left unbacked. Same
    // ownership test the org listing route applies, so nothing it would list survives.
    revokeApiKeysForOwner(store, ws, (o) => (o.type === 'organization' ? o.id : o.organization_id) === org.id);

    for (const group of ws.groups.findBy('organization_id', org.id)) {
      ws.groupRoleAssignments.deleteBy('group_id', group.id);
      ws.groups.delete(group.id);
    }
    for (const resource of ws.authorizationResources.findBy('organization_id', org.id)) {
      ws.roleAssignments.deleteBy('resource_id', resource.id);
      ws.groupRoleAssignments.deleteBy('resource_id', resource.id);
      ws.authorizationResources.delete(resource.id);
    }
    ws.organizations.delete(org.id);
    return c.body(null, 204);
  });
}
