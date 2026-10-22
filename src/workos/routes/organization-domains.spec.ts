import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import { workosPlugin } from '../index.js';

const apiKeys: ApiKeyMap = { sk_test_domains: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_domains', 'Content-Type': 'application/json' };

const BASE62_TOKEN = /^[0-9A-Za-z]{25}$/;

describe('Organization domain routes', () => {
  let app: ReturnType<typeof createServer>['app'];

  beforeEach(() => {
    app = createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys }).app;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;
  const post = (path: string, body?: Record<string, unknown>) =>
    req(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

  const createOrg = async (body: Record<string, unknown> = {}) =>
    json(await post('/organizations', { name: 'Acme Corp', ...body }));
  const eventsOf = async (name: string): Promise<any[]> => (await json(await req(`/events?events[]=${name}`))).data;

  describe('POST /organization_domains', () => {
    it('creates the domain pending, lowercased, and starts DNS verification on it', async () => {
      const org = await createOrg();
      const res = await post('/organization_domains', { organization_id: org.id, domain: 'Foo-Corp.com' });
      expect(res.status).toBe(201);
      const domain = await json(res);
      expect(domain).toMatchObject({
        object: 'organization_domain',
        organization_id: org.id,
        domain: 'foo-corp.com',
        state: 'pending',
        verification_strategy: 'dns',
      });
      expect(domain.id).toMatch(/^org_domain_/);
      expect(domain.verification_token).toMatch(BASE62_TOKEN);
      // The API passes no branded prefix, so none is minted.
      expect(domain).not.toHaveProperty('verification_prefix');
      expect((await json(await req(`/organizations/${org.id}`))).domains).toEqual([domain]);
    });

    it('fires created and then updated, as production writes the row and then starts verification', async () => {
      const org = await createOrg();
      const domain = await json(await post('/organization_domains', { organization_id: org.id, domain: 'acme.com' }));

      const created = (await eventsOf('organization_domain.created')).find((e) => e.data.id === domain.id);
      expect(created.data.state).toBe('pending');
      expect(created.data).not.toHaveProperty('verification_strategy');
      expect(created.data).not.toHaveProperty('verification_token');

      const updated = (await eventsOf('organization_domain.updated')).find((e) => e.data.id === domain.id);
      expect(updated.data.verification_strategy).toBe('dns');
      expect(updated.data.verification_token).toBe(domain.verification_token);
    });

    it('reports a malformed domain and a missing organization_id the way the validation pipe does', async () => {
      const res = await post('/organization_domains', { domain: 'not-a-domain' });
      expect(res.status).toBe(422);
      expect(await json(res)).toEqual({
        message: 'Validation failed',
        errors: [
          { field: 'domain', code: 'domain must be valid domain name' },
          { field: 'organization_id', code: 'organization_id must be a string' },
        ],
      });
    });

    it('rejects a non-ASCII domain, as production does without allowUnicode, and takes its punycode form', async () => {
      const org = await createOrg();
      const unicode = await post('/organization_domains', { organization_id: org.id, domain: 'bücher.de' });
      expect(unicode.status).toBe(422);
      expect(await json(unicode)).toEqual({
        message: 'Validation failed',
        errors: [{ field: 'domain', code: 'domain must be valid domain name' }],
      });

      const punycode = await post('/organization_domains', { organization_id: org.id, domain: 'xn--bcher-kva.de' });
      expect(punycode.status).toBe(201);
      expect((await json(punycode)).domain).toBe('xn--bcher-kva.de');
    });

    it('returns 404 for an unknown organization', async () => {
      const res = await post('/organization_domains', { organization_id: 'org_missing', domain: 'acme.com' });
      expect(res.status).toBe(404);
    });

    it('refuses a domain the organization already holds, in any casing', async () => {
      const org = await createOrg();
      await post('/organization_domains', { organization_id: org.id, domain: 'acme.com' });
      const res = await post('/organization_domains', { organization_id: org.id, domain: 'ACME.com' });
      expect(res.status).toBe(409);
      expect(await json(res)).toEqual({
        message: 'Domain already exists for this organization.',
        code: 'domain_already_exists',
      });
    });

    it('lets two organizations hold the same domain, as production does without its uniqueness flag', async () => {
      const first = await createOrg({ name: 'First' });
      const second = await createOrg({ name: 'Second' });
      await post('/organization_domains', { organization_id: first.id, domain: 'shared.com' });
      const res = await post('/organization_domains', { organization_id: second.id, domain: 'shared.com' });
      expect(res.status).toBe(201);
    });
  });

  describe('POST /organization_domains/{id}/verify', () => {
    it('starts DNS verification on a pending domain and rotates the token when called again', async () => {
      const org = await createOrg({ domain_data: [{ domain: 'acme.com', state: 'pending' }] });
      const [pending] = org.domains;
      expect(pending).not.toHaveProperty('verification_strategy');
      expect(pending).not.toHaveProperty('verification_token');

      const res = await post(`/organization_domains/${pending.id}/verify`);
      expect(res.status).toBe(201);
      const started = await json(res);
      expect(started).toMatchObject({ id: pending.id, state: 'pending', verification_strategy: 'dns' });
      expect(started.verification_token).toMatch(BASE62_TOKEN);

      const again = await json(await post(`/organization_domains/${pending.id}/verify`));
      expect(again.state).toBe('pending');
      expect(again.verification_token).toMatch(BASE62_TOKEN);
      expect(again.verification_token).not.toBe(started.verification_token);

      // Each start is an update; nothing resolves DNS, so nothing is ever verified.
      expect((await eventsOf('organization_domain.updated')).filter((e) => e.data.id === pending.id)).toHaveLength(2);
      expect(await eventsOf('organization_domain.verified')).toHaveLength(0);
      expect((await json(await req(`/organization_domains/${pending.id}`))).state).toBe('pending');
    });

    it('refuses an already verified domain', async () => {
      const org = await createOrg({ domain_data: [{ domain: 'acme.com', state: 'verified' }] });
      const res = await post(`/organization_domains/${org.domains[0].id}/verify`);
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ message: 'Domain is already verified.', code: 'domain_already_verified' });
      expect((await json(await req(`/organization_domains/${org.domains[0].id}`))).state).toBe('verified');
    });

    it('returns 404 for an unknown domain', async () => {
      const res = await post('/organization_domains/org_domain_missing/verify');
      expect(res.status).toBe(404);
    });
  });

  it('gets and deletes a domain', async () => {
    const org = await createOrg();
    const domain = await json(await post('/organization_domains', { organization_id: org.id, domain: 'acme.com' }));

    const got = await req(`/organization_domains/${domain.id}`);
    expect(got.status).toBe(200);
    expect(await json(got)).toEqual(domain);

    expect((await req(`/organization_domains/${domain.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await req(`/organization_domains/${domain.id}`)).status).toBe(404);
    expect((await json(await req(`/organizations/${org.id}`))).domains).toEqual([]);
  });
});
