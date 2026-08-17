/**
 * Configuration validation for seed config files
 */
import type { WorkOSSeedConfig } from './index.js';
import { validateJwtTemplateContent } from './jwt-template.js';
import { normalizeEmail, type NormalizedEmail } from './helpers.js';

/**
 * A seed is the one creation path that does not go through a route, so it is held to what the
 * routes enforce: an address is trimmed and is shaped like an address. Anything looser and a seed
 * is the remaining way to write a user under a spelling no lookup by email resolves — which is the
 * state all of this exists to prevent.
 *
 * Returns the stored form, or the problem for the caller to word in its own terms: each site
 * already says something more specific than "email" about what the address is for.
 */
function seedEmail(value: unknown): NormalizedEmail {
  return normalizeEmail(value, { requireShape: true });
}

/**
 * A pinned id is addressed as a single path segment (`/organizations/:id`,
 * `/user_management/users/:id`), so it must be URL-safe — a delimiter like `/` would
 * make the seeded resource unreachable by its documented id route. This charset accepts
 * every real WorkOS id (`org_01…`, `user_01…`) and every emulator-generated id
 * (`prefix_<Crockford-Base32>`) while rejecting anything that would split or need encoding.
 */
const PINNED_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

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
  // by email — collect the emails defined in this config for cross-referencing. Normalized the way
  // the store resolves them: lowercased, because every lookup by email is case-insensitive, and
  // trimmed, because that is the form seeding writes. A membership for 'a@x.test' names the user
  // seeded as ' A@x.test ', and resolving it any other way would reject a reference the running
  // emulator then honours.
  const userEmails = new Set(
    Array.isArray(config.users)
      ? config.users
          .map((u) => seedEmail(u.email))
          .filter((r): r is { ok: true; email: string } => r.ok)
          .map((r) => r.email.toLowerCase())
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
        const email = seedEmail(user.email);
        if (!email.ok) {
          errors.push({
            path: `users[${index}].email`,
            message:
              email.problem === 'malformed'
                ? // Same standard as the two routes that create users: an address that could only
                  // be a typo becomes an account nothing can reach, and a seed is the one creation
                  // path with no route in front of it to say so.
                  'email must be a valid email address'
                : 'email is required and must be a string',
            value: user.email,
          });
        }
        if (user.id !== undefined && (typeof user.id !== 'string' || !PINNED_ID_PATTERN.test(user.id))) {
          errors.push({
            path: `users[${index}].id`,
            message: 'id must be a non-empty, URL-safe string (letters, digits, "_" or "-") if provided',
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
        // Both are serialized straight onto the identity the users endpoint returns and the
        // `user.identities` map a template reads, so a non-string here is a contract the emulator
        // would break on behalf of a config only YAML or JSON could have written. The provider is
        // not checked against the spec's enum — `connections[].connection_type` is not either, and
        // a list baked in here would reject a provider WorkOS adds later.
        if (user.oauth_provider !== undefined && (typeof user.oauth_provider !== 'string' || !user.oauth_provider)) {
          errors.push({
            path: `users[${index}].oauth_provider`,
            message: 'oauth_provider must be a non-empty string if provided',
            value: user.oauth_provider,
          });
        }
        if (user.oauth_idp_id !== undefined && (typeof user.oauth_idp_id !== 'string' || !user.oauth_idp_id)) {
          errors.push({
            path: `users[${index}].oauth_idp_id`,
            message: 'oauth_idp_id must be a non-empty string if provided',
            value: user.oauth_idp_id,
          });
        }
      });

      // Email is the lookup key org memberships join on; duplicates would silently
      // bind a membership to the first match. Compared case-insensitively, matching the
      // uniqueness the API enforces: `POST /user_management/users` answers 409 for an address
      // differing only in case, so a seed that got two through would be the one way left to
      // manufacture the pair of accounts no lookup by email can tell apart.
      const seenEmails = new Set<string>();
      config.users.forEach((user, index) => {
        const email = seedEmail(user.email);
        if (!email.ok) return;
        const normalized = email.email.toLowerCase();
        if (seenEmails.has(normalized)) {
          errors.push({
            path: `users[${index}].email`,
            message: 'email must be unique across users',
            value: user.email,
          });
        }
        seenEmails.add(normalized);
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
        if (org.id !== undefined && (typeof org.id !== 'string' || !PINNED_ID_PATTERN.test(org.id))) {
          errors.push({
            path: `organizations[${index}].id`,
            message: 'id must be a non-empty, URL-safe string (letters, digits, "_" or "-") if provided',
            value: org.id,
          });
        }
        if (
          org.entitlements !== undefined &&
          (!Array.isArray(org.entitlements) || org.entitlements.some((e) => typeof e !== 'string'))
        ) {
          errors.push({
            path: `organizations[${index}].entitlements`,
            message: 'entitlements must be an array of strings if provided',
            value: org.entitlements,
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
              const memberEmail = seedEmail(membership.email);
              if (!memberEmail.ok) {
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
                    message:
                      memberEmail.problem === 'malformed'
                        ? 'email must be a valid email address'
                        : 'email is required and must be the email of a user defined in users',
                    value: membership.email,
                  });
                }
              } else if (!userEmails.has(memberEmail.email.toLowerCase())) {
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
        if (org.groups) {
          if (!Array.isArray(org.groups)) {
            errors.push({
              path: `organizations[${index}].groups`,
              message: 'groups must be an array if provided',
              value: org.groups,
            });
          } else {
            // Group members reference an org membership by the user's email, and that
            // membership must be one declared in this org's `memberships` — the only seed
            // path that creates org memberships. Collect those emails to cross-reference,
            // the way `userEmails` cross-references membership emails against users.
            // Guard against a truthy non-array `memberships`: the memberships block above
            // already recorded a structured error for that, and falling through to here
            // would call `.map()` on the invalid value and crash startup instead of
            // returning that error.
            const orgMembershipEmails = new Set(
              (Array.isArray(org.memberships) ? org.memberships : [])
                .map((m) => seedEmail(m.email))
                .filter((r): r is { ok: true; email: string } => r.ok)
                .map((r) => r.email.toLowerCase()),
            );
            org.groups.forEach((group, gIndex) => {
              // A non-object entry (e.g. `groups: [null]` from a YAML/JSON typo) would
              // throw on `group.name` below; record a structured error and skip the
              // property checks rather than crashing startup or `--validate-config`.
              if (group === null || typeof group !== 'object') {
                errors.push({
                  path: `organizations[${index}].groups[${gIndex}]`,
                  message: 'each group must be an object',
                  value: group,
                });
                return;
              }
              if (!group.name || typeof group.name !== 'string') {
                errors.push({
                  path: `organizations[${index}].groups[${gIndex}].name`,
                  message: 'name is required and must be a string',
                  value: group.name,
                });
              }
              if (
                group.description !== undefined &&
                group.description !== null &&
                typeof group.description !== 'string'
              ) {
                errors.push({
                  path: `organizations[${index}].groups[${gIndex}].description`,
                  message: 'description must be a string or null if provided',
                  value: group.description,
                });
              }
              if (group.members) {
                if (!Array.isArray(group.members)) {
                  errors.push({
                    path: `organizations[${index}].groups[${gIndex}].members`,
                    message: 'members must be an array of emails if provided',
                    value: group.members,
                  });
                } else {
                  group.members.forEach((email, mIndex) => {
                    const memberEmail = seedEmail(email);
                    if (!memberEmail.ok) {
                      errors.push({
                        path: `organizations[${index}].groups[${gIndex}].members[${mIndex}]`,
                        message:
                          memberEmail.problem === 'malformed'
                            ? 'must be a valid email address'
                            : 'each member must be the email of a user',
                        value: email,
                      });
                    } else if (!orgMembershipEmails.has(memberEmail.email.toLowerCase())) {
                      errors.push({
                        path: `organizations[${index}].groups[${gIndex}].members[${mIndex}]`,
                        message: "member email must match a membership defined in this organization's `memberships`",
                        value: email,
                      });
                    }
                  });
                }
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

  // Validate connected accounts
  if (config.connectedAccounts) {
    if (!Array.isArray(config.connectedAccounts)) {
      errors.push({
        path: 'connectedAccounts',
        message: 'connectedAccounts must be an array',
        value: config.connectedAccounts,
      });
    } else {
      // Organization name is the join key, the same one connections use.
      const orgNames = new Set(
        Array.isArray(config.organizations)
          ? config.organizations.map((o) => o.name).filter((n): n is string => typeof n === 'string')
          : [],
      );
      // (user, provider, organization) is the key requests address; a duplicate would seed
      // the pair POST answers 409 for, and every lookup would only ever resolve the first.
      const seenAccounts = new Set<string>();
      config.connectedAccounts.forEach((account, index) => {
        // A non-object entry (e.g. `connectedAccounts: [null]` from a YAML typo) would throw
        // on the property reads below; record a structured error instead of crashing startup.
        if (account === null || typeof account !== 'object') {
          errors.push({
            path: `connectedAccounts[${index}]`,
            message: 'each connected account must be an object',
            value: account,
          });
          return;
        }
        const email = seedEmail(account.email);
        if (!email.ok) {
          errors.push({
            path: `connectedAccounts[${index}].email`,
            message:
              email.problem === 'malformed'
                ? 'email must be a valid email address'
                : 'email is required and must be the email of a user defined in users',
            value: account.email,
          });
        } else if (!userEmails.has(email.email.toLowerCase())) {
          errors.push({
            path: `connectedAccounts[${index}].email`,
            message: 'email must match a user defined in users',
            value: account.email,
          });
        }
        if (!account.provider || typeof account.provider !== 'string') {
          errors.push({
            path: `connectedAccounts[${index}].provider`,
            message: 'provider is required and must be a non-empty string (the slug requests address, e.g. "github")',
            value: account.provider,
          });
        }
        if (
          account.organization !== undefined &&
          (typeof account.organization !== 'string' || !orgNames.has(account.organization))
        ) {
          errors.push({
            path: `connectedAccounts[${index}].organization`,
            message: 'organization must name an organization defined in organizations',
            value: account.organization,
          });
        }
        if (
          account.scopes !== undefined &&
          (!Array.isArray(account.scopes) || account.scopes.some((s) => typeof s !== 'string'))
        ) {
          errors.push({
            path: `connectedAccounts[${index}].scopes`,
            message: 'scopes must be an array of strings if provided',
            value: account.scopes,
          });
        }
        if (account.state && !['connected', 'needs_reauthorization'].includes(account.state)) {
          errors.push({
            path: `connectedAccounts[${index}].state`,
            message:
              'state must be "connected" or "needs_reauthorization" if provided — a disconnected account is a deleted one, so it cannot be seeded',
            value: account.state,
          });
        }
        if (email.ok && typeof account.provider === 'string' && account.provider) {
          const key = [
            email.email.toLowerCase(),
            account.provider,
            typeof account.organization === 'string' ? account.organization : '',
          ].join('\u0000');
          if (seenAccounts.has(key)) {
            errors.push({
              path: `connectedAccounts[${index}]`,
              message: 'duplicate connected account for this user, provider, and organization',
              value: { email: account.email, provider: account.provider, organization: account.organization },
            });
          }
          seenAccounts.add(key);
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
        const email = seedEmail(inv.email);
        if (!email.ok) {
          errors.push({
            path: `invitations[${index}].email`,
            message:
              email.problem === 'malformed'
                ? // As POST /user_management/invitations now answers: acceptance resolves the
                  // recipient by this address, so a typo is an invitation that enrolls nobody.
                  'email must be a valid email address'
                : 'email is required and must be a string',
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

    // A key value is the identity of the secret: it is the auth allow-list's map key and
    // the lookup key for the resource behind it. Two entries sharing one would split that
    // identity — the allow-list keeps the last entry's environment and expiry while the
    // record lookup resolves the first, so validation would gate on one seed entry and
    // report another's owner and permissions. Deleting either would also stop the other
    // authenticating. Production cannot issue one secret twice, so reject it here rather
    // than pick a winner.
    const seenKeyValues = new Set<string>();
    config.apiKeys.forEach((keyConfig, index) => {
      if (typeof keyConfig.value !== 'string' || keyConfig.value.length === 0) return;
      if (seenKeyValues.has(keyConfig.value)) {
        errors.push({
          path: `apiKeys[${index}].value`,
          message: 'value must be unique across apiKeys',
          value: keyConfig.value,
        });
      }
      seenKeyValues.add(keyConfig.value);
    });
  }

  // Validating the template here means `--validate-config` catches a broken one, rather
  // than leaving it to fail at the first sign-in.
  if (config.jwtTemplate !== undefined) {
    if (typeof config.jwtTemplate !== 'object' || config.jwtTemplate === null) {
      errors.push({
        path: 'jwtTemplate',
        message: 'must be an object with a content field',
        value: config.jwtTemplate,
      });
    } else {
      for (const problem of validateJwtTemplateContent(config.jwtTemplate.content)) {
        errors.push({ path: 'jwtTemplate.content', message: problem, value: config.jwtTemplate.content });
      }
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
