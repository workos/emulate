#!/usr/bin/env bun
/**
 * Codegen script: reads the WorkOS OpenAPI spec, the emulator's registered
 * routes, and the EmulatorSeedConfig keys, and generates the feature support
 * matrix (SUPPORTED.md).
 *
 * By default the spec comes from the @workos/openapi-spec devDependency, so
 * regenerating is just:
 *   npm run gen:supported
 * A local spec file can still be passed explicitly:
 *   npm run gen:supported -- path/to/openapi.yaml [--out <file>] [--dry-run]
 *
 * The generated file is committed and CI re-runs this script to check for
 * drift, so the table cannot fall behind the code. Running twice on the same
 * inputs produces identical output (idempotent).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { format, type FormatConfig } from 'oxfmt';

import {
  type SupportSpec,
  parseSpecOperations,
  parseEmulatorRoutes,
  parseSeedConfigKeys,
  buildMatrix,
  generateSupportedMarkdown,
} from './gen-supported-lib.js';

const ROUTES_DIR = 'src/workos/routes';
const SERVER_FILE = 'src/core/server.ts';
const INDEX_FILE = 'src/index.ts';

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
  const routes = parseEmulatorRoutes(readRouteSources());
  const seedKeys = parseSeedConfigKeys(readFileSync(resolve(INDEX_FILE), 'utf-8'));

  // buildMatrix throws on an unmapped spec tag or a stale seed key — that is
  // the drift check, and it must fail the build rather than emit a wrong table.
  const matrix = buildMatrix(operations, routes, seedKeys);
  const markdown = generateSupportedMarkdown(matrix, {
    specVersion: positional[0] ? undefined : readSpecVersion(require),
  });

  // Run the output through oxfmt (which aligns Markdown tables) so a freshly
  // generated file is already `fmt:check`-clean — otherwise every regeneration
  // would trip the pre-push hook and CI.
  const resolvedOut = resolve(outFile);
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
