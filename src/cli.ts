#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { parse as parseYaml } from 'yaml';
import { createEmulator, type EmulatorSeedConfig } from './index.js';

interface CliArgs {
  port: number;
  seed?: string;
  json: boolean;
  help: boolean;
}

const DEFAULT_PORT = 4100;
const SEED_CANDIDATES = ['workos-emulate.config.yaml', 'workos-emulate.config.yml', 'workos-emulate.config.json'];

function printHelp(): void {
  console.log(`Usage: workos-emulate [options]

Start a local WorkOS API emulator.

Options:
  --port, -p <port>   Port to listen on (default: ${DEFAULT_PORT})
  --seed, -s <path>   Path to seed config file (YAML or JSON)
  --json              Print startup details as JSON
  --help, -h          Show this help message
`);
}

function parseArgs(argv: string[]): CliArgs {
  const parsed: CliArgs = { port: DEFAULT_PORT, json: false, help: false };

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

    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
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

  const seedConfig = argv.seed ? loadSeedFile(argv.seed) : autoDetectSeedFile();
  const emulator = await createEmulator({
    port: argv.port,
    seed: seedConfig,
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
