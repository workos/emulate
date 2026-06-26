import { randomBytes } from 'node:crypto';
import type { ServicePlugin, Store, RouteContext, ApiKeyMap } from '../core/index.js';
import { generateId } from '../core/index.js';
import { getWorkOSStore } from './store.js';
import { organizationRoutes } from './routes/organizations.js';
import { organizationDomainRoutes } from './routes/organization-domains.js';
import { membershipRoutes } from './routes/memberships.js';
import { userRoutes } from './routes/users.js';
import { emailVerificationRoutes } from './routes/email-verification.js';
import { passwordResetRoutes } from './routes/password-reset.js';
import { magicAuthRoutes } from './routes/magic-auth.js';
import { authFactorRoutes } from './routes/auth-factors.js';
import { sessionRoutes } from './routes/sessions.js';
import { authRoutes } from './routes/auth.js';
import { connectionRoutes } from './routes/connections.js';
import { ssoRoutes } from './routes/sso.js';
import { pipeRoutes } from './routes/pipes.js';
import { authChallengeRoutes } from './routes/auth-challenges.js';
import { invitationRoutes } from './routes/invitations.js';
import { configRoutes } from './routes/config.js';
import { userFeatureRoutes } from './routes/user-features.js';
import { widgetRoutes } from './routes/widgets.js';
import { authorizationRoleRoutes } from './routes/authorization-roles.js';
import { authorizationPermissionRoutes } from './routes/authorization-permissions.js';
import { authorizationOrgRoleRoutes } from './routes/authorization-org-roles.js';
import { authorizationResourceRoutes } from './routes/authorization-resources.js';
import { authorizationCheckRoutes } from './routes/authorization-checks.js';
import { portalRoutes } from './routes/portal.js';
import { legacyMfaRoutes } from './routes/legacy-mfa.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { radarRoutes } from './routes/radar.js';
import { connectRoutes } from './routes/connect.js';
import { oauthRoutes } from './routes/oauth.js';
import { directoryRoutes } from './routes/directories.js';
import { auditLogRoutes } from './routes/audit-logs.js';
import { featureFlagRoutes } from './routes/feature-flags.js';
import { dataIntegrationRoutes } from './routes/data-integrations.js';
import { webhookEndpointRoutes } from './routes/webhook-endpoints.js';
import { eventRoutes } from './routes/events.js';
import { EventBus } from './event-bus.js';
import { STORE_KEYS, EVENTS } from './constants.js';
import { validateSeedConfig, formatValidationErrors } from './config-validator.js';
import {
  generateVerificationToken,
  hashPassword,
  expiresIn,
  formatUser,
  formatOrganization,
  formatMembership,
  formatConnection,
  formatSession,
  formatInvitation,
  formatRole,
  formatPermission,
  formatDirectory,
  formatDirectoryUser,
  formatDirectoryGroup,
  formatDomain,
  formatEmailVerification,
  formatMagicAuth,
  formatPasswordReset,
  formatApiKeyRecord,
  formatFeatureFlag,
  generateClientId,
  isExpired,
} from './helpers.js';
import type { WorkOSConnectionType, PipeProvider, PipeConnectionStatus, WorkOSApiKeyOwner } from './entities.js';

export { getWorkOSStore, type WorkOSStore } from './store.js';
export * from './entities.js';

export interface WorkOSSeedOrganization {
  name: string;
  external_id?: string;
  metadata?: Record<string, string>;
  domains?: Array<{ domain: string; state?: 'verified' | 'pending' }>;
  memberships?: Array<{
    user_id: string;
    role?: string;
    status?: 'active' | 'inactive' | 'pending';
  }>;
}

export interface WorkOSSeedUser {
  email: string;
  first_name?: string;
  last_name?: string;
  password?: string;
  email_verified?: boolean;
  external_id?: string;
  metadata?: Record<string, string>;
  impersonator?: { email: string; reason: string };
}

export interface WorkOSSeedConnection {
  name: string;
  connection_type?: WorkOSConnectionType;
  organization: string;
  state?: 'active' | 'inactive' | 'validating';
  domains?: string[];
  profiles?: Array<{
    email: string;
    first_name?: string;
    last_name?: string;
    idp_id?: string;
    groups?: string[];
  }>;
}

export interface WorkOSSeedPipeConnection {
  user_id: string;
  provider: PipeProvider;
  scopes: string[];
  status?: PipeConnectionStatus;
  external_account_id?: string;
}

export interface WorkOSSeedInvitation {
  email: string;
  organization_id?: string;
  inviter_user_id?: string;
  role_slug?: string;
}

export interface WorkOSSeedRole {
  slug: string;
  name: string;
  description?: string;
  type?: 'EnvironmentRole' | 'OrganizationRole';
  organization_id?: string;
  is_default_role?: boolean;
  priority?: number;
  permissions?: string[];
}

export interface WorkOSSeedPermission {
  slug: string;
  name: string;
  description?: string;
}

export interface WorkOSSeedWebhookEndpoint {
  endpoint_url?: string;
  /** @deprecated Use endpoint_url */
  url?: string;
  events?: string[];
  enabled?: boolean;
}

export interface WorkOSSeedConnectApplication {
  name: string;
  /** Application type. Defaults to `m2m`. */
  type?: 'm2m' | 'oauth';
  /** Owning organization, by name. Required for `m2m` applications. */
  organization?: string;
  description?: string;
  /** OAuth scopes granted to the application. */
  scopes?: string[];
  /** Pinned client_id. Generated (`client_...`) if omitted. */
  client_id?: string;
  /**
   * Pinned client secret value. Generated (`secret_...`) if omitted. Stored as a
   * client_secret resource so the seeded application has usable credentials. Pin it
   * to bake a known secret into a service's environment.
   */
  client_secret?: string;
  /** OAuth redirect URIs. Ignored for `m2m` applications. */
  redirect_uris?: string[];
}

export interface WorkOSSeedApiKey {
  name: string;
  /** Owning organization, by name. Required unless `user_id` is set. */
  organization?: string;
  /** Owning user, by id. When set, `organization` supplies the required organization_id. */
  user_id?: string;
  /**
   * Pinned secret value. Must start with `sk_` to be accepted for authentication.
   * Generated (`sk_test_...`) if omitted.
   */
  value?: string;
  /** Permission slugs assigned to the key. */
  permissions?: string[];
  /** Expiry timestamp (ISO 8601), or null for a key that never expires. */
  expires_at?: string | null;
  /** Auth environment. Defaults to `production` for `sk_live_*` values, else `test`. */
  environment?: string;
}

/** Legacy auth allow-list: maps a raw API key value to its environment. */
export type WorkOSSeedApiKeyAuthMap = Record<string, { environment: string }>;

export interface WorkOSSeedConfig {
  organizations?: WorkOSSeedOrganization[];
  users?: WorkOSSeedUser[];
  connections?: WorkOSSeedConnection[];
  pipeConnections?: WorkOSSeedPipeConnection[];
  invitations?: WorkOSSeedInvitation[];
  roles?: WorkOSSeedRole[];
  permissions?: WorkOSSeedPermission[];
  webhookEndpoints?: WorkOSSeedWebhookEndpoint[];
  connectApplications?: WorkOSSeedConnectApplication[];
  /**
   * API keys. Either the legacy auth allow-list map (value → environment) or an array
   * of API key resources. The array form creates `api_key` records AND registers each
   * value in the auth allow-list so the seeded key authenticates requests.
   */
  apiKeys?: WorkOSSeedApiKeyAuthMap | WorkOSSeedApiKey[];
}

export function seedFromConfig(store: Store, _baseUrl: string, config: WorkOSSeedConfig): void {
  // Validate the config before seeding
  const validation = validateSeedConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid seed configuration:\n${formatValidationErrors(validation.errors)}`);
  }

  const ws = getWorkOSStore(store);

  if (config.users) {
    for (const userConfig of config.users) {
      ws.users.insert({
        object: 'user',
        email: userConfig.email,
        first_name: userConfig.first_name ?? null,
        last_name: userConfig.last_name ?? null,
        email_verified: userConfig.email_verified ?? false,
        profile_picture_url: null,
        last_sign_in_at: null,
        external_id: userConfig.external_id ?? null,
        metadata: userConfig.metadata ?? {},
        locale: null,
        password_hash: userConfig.password ? hashPassword(userConfig.password) : null,
        impersonator: userConfig.impersonator ?? null,
      });
    }
  }

  if (config.organizations) {
    for (const orgConfig of config.organizations) {
      const org = ws.organizations.insert({
        object: 'organization',
        name: orgConfig.name,
        external_id: orgConfig.external_id ?? null,
        metadata: orgConfig.metadata ?? {},
        stripe_customer_id: null,
      });

      if (orgConfig.domains) {
        for (const dd of orgConfig.domains) {
          ws.organizationDomains.insert({
            object: 'organization_domain',
            organization_id: org.id,
            domain: dd.domain,
            state: dd.state ?? 'pending',
            verification_strategy: 'manual',
            verification_token: generateVerificationToken(),
            verification_prefix: 'workos-verify',
          });
        }
      }

      if (orgConfig.memberships) {
        for (const mm of orgConfig.memberships) {
          ws.organizationMemberships.insert({
            object: 'organization_membership',
            organization_id: org.id,
            user_id: mm.user_id,
            role: { slug: mm.role ?? 'member' },
            status: mm.status ?? 'active',
            external_id: null,
            metadata: {},
          });
        }
      }
    }
  }

  if (config.connections) {
    for (const connConfig of config.connections) {
      const org = ws.organizations.findOneBy('name', connConfig.organization);
      if (!org) continue;

      const domains = (connConfig.domains ?? []).map((d) => ({
        object: 'connection_domain' as const,
        id: generateId('conn_domain'),
        domain: d,
      }));

      const conn = ws.connections.insert({
        object: 'connection',
        organization_id: org.id,
        connection_type: connConfig.connection_type ?? 'GenericSAML',
        name: connConfig.name,
        state: connConfig.state ?? 'active',
        domains,
      });

      if (connConfig.profiles) {
        for (const p of connConfig.profiles) {
          ws.ssoProfiles.insert({
            object: 'profile',
            connection_id: conn.id,
            connection_type: conn.connection_type,
            organization_id: org.id,
            idp_id: p.idp_id ?? `idp_${generateId('usr')}`,
            email: p.email,
            first_name: p.first_name ?? null,
            last_name: p.last_name ?? null,
            groups: p.groups ?? [],
            raw_attributes: { email: p.email },
          });
        }
      }
    }
  }

  if (config.pipeConnections) {
    for (const pc of config.pipeConnections) {
      ws.pipeConnections.insert({
        object: 'pipe_connection',
        user_id: pc.user_id,
        provider: pc.provider,
        scopes: pc.scopes,
        status: pc.status ?? 'connected',
        external_account_id: pc.external_account_id ?? null,
      });
    }
  }

  if (config.permissions) {
    for (const permConfig of config.permissions) {
      ws.permissions.insert({
        object: 'permission',
        slug: permConfig.slug,
        name: permConfig.name,
        description: permConfig.description ?? null,
      });
    }
  }

  if (config.roles) {
    for (const roleConfig of config.roles) {
      const role = ws.roles.insert({
        object: 'role',
        slug: roleConfig.slug,
        name: roleConfig.name,
        description: roleConfig.description ?? null,
        type: roleConfig.type ?? 'EnvironmentRole',
        organization_id: roleConfig.organization_id ?? null,
        is_default_role: roleConfig.is_default_role ?? false,
        priority: roleConfig.priority ?? 0,
      });

      if (roleConfig.permissions) {
        for (const permSlug of roleConfig.permissions) {
          const perm = ws.permissions.findOneBy('slug', permSlug);
          if (perm) {
            ws.rolePermissions.insert({ role_id: role.id, permission_id: perm.id });
          }
        }
      }
    }
  }

  if (config.invitations) {
    for (const invConfig of config.invitations) {
      const token = generateVerificationToken();
      ws.invitations.insert({
        object: 'invitation',
        email: invConfig.email,
        state: 'pending',
        token,
        accept_invitation_url: `${_baseUrl}/user_management/invitations/accept?token=${token}`,
        organization_id: invConfig.organization_id ?? null,
        inviter_user_id: invConfig.inviter_user_id ?? null,
        role_slug: invConfig.role_slug ?? null,
        expires_at: expiresIn(72 * 60),
      });
    }
  }

  if (config.webhookEndpoints) {
    for (const whConfig of config.webhookEndpoints) {
      const endpointUrl = whConfig.endpoint_url ?? whConfig.url;
      if (!endpointUrl || typeof endpointUrl !== 'string') {
        throw new Error('workos seed config: webhookEndpoints[].endpoint_url is required');
      }
      ws.webhookEndpoints.insert({
        object: 'webhook_endpoint',
        endpoint_url: endpointUrl,
        secret: randomBytes(32).toString('hex'),
        enabled: whConfig.enabled !== false,
        events: whConfig.events ?? [],
        description: null,
      });
    }
  }

  if (config.connectApplications) {
    for (const appConfig of config.connectApplications) {
      const type = appConfig.type ?? 'm2m';
      const org = appConfig.organization ? ws.organizations.findOneBy('name', appConfig.organization) : undefined;
      // An m2m application must be tied to a real organization; a name that does not
      // resolve would otherwise produce an app with a null owner (invalid m2m shape).
      if (type === 'm2m' && !org) {
        throw new Error(
          `workos seed config: connectApplications[].organization not found: ${JSON.stringify(appConfig.organization)}`,
        );
      }

      const application = ws.connectApplications.insert({
        object: 'connect_application',
        name: appConfig.name,
        description: appConfig.description ?? null,
        application_type: type,
        organization_id: org?.id ?? null,
        scopes: appConfig.scopes ?? [],
        redirect_uris: appConfig.redirect_uris ?? [],
        client_id: appConfig.client_id ?? generateClientId(),
        logo_url: null,
      });

      // Always provision a client secret so the seeded app has usable credentials.
      const secretValue = appConfig.client_secret ?? `secret_${generateVerificationToken()}`;
      ws.clientSecrets.insert({
        object: 'client_secret',
        application_id: application.id,
        value: secretValue,
        last_four: secretValue.slice(-4),
      });
    }
  }

  // The array form seeds API key resources; the map form is the legacy auth allow-list
  // handled at server creation (see createEmulator), so it is skipped here.
  if (Array.isArray(config.apiKeys)) {
    const authMap = store.getData<ApiKeyMap>(STORE_KEYS.apiKeyMap) ?? {};
    for (const keyConfig of config.apiKeys) {
      const value = keyConfig.value ?? `sk_test_${generateVerificationToken()}`;
      const environment = keyConfig.environment ?? (value.startsWith('sk_live_') ? 'production' : 'test');
      const org = keyConfig.organization ? ws.organizations.findOneBy('name', keyConfig.organization) : undefined;
      // The owner organization must resolve; otherwise the key would be created with an
      // empty owner id yet still authenticate requests (config validation guarantees the
      // `organization` field is present for both org- and user-owned keys).
      if (keyConfig.organization && !org) {
        throw new Error(
          `workos seed config: apiKeys[].organization not found: ${JSON.stringify(keyConfig.organization)}`,
        );
      }

      const owner: WorkOSApiKeyOwner = keyConfig.user_id
        ? { type: 'user', id: keyConfig.user_id, organization_id: org?.id ?? '' }
        : { type: 'organization', id: org?.id ?? '' };

      const expiresAt = keyConfig.expires_at ?? null;
      ws.apiKeyRecords.insert({
        object: 'api_key',
        name: keyConfig.name,
        key: value,
        environment,
        owner,
        permissions: keyConfig.permissions ?? [],
        last_used_at: null,
        expires_at: expiresAt,
      });

      // Register the value in the shared auth allow-list (the same object the auth
      // middleware holds by reference) so the seeded key authenticates real requests.
      // An already-expired key is created as a resource but not registered, so it does
      // not authenticate — matching production, where an expired key is rejected.
      if (!expiresAt || !isExpired(expiresAt)) {
        authMap[value] = { environment };
      }
    }
    store.setData(STORE_KEYS.apiKeyMap, authMap);
  }
}

export const workosPlugin: ServicePlugin = {
  name: 'workos',
  register(ctx: RouteContext): void {
    organizationRoutes(ctx);
    organizationDomainRoutes(ctx);
    membershipRoutes(ctx);
    userRoutes(ctx);
    emailVerificationRoutes(ctx);
    passwordResetRoutes(ctx);
    magicAuthRoutes(ctx);
    authFactorRoutes(ctx);
    authChallengeRoutes(ctx);
    sessionRoutes(ctx);
    authRoutes(ctx);
    connectionRoutes(ctx);
    ssoRoutes(ctx);
    pipeRoutes(ctx);
    invitationRoutes(ctx);
    configRoutes(ctx);
    userFeatureRoutes(ctx);
    widgetRoutes(ctx);
    authorizationRoleRoutes(ctx);
    authorizationPermissionRoutes(ctx);
    authorizationOrgRoleRoutes(ctx);
    authorizationResourceRoutes(ctx);
    authorizationCheckRoutes(ctx);
    portalRoutes(ctx);
    legacyMfaRoutes(ctx);
    apiKeyRoutes(ctx);
    radarRoutes(ctx);
    connectRoutes(ctx);
    oauthRoutes(ctx);
    directoryRoutes(ctx);
    auditLogRoutes(ctx);
    featureFlagRoutes(ctx);
    dataIntegrationRoutes(ctx);
    webhookEndpointRoutes(ctx);
    eventRoutes(ctx);

    // Set up event bus with collection hooks (Option A from spec)
    // Store on ctx.store for route-level access (hybrid Option A+B for action events)
    // Check for webhook retry config in store data (set by emulator options)
    const webhookRetryConfig = ctx.store.getData<any>('webhookRetryConfig');
    const webhookDebugMode = ctx.store.getData<boolean>('webhookDebugMode') ?? false;

    const eventBus = new EventBus(ctx.store, {
      retryConfig: webhookRetryConfig,
      debugMode: webhookDebugMode,
    });
    ctx.store.setData(STORE_KEYS.eventBus, eventBus);
    const ws = getWorkOSStore(ctx.store);

    ws.users.setHooks({
      onInsert: (u) => eventBus.emit({ event: EVENTS.userCreated, data: formatUser(u) }),
      onUpdate: (u) => eventBus.emit({ event: EVENTS.userUpdated, data: formatUser(u) }),
      onDelete: (u) => eventBus.emit({ event: EVENTS.userDeleted, data: formatUser(u) }),
    });
    ws.organizations.setHooks({
      onInsert: (o) => eventBus.emit({ event: EVENTS.organizationCreated, data: formatOrganization(o, ws) }),
      onUpdate: (o) => eventBus.emit({ event: EVENTS.organizationUpdated, data: formatOrganization(o, ws) }),
      onDelete: (o) => eventBus.emit({ event: EVENTS.organizationDeleted, data: formatOrganization(o, ws) }),
    });
    ws.organizationDomains.setHooks({
      onInsert: (d) => eventBus.emit({ event: EVENTS.organizationDomainCreated, data: formatDomain(d) }),
      onUpdate: (d) =>
        eventBus.emit({
          event: d.state === 'verified' ? EVENTS.organizationDomainVerified : EVENTS.organizationDomainUpdated,
          data: formatDomain(d),
        }),
      onDelete: (d) => eventBus.emit({ event: EVENTS.organizationDomainDeleted, data: formatDomain(d) }),
    });
    ws.organizationMemberships.setHooks({
      onInsert: (m) => eventBus.emit({ event: EVENTS.organizationMembershipCreated, data: formatMembership(m) }),
      onUpdate: (m) => eventBus.emit({ event: EVENTS.organizationMembershipUpdated, data: formatMembership(m) }),
      onDelete: (m) => eventBus.emit({ event: EVENTS.organizationMembershipDeleted, data: formatMembership(m) }),
    });
    ws.connections.setHooks({
      // The spec has no connection.created/updated — only activation state transitions
      onInsert: (c) => {
        if (c.state === 'active') eventBus.emit({ event: EVENTS.connectionActivated, data: formatConnection(c) });
      },
      onUpdate: (c, prev) => {
        if (c.state === prev.state) return;
        if (c.state === 'active') {
          eventBus.emit({ event: EVENTS.connectionActivated, data: formatConnection(c) });
        } else if (c.state === 'inactive') {
          eventBus.emit({ event: EVENTS.connectionDeactivated, data: formatConnection(c) });
        }
      },
      onDelete: (c) => eventBus.emit({ event: EVENTS.connectionDeleted, data: formatConnection(c) }),
    });
    ws.sessions.setHooks({
      onInsert: (s) => eventBus.emit({ event: EVENTS.sessionCreated, data: formatSession(s) }),
      onDelete: (s) => eventBus.emit({ event: EVENTS.sessionRevoked, data: formatSession(s) }),
    });
    ws.invitations.setHooks({
      onInsert: (i) => eventBus.emit({ event: EVENTS.invitationCreated, data: formatInvitation(i) }),
    });
    // Lifecycle resources created during login flows. No delete hooks: codes are
    // deleted when consumed, and the spec has no events for that.
    ws.emailVerifications.setHooks({
      onInsert: (ev) => eventBus.emit({ event: EVENTS.emailVerificationCreated, data: formatEmailVerification(ev) }),
    });
    ws.magicAuths.setHooks({
      onInsert: (ma) => eventBus.emit({ event: EVENTS.magicAuthCreated, data: formatMagicAuth(ma) }),
    });
    ws.passwordResets.setHooks({
      onInsert: (pr) => eventBus.emit({ event: EVENTS.passwordResetCreated, data: formatPasswordReset(pr) }),
    });
    // Organization-scoped roles share the roles collection but have their own spec events
    ws.roles.setHooks({
      onInsert: (r) =>
        eventBus.emit({
          event: r.type === 'OrganizationRole' ? EVENTS.organizationRoleCreated : EVENTS.roleCreated,
          data: formatRole(r),
        }),
      onUpdate: (r) =>
        eventBus.emit({
          event: r.type === 'OrganizationRole' ? EVENTS.organizationRoleUpdated : EVENTS.roleUpdated,
          data: formatRole(r),
        }),
      onDelete: (r) =>
        eventBus.emit({
          event: r.type === 'OrganizationRole' ? EVENTS.organizationRoleDeleted : EVENTS.roleDeleted,
          data: formatRole(r),
        }),
    });
    ws.permissions.setHooks({
      onInsert: (p) => eventBus.emit({ event: EVENTS.permissionCreated, data: formatPermission(p) }),
      onUpdate: (p) => eventBus.emit({ event: EVENTS.permissionUpdated, data: formatPermission(p) }),
      onDelete: (p) => eventBus.emit({ event: EVENTS.permissionDeleted, data: formatPermission(p) }),
    });
    ws.directories.setHooks({
      // The spec has no dsync.updated — only activation and deletion
      onInsert: (d) => eventBus.emit({ event: EVENTS.dsyncActivated, data: formatDirectory(d) }),
      onDelete: (d) => eventBus.emit({ event: EVENTS.dsyncDeleted, data: formatDirectory(d) }),
    });
    ws.directoryUsers.setHooks({
      onInsert: (u) => eventBus.emit({ event: EVENTS.dsyncUserCreated, data: formatDirectoryUser(u) }),
      onUpdate: (u) => eventBus.emit({ event: EVENTS.dsyncUserUpdated, data: formatDirectoryUser(u) }),
      onDelete: (u) => eventBus.emit({ event: EVENTS.dsyncUserDeleted, data: formatDirectoryUser(u) }),
    });
    ws.directoryGroups.setHooks({
      onInsert: (g) => eventBus.emit({ event: EVENTS.dsyncGroupCreated, data: formatDirectoryGroup(g) }),
      onUpdate: (g) => eventBus.emit({ event: EVENTS.dsyncGroupUpdated, data: formatDirectoryGroup(g) }),
      onDelete: (g) => eventBus.emit({ event: EVENTS.dsyncGroupDeleted, data: formatDirectoryGroup(g) }),
    });
    ws.apiKeyRecords.setHooks({
      onInsert: (k) => eventBus.emit({ event: EVENTS.apiKeyCreated, data: formatApiKeyRecord(k) }),
      onUpdate: (k) => eventBus.emit({ event: EVENTS.apiKeyUpdated, data: formatApiKeyRecord(k) }),
      onDelete: (k) => eventBus.emit({ event: EVENTS.apiKeyRevoked, data: formatApiKeyRecord(k) }),
    });
    ws.featureFlags.setHooks({
      onInsert: (f) => eventBus.emit({ event: EVENTS.flagCreated, data: formatFeatureFlag(f) }),
      onUpdate: (f) => eventBus.emit({ event: EVENTS.flagUpdated, data: formatFeatureFlag(f) }),
      onDelete: (f) => eventBus.emit({ event: EVENTS.flagDeleted, data: formatFeatureFlag(f) }),
    });
    ws.webhookEndpoints.setHooks({
      onInsert: () => eventBus.rebuildIndex(),
      onUpdate: () => eventBus.rebuildIndex(),
      onDelete: () => eventBus.rebuildIndex(),
    });
  },
  seed(_store: Store, _baseUrl: string): void {
    // No default seed data — users provide their own via seedFromConfig
  },
};

export default workosPlugin;
