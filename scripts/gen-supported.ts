#!/usr/bin/env bun
/**
 * Codegen script: reads the WorkOS OpenAPI spec, the emulator's registered
 * routes, and the EmulatorSeedConfig keys, and rewrites the feature support
 * matrix inside SUPPORTED.md.
 *
 * SUPPORTED.md is hand-written around a generated region marked by two
 * `gen:supported` comments; only that region is replaced. Each row links to
 * its `## <Feature>` section in docs/behavior.md, and an implemented feature
 * with no section fails the run, so the parity doc cannot fall behind the
 * table any more than the table can fall behind the code.
 *
 * By default the spec comes from the @workos/openapi-spec devDependency, so
 * regenerating is just:
 *   npm run gen:supported
 * A local spec file can still be passed explicitly:
 *   npm run gen:supported -- path/to/openapi.yaml [--out <file>] [--dry-run]
 *
 * The result is committed and CI re-runs this script to check for drift.
 * Running twice on the same inputs produces identical output (idempotent).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, relative, extname, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { format, type FormatConfig } from 'oxfmt';

import {
  type SupportSpec,
  parseSpecOperations,
  parseEmulatorRoutes,
  parseRoleHelperRoutes,
  parseSeedConfigKeys,
  buildMatrix,
  renderMatrix,
  spliceGenerated,
  parseSectionSlugs,
  checkBehaviorSections,
  GENERATED_BEGIN,
  GENERATED_END,
} from './gen-supported-lib.js';

const ROUTES_DIR = 'src/workos/routes';
const ROLE_HELPER_FILE = 'src/workos/role-helpers.ts';
const SERVER_FILE = 'src/core/server.ts';
const INDEX_FILE = 'src/index.ts';
const BEHAVIOR_DOC = 'docs/behavior.md';

/** Load the project's oxfmt config so generated output matches `npm run fmt`. */
function loadFormatConfig(): FormatConfig {
  const configPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.oxfmtrc.json');
  return existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf-8')) as FormatConfig) : {};
}

/** Collect route source: every route module, plus server.ts for JWKS and friends. */
function readRouteSources(): string[] {
  const sources: string[] = [];

  const routesDir = resolve(ROUTES_DIR);
  if (!existsSync(routesDir)) {
    throw new Error(`Route directory not found: ${routesDir}`);
  }

  for (const file of readdirSync(routesDir)) {
    if (file.endsWith('.ts') && !file.endsWith('.spec.ts')) {
      sources.push(readFileSync(join(routesDir, file), 'utf-8'));
    }
  }

  const serverFile = resolve(SERVER_FILE);
  if (existsSync(serverFile)) sources.push(readFileSync(serverFile, 'utf-8'));

  return sources;
}

/** Version of the spec package the matrix was built from, when it is the source. */
function readSpecVersion(require: NodeRequire): string | undefined {
  try {
    return (require('@workos/openapi-spec/package.json') as { version?: string }).version;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));

  const require = createRequire(import.meta.url);
  // Default to the published spec package; a positional path overrides it.
  const specPath = positional[0] ?? require.resolve('@workos/openapi-spec/spec');

  const dryRun = flags.includes('--dry-run');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 ? args[outIdx + 1] : 'SUPPORTED.md';

  const resolvedSpec = resolve(specPath);
  if (!existsSync(resolvedSpec)) {
    console.error(`Spec file not found: ${resolvedSpec}`);
    process.exit(1);
  }

  const raw = readFileSync(resolvedSpec, 'utf-8');
  const ext = extname(resolvedSpec).toLowerCase();
  const spec: SupportSpec =
    ext === '.yaml' || ext === '.yml' ? (YAML.parse(raw) as SupportSpec) : (JSON.parse(raw) as SupportSpec);

  const operations = parseSpecOperations(spec);
  // The role helper registers its routes under a caller-supplied prefix, so its
  // source is parsed on its own; an empty result means the parser drifted from
  // how the helper registers routes, which must fail loudly rather than quietly
  // dropping every role endpoint from the table.
  const roleHelperRoutes = parseRoleHelperRoutes(readFileSync(resolve(ROLE_HELPER_FILE), 'utf-8'));
  if (roleHelperRoutes.length === 0) {
    throw new Error(`No route registrations found in ${ROLE_HELPER_FILE}; update parseRoleHelperRoutes.`);
  }
  const routes = parseEmulatorRoutes(readRouteSources(), roleHelperRoutes);
  const seedKeys = parseSeedConfigKeys(readFileSync(resolve(INDEX_FILE), 'utf-8'));

  // buildMatrix throws on an unmapped spec tag or a stale seed key — that is
  // the drift check, and it must fail the build rather than emit a wrong table.
  const matrix = buildMatrix(operations, routes, seedKeys);

  // SUPPORTED.md is hand-written around the generated region, so it has to
  // exist already; this script only fills in what lies between the markers.
  const resolvedOut = resolve(outFile);
  if (!existsSync(resolvedOut)) {
    console.error(
      `${outFile} not found. It is hand-written around a generated region; create it with the ` +
        `${GENERATED_BEGIN} and ${GENERATED_END} markers and run again.`,
    );
    process.exit(1);
  }

  // The prose about each feature lives in docs/behavior.md, one `## <Feature>`
  // section per row. The table links there, and an implemented feature with
  // no section is a build failure, so the parity doc cannot fall behind.
  const resolvedDoc = resolve(BEHAVIOR_DOC);
  const sections = parseSectionSlugs(readFileSync(resolvedDoc, 'utf-8'));
  checkBehaviorSections(matrix, sections, BEHAVIOR_DOC);

  const region = renderMatrix(matrix, {
    specVersion: positional[0] ? undefined : readSpecVersion(require),
    behaviorDoc: { path: relative(dirname(resolvedOut), resolvedDoc).split(sep).join('/'), sections },
  });
  const markdown = spliceGenerated(readFileSync(resolvedOut, 'utf-8'), region);

  // Run the output through oxfmt (which aligns Markdown tables) so a freshly
  // generated file is already `fmt:check`-clean — otherwise every regeneration
  // would trip the pre-push hook and CI.
  const formatted = await format(resolvedOut, markdown, loadFormatConfig());
  if (formatted.errors.length > 0) {
    console.error('oxfmt reported errors while formatting generated output:');
    for (const err of formatted.errors) console.error(`  ${err.severity}: ${err.message}`);
    process.exit(1);
  }
  const content = formatted.code;

  if (dryRun) {
    console.log(content);
    return;
  }

  writeFileSync(resolvedOut, content, 'utf-8');

  const { covered, total } = matrix.totals;
  const pct = total > 0 ? ((covered / total) * 100).toFixed(1) : '0.0';
  console.log(`  wrote ${resolvedOut}`);
  console.log(`\nCoverage: ${covered}/${total} endpoints (${pct}%) across ${matrix.rows.length} features`);
}

await main();
