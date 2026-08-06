#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { parse as parseYaml } from 'yaml';
import { createEmulator, type EmulatorSeedConfig } from './index.js';
import { checkForUpdates, shouldCheckForUpdates } from './version-check.js';
import { VERSION } from './version.js';
import { validateSeedConfig, formatValidationErrors } from './workos/config-validator.js';

interface CliArgs {
  port: number;
  host?: string;
  seed?: string;
  signingKey?: string;
  kid?: string;
  issuer?: string;
  redirectHosts?: string[];
  json: boolean;
  help: boolean;
  version: boolean;
  interactive: boolean;
  validateConfig: boolean;
}

const DEFAULT_PORT = 4100;
const SEED_CANDIDATES = ['workos-emulate.config.yaml', 'workos-emulate.config.yml', 'workos-emulate.config.json'];

/** Flags taking a string value, accepted as either `--flag value` or `--flag=value`. */
const VALUE_FLAGS = [
  ['--signing-key', 'signingKey'],
  ['--kid', 'kid'],
  ['--issuer', 'issuer'],
] as const satisfies ReadonlyArray<readonly [string, 'signingKey' | 'kid' | 'issuer']>;

function printHelp(): void {
  console.log(`Usage: workos-emulate [options]

Start a local WorkOS API emulator.

Options:
  --port, -p <port>   Port to listen on (default: ${DEFAULT_PORT})
  --host <hostname>   Interface to bind to (default: localhost). Use 0.0.0.0 to
                      intentionally expose the emulator to other hosts.
  --seed, -s <path>   Path to seed config file (YAML or JSON)
  --signing-key <path>
                      Path to a PEM-encoded RSA private key to sign tokens with. Without
                      it a key is generated at startup, so the published JWKS changes on
                      every restart. Pin it to keep the JWKS stable.
  --kid <id>          Key id to advertise in the JWKS (default: derived from the key)
  --issuer <url>      Value to mint as the "iss" claim (default: the emulator's own URL)
  --redirect-hosts <hosts>
                      Comma-separated hosts a redirect_uri may point at, on top of localhost
                      (always allowed). Use for test environments with production-like
                      hostnames. Accepts subdomain wildcards ("*.example.test") and "*" to
                      allow any host. Repeatable.
  --interactive, -i   Show login pages for SSO/AuthKit (for E2E browser testing)
  --validate-config   Validate seed config file without starting server
  --json              Print startup details as JSON
  --version, -v       Print the installed version
  --help, -h          Show this help message

Environment:
  WORKOS_EMULATE_SIGNING_KEY=<path>     Same as --signing-key
  WORKOS_EMULATE_KID=<id>               Same as --kid
  WORKOS_EMULATE_ISSUER=<url>           Same as --issuer
  WORKOS_EMULATE_REDIRECT_HOSTS=<hosts> Same as --redirect-hosts
  NO_UPDATE_NOTIFIER=1                  Disable update checks
  WORKOS_EMULATE_DISABLE_UPDATE_CHECK=1 Disable update checks
`);
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = {
    port: DEFAULT_PORT,
    json: false,
    help: false,
    version: false,
    interactive: false,
    validateConfig: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') continue;

    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }

    if (arg === '--json') {
      parsed.json = true;
      continue;
    }

    if (arg === '--version' || arg === '-v') {
      parsed.version = true;
      continue;
    }

    if (arg === '--interactive' || arg === '-i') {
      parsed.interactive = true;
      continue;
    }

    if (arg === '--validate-config') {
      parsed.validateConfig = true;
      continue;
    }

    if (arg === '--port' || arg === '-p') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      parsed.port = parsePort(value);
      continue;
    }

    if (arg.startsWith('--port=')) {
      parsed.port = parsePort(arg.slice('--port='.length));
      continue;
    }

    if (arg === '--host') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      parsed.host = value;
      continue;
    }

    if (arg.startsWith('--host=')) {
      const value = arg.slice('--host='.length);
      if (!value) throw new Error('--host requires a value');
      parsed.host = value;
      continue;
    }

    if (arg === '--redirect-hosts' || arg.startsWith('--redirect-hosts=')) {
      const value = arg === '--redirect-hosts' ? argv[++i] : arg.slice('--redirect-hosts='.length);
      if (!value) throw new Error('--redirect-hosts requires a value');
      // Repeatable, and each occurrence may itself be a comma-separated list.
      const hosts = splitHosts(value);
      // A value that contributes no entries (',' or '  ') would leave an empty array, which is
      // not nullish — so it would also discard WORKOS_EMULATE_REDIRECT_HOSTS on the way past.
      // Two silent no-ops for the price of one, from a flag that was clearly meant to configure
      // something.
      if (hosts.length === 0) throw new Error('--redirect-hosts requires at least one host');
      parsed.redirectHosts = [...(parsed.redirectHosts ?? []), ...hosts];
      continue;
    }

    if (arg === '--seed' || arg === '-s') {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a value`);
      parsed.seed = value;
      continue;
    }

    if (arg.startsWith('--seed=')) {
      parsed.seed = arg.slice('--seed='.length);
      continue;
    }

    const valueFlag = VALUE_FLAGS.find(([flag]) => arg === flag || arg.startsWith(`${flag}=`));
    if (valueFlag) {
      const [flag, field] = valueFlag;
      const value = arg === flag ? argv[++i] : arg.slice(flag.length + 1);
      if (!value) throw new Error(`${flag} requires a value`);
      parsed[field] = value;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}

function splitHosts(value: string): string[] {
  return value
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host !== '');
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function loadSeedFile(filePath: string): EmulatorSeedConfig {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`Seed file not found: ${resolved}`);
  }

  const content = readFileSync(resolved, 'utf-8');
  if (resolved.endsWith('.json')) {
    return JSON.parse(content) as EmulatorSeedConfig;
  }
  return parseYaml(content) as EmulatorSeedConfig;
}

/** Read a pinned signing key from disk. Undefined path means "generate one", not an error. */
function readSigningKey(filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    throw new Error(`Signing key file not found: ${resolved}`);
  }
  return readFileSync(resolved, 'utf-8');
}

function autoDetectSeedFile(): EmulatorSeedConfig | undefined {
  for (const name of SEED_CANDIDATES) {
    const filePath = resolve(name);
    if (existsSync(filePath)) return loadSeedFile(filePath);
  }
  return undefined;
}

function printBanner(emulator: { url: string; apiKey: string }): void {
  console.log();
  console.log(chalk.bold('  WorkOS Emulator'));
  console.log();
  console.log(`  ${chalk.dim('URL:')}      ${emulator.url}`);
  console.log(`  ${chalk.dim('API Key:')}  ${emulator.apiKey}`);
  console.log(`  ${chalk.dim('Health:')}   ${emulator.url}/health`);
  console.log();
  console.log(chalk.dim('  Press Ctrl+C to stop'));
  console.log();
}

async function main(): Promise<void> {
  const argv = parseArgs(process.argv.slice(2));
  if (argv.help) {
    printHelp();
    return;
  }
  if (argv.version) {
    console.log(VERSION);
    return;
  }

  const seedConfig = argv.seed ? loadSeedFile(argv.seed) : autoDetectSeedFile();

  // Handle config validation mode
  if (argv.validateConfig) {
    if (!seedConfig) {
      console.error('No seed config file found to validate');
      process.exit(1);
    }

    const validation = validateSeedConfig(seedConfig);
    if (validation.valid) {
      console.log(chalk.green('✓ Configuration is valid'));
      process.exit(0);
    } else {
      console.error(chalk.red('✗ Configuration validation failed:'));
      console.error(formatValidationErrors(validation.errors));
      process.exit(1);
    }
  }

  // Flags win over environment, so a compose file can set a default a command can override.
  const signingKeyPath = argv.signingKey ?? process.env.WORKOS_EMULATE_SIGNING_KEY;
  const kid = argv.kid ?? process.env.WORKOS_EMULATE_KID;
  const issuer = argv.issuer ?? process.env.WORKOS_EMULATE_ISSUER;
  const allowedRedirectHosts = argv.redirectHosts ?? splitHosts(process.env.WORKOS_EMULATE_REDIRECT_HOSTS ?? '');

  const emulator = await createEmulator({
    port: argv.port,
    hostname: argv.host,
    seed: seedConfig,
    issuer,
    signingKey: signingKeyPath || kid ? { privateKey: readSigningKey(signingKeyPath), kid } : undefined,
    allowedRedirectHosts,
    interactiveAuth: argv.interactive,
  });

  if (argv.json) {
    console.log(
      JSON.stringify({
        url: emulator.url,
        port: emulator.port,
        apiKey: emulator.apiKey,
        health: `${emulator.url}/health`,
      }),
    );
  } else {
    printBanner(emulator);
  }

  if (shouldCheckForUpdates({ json: argv.json })) {
    void checkForUpdates().then((update) => {
      if (!update) return;
      console.error(chalk.yellow(`Update available: ${update.currentVersion} → ${update.latestVersion}`));
      console.error(chalk.dim(update.notice));
      console.error();
    });
  }

  const shutdown = () => {
    if (!argv.json) console.log(`\n${chalk.dim('Shutting down...')}`);
    emulator.close().then(() => process.exit(0));
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  if (process.platform === 'win32') process.once('SIGBREAK', shutdown);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
