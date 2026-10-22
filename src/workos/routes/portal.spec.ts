import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer, type ApiKeyMap } from '../../core/index.js';
import type { WorkOSConnectionType } from '../entities.js';
import { workosPlugin } from '../index.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';
import { PORTAL_LINK_INTENTS } from './portal.js';

const apiKeys: ApiKeyMap = { sk_test_org: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_org', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

const insertOrganization = (ws: WorkOSStore, id: string) =>
  ws.organizations.insert({
    id,
    object: 'organization',
    name: id,
    external_id: null,
    metadata: {},
    stripe_customer_id: null,
    allow_profiles_outside_organization: false,
    entitlements: [],
  });

const insertConnection = (
  ws: WorkOSStore,
  organizationId: string,
  connectionType: WorkOSConnectionType,
  state: 'active' | 'inactive' | 'validating',
) =>
  ws.connections.insert({
    object: 'connection',
    organization_id: organizationId,
    connection_type: connectionType,
    name: `${connectionType} ${state}`,
    state,
    domains: [],
  });

describe('Portal routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let ws: WorkOSStore;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    ws = getWorkOSStore(server.store);
    insertOrganization(ws, 'org_123');
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;
  const generate = (body: unknown) => req('/portal/generate_link', { method: 'POST', body: JSON.stringify(body) });

  it('generates a portal link, created', async () => {
    const res = await generate({ intent: 'sso', organization: 'org_123' });
    expect(res.status).toBe(201);
    const data = await json(res);
    expect(data.link).toContain('/portal/sso/org_123');
  });

  it('accepts every production intent', async () => {
    insertConnection(ws, 'org_123', 'OktaSAML', 'active');
    for (const intent of PORTAL_LINK_INTENTS) {
      const res = await generate({ intent, organization: 'org_123' });
      expect(res.status).toBe(201);
      expect((await json(res)).link).toContain(`/portal/${intent}/org_123`);
    }
  });

  it('rejects an unknown intent as production does, quoting what was sent', async () => {
    const res = await generate({ intent: 'banana', organization: 'org_123' });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      message: "You must provide a valid intent to generate a Portal Link, received 'banana'.",
      code: 'invalid_portal_link_intent',
    });
  });

  it('rejects a missing intent with the same 400, not a validation error', async () => {
    const res = await generate({ organization: 'org_123' });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      message: "You must provide a valid intent to generate a Portal Link, received 'undefined'.",
      code: 'invalid_portal_link_intent',
    });
  });

  it('rejects a non-string intent, which the DTO lets through to the decoder', async () => {
    const res = await generate({ intent: 42, organization: 'org_123' });
    expect(res.status).toBe(400);
    expect((await json(res)).message).toBe("You must provide a valid intent to generate a Portal Link, received '42'.");
  });

  it('rejects missing organization', async () => {
    const res = await generate({ intent: 'sso' });
    expect(res.status).toBe(422);
  });

  it('answers 404 for an organization that does not exist', async () => {
    const res = await generate({ intent: 'sso', organization: 'org_nope' });
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({
      message: "Organization not found: 'org_nope'.",
      code: 'entity_not_found',
      entity_id: 'org_nope',
    });
  });

  it('resolves the organization before the intent, so an unknown org wins over a bad intent', async () => {
    const res = await generate({ intent: 'banana', organization: 'org_nope' });
    expect(res.status).toBe(404);
  });

  describe('enterprise_managed_authorization', () => {
    const generateEma = () => generate({ intent: 'enterprise_managed_authorization', organization: 'org_123' });

    it('requires an active Okta connection on the organization', async () => {
      const res = await generateEma();
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({
        message:
          "Organization 'org_123' has no active Okta connection. The 'enterprise_managed_authorization' intent requires an active Okta SAML or Okta OIDC connection.",
        code: 'okta_connection_required',
      });
    });

    it('is not satisfied by an inactive Okta connection, nor by an active non-Okta one', async () => {
      insertConnection(ws, 'org_123', 'OktaSAML', 'inactive');
      insertConnection(ws, 'org_123', 'GoogleSAML', 'active');
      expect((await generateEma()).status).toBe(400);
    });

    it("is not satisfied by another organization's Okta connection", async () => {
      insertOrganization(ws, 'org_other');
      insertConnection(ws, 'org_other', 'OktaSAML', 'active');
      expect((await generateEma()).status).toBe(400);
    });

    it('generates the link once the organization has an active Okta connection', async () => {
      insertConnection(ws, 'org_123', 'OktaSAML', 'active');
      const res = await generateEma();
      expect(res.status).toBe(201);
      expect((await json(res)).link).toContain('/portal/enterprise_managed_authorization/org_123');
    });
  });
});
