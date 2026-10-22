/**
 * Core codegen logic for gen-supported. Separated from the CLI entry point
 * so the transformation functions can be unit-tested independently.
 *
 * Builds the feature support matrix (SUPPORTED.md) by cross-referencing three
 * sources, none of which is hand-maintained:
 *   - the WorkOS OpenAPI spec (every endpoint that exists, grouped by tag)
 *   - the emulator's registered Hono routes (which of them are implemented)
 *   - the `EmulatorSeedConfig` keys (which features can be populated at boot)
 *
 * Endpoint coverage alone is misleading: Directory Sync implements every
 * endpoint the spec defines for it, yet nothing can create a directory, so the
 * feature is unusable. The `setup` column exists to catch exactly that case —
 * it asks "can you get data in?", which is what a reader actually wants to
 * know. See `deriveSetup`.
 *
 * The only hand-authored input is FEATURES: the spec's tags are API-shaped
 * (45 of them) while readers think in products (~20), and the caveat prose
 * needs judgment. Everything else is derived, so the table cannot drift from
 * the code without CI noticing.
 */

// ---------------------------------------------------------------------------
// Spec types
// ---------------------------------------------------------------------------

export interface SpecPathItem {
  [method: string]: { operationId?: string; summary?: string; tags?: string[] } | undefined;
}

export interface SupportSpec {
  paths?: Record<string, SpecPathItem>;
}

/** A single spec endpoint, flattened out of the paths object. */
export interface SpecOperation {
  method: string;
  /** Path with OpenAPI `{id}` params normalized to Hono `:id` form. */
  path: string;
  tag: string;
  summary?: string;
}

/** A route the emulator actually registers. */
export interface EmulatorRoute {
  method: string;
  path: string;
}

const READ_METHOD = 'GET';
const SPEC_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
/** Methods that can bring a record into existence. DELETE cannot — see `deriveSetup`. */
const CREATE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

// ---------------------------------------------------------------------------
// Feature map — the one hand-authored input
// ---------------------------------------------------------------------------

export interface FeatureDef {
  /** Product name as a reader would say it. */
  name: string;
  /** Spec tags that roll up into this product. */
  tags: string[];
  /**
   * `EmulatorSeedConfig` keys that populate this feature at boot. Validated
   * against the real interface — a stale key here fails the build rather than
   * silently promising seeding that does not exist.
   */
  seedKeys?: string[];
  /**
   * The feature is seedable through a config section that is not a top-level
   * `EmulatorSeedConfig` key — e.g. `memberships` or `groups` nested under
   * `organizations` — so it cannot be verified the way `seedKeys` can. When set,
   * `Set up` reports seeding honestly instead of falling back to "API only";
   * the note explains where the nested key lives. A top-level `seedKeys` entry,
   * if present, takes priority.
   */
  seedVia?: string;
  /**
   * Path prefixes for emulator-specific creation routes that have no spec
   * equivalent, e.g. `POST /feature-flags/:slug/enable`. These are excluded
   * from the coverage columns (they are not spec endpoints) but they are still
   * a genuine way to get data in, so `Set up` must see them.
   */
  emulatorCreateRoutes?: string[];
  /**
   * Data appears as a side effect of other operations rather than through any
   * endpoint — events are emitted, not created. Without this, such a feature
   * renders as "no way to create data", which reads as broken.
   */
  automatic?: boolean;
  /** Caveat prose. The only column that needs human judgment. */
  notes?: string;
}

/**
 * Spec tags grouped into products. Every tag in the spec must appear exactly
 * once; `buildMatrix` throws otherwise, so a new WorkOS product forces a
 * deliberate entry here instead of silently vanishing from the table.
 */
export const FEATURES: FeatureDef[] = [
  {
    name: 'Organizations',
    tags: ['organizations', 'organization-domains', 'organizations.it-contacts'],
    seedKeys: ['organizations'],
    notes:
      "IT contacts are stored lowercased, capped at 20 per organization, and listed whole under null cursors, as production does. An organization is held to one active Admin Portal invitation — inviting any contact while one is active conflicts, the holder included — but nothing is emailed: the setup link an invitation would send is recorded on the contact and served by no route. Revoking clears the organization's invitation through any contact, since no route reports which one holds it. The `403` and `503` these routes document are not implemented — the store is not environment-scoped, so the forbidden case cannot arise — but both can be injected through the error hooks. Domains are stored lowercased and validated as production does: a `domain_data` entry needs a `state` of `pending` or `verified`, and a malformed domain, a domain listed twice or a public consumer domain (production's list, vendored) is `422` before the organization is written; the organization's own duplicate on `POST /organization_domains` is `409 domain_already_exists`, but two organizations may share a domain, since production enforces uniqueness only behind a flag. `POST /organization_domains/{id}/verify` starts DNS verification — `201`, `pending`, the `dns` strategy and a fresh token; `400 domain_already_verified` once verified — and resolves no DNS, so a domain gets verified only by seeding `state: verified` or sending `domain_data[].state: verified`, which on update recreates the domain under a new id as production does. `external_id` is unique across organizations: `400 external_id_already_used` on create and update.",
  },
  {
    name: 'User Management',
    tags: ['user-management.users', 'user-management.session-tokens', 'user-management.waitlists'],
    seedKeys: ['users'],
    notes:
      "Email-change confirm/send and waitlist endpoints are not implemented. Passwords sent to create, update and the password-reset confirm are held to production's policy (10+ characters, 72 bytes at most, not containing the email, zxcvbn score 3+) and refused with production's error bodies; the breached-password lookup is not performed, and seeded passwords are written as given. A password reset token lasts 15 minutes, and confirming it signs the user out everywhere and verifies the email. A taken `external_id` is refused, and `email_verified` can be set but not unset.",
  },
  {
    name: 'Authentication',
    tags: ['user-management.authentication', 'user-management.magic-auth'],
    notes:
      'All grant types are hand-written rather than generated from the spec. Refresh tokens rotate on every exchange, with the documented 30-second replay grace period.',
  },
  {
    name: 'Organization Memberships',
    tags: ['user-management.organization-membership', 'user-management.organization-membership.groups'],
    seedVia: 'memberships',
    notes:
      'Seeded via `memberships` nested under an organization. A role slug must name a role of the organization or of the environment (`member` and `admin` always resolve, as production creates both with every environment), else `422 invalid_role`; listing wants an `organization_id` or `user_id`. Multiple roles are assumed enabled for the environment.',
  },
  {
    name: 'Groups',
    tags: ['groups'],
    seedVia: 'groups',
    notes:
      'Seeded via `groups` nested under an organization. Members reference a seeded membership by email. Names are unique within an organization (a bare `409`, as production renders it), `name` is at most 256 characters, `description` a non-empty string of at most 150, and a group holds at most 500 members.',
  },
  {
    name: 'Invitations',
    tags: ['user-management.invitations'],
    seedKeys: ['invitations'],
    notes:
      "State is derived when an invitation is read, so one expires on its own: 7 days by default, or `expires_in_days` from 1 to 30. A second open invitation for the address, an existing account on an environment invitation, an unknown role slug, and accepting, revoking or resending a non-pending invitation are refused with production's codes. There is no DELETE route, as there is none in the spec.",
  },
  {
    name: 'SSO',
    tags: ['sso', 'connections'],
    seedKeys: ['connections'],
    notes:
      'Seeded connections carry `profiles`, which drive the SSO login flow. `POST /connections` follows production: one SSO connection per organization (`connection_already_exists_for_organization`, with `organization_id` in the body), SAML and OIDC types only with their `saml_options` / `oidc_options` present, no `domains` field (seed-only), and a created connection starts `validating` until the first login through it activates it and emits `connection.activated`. `GET /connections` lists SSO connections only. `GET /sso/authorize` requires `client_id`, sends a `validating` connection through and redirects an `inactive` one back with `error=connection_unlinked`; `POST /sso/token` requires `client_id` and `client_secret` (an environment API key); authorization codes live five minutes.',
  },
  {
    name: 'Directory Sync',
    tags: ['directories', 'directory-users', 'directory-groups'],
    seedKeys: ['directories'],
    notes:
      'Read-only over HTTP, as production is: a directory is connected in the dashboard, so there is no POST route to emulate. Seed `directories` to get one, with its groups, its users, and group-to-role mappings resolved onto the organization membership (which then reports `directory_managed`); seeding emits `dsync.activated` (for a `linked` directory), `dsync.group.created`, `dsync.user.created`, and `dsync.group.user_added` for each seeded membership (queryable at `GET /events`, not delivered — seeded endpoints register after), and `DELETE /directories/:id` emits a delivered `dsync.deleted` — except for an `unlinked` directory with no groups, which production deletes silently. Removing a user from a group emits `dsync.group.user_removed`.',
  },
  {
    name: 'Multi-Factor Auth',
    tags: ['multi-factor-auth', 'multi-factor-auth.challenges', 'user-management.multi-factor-authentication'],
    notes: 'TOTP codes are accepted without verifying the shared secret.',
  },
  {
    name: 'FGA / Authorization',
    tags: ['authorization', 'permissions'],
    seedKeys: ['roles', 'permissions'],
    notes:
      "Checks and effective-permission listings include direct and native group role assignments, live group membership, and ancestor inheritance (`parent_resource_id`). Group grants support create/list/get and removal by ID or criteria; bulk replacement is not implemented. Role, permission, and resource bodies follow production's slug patterns (`org-` prefix or a generated slug for organization roles), lengths, and whitelists, answering 422 with production's field messages. Environment roles cannot be deleted over HTTP, as in production; an organization role a membership still holds answers 409 `role_has_assignments`. The organization role priority endpoint takes `role_priority_order`, naming every applying role once; the emulator keeps one priority per role, so an environment role reordered through one organization is reordered everywhere. Resource types are not modeled: any well-formed `resource_type_slug` is accepted on roles and permissions, and permission scopes are not checked against the role scope. Every organization owns an implicit `organization` resource whose `external_id` is the organization `external_id`, falling back to the organization id; resources created without parent fields attach to it, and it cannot be created, updated, or deleted directly.",
  },
  {
    name: 'Audit Logs',
    tags: ['audit-logs'],
    notes:
      "Events are ingested with production's `{organization_id, event}` body, validated the way its DTO validates them, and stored under their idempotency key. No action schemas are registered, so any action, target type and metadata are accepted. Export generation is not implemented.",
  },
  {
    name: 'Vault',
    tags: ['vault'],
    notes: 'Object CRUD is implemented; data-key encryption endpoints are not.',
  },
  {
    name: 'Feature Flags',
    tags: [
      'feature-flags',
      'feature-flags.targets',
      'organizations.feature-flags',
      'user-management.users.feature-flags',
    ],
    seedKeys: ['featureFlags'],
    notes:
      "Every spec endpoint is implemented at its documented verb; the emulator additionally accepts `POST` on enable/disable and `PUT` on target creation as aliases, which production rejects. Flags resolve into the `feature_flags` access-token claim, the per-user and per-organization list endpoints, and `GET /sdk/feature-flags` — the Node SDK runtime client's polling endpoint, which the spec does not define. Production has no create-flag endpoint, so flags come from the `featureFlags` seed key.",
  },
  {
    name: 'API Keys',
    tags: ['api_keys', 'organizations.api_keys'],
    seedKeys: ['apiKeys'],
    notes: 'Created and seeded keys authenticate real requests.',
  },
  {
    name: 'Pipes / Connected Apps',
    tags: ['pipes', 'pipes.provider', 'user-management.data-providers', 'organizations.data-providers'],
    emulatorCreateRoutes: ['/pipes'],
    seedKeys: ['connectedAccounts'],
    notes:
      'User-owned connected-account CRUD and access-token retrieval are supported; a refresh mints a local `di_mock_` token rather than contacting the provider. Organization-owned connected accounts are not implemented. The older `/pipes/connections` routes remain emulator-specific.',
  },
  {
    name: 'Applications',
    tags: [
      'applications',
      'application.client-secrets',
      'client',
      'user-management.users.authorized-applications',
      'organizations.authorized-applications',
      'workos-connect',
    ],
    seedKeys: ['connectApplications'],
    notes:
      'A redirect URI is stored as a bare string, so `default` is accepted on create and update but always reported as `false`. `uses_pkce` and `is_first_party` are stored and reported; `uses_pkce` makes a public client, whose codes `/oauth2/token` redeems by PKCE verifier alone and which may present no client secret. `POST /oauth2/register` (RFC 7591, outside the spec) creates `was_dynamically_registered` applications, which `registration_types` filters. `POST /client/token` mints a signed, short-lived token, but the spec documents only the `{ token }` envelope — the claims inside are an emulator convention, and no Client GraphQL API is served for it to authenticate against.',
  },
  {
    name: 'JWT Templates',
    tags: ['user-management.jwt-template'],
    seedKeys: ['jwtTemplate'],
    notes: 'Claims render into every access token. Filters, conditionals, and loops are not supported.',
  },
  {
    name: 'Webhooks',
    tags: ['webhooks'],
    seedKeys: ['webhookEndpoints'],
    notes:
      '`POST` and `PATCH /webhook_endpoints` validate as production does: an HTTPS `endpoint_url`, a non-empty `events` list from the subscribable catalog, `status` of `enabled` or `disabled`, and a generated signing secret (returned on every read). One emulator-only relaxation: a plain `http://` URL is accepted for a loopback host (`localhost`, `127.0.0.0/8`, `::1`), so a local receiver can be registered over the API. Seed an endpoint to point it at any other `http://` receiver, pin its `secret`, or subscribe it to every event with an empty `events` list. Delivery is fire-and-forget with a 5s timeout and no retries. Endpoints registered in a seed file do not receive events from that same seed file.',
  },
  {
    name: 'Events',
    tags: ['events'],
    automatic: true,
    notes:
      'Emitted as a side effect of every other operation. All are queryable at `GET /events`, including those with no registered webhook endpoint; the `events` filter is required, as in production.',
  },
  {
    name: 'AuthKit Configuration',
    tags: ['user-management.redirect-uris', 'user-management.cors-origins', 'user-management.authkit-oauth-resources'],
    seedKeys: ['resourceIndicators'],
    notes:
      'Redirect URIs are accepted but not enforced against authorize requests. MCP resource indicators (RFC 8707) are stored and, when a request names a registered one, become the `aud` of tokens from `/oauth2/token`; once any is registered, a dynamically registered client naming an unregistered one at `/oauth2/authorize` is answered `invalid_target`, and one naming none is bound to the resource flagged `default`. Resources are matched by normalized URL; wildcard patterns are refused.',
  },
  {
    name: 'Admin Portal',
    tags: ['admin-portal'],
    notes:
      "Generates a portal link (`201`) for an existing organization (`404` otherwise) and one of production's intents — `enterprise_managed_authorization` included, which needs an active Okta connection (`400 okta_connection_required`); an unknown or missing intent is a `400 invalid_portal_link_intent`. The portal itself is not served, and `certificate_renewal` is not held to production's expiring-certificate check, since certificates are not modeled.",
  },
  {
    name: 'Widgets',
    tags: ['widgets'],
    emulatorCreateRoutes: ['/_widgets'],
    notes:
      "Mints widget tokens (`201`) under production's rules: scopes must be production's, an organization must exist and a user hold an active membership in it (`404`), and a session may be org-only (standalone scopes) or user-only (no scopes); a user's `permissions` are not narrowed to the role's grants. Serves the private `/_widgets/ApiKeys/*` routes the org-scope `<ApiKeys>` widget calls; that surface is outside the public spec, so it is not counted here. Other widgets and `scope=\"user\"` API keys are not implemented.",
  },
  {
    name: 'Radar',
    tags: ['radar'],
    notes: 'Attempt listing only; no risk signals are computed.',
  },
  {
    name: 'Agent Auth',
    tags: ['agents.blueprints', 'agents.blueprints.tokens', 'agents.instances', 'agents.sessions'],
    seedKeys: ['agentBlueprints'],
    notes:
      'Blueprint CRUD, all four token grants (`user_delegated`, `autonomous`, `agent_delegated`, `refresh`), token validation, and instance and session listing, lookup, deletion and revocation. Agent access tokens are signed with the emulator key (`typ: at+jwt`, `sub_profile: ai_agent`) so JWKS validation works; delegated permissions are recomputed from the member’s current role at every mint and refresh. Agent tokens carry the `workos-emulate` placeholder audience, since nothing at the API-key-authenticated token endpoint names a client.',
  },
  {
    name: 'Agent Registration',
    tags: ['agents.registrations'],
    notes: 'Not implemented.',
  },
  {
    name: 'Platform Teams',
    tags: ['platform.teams'],
    notes: 'Not implemented.',
  },
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Normalize OpenAPI `{id}` params to Hono `:id` form. */
export function specPathToHono(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

/**
 * Canonicalize a path for matching, so `:id`, `:orgId`, and `:organization_id`
 * compare equal in the same position — the emulator is free to name its params
 * differently from the spec.
 */
export function normalizePath(path: string): string {
  return path
    .replace(/:[a-zA-Z_]+/g, ':param')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

/** Flatten a spec's paths object into one entry per method. */
export function parseSpecOperations(spec: SupportSpec): SpecOperation[] {
  const operations: SpecOperation[] = [];

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of SPEC_METHODS) {
      const op = item[method];
      if (!op) continue;

      operations.push({
        method: method.toUpperCase(),
        path: specPathToHono(path),
        tag: op.tags?.[0] ?? 'untagged',
        summary: op.summary,
      });
    }
  }

  return operations;
}

/** A route `registerRoleRoutes` registers beneath each caller's `pathPrefix`. */
export interface RoleHelperRoute {
  method: string;
  suffix: string;
}

/**
 * Read the routes `registerRoleRoutes` (src/workos/role-helpers.ts) registers
 * from its own source, so the matrix cannot drift from the helper. A
 * registration is either `app.verb(pathPrefix, …)` (empty suffix) or
 * `app.verb(\`${pathPrefix}/suffix\`, …)`.
 */
export function parseRoleHelperRoutes(source: string): RoleHelperRoute[] {
  const routes: RoleHelperRoute[] = [];
  const pattern = /app\.(get|post|put|patch|delete)\((?:pathPrefix|`\$\{pathPrefix\}([^`]*)`)\s*,/g;
  for (const match of source.matchAll(pattern)) {
    routes.push({ method: match[1].toUpperCase(), suffix: match[2] ?? '' });
  }
  return routes;
}

/**
 * Extract route registrations from route source. Handles three patterns:
 *   - `app.method('/literal')` — direct literal paths
 *   - `app.method(`\`${prefix}/suffix\``) — template literals whose variable
 *     is a `const` assigned a literal string earlier in the same file
 *   - `registerRoleRoutes(ctx, { pathPrefix: … })` — helper whose routes are
 *     parsed from its own source (`roleHelperRoutes`) and expanded under the prefix
 *
 * Static parsing rather than booting the server keeps codegen free of side
 * effects (a real boot binds a port and seeds a store).
 */
export function parseEmulatorRoutes(
  sources: string[],
  roleHelperRoutes: ReadonlyArray<RoleHelperRoute> = [],
): EmulatorRoute[] {
  const routes: EmulatorRoute[] = [];
  const literalPattern = /app\.(get|post|put|patch|delete)\('([^']+)'/g;
  const templatePattern = /app\.(get|post|put|patch|delete)\(`([^`]+)`/g;
  const identifierPattern = /app\.(get|post|put|patch|delete)\((\w+)\s*,/g;
  const helperPattern = /pathPrefix:\s*([^,}\n]+)/g;

  for (const source of sources) {
    // Build a map of `const name = 'value'` assignments so template-literal
    // interpolations and helper pathPrefix variables can be resolved.
    const vars = new Map<string, string>();
    for (const m of source.matchAll(/const\s+(\w+)\s*=\s*'([^']+)'/g)) {
      vars.set(m[1], m[2]);
    }

    // 1. Literal string routes
    for (const match of source.matchAll(literalPattern)) {
      routes.push({ method: match[1].toUpperCase(), path: match[2] });
    }

    // 2. Template literal routes — resolve ${var} interpolations
    for (const match of source.matchAll(templatePattern)) {
      const raw = match[2].replace(/\$\{(\w+)\}/g, (full, name) => vars.get(name) ?? full);
      if (raw.includes('${')) continue; // unresolved interpolation — skip
      routes.push({ method: match[1].toUpperCase(), path: raw });
    }

    // 3. Bare identifier routes — a shared `const PATH = '...'` registered on several verbs
    for (const match of source.matchAll(identifierPattern)) {
      const path = vars.get(match[2]);
      if (path) routes.push({ method: match[1].toUpperCase(), path });
    }

    // 4. registerRoleRoutes helper — expand the helper's own routes under each pathPrefix
    for (const match of source.matchAll(helperPattern)) {
      let prefix = match[1].trim();
      if (prefix.startsWith("'") && prefix.endsWith("'")) {
        prefix = prefix.slice(1, -1);
      } else {
        prefix = vars.get(prefix) ?? '';
      }
      if (!prefix) continue;
      for (const r of roleHelperRoutes) {
        routes.push({ method: r.method, path: prefix + r.suffix });
      }
    }
  }

  return routes;
}

/**
 * Read the declared keys of the `EmulatorSeedConfig` interface from src/index.ts.
 * Parsed from source rather than imported because codegen must not load the
 * emulator itself, and the interface is the honest answer to "what can a seed
 * file contain?".
 */
export function parseSeedConfigKeys(indexSource: string): string[] {
  const block = indexSource.match(/export interface EmulatorSeedConfig \{([\s\S]*?)\n\}/);
  if (!block) {
    throw new Error('Could not find `export interface EmulatorSeedConfig` in src/index.ts');
  }

  const keys = [...block[1].matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
  if (keys.length === 0) {
    throw new Error('EmulatorSeedConfig appears to declare no keys');
  }

  return keys;
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

export type SupportLevel = 'full' | 'partial' | 'none' | 'n/a';

export interface CoverageCell {
  covered: number;
  total: number;
  level: SupportLevel;
}

export interface SetupCell {
  level: SupportLevel;
  label: string;
}

export interface FeatureRow {
  name: string;
  read: CoverageCell;
  write: CoverageCell;
  setup: SetupCell;
  notes?: string;
}

export interface SupportMatrix {
  rows: FeatureRow[];
  totals: { covered: number; total: number };
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Tally every registered POST/PUT/PATCH route against the feature that owns its
 * path, keyed by feature name.
 *
 * Ownership is by longest matching prefix, where a feature's prefixes are the
 * spec paths carrying its tags plus any `emulatorCreateRoutes`. Deriving from
 * spec paths rather than requiring an opt-in list is what keeps the column
 * honest: add `POST /directories` tomorrow and Directory Sync stops reporting
 * "no way to create data" without anyone remembering to update this file.
 * Longest-match breaks ties, so `/organizations/:param/feature-flags` beats
 * `/organizations` and the route lands on Feature Flags rather than
 * Organizations.
 */
export function attributeCreateRoutes(
  routes: EmulatorRoute[],
  prefixesByFeature: Map<string, string[]>,
): Map<string, number> {
  const counts = new Map<string, number>();

  for (const route of routes) {
    if (!CREATE_METHODS.has(route.method.toUpperCase())) continue;
    const path = normalizePath(route.path);

    let owner: string | undefined;
    let longest = -1;
    for (const [feature, prefixes] of prefixesByFeature) {
      for (const prefix of prefixes) {
        if (isUnder(path, prefix) && prefix.length > longest) {
          owner = feature;
          longest = prefix.length;
        }
      }
    }

    if (owner) counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }

  return counts;
}

function toCell(covered: number, total: number): CoverageCell {
  if (total === 0) return { covered, total, level: 'n/a' };
  if (covered === 0) return { covered, total, level: 'none' };
  return { covered, total, level: covered === total ? 'full' : 'partial' };
}

/**
 * Answer "can you get data into this feature?" — the column endpoint coverage
 * cannot express. Seeding beats API-only because it works before the first
 * request and from any language; a feature with neither is unusable no matter
 * how complete its read endpoints look.
 *
 * `implementedCreates` deliberately excludes DELETE: destroying a record is not
 * a way to create one. Directory Sync is the case that proves it — its only
 * write endpoint is `DELETE /directories/:id`, so counting all mutations would
 * label it "API only" and reintroduce the exact lie this column exists to stop.
 */
export function deriveSetup(feature: FeatureDef, seedConfigKeys: string[], implementedCreates: number): SetupCell {
  const seedKeys = feature.seedKeys ?? [];

  for (const key of seedKeys) {
    if (!seedConfigKeys.includes(key)) {
      throw new Error(
        `Feature "${feature.name}" declares seed key "${key}", which is not a key of EmulatorSeedConfig. ` +
          `Update FEATURES in scripts/gen-supported-lib.ts, or add the key to EmulatorSeedConfig in src/index.ts.`,
      );
    }
  }

  if (seedKeys.length > 0) {
    return { level: 'full', label: `seed \`${seedKeys.join('`, `')}\`` };
  }
  if (feature.seedVia) {
    return { level: 'full', label: `seed \`${feature.seedVia}\`` };
  }
  if (feature.automatic) {
    return { level: 'full', label: 'automatic' };
  }
  if (implementedCreates > 0) {
    return { level: 'partial', label: 'API only' };
  }
  return { level: 'none', label: 'none' };
}

/** Cross-reference spec, routes, and seed keys into the finished matrix. */
export function buildMatrix(
  operations: SpecOperation[],
  routes: EmulatorRoute[],
  seedConfigKeys: string[],
  features: FeatureDef[] = FEATURES,
): SupportMatrix {
  const implemented = new Set(routes.map((r) => routeKey(r.method, r.path)));

  const mapped = new Map<string, FeatureDef>();
  for (const feature of features) {
    for (const tag of feature.tags) {
      const existing = mapped.get(tag);
      if (existing) {
        throw new Error(`Tag "${tag}" is claimed by both "${existing.name}" and "${feature.name}"`);
      }
      mapped.set(tag, feature);
    }
  }

  const unmapped = [...new Set(operations.map((op) => op.tag))].filter((tag) => !mapped.has(tag)).sort();
  if (unmapped.length > 0) {
    throw new Error(
      `Spec tags are not assigned to a feature: ${unmapped.join(', ')}. ` +
        `Add them to FEATURES in scripts/gen-supported-lib.ts.`,
    );
  }

  const byFeature = new Map<string, SpecOperation[]>();
  for (const op of operations) {
    const feature = mapped.get(op.tag)!;
    const bucket = byFeature.get(feature.name);
    if (bucket) bucket.push(op);
    else byFeature.set(feature.name, [op]);
  }

  // Prefixes that identify each feature's URL space, used to attribute
  // emulator-only creation routes that no spec path covers.
  const prefixesByFeature = new Map<string, string[]>();
  for (const feature of features) {
    const fromSpec = (byFeature.get(feature.name) ?? []).map((op) => normalizePath(op.path));
    const explicit = (feature.emulatorCreateRoutes ?? []).map(normalizePath);
    prefixesByFeature.set(feature.name, [...new Set([...fromSpec, ...explicit])]);
  }
  const createsByFeature = attributeCreateRoutes(routes, prefixesByFeature);

  let totalCovered = 0;
  const rows: FeatureRow[] = [];

  for (const feature of features) {
    const ops = byFeature.get(feature.name) ?? [];
    const reads = ops.filter((op) => op.method === READ_METHOD);
    const writes = ops.filter((op) => op.method !== READ_METHOD);

    const coveredReads = reads.filter((op) => implemented.has(routeKey(op.method, op.path))).length;
    const coveredWriteOps = writes.filter((op) => implemented.has(routeKey(op.method, op.path)));
    totalCovered += coveredReads + coveredWriteOps.length;

    // Counted from registered routes, not spec operations, so emulator-only
    // creation surfaces (absent from the coverage columns above) still count.
    const coveredCreates = createsByFeature.get(feature.name) ?? 0;

    rows.push({
      name: feature.name,
      read: toCell(coveredReads, reads.length),
      write: toCell(coveredWriteOps.length, writes.length),
      setup: deriveSetup(feature, seedConfigKeys, coveredCreates),
      notes: feature.notes,
    });
  }

  return { rows, totals: { covered: totalCovered, total: operations.length } };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const ICONS: Record<SupportLevel, string> = {
  full: '✅',
  partial: '⚠️',
  none: '❌',
  'n/a': '—',
};

function renderCoverage(cell: CoverageCell): string {
  return cell.level === 'n/a' ? ICONS['n/a'] : `${ICONS[cell.level]} ${cell.covered}/${cell.total}`;
}

function renderSetup(cell: SetupCell): string {
  return `${ICONS[cell.level]} ${cell.label}`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

export interface RenderOptions {
  /** Version of @workos/openapi-spec the matrix was generated from. */
  specVersion?: string;
}

export function generateSupportedMarkdown(matrix: SupportMatrix, options: RenderOptions = {}): string {
  const { rows, totals } = matrix;
  const pct = totals.total > 0 ? ((totals.covered / totals.total) * 100).toFixed(1) : '0.0';
  const specNote = options.specVersion ? ` (\`@workos/openapi-spec@${options.specVersion}\`)` : '';

  const lines: string[] = [
    '<!-- Generated by `bun run gen:supported`. Do not edit by hand. -->',
    '',
    '# Supported Features',
    '',
    `The emulator implements **${totals.covered} of ${totals.total}** endpoints in the WorkOS OpenAPI spec${specNote} (**${pct}%**).`,
    '',
    'Endpoint coverage says whether a route exists, not whether a',
    'feature is usable; for example, Directory Sync implements every endpoint the spec defines for it and is',
    'still unusable, because nothing can create a directory. The **Set up** column is the one that',
    'answers "can I actually emulate this?".',
    '',
    '| Column     | Meaning                                                                    |',
    '| ---------- | -------------------------------------------------------------------------- |',
    '| **Read**   | `GET` endpoints implemented / defined in the spec                          |',
    '| **Write**  | `POST`/`PUT`/`PATCH`/`DELETE` endpoints implemented / defined in the spec   |',
    '| **Set up** | How data gets in: ✅ seed file, ⚠️ API calls only, ❌ no way to create data |',
    '',
    '✅ full · ⚠️ partial · ❌ none · — not applicable',
    '',
    '| Feature | Read | Write | Set up | Notes |',
    '| ------- | ---- | ----- | ------ | ----- |',
  ];

  for (const row of rows) {
    const cells = [
      escapeCell(row.name),
      renderCoverage(row.read),
      renderCoverage(row.write),
      renderSetup(row.setup),
      escapeCell(row.notes ?? ''),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }

  lines.push(
    '',
    '## How this file is generated',
    '',
    'Every column except **Notes** is derived, so the table cannot drift from the code:',
    '',
    "- **Read** / **Write** come from cross-referencing the spec's paths against the routes",
    '  registered in `src/workos/routes/`.',
    '- **Set up** comes from the `EmulatorSeedConfig` keys in `src/index.ts`. A feature declaring',
    '  a seed key that the interface does not define fails the build.',
    "- **Feature** groups the spec's API-shaped tags into products, in",
    '  `scripts/gen-supported-lib.ts`. A spec tag with no feature also fails the build, so a new',
    '  WorkOS product cannot silently disappear from this table.',
    '',
  );

  return lines.join('\n');
}
