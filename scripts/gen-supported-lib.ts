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
 * The only hand-authored input here is FEATURES: the spec's tags are
 * API-shaped (45 of them) while readers think in products (~20). What each
 * feature does and does not do is prose, and prose belongs in Markdown:
 * docs/behavior.md holds one `## <Feature>` section per row, the table links
 * to it, and `checkBehaviorSections` fails the build when an implemented
 * feature has none. Everything else is derived, so the table cannot drift
 * from the code without CI noticing.
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
  },
  {
    name: 'User Management',
    tags: ['user-management.users', 'user-management.session-tokens', 'user-management.waitlists'],
    seedKeys: ['users'],
  },
  {
    name: 'Authentication',
    tags: ['user-management.authentication', 'user-management.magic-auth'],
  },
  {
    name: 'Organization Memberships',
    tags: ['user-management.organization-membership', 'user-management.organization-membership.groups'],
    seedVia: 'memberships',
  },
  {
    name: 'Groups',
    tags: ['groups'],
    seedVia: 'groups',
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
  },
  {
    name: 'Directory Sync',
    tags: ['directories', 'directory-users', 'directory-groups'],
    seedKeys: ['directories'],
  },
  {
    name: 'Multi-Factor Auth',
    tags: ['multi-factor-auth', 'multi-factor-auth.challenges', 'user-management.multi-factor-authentication'],
  },
  {
    name: 'FGA / Authorization',
    tags: ['authorization', 'permissions'],
    seedKeys: ['roles', 'permissions'],
  },
  {
    name: 'Audit Logs',
    tags: ['audit-logs'],
  },
  {
    name: 'Vault',
    tags: ['vault'],
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
  },
  {
    name: 'API Keys',
    tags: ['api_keys', 'organizations.api_keys'],
    seedKeys: ['apiKeys'],
  },
  {
    name: 'Pipes / Connected Apps',
    tags: ['pipes', 'pipes.provider', 'user-management.data-providers', 'organizations.data-providers'],
    emulatorCreateRoutes: ['/pipes'],
    seedKeys: ['connectedAccounts'],
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
  },
  {
    name: 'Webhooks',
    tags: ['webhooks'],
    seedKeys: ['webhookEndpoints'],
  },
  {
    name: 'Events',
    tags: ['events'],
    automatic: true,
  },
  {
    name: 'AuthKit Configuration',
    tags: ['user-management.redirect-uris', 'user-management.cors-origins', 'user-management.authkit-oauth-resources'],
    seedKeys: ['resourceIndicators'],
  },
  {
    name: 'Admin Portal',
    tags: ['admin-portal'],
  },
  {
    name: 'Widgets',
    tags: ['widgets'],
    emulatorCreateRoutes: ['/_widgets'],
  },
  {
    name: 'Radar',
    tags: ['radar'],
  },
  {
    name: 'Agent Auth',
    tags: ['agents.blueprints', 'agents.blueprints.tokens', 'agents.instances', 'agents.sessions'],
    seedKeys: ['agentBlueprints'],
  },
  {
    name: 'Agent Registration',
    tags: ['agents.registrations'],
  },
  {
    name: 'Platform Teams',
    tags: ['platform.teams'],
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
    });
  }

  return { rows, totals: { covered: totalCovered, total: operations.length } };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * SUPPORTED.md is hand-written except for the region between these two
 * markers, which the generator rewrites in place. Keeping the prose in the
 * Markdown file means editing it is editing Markdown, not a TypeScript string.
 */
export const GENERATED_BEGIN = '<!-- gen:supported:begin -->';
export const GENERATED_END = '<!-- gen:supported:end -->';

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

/**
 * GitHub's heading-to-anchor rule: lowercase, drop everything but letters,
 * digits, spaces and hyphens, then turn spaces into hyphens. "FGA / Authorization"
 * becomes `fga--authorization`, which is the anchor GitHub actually renders.
 */
export function slugifyHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/ /g, '-');
}

/** The level-2 headings of a Markdown document, as anchor slugs. Fenced code is skipped. */
export function parseSectionSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^## (.+?)\s*$/.exec(line);
    if (match) slugs.add(slugifyHeading(match[1]));
  }
  return slugs;
}

/** A feature with at least one implemented endpoint has behavior worth documenting. */
export function isImplemented(row: FeatureRow): boolean {
  return row.read.covered > 0 || row.write.covered > 0;
}

/**
 * Every implemented feature must have a `## <Feature>` section in the parity
 * doc, so the table always has somewhere to send the reader and a new feature
 * cannot ship undocumented. Features with no routes are exempt: their row
 * already says everything there is to say.
 */
export function checkBehaviorSections(matrix: SupportMatrix, sections: Set<string>, docPath: string): void {
  const missing = matrix.rows.filter((row) => isImplemented(row) && !sections.has(slugifyHeading(row.name)));
  if (missing.length > 0) {
    throw new Error(
      `${docPath} has no "## <Feature>" section for: ${missing.map((row) => row.name).join(', ')}. ` +
        `Add one, even a sentence long, so the table has somewhere to link.`,
    );
  }
}

export interface RenderOptions {
  /** Version of @workos/openapi-spec the matrix was generated from. */
  specVersion?: string;
  /**
   * The parity doc as a link target relative to the output file, with the
   * slugs of its sections. A feature that has a section links to it.
   */
  behaviorDoc?: { path: string; sections: Set<string> };
}

/** The generated region: the headline number and the matrix. Everything around it is hand-written. */
export function renderMatrix(matrix: SupportMatrix, options: RenderOptions = {}): string {
  const { rows, totals } = matrix;
  const pct = totals.total > 0 ? ((totals.covered / totals.total) * 100).toFixed(1) : '0.0';
  const specNote = options.specVersion ? ` (\`@workos/openapi-spec@${options.specVersion}\`)` : '';

  const lines: string[] = [
    `The emulator implements **${totals.covered} of ${totals.total}** endpoints in the WorkOS OpenAPI spec${specNote} (**${pct}%**).`,
    '',
    '| Feature | Read | Write | Set up |',
    '| ------- | ---- | ----- | ------ |',
  ];

  for (const row of rows) {
    const slug = slugifyHeading(row.name);
    const doc = options.behaviorDoc;
    const name =
      doc && doc.sections.has(slug) ? `[${escapeCell(row.name)}](${doc.path}#${slug})` : escapeCell(row.name);
    const cells = [name, renderCoverage(row.read), renderCoverage(row.write), renderSetup(row.setup)];
    lines.push(`| ${cells.join(' | ')} |`);
  }

  return lines.join('\n');
}

/**
 * Replace the generated region of a hand-written document. The markers stay
 * on their own lines so the next run finds them again, and everything outside
 * them comes back untouched.
 */
export function spliceGenerated(document: string, region: string): string {
  const begin = document.indexOf(GENERATED_BEGIN);
  const end = document.indexOf(GENERATED_END);
  if (begin === -1 || end === -1) {
    const marker = begin === -1 ? GENERATED_BEGIN : GENERATED_END;
    throw new Error(
      `Document has no ${marker} marker; the generated table goes between the two gen:supported markers.`,
    );
  }
  if (end < begin) {
    throw new Error('The gen:supported markers are out of order: begin must come before end.');
  }
  const head = document.slice(0, begin + GENERATED_BEGIN.length);
  const tail = document.slice(end);
  return `${head}\n\n${region}\n\n${tail}`;
}
