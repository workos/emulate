#!/usr/bin/env tsx
/**
 * Codegen script: fetches the published Widgets API (Client GraphQL API) schema and writes it to
 * src/workos/generated/widgets-api-schema.ts as an SDL string.
 *
 * The Widgets API is a GraphQL surface, so it has no place in @workos/openapi-spec. WorkOS
 * publishes its schema as a downloadable artifact instead (production refuses introspection), and
 * that download is what this script reads. Regenerating is:
 *   bun run gen:widgets-schema
 * A local schema file can be passed explicitly:
 *   bun run gen:widgets-schema -- path/to/schema.graphql [--out <file>] [--dry-run]
 *
 * The generated file is committed, so consumers of the package never need the download. CI does
 * not regenerate it — the download tracks production deploys, not a versioned package — so
 * re-running it is the drift check. Running twice on the same schema produces identical output.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format, type FormatConfig } from 'oxfmt';

import { WIDGETS_API_SCHEMA_URL, generateWidgetsSchemaFile } from './gen-widgets-schema-lib.js';

/** Load the project's oxfmt config so generated output matches `npm run fmt`. */
function loadFormatConfig(): FormatConfig {
  const configPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '.oxfmtrc.json');
  return existsSync(configPath) ? (JSON.parse(readFileSync(configPath, 'utf-8')) as FormatConfig) : {};
}

async function readSchema(source: string): Promise<string> {
  if (!/^https?:\/\//.test(source)) return readFileSync(resolve(source), 'utf-8');

  const response = await fetch(source);
  if (!response.ok) throw new Error(`GET ${source} answered ${response.status}`);
  return response.text();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));

  // Default to the published schema; a positional path overrides it.
  const source = positional[0] ?? WIDGETS_API_SCHEMA_URL;

  const dryRun = flags.includes('--dry-run');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 ? args[outIdx + 1] : 'src/workos/generated/widgets-api-schema.ts';

  const sdl = await readSchema(source);
  const generated = generateWidgetsSchemaFile(sdl, source);
  const { code } = await format(outFile, generated, loadFormatConfig());

  if (dryRun) {
    process.stdout.write(code);
    return;
  }

  mkdirSync(dirname(resolve(outFile)), { recursive: true });
  writeFileSync(resolve(outFile), code);
  console.log(`Wrote ${outFile} (${sdl.length} chars of SDL from ${source})`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
