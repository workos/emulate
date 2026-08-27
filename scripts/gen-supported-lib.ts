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
    tags: ['organizations', 'organization-domains'],
    seedKeys: ['organizations'],
  },
  {
    name: 'User Management',
    tags: ['user-management.users', 'user-management.session-tokens'],
    seedKeys: ['users'],
    notes: 'Email-change confirm/send endpoints are not implemented.',
  },
  {
    name: 'Authentication',
    tags: ['user-management.authentication', 'user-management.magic-auth'],
    notes:
      'All grant types are hand-written rather than generated from the spec. Refresh tokens always rotate, which is stricter than production.',
  },
  {
    name: 'Organization Memberships',
    tags: ['user-management.organization-membership', 'user-management.organization-membership.groups'],
    seedVia: 'memberships',
    notes: 'Seeded via `memberships` nested under an organization.',
  },
  {
    name: 'Groups',
    tags: ['groups'],
    seedVia: 'groups',
    notes: 'Seeded via `groups` nested under an organization. Members reference a seeded membership by email.',
  },
  {
    name: 'Invitations',
    tags: ['user-management.invitations'],
    seedKeys: ['invitations'],
  },
  {
    name: 'SSO',
    tags: ['sso', 'connections'],
    seedKeys: ['connections'],
    notes: 'Seeded connections carry `profiles`, which drive the SSO login flow.',
  },
  {
    name: 'Directory Sync',
    tags: ['directories', 'directory-users', 'directory-groups'],
    notes:
      'Read-only. Every spec endpoint is implemented and all `dsync.*` events are wired, but nothing can create a directory: there is no POST route and no seed key. Node callers can insert directly via `getWorkOSStore(emulator.store)`, which does emit the events. `dsync.group.user_added` / `user_removed` are never emitted — there is no group membership mutation surface.',
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
    notes: 'Warrant/check semantics are partial; group role assignments are not implemented.',
  },
  {
    name: 'Audit Logs',
    tags: ['audit-logs'],
    notes: 'Events are stored and queryable. Export generation is not implemented.',
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
    notes:
      'Enable/disable and targeting exist, but under different verbs than the spec (`POST /feature-flags/:slug/enable` where the spec says `PUT`), so they do not count toward coverage.',
  },
  {
    name: 'API Keys',
    tags: ['api_keys', 'organizations.api_keys'],
    seedKeys: ['apiKeys'],
    notes: 'Created and seeded keys authenticate real requests.',
  },
  {
    name: 'Pipes / Connected Apps',
    tags: ['pipes', 'pipes.provider', 'user-management.data-providers'],
    emulatorCreateRoutes: ['/pipes'],
    seedKeys: ['connectedAccounts'],
    notes: 'Connection CRUD and access-token minting are emulator-specific routes under `/pipes/connections`.',
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
      'Delivery is fire-and-forget with a 5s timeout and no retries. Endpoints registered in a seed file do not receive events from that same seed file.',
  },
  {
    name: 'Events',
    tags: ['events'],
    automatic: true,
    notes:
      'Emitted as a side effect of every other operation. All are queryable at `GET /events`, including those with no registered webhook endpoint.',
  },
  {
    name: 'AuthKit Configuration',
    tags: ['user-management.redirect-uris', 'user-management.cors-origins'],
    notes: 'Redirect URIs are accepted but not enforced against authorize requests.',
  },
  {
    name: 'Admin Portal',
    tags: ['admin-portal'],
    notes: 'Generates a portal link; the portal itself is not served.',
  },
  {
    name: 'Widgets',
    tags: ['widgets'],
    notes: 'Mints widget tokens only.',
  },
  {
    name: 'Radar',
    tags: ['radar'],
    notes: 'Attempt listing only; no risk signals are computed.',
  },
  {
    name: 'Agents',
    tags: ['agents'],
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

/**
 * Routes that `registerRoleRoutes` in `src/workos/role-helpers.ts` registers
 * for each path prefix. Kept in sync with that helper — if it gains or loses
 * a route, this list must be updated.
 */
const ROLE_HELPER_ROUTES: ReadonlyArray<{ method: string; suffix: string }> = [
  { method: 'POST', suffix: '' },
  { method: 'GET', suffix: '' },
  { method: 'GET', suffix: '/:slug' },
  { method: 'PUT', suffix: '/:slug' },
  { method: 'DELETE', suffix: '/:slug' },
  { method: 'GET', suffix: '/:slug/permissions' },
  { method: 'POST', suffix: '/:slug/permissions' },
];

/**
 * Extract route registrations from route source. Handles three patterns:
 *   - `app.method('/literal')` — direct literal paths
 *   - `app.method(`\`${prefix}/suffix\``) — template literals whose variable
 *     is a `const` assigned a literal string earlier in the same file
 *   - `registerRoleRoutes(ctx, { pathPrefix: … })` — helper that registers a
 *     known set of routes under the given prefix
 *
 * Static parsing rather than booting the server keeps codegen free of side
 * effects (a real boot binds a port and seeds a store).
 */
export function parseEmulatorRoutes(sources: string[]): EmulatorRoute[] {
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

    // 4. registerRoleRoutes helper — expand the known routes from pathPrefix
    for (const match of source.matchAll(helperPattern)) {
      let prefix = match[1].trim();
      if (prefix.startsWith("'") && prefix.endsWith("'")) {
        prefix = prefix.slice(1, -1);
      } else {
        prefix = vars.get(prefix) ?? '';
      }
      if (!prefix) continue;
      for (const r of ROLE_HELPER_ROUTES) {
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
