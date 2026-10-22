import { type RouteContext, notFound, parseJsonBody, validationError, WorkOSApiError } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';

/**
 * The intents `POST /portal/generate_link` accepts: production's `IntentDto`
 * (packages/api/src/portal-sessions/dto/intent.dto.ts). `enterprise_managed_authorization` is
 * undocumented and flag-gated per team there; the emulator treats every team as flagged in.
 */
export const PORTAL_LINK_INTENTS = [
  'sso',
  'dsync',
  'audit_logs',
  'log_streams',
  'domain_verification',
  'certificate_renewal',
  'bring_your_own_key',
  'enterprise_managed_authorization',
] as const;

export type PortalLinkIntent = (typeof PORTAL_LINK_INTENTS)[number];

const isPortalLinkIntent = (value: unknown): value is PortalLinkIntent =>
  typeof value === 'string' && (PORTAL_LINK_INTENTS as readonly string[]).includes(value);

/**
 * The connection types the Enterprise-Managed Authorization wizard can configure, as their
 * public `connection_type` names: production's `EMA_CONNECTION_TYPES` (`OktaSaml`, `OktaOidc`
 * in packages/api/src/cross-app-access/ema-connection-types.ts).
 */
const EMA_CONNECTION_TYPES: ReadonlySet<string> = new Set(['OktaSAML', 'OktaOIDC']);

/** Production's `InvalidPortalLinkIntent`: the body quotes whatever was sent, `undefined` included. */
function invalidPortalLinkIntent(intent: unknown): WorkOSApiError {
  return new WorkOSApiError(
    400,
    `You must provide a valid intent to generate a Portal Link, received '${String(intent)}'.`,
    'invalid_portal_link_intent',
  );
}

export function portalRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/portal/generate_link', async (c) => {
    const body = await parseJsonBody(c);
    const organization = body.organization;
    const intent = body.intent;

    if (typeof organization !== 'string' || !organization) {
      throw validationError('organization is required', [{ field: 'organization', code: 'required' }]);
    }

    // Production resolves the organization before it reads the intent
    // (portal-sessions.controller.ts, `locateTarget` then `IntentDto.decode`), so an unknown
    // organization is a 404 whatever the intent says.
    if (!ws.organizations.get(organization)) throw notFound('Organization', organization);

    // `intent` is optional in the DTO but an organization target has nothing to infer one from,
    // so a missing intent fails the same way an unknown one does.
    if (!isPortalLinkIntent(intent)) throw invalidPortalLinkIntent(intent);

    // The EMA wizard configures cross-app access on the organization's Okta connection and its
    // verify step needs a working login, so production refuses the intent without an active one
    // (`OktaConnectionRequired`).
    if (intent === 'enterprise_managed_authorization') {
      const hasActiveOktaConnection = ws.connections
        .findBy('organization_id', organization)
        .some((conn) => EMA_CONNECTION_TYPES.has(conn.connection_type) && conn.state === 'active');
      if (!hasActiveOktaConnection) {
        throw new WorkOSApiError(
          400,
          `Organization '${organization}' has no active Okta connection. The 'enterprise_managed_authorization' intent requires an active Okta SAML or Okta OIDC connection.`,
          'okta_connection_required',
        );
      }
    }

    const baseUrl = new URL(c.req.url).origin;
    return c.json({ link: `${baseUrl}/portal/${intent}/${organization}` }, 201);
  });
}
