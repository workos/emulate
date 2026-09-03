/** Typed keys for Store.getData/setData */
export const STORE_KEYS = {
  workosStore: '_workos_store',
  eventBus: 'eventBus',
  apiKeyMap: 'apiKeyMap',
  jwtTemplate: 'jwt_template',
  interactiveAuth: 'interactiveAuth',
  /** Set alongside interactiveAuth when the AuthKit login page should also ask for a password. */
  interactivePassword: 'interactivePassword',
  allowedRedirectHosts: 'allowedRedirectHosts',
} as const;

/** Prefix for dynamic store keys */
export const STORE_KEY_PREFIXES = {
  pendingAuth: 'pending_auth:',
  /** A password the interactive page has checked, carried across the organization page instead of the password itself. */
  interactiveLogin: 'interactive_login:',
  ssoToken: 'sso_token:',
  ssoLogout: 'sso_logout:',
  auditSchema: 'audit_schema_',
  radarIpList: 'radar_ip_list',
} as const;

/**
 * WorkOS event catalog, generated from the OpenAPI spec.
 * Regenerate with: npm run gen:events -- path/to/open-api-spec.yaml
 */
export {
  EVENTS,
  SUBSCRIBABLE_EVENTS,
  EVENT_DATA_REQUIREMENTS,
  type WorkOSEventName,
  type AuthenticationEventData,
} from './generated/events.js';
