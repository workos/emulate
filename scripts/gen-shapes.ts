#!/usr/bin/env tsx
/**
 * Codegen script: reads the WorkOS OpenAPI spec and generates the response
 * shape catalog (src/workos/generated/response-shapes.ts) — per-resource
 * property and required-field sets, extracted from the schema curated for each
 * object type in gen-shapes-lib.ts.
 *
 * By default the spec comes from the @workos/openapi-spec devDependency, so
 * regenerating is just:
 *   npm run gen:shapes
 * Update the dependency to pick up a newer spec:
 *   npm install -D @workos/openapi-spec@latest && npm run gen:shapes
 * A local spec file can still be passed explicitly:
 *   npm run gen:shapes -- path/to/openapi.yaml [--out <file>] [--dry-run]
 *
 * The generated file is committed, so consumers of the package never need the
 * spec. Re-running against a newer spec is the drift check. Running twice on
 * the same spec produces identical output (idempotent).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { format, type FormatConfig } from 'oxfmt';

import { type EventSchemaNode } from './gen-events-lib.js';
import { parseShapeCatalog, generateShapesFile } from './gen-shapes-lib.js';

/** Load the project's oxfmt config so generated output matches `npm run fmt`. */
function loadFormatConfig(): FormatConfig {
  const configPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.oxfmtrc.json');
  return existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf-8')) as FormatConfig) : {};
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));

  // Default to the published spec package; a positional path overrides it.
  const specPath = positional[0] ?? createRequire(import.meta.url).resolve('@workos/openapi-spec/spec');

  const dryRun = flags.includes('--dry-run');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 ? args[outIdx + 1] : 'src/workos/generated/response-shapes.ts';
  // A bare `--out` (no value, or followed by another flag) would otherwise write
  // to a file literally named after the next flag — fail instead of silently
  // leaving the committed generated file stale.
  if (outIdx !== -1 && (!outFile || outFile.startsWith('--'))) {
    console.error('Missing output file after --out');
    process.exit(1);
  }

  const resolvedSpec = resolve(specPath);
  if (!existsSync(resolvedSpec)) {
    console.error(`Spec file not found: ${resolvedSpec}`);
    process.exit(1);
  }

  const raw = readFileSync(resolvedSpec, 'utf-8');
  const ext = extname(resolvedSpec).toLowerCase();
  const spec: EventSchemaNode =
    ext === '.yaml' || ext === '.yml' ? (YAML.parse(raw) as EventSchemaNode) : (JSON.parse(raw) as EventSchemaNode);

  const shapes = parseShapeCatalog(spec);
  const resolvedOut = resolve(outFile);
  // The output path's `.ts` extension tells oxfmt to use the TypeScript parser.
  const formatted = await format(resolvedOut, generateShapesFile(shapes), loadFormatConfig());
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

  mkdirSync(dirname(resolvedOut), { recursive: true });
  writeFileSync(resolvedOut, content, 'utf-8');
  console.log(`  wrote ${resolvedOut}`);
  console.log(`\nShapes: ${shapes.length} resources`);
}

await main();
