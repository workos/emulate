/**
 * Spec conformance, run under every test: each exchange the emulator handles is validated
 * against the OpenAPI spec (see inspector.ts), and a finding not already in baseline.txt fails
 * the test that produced it.
 *
 * The baseline is the set of known gaps, one finding per line. It only shrinks on purpose:
 * fix the gap and delete the line, or if production really behaves that way, keep the line and
 * say why in docs/behavior.md. Regenerate it from a clean run with
 * `SPEC_CONFORMANCE=baseline bun test`; `SPEC_CONFORMANCE=off` disables the check.
 *
 * Loaded through bunfig.toml's `[test] preload`, so the hooks here run around every test in
 * every file.
 */
import { afterAll, afterEach } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setExchangeInspector } from '../../src/core/index.js';
import { findingKey, inspectExchange } from './inspector.js';

const BASELINE = fileURLToPath(new URL('./baseline.txt', import.meta.url));
const mode = process.env.SPEC_CONFORMANCE ?? 'check';

function readBaseline(): Set<string> {
  try {
    return new Set(
      readFileSync(BASELINE, 'utf-8')
        .split('\n')
        .filter((line) => line !== '' && !line.startsWith('#')),
    );
  } catch {
    return new Set();
  }
}

const baseline = readBaseline();
const seen = new Set<string>();
let novel: string[] = [];

if (mode !== 'off') {
  setExchangeInspector((exchange) => {
    let findings;
    try {
      findings = inspectExchange(exchange);
    } catch (error) {
      // A validator that cannot be built is a tooling fault, reported like a finding so it fails
      // the test with its cause rather than failing the request with a 500.
      novel.push(
        `tooling ${exchange.method} ${exchange.url.pathname}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    for (const finding of findings) {
      const key = findingKey(finding);
      seen.add(key);
      if (!baseline.has(key)) novel.push(key);
    }
  });

  // Findings are checked, and only then cleared, after every test and again after a file: a
  // request made in `beforeAll` is reported by the first test that follows it, and one made in
  // `afterAll` by the file's own closing hook, so no exchange goes unchecked for want of a test.
  afterEach(check);
  afterAll(check);
}

function check(): void {
  if (mode === 'baseline') {
    // Rewritten whenever the set grows: bun test does not run process exit handlers.
    if (seen.size !== written) writeBaseline();
    return;
  }
  if (novel.length === 0) return;
  const lines = [...new Set(novel)].sort();
  novel = [];
  throw new Error(
    `Outside the OpenAPI spec:\n  ${lines.join('\n  ')}\n` +
      'Fix the emulator, or if production really behaves this way add the line to test/spec-conformance/baseline.txt.',
  );
}

let written = -1;
function writeBaseline(): void {
  const header = [
    '# Known gaps between the emulator and the OpenAPI spec, one finding per line.',
    '# Format: <METHOD> <path template> <status> <response|status|query|request> <detail>',
    '# Regenerate from a clean run with `SPEC_CONFORMANCE=baseline bun test`; see preload.ts.',
  ];
  writeFileSync(BASELINE, `${[...header, ...[...seen].sort()].join('\n')}\n`);
  written = seen.size;
}
