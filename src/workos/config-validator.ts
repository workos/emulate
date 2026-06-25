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
