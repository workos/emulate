import {
  type RouteContext,
  notFound,
  parseJsonBody,
  parseListParams,
  validationError,
  WorkOSApiError,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatConnection,
  formatListResponse,
  isListedConnectionType,
  organizationSsoConnections,
} from '../helpers.js';
import type { WorkOSConnectionType } from '../entities.js';

/**
 * The connection types `POST /connections` may create, spelled as the spec's `connection_type`
 * enum spells them. Production's `parseConnectionType`
 * (`api/src/connections/utils/validate-create-connection.ts`) takes a SAML or OIDC type and
 * refuses everything else with `connection_type_not_supported`: the OAuth and Magic Link types
 * belong to the environment, not to an organization, and `TestIdp` and `Auth0Migration` are
 * internal. Which set a type is in decides which protocol options the request must carry.
 */
const SAML_CONNECTION_TYPES: ReadonlySet<WorkOSConnectionType> = new Set<WorkOSConnectionType>([
  'ADFSSAML',
  'Auth0SAML',
  'AzureSAML',
  'CasSAML',
  'ClassLinkSAML',
  'CloudflareSAML',
  'CyberArkSAML',
  'DuoSAML',
  'GenericSAML',
  'GoogleSAML',
  'JumpCloudSAML',
  'KeycloakSAML',
  'LastPassSAML',
  'MiniOrangeSAML',
  'NetIqSAML',
  'OktaSAML',
  'OneLoginSAML',
  'OracleSAML',
  'PingFederateSAML',
  'PingOneSAML',
  'RipplingSAML',
  'SalesforceSAML',
  'ShibbolethGenericSAML',
  'ShibbolethSAML',
  'SimpleSamlPhpSAML',
  'VMwareSAML',
]);

const OIDC_CONNECTION_TYPES: ReadonlySet<WorkOSConnectionType> = new Set<WorkOSConnectionType>([
  'AdpOidc',
  'CleverOIDC',
  'EntraIdOIDC',
  'GenericOIDC',
  'GoogleOIDC',
  'LoginGovOidc',
  'OktaOIDC',
]);

const badRequest = (code: string, message: string) => new WorkOSApiError(400, message, code);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** The optional string fields of each options object, which the DTO holds to `@IsString() @IsNotEmpty()` when given. */
const SAML_STRING_FIELDS = ['idp_metadata_url', 'acs_url', 'sp_entity_id', 'idp_entity_id', 'idp_sso_url'] as const;
const OIDC_STRING_FIELDS = ['client_secret', 'redirect_uri'] as const;

/**
 * The DTO's own checks, which production runs before any cross-field rule: a required field
 * that is absent, or a given field that is not the non-empty string the DTO demands, is a 422,
 * not one of the 400s below. The emulator renders those with its standard validation envelope.
 * A `null` is refused with the empty string rather than read as absent: the cross-field rules
 * key on presence, and a null `idp_metadata_url` must not pass as an IdP description.
 */
function validateShape(body: Record<string, unknown>): void {
  const errors: NonNullable<WorkOSApiError['errors']> = [];
  if (!isNonEmptyString(body.organization_id)) {
    errors.push({ field: 'organization_id', code: 'required' });
  }
  if (body.name !== undefined && !isNonEmptyString(body.name)) {
    errors.push({ field: 'name', code: 'invalid' });
  }
  for (const field of ['saml_options', 'oidc_options'] as const) {
    if (body[field] !== undefined && !isObject(body[field])) errors.push({ field, code: 'invalid' });
  }
  if (isObject(body.saml_options)) {
    const options = body.saml_options;
    for (const field of SAML_STRING_FIELDS) {
      if (options[field] !== undefined && !isNonEmptyString(options[field])) {
        errors.push({ field: `saml_options.${field}`, code: 'invalid' });
      }
    }
    const certs = options.idp_signing_certs;
    if (certs !== undefined && (!Array.isArray(certs) || !certs.every(isNonEmptyString))) {
      errors.push({ field: 'saml_options.idp_signing_certs', code: 'invalid' });
    }
  }
  if (isObject(body.oidc_options)) {
    const options = body.oidc_options;
    for (const field of ['discovery_endpoint', 'client_id'] as const) {
      if (!isNonEmptyString(options[field])) errors.push({ field: `oidc_options.${field}`, code: 'required' });
    }
    for (const field of OIDC_STRING_FIELDS) {
      if (options[field] !== undefined && !isNonEmptyString(options[field])) {
        errors.push({ field: `oidc_options.${field}`, code: 'invalid' });
      }
    }
  }
  if (errors.length > 0) throw validationError('Validation failed', errors);
}

/**
 * The presence rules of production's `validateOidcOptions`. A `private_key_jwt` connection
 * authenticates with a key pair and a `client_secret` connection with a secret, and each
 * refuses the other's credential rather than discarding it. The certificate in a supplied key
 * pair is not parsed here.
 */
function validateOidcOptions(options: Record<string, unknown>): void {
  if (options.token_authentication_method === 'private_key_jwt') {
    if (options.client_secret !== undefined) {
      throw badRequest(
        'client_secret_not_accepted',
        'A connection using the private_key_jwt token_authentication_method authenticates with a key pair, so no client_secret may be provided.',
      );
    }
    return;
  }
  if (options.client_secret === undefined) {
    throw badRequest(
      'client_secret_required',
      'client_secret is required unless token_authentication_method is private_key_jwt.',
    );
  }
  if (options.jwt_signing_key_pair !== undefined) {
    throw badRequest(
      'key_pair_not_accepted',
      'jwt_signing_key_pair is only accepted when token_authentication_method is private_key_jwt.',
    );
  }
}

/**
 * The presence rules of production's `validateSamlOptions`: the IdP is described either by a
 * metadata URL or by the manual fields, of which `idp_sso_url` and at least one signing
 * certificate are required. The certificates are not parsed and the URLs are not fetched —
 * there is no IdP to reach.
 */
function validateSamlOptions(options: Record<string, unknown>): void {
  const hasManualIdpFields =
    options.idp_entity_id !== undefined || options.idp_sso_url !== undefined || options.idp_signing_certs !== undefined;

  if (options.idp_metadata_url !== undefined) {
    if (hasManualIdpFields) {
      throw badRequest(
        'ambiguous_saml_options',
        'Provide either idp_metadata_url or the manual IdP fields (idp_entity_id, idp_sso_url, idp_signing_certs), not both.',
      );
    }
    return;
  }

  const certs = options.idp_signing_certs;
  if (options.idp_sso_url === undefined || !Array.isArray(certs) || certs.length === 0) {
    throw badRequest(
      'incomplete_saml_options',
      'Provide either idp_metadata_url, or idp_sso_url along with at least one certificate in idp_signing_certs.',
    );
  }
}

/**
 * Production's `validateCreateConnection`, rule for rule and in its order: the type and the
 * protocol options must agree, and whichever protocol results must have its options. Returns
 * the type the connection is created with. When the request names none, production infers it
 * by inspecting the IdP (`SamlMetadataClient.inferSamlConnectionTypeWithDnsCheck`,
 * `inferOidcConnectionType`) and falls back to the generic type when it recognizes no vendor;
 * the emulator inspects nothing, so the generic type is what it always reports.
 */
function validateCreateConnection(body: Record<string, unknown>): WorkOSConnectionType {
  const samlOptions = body.saml_options as Record<string, unknown> | undefined;
  const oidcOptions = body.oidc_options as Record<string, unknown> | undefined;

  if (samlOptions !== undefined && oidcOptions !== undefined) {
    throw badRequest('both_saml_and_oidc_options_provided', 'Provide either saml_options or oidc_options, not both.');
  }

  let connectionType: WorkOSConnectionType | undefined;
  if (body.connection_type !== undefined) {
    const requested = body.connection_type as WorkOSConnectionType;
    if (!SAML_CONNECTION_TYPES.has(requested) && !OIDC_CONNECTION_TYPES.has(requested)) {
      throw badRequest(
        'connection_type_not_supported',
        'Only SAML and OIDC connection types may be created through this endpoint.',
      );
    }
    connectionType = requested;
  }

  if (connectionType === undefined && samlOptions === undefined && oidcOptions === undefined) {
    throw badRequest(
      'connection_type_or_options_required',
      'Provide a connection_type, saml_options, or oidc_options to create a connection.',
    );
  }

  const isSamlType = connectionType !== undefined && SAML_CONNECTION_TYPES.has(connectionType);
  const isOidcType = connectionType !== undefined && OIDC_CONNECTION_TYPES.has(connectionType);

  if ((isSamlType && oidcOptions !== undefined) || (isOidcType && samlOptions !== undefined)) {
    throw badRequest(
      'connection_type_conflicts_with_options',
      'The provided connection_type conflicts with the provided protocol options.',
    );
  }

  if (oidcOptions !== undefined || isOidcType) {
    if (oidcOptions === undefined) {
      throw badRequest('oidc_options_required', 'oidc_options must be provided to create an OIDC connection.');
    }
    validateOidcOptions(oidcOptions);
    return connectionType ?? 'GenericOIDC';
  }

  if (samlOptions === undefined) {
    throw badRequest('saml_options_required', 'saml_options must be provided to create a SAML connection.');
  }
  validateSamlOptions(samlOptions);
  return connectionType ?? 'GenericSAML';
}

export function connectionRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/connections', async (c) => {
    const body = await parseJsonBody(c);
    validateShape(body);
    const connectionType = validateCreateConnection(body);

    const organizationId = body.organization_id as string;
    const org = ws.organizations.get(organizationId);
    if (!org) throw notFound('Organization', organizationId);

    // One SSO connection per organization. Production enforces this behind the per-team flag
    // `restrict-organizations-to-one-connection-and-directory`, on for every team created since
    // 2022-08-04, so the emulator treats it as always on. The body is production's
    // `ConnectionAlreadyExistsForOrganizationException`, `organization_id` included; the spec
    // does not list this code under the endpoint's 400s, and a customer took the emulator's
    // silence for permission.
    if (organizationSsoConnections(ws, org.id).length > 0) {
      throw new WorkOSApiError(
        400,
        `Organization '${org.id}' already has a Connection.`,
        'connection_already_exists_for_organization',
        undefined,
        { organization_id: org.id },
      );
    }

    // `domains` is not a field of production's CreateConnectionDto: a request that carries one
    // is accepted and the array ignored, and the created connection has none. Domains reach a
    // connection through the organization's verified domains, which only a seed can declare
    // for a connection here. The state is production's: a created connection is `validating`
    // until an IdP response proves the configuration, which here is the first SSO login
    // through it, and announces no `connection.activated` before then.
    const conn = ws.connections.insert({
      object: 'connection',
      organization_id: org.id,
      connection_type: connectionType,
      name: (body.name as string | undefined) ?? org.name,
      state: 'validating',
      domains: [],
    });

    return c.json(formatConnection(conn), 201);
  });

  app.get('/connections', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const orgFilter = url.searchParams.get('organization_id') ?? undefined;
    const typeFilter = url.searchParams.get('connection_type') ?? undefined;
    const domainFilter = url.searchParams.get('domain') ?? undefined;

    const result = ws.connections.list({
      ...params,
      filter: (conn) => {
        // The environment-level types are never listed, whatever the filters ask for.
        if (!isListedConnectionType(conn.connection_type)) return false;
        if (orgFilter && conn.organization_id !== orgFilter) return false;
        if (typeFilter && conn.connection_type !== typeFilter) return false;
        if (domainFilter && !conn.domains.some((d) => d.domain === domainFilter)) return false;
        return true;
      },
    });

    return c.json(formatListResponse(result, formatConnection));
  });

  app.get('/connections/:id', (c) => {
    const conn = ws.connections.get(c.req.param('id'));
    if (!conn) throw notFound('Connection', c.req.param('id'));
    return c.json(formatConnection(conn));
  });

  app.delete('/connections/:id', (c) => {
    const conn = ws.connections.get(c.req.param('id'));
    if (!conn) throw notFound('Connection', c.req.param('id'));

    for (const auth of ws.ssoAuthorizations.all()) {
      if (auth.connection_id === conn.id) {
        ws.ssoAuthorizations.delete(auth.id);
      }
    }

    ws.connections.delete(conn.id);
    return c.body(null, 204);
  });
}
