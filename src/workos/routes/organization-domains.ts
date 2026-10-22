import { type RouteContext, notFound, parseJsonBody, validationFailed, WorkOSApiError } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatDomain } from '../helpers.js';
import { isValidDomain, normalizeDomain, startDnsVerification } from '../domain-helpers.js';

export function organizationDomainRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/organization_domains', async (c) => {
    const body = await parseJsonBody(c);

    // Production's CreateOrganizationDomainDto: `domain` must be a valid domain name and
    // `organization_id` a string, both reported by the validation pipe before any lookup.
    const errors: Array<{ field: string; code: string }> = [];
    if (!isValidDomain(body.domain)) errors.push({ field: 'domain', code: 'domain must be valid domain name' });
    if (typeof body.organization_id !== 'string') {
      errors.push({ field: 'organization_id', code: 'organization_id must be a string' });
    }
    if (errors.length > 0) throw validationFailed(errors);

    const organizationId = body.organization_id as string;
    const org = ws.organizations.get(organizationId);
    if (!org) throw notFound('Organization', organizationId);

    const domain = normalizeDomain(body.domain as string);
    const existing = ws.organizationDomains.findBy('organization_id', org.id).find((d) => d.domain === domain);
    if (existing) {
      throw new WorkOSApiError(409, 'Domain already exists for this organization.', 'domain_already_exists');
    }

    // Two writes, as in production: the domain is created pending, then DNS verification is
    // started on it in the same request, so `organization_domain.created` is followed by
    // `organization_domain.updated` carrying the `dns` strategy and the token.
    const created = ws.organizationDomains.insert({
      object: 'organization_domain',
      organization_id: org.id,
      domain,
      state: 'pending',
    });
    return c.json(formatDomain(startDnsVerification(ws, created)), 201);
  });

  app.get('/organization_domains/:id', (c) => {
    const domain = ws.organizationDomains.get(c.req.param('id'));
    if (!domain) throw notFound('Organization Domain', c.req.param('id'));
    return c.json(formatDomain(domain));
  });

  app.delete('/organization_domains/:id', (c) => {
    const domain = ws.organizationDomains.get(c.req.param('id'));
    if (!domain) throw notFound('Organization Domain', c.req.param('id'));
    ws.organizationDomains.delete(domain.id);
    return c.body(null, 204);
  });

  // Starts DNS verification; it does not verify. Production answers 201 with the domain pending
  // under the `dns` strategy and a fresh token, and leaves it to a cron that resolves the TXT
  // record. The emulator has no such cron, so the domain stays pending: seed `state: verified`
  // or send `domain_data[].state: verified` on the organization to get a verified domain.
  app.post('/organization_domains/:id/verify', (c) => {
    const domain = ws.organizationDomains.get(c.req.param('id'));
    if (!domain) throw notFound('Organization Domain', c.req.param('id'));
    if (domain.state === 'verified') {
      throw new WorkOSApiError(400, 'Domain is already verified.', 'domain_already_verified');
    }
    return c.json(formatDomain(startDnsVerification(ws, domain)), 201);
  });
}
