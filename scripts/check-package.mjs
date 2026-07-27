import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'workos-emulate-package-'));
const packDirectory = join(temporaryRoot, 'pack');
const consumerDirectory = join(temporaryRoot, 'consumer');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const requiredFiles = [
  'LICENSE.txt',
  'README.md',
  'dist/cli.js',
  'dist/core/index.d.ts',
  'dist/core/index.js',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/workos/index.d.ts',
  'dist/workos/index.js',
  'package.json',
];

try {
  mkdirSync(packDirectory, { recursive: true });
  const packOutput = run(npm, ['pack', '--json', '--ignore-scripts', '--pack-destination', packDirectory], projectRoot);
  const results = JSON.parse(packOutput);
  assert.equal(results.length, 1, 'npm pack must produce exactly one tarball');

  const packedFiles = results[0].files.map((file) => file.path);
  const packedFileSet = new Set(packedFiles);

  for (const required of requiredFiles) {
    assert.ok(packedFileSet.has(required), `npm package is missing required file: ${required}`);
  }

  const unexpected = packedFiles.filter(
    (path) => !path.startsWith('dist/') && !['LICENSE.txt', 'README.md', 'package.json'].includes(path),
  );
  assert.deepEqual(unexpected, [], `npm package contains unexpected files: ${unexpected.join(', ')}`);

  const forbidden = packedFiles.filter(
    (path) =>
      /(^|\/)(?:src|scripts|coverage|node_modules|\.github)\//.test(path) ||
      /(?:^|\/)\.env(?:\.|$)/.test(path) ||
      /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path) ||
      path.endsWith('.bun-build') ||
      path === 'bun.lock' ||
      path === 'bunfig.toml',
  );
  assert.deepEqual(forbidden, [], `npm package contains development or sensitive files: ${forbidden.join(', ')}`);

  const tarball = join(packDirectory, results[0].filename);
  assert.ok(existsSync(tarball), `npm pack did not create ${tarball}`);

  mkdirSync(consumerDirectory, { recursive: true });
  writeFileSync(
    join(consumerDirectory, 'package.json'),
    `${JSON.stringify({ name: 'package-contract-consumer', private: true, type: 'module' }, null, 2)}\n`,
  );
  writeFileSync(
    join(consumerDirectory, '.npmrc'),
    ['audit=false', 'fund=false', 'package-lock=false', 'update-notifier=false'].join('\n'),
  );

  run(
    npm,
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', tarball],
    consumerDirectory,
  );

  run(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      [
        "const root = await import('@workos/emulate');",
        "const core = await import('@workos/emulate/core');",
        "const workos = await import('@workos/emulate/workos');",
        "if (typeof root.createEmulator !== 'function') throw new Error('root createEmulator export is missing');",
        "if (Object.keys(core).length === 0) throw new Error('core export is empty');",
        "if (Object.keys(workos).length === 0) throw new Error('workos export is empty');",
      ].join('\n'),
    ],
    consumerDirectory,
  );

  const installedPackageRoot = join(consumerDirectory, 'node_modules', '@workos', 'emulate');
  const cliPath = join(installedPackageRoot, packageJson.bin['workos-emulate']);
  assert.ok(existsSync(cliPath), `installed CLI is missing: ${cliPath}`);
  assert.ok(existsSync(join(consumerDirectory, 'node_modules', '.bin', 'workos-emulate')), 'npm bin link is missing');

  const installedVersion = run(process.execPath, [cliPath, '--version'], consumerDirectory);
  assert.equal(installedVersion, packageJson.version);

  console.log(`check-package: OK (${packedFiles.length} files, imports and CLI verified under ${process.version})`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: 'true', NO_UPDATE_NOTIFIER: '1' },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [`${command} ${args.join(' ')} failed with exit code ${result.status}`, result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n'),
    );
  }
  return result.stdout.trim();
}
