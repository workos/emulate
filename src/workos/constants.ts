/** Typed keys for Store.getData/setData */
export const STORE_KEYS = {
  workosStore: '_workos_store',
  eventBus: 'eventBus',
  apiKeyMap: 'apiKeyMap',
  jwtTemplate: 'jwt_template',
  interactiveAuth: 'interactiveAuth',
  allowedRedirectHosts: 'allowedRedirectHosts',
} as const;

/** Prefix for dynamic store keys */
export const STORE_KEY_PREFIXES = {
  pendingAuth: 'pending_auth:',
  ssoToken: 'sso_token:',
  ssoLogout: 'sso_logout:',
  auditSchema: 'audit_schema_',
  radarIpList: 'radar_ip_list',
} as const;

/**
 * Resource type a permission is scoped to when the caller supplies none.
 * Production scopes permissions to the built-in `organization` resource type
 * by default; the emulator does the same so every response carries the
 * spec-required `resource_type_slug`.
 */
export const DEFAULT_PERMISSION_RESOURCE_TYPE_SLUG = 'organization';

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
