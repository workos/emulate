import { describe, it, expect, beforeEach } from 'bun:test';
import { createServer as createNetServer } from 'node:net';
import { createServer, type ApiKeyMap, type Store } from '../../core/index.js';
import { createEmulator } from '../../index.js';
import { workosPlugin, seedFromConfig } from '../index.js';
import { getWorkOSStore } from '../store.js';

const apiKeys: ApiKeyMap = { sk_test_conn: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_conn', 'Content-Type': 'application/json' };

function createTestApp() {
  return createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
}

/** The smallest body production's create endpoint accepts: an IdP described by its metadata URL. */
const SAML_OPTIONS = { idp_metadata_url: 'https://idp.example.com/metadata' };
const OIDC_OPTIONS = {
  discovery_endpoint: 'https://idp.example.com/.well-known/openid-configuration',
  client_id: 'idp-client',
  client_secret: 'idp-secret',
};

describe('Connection routes', () => {
  let app: ReturnType<typeof createTestApp>['app'];
  let store: Store;

  beforeEach(() => {
    const server = createTestApp();
    app = server.app;
    store = server.store;
  });

  const req = (path: string, init?: RequestInit) => app.request(path, { headers, ...init });
  const json = (res: Response) => res.json() as Promise<any>;

  async function createOrg(name: string) {
    return json(
      await req('/organizations', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
    );
  }

  const create = (body: Record<string, unknown>) => req('/connections', { method: 'POST', body: JSON.stringify(body) });

  it('creates a connection', async () => {
    const org = await createOrg('SSO Org');
    const res = await create({
      name: 'Test SSO',
      organization_id: org.id,
      connection_type: 'OktaSAML',
      saml_options: SAML_OPTIONS,
    });
    expect(res.status).toBe(201);
    const conn = await json(res);
    expect(conn.object).toBe('connection');
    expect(conn.organization_id).toBe(org.id);
    expect(conn.name).toBe('Test SSO');
    expect(conn.connection_type).toBe('OktaSAML');
  });

  // Production's `SamlConnectionCreator` and `OidcConnectionCreator` save a new connection as
  // `Validating` (`precomputedState`), and its verifier never returns `Active` for one: an
  // IdP response has to prove the configuration first. Nothing is announced until then.
  it('starts a created connection validating, and announces no activation', async () => {
    const org = await createOrg('Validating Org');
    const conn = await json(await create({ organization_id: org.id, saml_options: SAML_OPTIONS }));
    expect(conn.state).toBe('validating');
    expect(
      getWorkOSStore(store)
        .events.all()
        .filter((e) => e.event === 'connection.activated'),
    ).toHaveLength(0);
  });

  it('names the connection after the organization when no name is given', async () => {
    const org = await createOrg('Nameless Org');
    const conn = await json(await create({ organization_id: org.id, saml_options: SAML_OPTIONS }));
    expect(conn.name).toBe('Nameless Org');
  });

  // CreateConnectionDto has no `domains`; production accepts and ignores the array, and the
  // created connection has none. Domains are a seed-only field here.
  it('ignores a domains array in the request', async () => {
    const org = await createOrg('Domains Org');
    const conn = await json(
      await create({ organization_id: org.id, saml_options: SAML_OPTIONS, domains: ['acme.test'] }),
    );
    expect(conn.domains).toEqual([]);
    expect((await json(await req('/connections?domain=acme.test'))).data).toHaveLength(0);
  });

  // The rule a customer was misled by: production allows one SSO connection per organization
  // (`ConnectionCreator.isAtConnectionLimit`, behind a flag on for every team since 2022), and
  // the body is its `ConnectionAlreadyExistsForOrganizationException`, `organization_id` and all.
  it('refuses a second connection for an organization', async () => {
    const org = await createOrg('One Conn Org');
    expect((await create({ organization_id: org.id, saml_options: SAML_OPTIONS })).status).toBe(201);

    const res = await create({ organization_id: org.id, name: 'Second', oidc_options: OIDC_OPTIONS });
    expect(res.status).toBe(400);
    expect(await json(res)).toEqual({
      message: `Organization '${org.id}' already has a Connection.`,
      code: 'connection_already_exists_for_organization',
      organization_id: org.id,
    });
    expect((await json(await req(`/connections?organization_id=${org.id}`))).data).toHaveLength(1);

    // A different organization is a different count.
    const other = await createOrg('Other Org');
    expect((await create({ organization_id: other.id, saml_options: SAML_OPTIONS })).status).toBe(201);
  });

  it('allows a connection again once the organization’s connection is deleted', async () => {
    const org = await createOrg('Replace Org');
    const first = await json(await create({ organization_id: org.id, saml_options: SAML_OPTIONS }));
    expect((await req(`/connections/${first.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await create({ organization_id: org.id, saml_options: SAML_OPTIONS })).status).toBe(201);
  });

  // An organization-bound OAuth connection — a seed can declare one — is environment-level in
  // production and left out of its count, as it is here.
  it('does not count a seeded OAuth connection toward the limit', async () => {
    seedFromConfig(store, 'http://localhost:0', {
      organizations: [{ name: 'Social Org' }],
      connections: [{ name: 'Google', organization: 'Social Org', connection_type: 'GoogleOAuth' }],
    });
    const org = getWorkOSStore(store).organizations.findOneBy('name', 'Social Org')!;
    expect((await create({ organization_id: org.id, saml_options: SAML_OPTIONS })).status).toBe(201);
  });

  describe('create validation', () => {
    let orgId: string;
    beforeEach(async () => {
      orgId = (await createOrg('Validated Org')).id;
    });

    const rejects = async (body: Record<string, unknown>, code: string, message: string) => {
      const res = await create({ organization_id: orgId, ...body });
      expect(res.status).toBe(400);
      expect(await json(res)).toEqual({ message, code });
    };

    // Only SAML and OIDC types: the OAuth and Magic Link types are environment-level and the
    // internal ones are not for the API, whatever the connection_type enum lists.
    it('refuses a connection_type that is not SAML or OIDC', async () => {
      for (const type of ['GoogleOAuth', 'MagicLink', 'TestIdp', 'Auth0Migration', 'Pending', 'NotAType']) {
        await rejects(
          { connection_type: type, saml_options: SAML_OPTIONS },
          'connection_type_not_supported',
          'Only SAML and OIDC connection types may be created through this endpoint.',
        );
      }
    });

    it('requires a connection_type or protocol options', async () => {
      await rejects(
        { name: 'Bare' },
        'connection_type_or_options_required',
        'Provide a connection_type, saml_options, or oidc_options to create a connection.',
      );
    });

    it('refuses both protocols at once, checked before anything else', async () => {
      await rejects(
        { connection_type: 'NotAType', saml_options: SAML_OPTIONS, oidc_options: OIDC_OPTIONS },
        'both_saml_and_oidc_options_provided',
        'Provide either saml_options or oidc_options, not both.',
      );
    });

    it('refuses a connection_type that contradicts the options', async () => {
      await rejects(
        { connection_type: 'OktaSAML', oidc_options: OIDC_OPTIONS },
        'connection_type_conflicts_with_options',
        'The provided connection_type conflicts with the provided protocol options.',
      );
      await rejects(
        { connection_type: 'OktaOIDC', saml_options: SAML_OPTIONS },
        'connection_type_conflicts_with_options',
        'The provided connection_type conflicts with the provided protocol options.',
      );
    });

    it('requires the protocol options the connection_type calls for', async () => {
      await rejects(
        { connection_type: 'GenericSAML' },
        'saml_options_required',
        'saml_options must be provided to create a SAML connection.',
      );
      await rejects(
        { connection_type: 'GenericOIDC' },
        'oidc_options_required',
        'oidc_options must be provided to create an OIDC connection.',
      );
    });

    it('requires a complete, unambiguous IdP description in saml_options', async () => {
      await rejects(
        { saml_options: { idp_sso_url: 'https://idp.example.com/sso' } },
        'incomplete_saml_options',
        'Provide either idp_metadata_url, or idp_sso_url along with at least one certificate in idp_signing_certs.',
      );
      await rejects(
        { saml_options: { idp_sso_url: 'https://idp.example.com/sso', idp_signing_certs: [] } },
        'incomplete_saml_options',
        'Provide either idp_metadata_url, or idp_sso_url along with at least one certificate in idp_signing_certs.',
      );
      await rejects(
        { saml_options: { ...SAML_OPTIONS, idp_entity_id: 'urn:idp' } },
        'ambiguous_saml_options',
        'Provide either idp_metadata_url or the manual IdP fields (idp_entity_id, idp_sso_url, idp_signing_certs), not both.',
      );
      // The manual fields are enough on their own; the certificate is not parsed.
      const manual = await create({
        organization_id: orgId,
        saml_options: { idp_sso_url: 'https://idp.example.com/sso', idp_signing_certs: ['not-really-a-cert'] },
      });
      expect(manual.status).toBe(201);
    });

    it('requires the OIDC credential the token_authentication_method calls for', async () => {
      const { client_secret: _secret, ...withoutSecret } = OIDC_OPTIONS;
      await rejects(
        { oidc_options: withoutSecret },
        'client_secret_required',
        'client_secret is required unless token_authentication_method is private_key_jwt.',
      );
      await rejects(
        { oidc_options: { ...OIDC_OPTIONS, token_authentication_method: 'private_key_jwt' } },
        'client_secret_not_accepted',
        'A connection using the private_key_jwt token_authentication_method authenticates with a key pair, so no client_secret may be provided.',
      );
      await rejects(
        { oidc_options: { ...OIDC_OPTIONS, jwt_signing_key_pair: { cert: 'c', private_key: 'k' } } },
        'key_pair_not_accepted',
        'jwt_signing_key_pair is only accepted when token_authentication_method is private_key_jwt.',
      );
      const keyPair = await create({
        organization_id: orgId,
        oidc_options: { ...withoutSecret, token_authentication_method: 'private_key_jwt' },
      });
      expect(keyPair.status).toBe(201);
      expect((await json(keyPair)).connection_type).toBe('GenericOIDC');
    });

    // The DTO's required fields fail before any cross-field rule, as a 422.
    it('reports a missing required field as a validation failure', async () => {
      const noOrg = await create({ saml_options: SAML_OPTIONS });
      expect(noOrg.status).toBe(422);
      expect((await json(noOrg)).errors).toEqual([{ field: 'organization_id', code: 'required' }]);

      const noEndpoint = await create({ organization_id: orgId, oidc_options: { client_id: 'idp-client' } });
      expect(noEndpoint.status).toBe(422);
      expect((await json(noEndpoint)).errors).toEqual([{ field: 'oidc_options.discovery_endpoint', code: 'required' }]);
    });

    // A field that is given must be the non-empty string the DTO demands: a null or empty
    // `idp_metadata_url` is not an IdP description, and a null or empty `client_secret` is
    // not a credential — neither passes as present, and neither is read as absent.
    it('refuses a null or empty option field rather than reading it as present', async () => {
      for (const idp_metadata_url of [null, '']) {
        const res = await create({ organization_id: orgId, saml_options: { idp_metadata_url } });
        expect(res.status).toBe(422);
        expect((await json(res)).errors).toEqual([{ field: 'saml_options.idp_metadata_url', code: 'invalid' }]);
      }
      const badCerts = await create({
        organization_id: orgId,
        saml_options: { idp_sso_url: 'https://idp.example.com/sso', idp_signing_certs: [''] },
      });
      expect(badCerts.status).toBe(422);
      expect((await json(badCerts)).errors).toEqual([{ field: 'saml_options.idp_signing_certs', code: 'invalid' }]);

      for (const client_secret of [null, '']) {
        const res = await create({ organization_id: orgId, oidc_options: { ...OIDC_OPTIONS, client_secret } });
        expect(res.status).toBe(422);
        expect((await json(res)).errors).toEqual([{ field: 'oidc_options.client_secret', code: 'invalid' }]);
      }
      const nullEndpoint = await create({
        organization_id: orgId,
        oidc_options: { ...OIDC_OPTIONS, discovery_endpoint: null },
      });
      expect(nullEndpoint.status).toBe(422);
      expect((await json(nullEndpoint)).errors).toEqual([
        { field: 'oidc_options.discovery_endpoint', code: 'required' },
      ]);
      // Nothing was created by any of the refusals.
      expect((await json(await req(`/connections?organization_id=${orgId}`))).data).toHaveLength(0);
    });

    it('still 404s an organization it does not know', async () => {
      const res = await create({ organization_id: 'org_missing', saml_options: SAML_OPTIONS });
      expect(res.status).toBe(404);
    });
  });

  it('lists connections filtered by org', async () => {
    const org1 = await createOrg('Org 1');
    const org2 = await createOrg('Org 2');

    await create({ name: 'C1', organization_id: org1.id, saml_options: SAML_OPTIONS });
    await create({ name: 'C2', organization_id: org2.id, saml_options: SAML_OPTIONS });

    const list = await json(await req(`/connections?organization_id=${org1.id}`));
    expect(list.data).toHaveLength(1);
    expect(list.data[0].name).toBe('C1');
  });

  // Production's listing passes excludeOauth, excludeMagicLink and excludeTestIdp: the
  // environment-level connections are never in it, even when the type filter names one.
  it('lists SSO connections only, never the environment-level types', async () => {
    seedFromConfig(store, 'http://localhost:0', {
      organizations: [{ name: 'Mixed' }, { name: 'Sandbox' }],
      connections: [
        { name: 'Mixed SAML', organization: 'Mixed', connection_type: 'OktaSAML', state: 'validating' },
        { name: 'Mixed Google', organization: 'Mixed', connection_type: 'GoogleOAuth' },
        { name: 'Mixed Magic', organization: 'Mixed', connection_type: 'MagicLink' },
        // A TestIdp connection is production's sandbox stand-in for an organization's SSO
        // connection, so it takes the organization's one slot while staying out of the list.
        { name: 'Sandbox Test', organization: 'Sandbox', connection_type: 'TestIdp' },
      ],
    });

    const list = await json(await req('/connections'));
    expect(list.data.map((c: any) => c.name)).toEqual(['Mixed SAML']);
    expect((await json(await req('/connections?connection_type=GoogleOAuth'))).data).toHaveLength(0);
    // Hidden from the list, not from the store: a seeded OAuth connection still signs people in.
    expect(getWorkOSStore(store).connections.all()).toHaveLength(4);
  });

  it('gets a connection by id', async () => {
    const org = await createOrg('Conn Org');
    const created = await json(await create({ name: 'Get Me', organization_id: org.id, saml_options: SAML_OPTIONS }));

    const res = await req(`/connections/${created.id}`);
    expect(res.status).toBe(200);
    expect((await json(res)).name).toBe('Get Me');
  });

  it('deletes a connection', async () => {
    const org = await createOrg('Del Org');
    const conn = await json(await create({ name: 'Del Conn', organization_id: org.id, saml_options: SAML_OPTIONS }));

    const delRes = await req(`/connections/${conn.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(204);

    const getRes = await req(`/connections/${conn.id}`);
    expect(getRes.status).toBe(404);
  });
});

describe('Seeding connections', () => {
  const seed = (store: Store, config: Parameters<typeof seedFromConfig>[2]) =>
    seedFromConfig(store, 'http://localhost:0', config);

  // The same rule the create endpoint enforces, at the only other place a connection comes
  // from: a seed that stands up two SSO connections for one organization describes a tenant
  // production cannot have, so it fails naming the organization and both connections.
  it('rejects a second SSO connection for one organization', () => {
    const { store } = createTestApp();
    expect(() =>
      seed(store, {
        organizations: [{ name: 'Acme Corp' }],
        connections: [
          { name: 'Acme Okta', organization: 'Acme Corp', connection_type: 'OktaSAML' },
          { name: 'Acme Entra', organization: 'Acme Corp', connection_type: 'EntraIdOIDC' },
        ],
      }),
    ).toThrow(
      'workos seed config: organization "Acme Corp" already has a connection: "Acme Okta" and "Acme Entra" both belong to it, and production allows one SSO connection per organization',
    );
  });

  it('lets an organization hold its SSO connection beside OAuth ones', () => {
    const { store } = createTestApp();
    seed(store, {
      organizations: [{ name: 'Acme Corp' }],
      connections: [
        { name: 'Acme Google', organization: 'Acme Corp', connection_type: 'GoogleOAuth' },
        { name: 'Acme Okta', organization: 'Acme Corp', connection_type: 'OktaSAML', domains: ['acme.test'] },
        { name: 'Acme Microsoft', organization: 'Acme Corp', connection_type: 'MicrosoftOAuth' },
      ],
    });
    const ws = getWorkOSStore(store);
    const org = ws.organizations.findOneBy('name', 'Acme Corp')!;
    expect(ws.connections.findBy('organization_id', org.id)).toHaveLength(3);
  });

  // A seed stands for a connection set up before the suite began: it keeps its declared
  // state, defaults to active, and keeps its domains — none of which the create endpoint does.
  it('keeps a seeded connection’s state, default active, and its domains', () => {
    const { store } = createTestApp();
    seed(store, {
      organizations: [{ name: 'Acme Corp' }, { name: 'Globex' }],
      connections: [
        { name: 'Acme SSO', organization: 'Acme Corp', domains: ['acme.test'] },
        { name: 'Globex SSO', organization: 'Globex', state: 'validating' },
      ],
    });
    const ws = getWorkOSStore(store);
    const acme = ws.connections.findOneBy('name', 'Acme SSO')!;
    expect(acme.state).toBe('active');
    expect(acme.domains.map((d) => d.domain)).toEqual(['acme.test']);
    expect(ws.connections.findOneBy('name', 'Globex SSO')!.state).toBe('validating');
    // Activation is announced for the active one only.
    const activated = ws.events.all().filter((e) => e.event === 'connection.activated');
    expect(activated.map((e) => (e.data as { name: string }).name)).toEqual(['Acme SSO']);
  });

  // createEmulator binds its listeners before it seeds, and a seed that fails the boot is
  // thrown before the caller holds a `close()`. The listeners must go with it, or a retry on
  // the same port — the natural next move after fixing the seed — meets EADDRINUSE.
  it('releases the port when the seed fails the boot', async () => {
    // A port the OS just handed out and we gave back, so both boots below contend for it.
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createNetServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address();
        const chosen = typeof address === 'object' && address ? address.port : 0;
        probe.close(() => resolve(chosen));
      });
    });

    await expect(
      createEmulator({
        port,
        seed: {
          organizations: [{ name: 'Acme Corp' }],
          connections: [
            { name: 'Acme Okta', organization: 'Acme Corp' },
            { name: 'Acme Entra', organization: 'Acme Corp' },
          ],
        },
      }),
    ).rejects.toThrow('workos seed config: organization "Acme Corp" already has a connection');

    const retry = await createEmulator({ port, seed: { organizations: [{ name: 'Acme Corp' }] } });
    try {
      expect(retry.port).toBe(port);
    } finally {
      await retry.close();
    }
  });
});
