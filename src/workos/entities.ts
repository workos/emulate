import type { Entity } from '../core/index.js';

/**
 * The environment's JWT template. Environment-scoped rather than a collection resource, so
 * it carries no id and lives in store data instead of a collection.
 */
export interface WorkOSJwtTemplate {
  object: 'jwt_template';
  /** Template string rendering to a JSON object of claims. See workos/jwt-template.ts. */
  content: string;
  created_at: string;
  updated_at: string;
}

export interface WorkOSOrganization extends Entity {
  object: 'organization';
  name: string;
  external_id: string | null;
  metadata: Record<string, string>;
  stripe_customer_id: string | null;
  allow_profiles_outside_organization: boolean;
  /**
   * Entitlement slugs minted into org-scoped access tokens. Seed-only state: the spec's
   * organization shape has no such field, so it is never serialized onto the API object.
   */
  entitlements: string[];
}

export interface WorkOSOrganizationDomain extends Entity {
  object: 'organization_domain';
  organization_id: string;
  domain: string;
  state: 'verified' | 'pending';
  verification_strategy: 'manual' | 'dns';
  verification_token: string;
  verification_prefix: string;
}

export interface WorkOSOrganizationMembership extends Entity {
  object: 'organization_membership';
  organization_id: string;
  user_id: string;
  role: { slug: string };
  status: 'active' | 'inactive' | 'pending';
  external_id: string | null;
  metadata: Record<string, string>;
}

/** An AuthKit group within an organization (`/organizations/{org}/groups`). */
export interface WorkOSGroup extends Entity {
  object: 'group';
  organization_id: string;
  name: string;
  description: string | null;
}

/** Join between a group and an organization membership. Internal — never serialized by id. */
export interface WorkOSGroupMembership extends Entity {
  group_id: string;
  organization_membership_id: string;
}

export interface WorkOSUser extends Entity {
  object: 'user';
  email: string;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  email_verified: boolean;
  profile_picture_url: string | null;
  last_sign_in_at: string | null;
  external_id: string | null;
  metadata: Record<string, string>;
  locale: string | null;
  password_hash: string | null;
  impersonator: { email: string; reason: string } | null;
  /**
   * The OAuth provider this user authenticates with, as a spec-valid
   * AuthenticateResponse.authentication_method value (e.g. 'GoogleOAuth', 'MicrosoftOAuth').
   * Reported as the authentication_method for OAuth-based grants; when unset the emulator omits
   * the field rather than inventing a provider. Internal-only — excluded from the user response.
   */
  oauth_provider?: string | null;
}

export interface WorkOSSession extends Entity {
  object: 'session';
  user_id: string;
  organization_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  auth_method: string;
  status: 'active' | 'expired' | 'revoked';
  expires_at: string;
  ended_at: string | null;
}

export interface WorkOSEmailVerification extends Entity {
  object: 'email_verification';
  user_id: string;
  email: string;
  code: string;
  expires_at: string;
}

export interface WorkOSPasswordReset extends Entity {
  object: 'password_reset';
  user_id: string;
  email: string;
  token: string;
  expires_at: string;
}

export interface WorkOSMagicAuth extends Entity {
  object: 'magic_auth';
  user_id: string;
  email: string;
  code: string;
  expires_at: string;
}

export interface WorkOSAuthenticationFactor extends Entity {
  object: 'authentication_factor';
  user_id: string;
  type: 'totp';
  totp: {
    issuer: string;
    user: string;
    uri: string;
  };
}

export interface WorkOSAuthorizationCode extends Entity {
  user_id: string;
  organization_id: string | null;
  code: string;
  redirect_uri: string;
  expires_at: string;
  code_challenge: string | null;
  code_challenge_method: string | null;
  /** The OAuth client that initiated the authorization, bound to the code so the token claim can't be spoofed at redemption. */
  client_id: string | null;
}

export interface WorkOSIdentity extends Entity {
  object: 'identity';
  user_id: string;
  /** An OAuth provider, e.g. 'GoogleOAuth'. The spec supports no other identity type yet. */
  provider: string;
  /** The user's id at the provider. */
  idp_id: string;
  type: 'OAuth';
}

export type WorkOSConnectionType =
  | 'ADFSSAML'
  | 'AzureSAML'
  | 'GenericOIDC'
  | 'GenericSAML'
  | 'GoogleOAuth'
  | 'GoogleSAML'
  | 'OktaSAML'
  | 'OneLoginSAML'
  | 'PingFederateSAML'
  | 'PingOneSAML'
  | 'GitHubOAuth'
  | 'MicrosoftOAuth'
  | 'AppleOAuth';

export interface WorkOSConnectionDomain {
  object: 'connection_domain';
  id: string;
  domain: string;
}

export interface WorkOSConnection extends Entity {
  object: 'connection';
  organization_id: string;
  connection_type: WorkOSConnectionType;
  name: string;
  state: 'active' | 'inactive' | 'validating';
  domains: WorkOSConnectionDomain[];
}

export interface WorkOSSSOProfile extends Entity {
  object: 'profile';
  connection_id: string;
  connection_type: WorkOSConnectionType;
  organization_id: string;
  idp_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  groups: string[];
  raw_attributes: Record<string, unknown>;
}

export interface WorkOSSSOAuthorization extends Entity {
  code: string;
  connection_id: string;
  organization_id: string;
  profile_id: string;
  redirect_uri: string;
  state: string | null;
  expires_at: string;
}

export interface WorkOSInvitation extends Entity {
  object: 'invitation';
  email: string;
  state: 'pending' | 'accepted' | 'expired' | 'revoked';
  token: string;
  accept_invitation_url: string;
  organization_id: string | null;
  inviter_user_id: string | null;
  role_slug: string | null;
  expires_at: string;
  // The generated SDK treats these as nullable-but-required keys: a missing key raises KeyError
  // on parse. Production always sends them (null when unset), so emulate does too.
  accepted_at: string | null;
  revoked_at: string | null;
  accepted_user_id: string | null;
}

export interface WorkOSRedirectUri extends Entity {
  object: 'redirect_uri';
  uri: string;
}

export interface WorkOSCorsOrigin extends Entity {
  object: 'cors_origin';
  origin: string;
}

export interface WorkOSAuthorizedApplication extends Entity {
  object: 'authorized_application';
  user_id: string;
  name: string;
  redirect_uri: string;
}

/**
 * States a stored connected account can hold. The spec's enum also has `disconnected`, but
 * disconnecting an account is deleting it — that value is observable only in the
 * `pipes.connected_account.disconnected` event a deletion emits, never on a stored row,
 * so a fresh import after a disconnect can't be answered 409 by a row that no longer works.
 */
export type ConnectedAccountState = 'connected' | 'needs_reauthorization';

export interface WorkOSConnectedAccount extends Entity {
  object: 'connected_account';
  user_id: string;
  organization_id: string | null;
  /** Provider slug the account is addressed by (`github`, `slack`, …). Not part of the spec's REST shape — requests carry it in the path, events as `provider_slug`. */
  provider: string;
  /** The environment's integration for this provider; every account of one slug shares it. */
  data_integration_id: string;
  scopes: string[];
  /** The import DTO and seed only describe OAuth connections, so this is the one value the emulator can be told. */
  auth_method: 'oauth';
  api_key_last_4: null;
  state: ConnectedAccountState;
  /** Tokens the import/update endpoints were given. Kept because deleting the account is specified to remove them; never serialized. */
  access_token: string | null;
  refresh_token: string | null;
  token_expires_at: string | null;
}

export type PipeProvider = 'github' | 'slack' | 'google' | 'salesforce';
export type PipeConnectionStatus = 'connected' | 'disconnected' | 'requires_reauth';

export interface WorkOSPipeConnection extends Entity {
  object: 'pipe_connection';
  user_id: string;
  provider: PipeProvider;
  scopes: string[];
  status: PipeConnectionStatus;
  external_account_id: string | null;
}

export interface WorkOSRefreshToken extends Entity {
  token: string;
  user_id: string;
  organization_id: string | null;
  session_id: string;
  expires_at: string;
  /** The client_id the original access token was minted for, carried forward across refresh rotations. */
  client_id: string | null;
}

export interface WorkOSAuthenticationChallenge extends Entity {
  object: 'authentication_challenge';
  user_id: string;
  factor_id: string;
  expires_at: string;
  code: string | null;
}

export interface WorkOSDeviceAuthorization extends Entity {
  device_code: string;
  user_code: string;
  user_id: string | null;
  client_id: string;
  expires_at: string;
  interval: number;
}

export interface WorkOSRole extends Entity {
  object: 'role';
  slug: string;
  name: string;
  description: string | null;
  type: 'EnvironmentRole' | 'OrganizationRole';
  organization_id: string | null;
  is_default_role: boolean;
  priority: number;
}

export interface WorkOSPermission extends Entity {
  object: 'permission';
  slug: string;
  name: string;
  description: string | null;
  resource_type_slug?: string;
}

export interface WorkOSRolePermission extends Entity {
  role_id: string;
  permission_id: string;
}

export interface WorkOSAuthorizationResource extends Entity {
  object: 'authorization_resource';
  resource_type_slug: string;
  external_id: string;
  organization_id: string;
  // Production requires name on create; rows persisted by pre-0.11 releases
  // (which had no name field) hold null.
  name: string | null;
  description: string | null;
  parent_resource_id: string | null;
  metadata: Record<string, string>;
}

export interface WorkOSRoleAssignment extends Entity {
  object: 'role_assignment';
  organization_membership_id: string;
  role_id: string;
  role_slug: string;
  resource_id: string | null;
  resource_external_id: string | null;
  resource_type_slug: string | null;
}

export interface WorkOSDirectory extends Entity {
  object: 'directory';
  name: string;
  organization_id: string | null;
  domain: string | null;
  type: string;
  state: 'linked' | 'unlinked' | 'deleting' | 'invalid_credentials';
  external_key: string | null;
}

export interface WorkOSDirectoryUser extends Entity {
  object: 'directory_user';
  directory_id: string;
  organization_id: string | null;
  idp_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  username: string | null;
  state: 'active' | 'inactive';
  role: { slug: string } | null;
  custom_attributes: Record<string, unknown>;
  raw_attributes: Record<string, unknown>;
  groups: Array<{ object: 'directory_group'; id: string; name: string }>;
}

export interface WorkOSDirectoryGroup extends Entity {
  object: 'directory_group';
  directory_id: string;
  organization_id: string | null;
  idp_id: string;
  name: string;
  raw_attributes: Record<string, unknown>;
}

export interface WorkOSAuditLogAction extends Entity {
  object: 'audit_log_action';
  name: string;
  description: string | null;
  condition: string | null;
}

export interface WorkOSAuditLogEvent extends Entity {
  object: 'audit_log_event';
  organization_id: string;
  action: { name: string; type: string; id: string };
  actor: Record<string, unknown>;
  targets: Array<Record<string, unknown>>;
  metadata: Record<string, unknown> | null;
  occurred_at: string;
}

export interface WorkOSAuditLogExport extends Entity {
  object: 'audit_log_export';
  organization_id: string;
  state: 'pending' | 'ready' | 'error';
  url: string | null;
  filters: Record<string, unknown>;
}

export interface WorkOSFeatureFlag extends Entity {
  object: 'feature_flag';
  slug: string;
  name: string;
  description: string | null;
  type: 'boolean' | 'string' | 'number';
  default_value: unknown;
  enabled: boolean;
}

export interface WorkOSFlagTarget extends Entity {
  object: 'flag_target';
  flag_slug: string;
  resource_id: string;
  resource_type: string;
  value: unknown;
}

export interface WorkOSConnectApplication extends Entity {
  object: 'connect_application';
  name: string;
  description: string | null;
  application_type: 'oauth' | 'm2m';
  /** Required for m2m applications; the organization the app belongs to. */
  organization_id: string | null;
  scopes: string[];
  /** The `aud` claim minted into m2m tokens. Falls back to client_id when null. */
  audience: string | null;
  redirect_uris: string[];
  client_id: string;
  logo_url: string | null;
}

export interface WorkOSClientSecret extends Entity {
  object: 'client_secret';
  application_id: string;
  value: string;
  last_four: string;
}

export interface WorkOSDataIntegrationAuth extends Entity {
  slug: string;
  code: string;
  redirect_uri: string;
  state: string | null;
  expires_at: string;
}

export interface WorkOSRadarAttempt extends Entity {
  object: 'radar_attempt';
  user_id: string | null;
  ip_address: string;
  user_agent: string | null;
  verdict: 'allow' | 'deny' | 'challenge';
  signals: Array<{ type: string; confidence: number }>;
}

/** The entity that owns an API key. Mirrors the spec's discriminated `owner` union. */
export type WorkOSApiKeyOwner =
  | { type: 'organization'; id: string }
  | { type: 'user'; id: string; organization_id: string };

export interface WorkOSApiKey extends Entity {
  object: 'api_key';
  name: string;
  /** Full secret value, e.g. `sk_test_...`. Internal — never serialized; only `obfuscated_value` is returned. */
  key: string;
  /** Internal — used to register the key in the auth allow-list; never serialized. */
  environment: string;
  owner: WorkOSApiKeyOwner;
  permissions: string[];
  last_used_at: string | null;
  expires_at: string | null;
}

export interface WorkOSVaultObjectVersion {
  id: string;
  created_at: string;
  current_version: boolean;
  size: number;
  etag: string;
}

export interface WorkOSVaultObject extends Entity {
  name: string;
  value: string;
  key_context: Record<string, string>;
  environment_id: string;
  key_id: string;
  updated_by: { id: string; name: string };
  version_id: string;
  versions: WorkOSVaultObjectVersion[];
}

export interface WorkOSEvent extends Entity {
  object: 'event';
  event: string;
  data: Record<string, unknown>;
  environment_id: string | null;
}

export interface WorkOSWebhookEndpoint extends Entity {
  object: 'webhook_endpoint';
  endpoint_url: string;
  secret: string;
  enabled: boolean;
  events: string[];
  description: string | null;
}
