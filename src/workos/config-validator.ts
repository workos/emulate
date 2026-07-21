/**
 * Configuration validation for seed config files
 */
import type { WorkOSSeedConfig } from './index.js';

export interface ConfigValidationError {
  path: string;
  message: string;
  value?: unknown;
}

export interface ConfigValidationResult {
  valid: boolean;
  errors: ConfigValidationError[];
}

export function validateSeedConfig(config: WorkOSSeedConfig): ConfigValidationResult {
  const errors: ConfigValidationError[] = [];

  // Seeded user ids are generated at insert time, so org memberships reference users
  // by email — collect the emails defined in this config for cross-referencing.
  const userEmails = new Set(
    Array.isArray(config.users)
      ? config.users.map((u) => u.email).filter((e): e is string => typeof e === 'string')
      : [],
  );

  // Validate users
  if (config.users) {
    if (!Array.isArray(config.users)) {
      errors.push({
        path: 'users',
        message: 'users must be an array',
        value: config.users,
      });
    } else {
      config.users.forEach((user, index) => {
        if (!user.email || typeof user.email !== 'string') {
          errors.push({
            path: `users[${index}].email`,
            message: 'email is required and must be a string',
            value: user.email,
          });
        }
        if (user.id !== undefined && (typeof user.id !== 'string' || user.id.length === 0)) {
          errors.push({
            path: `users[${index}].id`,
            message: 'id must be a non-empty string if provided',
            value: user.id,
          });
        }
        if (user.password && typeof user.password !== 'string') {
          errors.push({
            path: `users[${index}].password`,
            message: 'password must be a string if provided',
            value: user.password,
          });
        }
        if (user.email_verified !== undefined && typeof user.email_verified !== 'boolean') {
          errors.push({
            path: `users[${index}].email_verified`,
            message: 'email_verified must be a boolean if provided',
            value: user.email_verified,
          });
        }
      });

      // Email is the lookup key org memberships join on; duplicates would silently
      // bind a membership to the first match.
      const seenEmails = new Set<string>();
      config.users.forEach((user, index) => {
        if (!user.email || typeof user.email !== 'string') return;
        if (seenEmails.has(user.email)) {
          errors.push({
            path: `users[${index}].email`,
            message: 'email must be unique across users',
            value: user.email,
          });
        }
        seenEmails.add(user.email);
      });

      // A pinned user id is the primary key in the store; two users sharing one would
      // silently overwrite each other on insert.
      const seenUserIds = new Set<string>();
      config.users.forEach((user, index) => {
        if (typeof user.id !== 'string' || user.id.length === 0) return;
        if (seenUserIds.has(user.id)) {
          errors.push({
            path: `users[${index}].id`,
            message: 'id must be unique across users',
            value: user.id,
          });
        }
        seenUserIds.add(user.id);
      });
    }
  }

  // Validate organizations
  if (config.organizations) {
    if (!Array.isArray(config.organizations)) {
      errors.push({
        path: 'organizations',
        message: 'organizations must be an array',
        value: config.organizations,
      });
    } else {
      config.organizations.forEach((org, index) => {
        if (!org.name || typeof org.name !== 'string') {
          errors.push({
            path: `organizations[${index}].name`,
            message: 'name is required and must be a string',
            value: org.name,
          });
        }
        if (org.id !== undefined && (typeof org.id !== 'string' || org.id.length === 0)) {
          errors.push({
            path: `organizations[${index}].id`,
            message: 'id must be a non-empty string if provided',
            value: org.id,
          });
        }
        if (org.domains) {
          if (!Array.isArray(org.domains)) {
            errors.push({
              path: `organizations[${index}].domains`,
              message: 'domains must be an array if provided',
              value: org.domains,
            });
          } else {
            org.domains.forEach((domain, dIndex) => {
              if (!domain.domain || typeof domain.domain !== 'string') {
                errors.push({
                  path: `organizations[${index}].domains[${dIndex}].domain`,
                  message: 'domain is required and must be a string',
                  value: domain.domain,
                });
              }
              if (domain.state && !['verified', 'pending'].includes(domain.state)) {
                errors.push({
                  path: `organizations[${index}].domains[${dIndex}].state`,
                  message: 'state must be "verified" or "pending" if provided',
                  value: domain.state,
                });
              }
            });
          }
        }
        if (org.memberships) {
          if (!Array.isArray(org.memberships)) {
            errors.push({
              path: `organizations[${index}].memberships`,
              message: 'memberships must be an array if provided',
              value: org.memberships,
            });
          } else {
            org.memberships.forEach((membership, mIndex) => {
              // The pre-rename key: it read as "pass a user_... id", which can never
              // resolve (ids are generated at startup) — point at `email` instead.
              const legacyUserId = (membership as { user_id?: unknown }).user_id;
              if (!membership.email || typeof membership.email !== 'string') {
                if (legacyUserId !== undefined) {
                  errors.push({
                    path: `organizations[${index}].memberships[${mIndex}].user_id`,
                    message:
                      'memberships reference seeded users by email — use `email` (seeded user ids are generated at startup, so a user_id literal can never resolve)',
                    value: legacyUserId,
                  });
                } else {
                  errors.push({
                    path: `organizations[${index}].memberships[${mIndex}].email`,
                    message: 'email is required and must be the email of a user defined in users',
                    value: membership.email,
                  });
                }
              } else if (!userEmails.has(membership.email)) {
                // A dangling reference would seed a membership whose embedded user
                // cannot resolve, which membership serialization rejects.
                errors.push({
                  path: `organizations[${index}].memberships[${mIndex}].email`,
                  message: 'email must match a user defined in users',
                  value: membership.email,
                });
              }
              if (membership.status && !['active', 'inactive', 'pending'].includes(membership.status)) {
                errors.push({
                  path: `organizations[${index}].memberships[${mIndex}].status`,
                  message: 'status must be "active", "inactive", or "pending" if provided',
                  value: membership.status,
                });
              }
            });
          }
        }
      });

      // Organization name is the lookup key for connections, connectApplications, and
      // apiKeys seeds; duplicates would silently bind those to the first match.
      const seenOrgNames = new Set<string>();
      config.organizations.forEach((org, index) => {
        if (!org.name || typeof org.name !== 'string') return;
        if (seenOrgNames.has(org.name)) {
          errors.push({
            path: `organizations[${index}].name`,
            message: 'name must be unique across organizations',
            value: org.name,
          });
        }
        seenOrgNames.add(org.name);
      });

      // A pinned organization id is the primary key in the store; two orgs sharing one
      // would silently overwrite each other on insert.
      const seenOrgIds = new Set<string>();
      config.organizations.forEach((org, index) => {
        if (typeof org.id !== 'string' || org.id.length === 0) return;
        if (seenOrgIds.has(org.id)) {
          errors.push({
            path: `organizations[${index}].id`,
            message: 'id must be unique across organizations',
            value: org.id,
          });
        }
        seenOrgIds.add(org.id);
      });
    }
  }

  // Validate connections
  if (config.connections) {
    if (!Array.isArray(config.connections)) {
      errors.push({
        path: 'connections',
        message: 'connections must be an array',
        value: config.connections,
      });
    } else {
      config.connections.forEach((conn, index) => {
        if (!conn.name || typeof conn.name !== 'string') {
          errors.push({
            path: `connections[${index}].name`,
            message: 'name is required and must be a string',
            value: conn.name,
          });
        }
        if (!conn.organization || typeof conn.organization !== 'string') {
          errors.push({
            path: `connections[${index}].organization`,
            message: 'organization is required and must be a string',
            value: conn.organization,
          });
        }
        if (conn.state && !['active', 'inactive', 'validating'].includes(conn.state)) {
          errors.push({
            path: `connections[${index}].state`,
            message: 'state must be "active", "inactive", or "validating" if provided',
            value: conn.state,
          });
        }
      });
    }
  }

  // Validate roles
  if (config.roles) {
    if (!Array.isArray(config.roles)) {
      errors.push({
        path: 'roles',
        message: 'roles must be an array',
        value: config.roles,
      });
    } else {
      config.roles.forEach((role, index) => {
        if (!role.slug || typeof role.slug !== 'string') {
          errors.push({
            path: `roles[${index}].slug`,
            message: 'slug is required and must be a string',
            value: role.slug,
          });
        }
        if (!role.name || typeof role.name !== 'string') {
          errors.push({
            path: `roles[${index}].name`,
            message: 'name is required and must be a string',
            value: role.name,
          });
        }
        if (role.type && !['EnvironmentRole', 'OrganizationRole'].includes(role.type)) {
          errors.push({
            path: `roles[${index}].type`,
            message: 'type must be "EnvironmentRole" or "OrganizationRole" if provided',
            value: role.type,
          });
        }
      });
    }
  }

  // Validate permissions
  if (config.permissions) {
    if (!Array.isArray(config.permissions)) {
      errors.push({
        path: 'permissions',
        message: 'permissions must be an array',
        value: config.permissions,
      });
    } else {
      config.permissions.forEach((perm, index) => {
        if (!perm.slug || typeof perm.slug !== 'string') {
          errors.push({
            path: `permissions[${index}].slug`,
            message: 'slug is required and must be a string',
            value: perm.slug,
          });
        }
        if (!perm.name || typeof perm.name !== 'string') {
          errors.push({
            path: `permissions[${index}].name`,
            message: 'name is required and must be a string',
            value: perm.name,
          });
        }
      });
    }
  }

  // Validate webhook endpoints
  if (config.webhookEndpoints) {
    if (!Array.isArray(config.webhookEndpoints)) {
      errors.push({
        path: 'webhookEndpoints',
        message: 'webhookEndpoints must be an array',
        value: config.webhookEndpoints,
      });
    } else {
      config.webhookEndpoints.forEach((endpoint, index) => {
        const url = endpoint.endpoint_url || endpoint.url;
        if (!url || typeof url !== 'string') {
          errors.push({
            path: `webhookEndpoints[${index}].endpoint_url`,
            message: 'endpoint_url is required and must be a string',
            value: url,
          });
        } else {
          try {
            new URL(url);
          } catch {
            errors.push({
              path: `webhookEndpoints[${index}].endpoint_url`,
              message: 'endpoint_url must be a valid URL',
              value: url,
            });
          }
        }
        if (endpoint.events && !Array.isArray(endpoint.events)) {
          errors.push({
            path: `webhookEndpoints[${index}].events`,
            message: 'events must be an array if provided',
            value: endpoint.events,
          });
        }
      });
    }
  }

  // Validate invitations
  if (config.invitations) {
    if (!Array.isArray(config.invitations)) {
      errors.push({
        path: 'invitations',
        message: 'invitations must be an array',
        value: config.invitations,
      });
    } else {
      config.invitations.forEach((inv, index) => {
        if (!inv.email || typeof inv.email !== 'string') {
          errors.push({
            path: `invitations[${index}].email`,
            message: 'email is required and must be a string',
            value: inv.email,
          });
        }
      });
    }
  }

  // Validate connect applications
  if (config.connectApplications) {
    if (!Array.isArray(config.connectApplications)) {
      errors.push({
        path: 'connectApplications',
        message: 'connectApplications must be an array',
        value: config.connectApplications,
      });
    } else {
      config.connectApplications.forEach((appConfig, index) => {
        if (!appConfig.name || typeof appConfig.name !== 'string') {
          errors.push({
            path: `connectApplications[${index}].name`,
            message: 'name is required and must be a string',
            value: appConfig.name,
          });
        }
        if (appConfig.type && !['m2m', 'oauth'].includes(appConfig.type)) {
          errors.push({
            path: `connectApplications[${index}].type`,
            message: 'type must be "m2m" or "oauth" if provided',
            value: appConfig.type,
          });
        }
        const type = appConfig.type ?? 'm2m';
        if (type === 'm2m' && (!appConfig.organization || typeof appConfig.organization !== 'string')) {
          errors.push({
            path: `connectApplications[${index}].organization`,
            message: 'organization is required for m2m applications',
            value: appConfig.organization,
          });
        }
        if (
          appConfig.scopes !== undefined &&
          (!Array.isArray(appConfig.scopes) || !appConfig.scopes.every((s) => typeof s === 'string'))
        ) {
          errors.push({
            path: `connectApplications[${index}].scopes`,
            message: 'scopes must be an array of strings if provided',
            value: appConfig.scopes,
          });
        }
        if (appConfig.audience !== undefined && typeof appConfig.audience !== 'string') {
          errors.push({
            path: `connectApplications[${index}].audience`,
            message: 'audience must be a string if provided',
            value: appConfig.audience,
          });
        }
      });

      // A client_id identifies exactly one application; duplicates make token exchange
      // ambiguous (the lookup would resolve only the first match), so reject them.
      const seenClientIds = new Set<string>();
      config.connectApplications.forEach((appConfig, index) => {
        if (!appConfig.client_id) return;
        if (seenClientIds.has(appConfig.client_id)) {
          errors.push({
            path: `connectApplications[${index}].client_id`,
            message: 'client_id must be unique across connectApplications',
            value: appConfig.client_id,
          });
        }
        seenClientIds.add(appConfig.client_id);
      });
    }
  }

  // Validate API key resources. The map form is the legacy auth allow-list and is
  // intentionally left unvalidated here; only the array (resource) form is checked.
  if (config.apiKeys && Array.isArray(config.apiKeys)) {
    config.apiKeys.forEach((keyConfig, index) => {
      if (!keyConfig.name || typeof keyConfig.name !== 'string') {
        errors.push({
          path: `apiKeys[${index}].name`,
          message: 'name is required and must be a string',
          value: keyConfig.name,
        });
      }
      if (!keyConfig.organization && !keyConfig.user_id) {
        errors.push({
          path: `apiKeys[${index}].organization`,
          message: 'organization or user_id is required',
        });
      }
      if (keyConfig.user_id && !keyConfig.organization) {
        errors.push({
          path: `apiKeys[${index}].organization`,
          message: 'organization is required when user_id is set (supplies organization_id)',
        });
      }
      if (
        keyConfig.value !== undefined &&
        (typeof keyConfig.value !== 'string' || !keyConfig.value.startsWith('sk_'))
      ) {
        errors.push({
          path: `apiKeys[${index}].value`,
          message: 'value must be a string starting with "sk_" if provided',
          value: keyConfig.value,
        });
      }
      if (keyConfig.permissions && !Array.isArray(keyConfig.permissions)) {
        errors.push({
          path: `apiKeys[${index}].permissions`,
          message: 'permissions must be an array if provided',
          value: keyConfig.permissions,
        });
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export function formatValidationErrors(errors: ConfigValidationError[]): string {
  return errors
    .map((error) => {
      const valueStr = error.value !== undefined ? ` (got: ${JSON.stringify(error.value)})` : '';
      return `  - ${error.path}: ${error.message}${valueStr}`;
    })
    .join('\n');
}
