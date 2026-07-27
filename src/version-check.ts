import { lt, valid } from 'semver';
import { detectInstallMethod, type InstallMethod, upgradeNotice } from './install-method.js';
import { VERSION } from './version.js';

const NPM_LATEST_URL = 'https://registry.npmjs.org/@workos%2Femulate/latest';
const GITHUB_LATEST_URL = 'https://github.com/workos/emulate/releases/latest';
const GITHUB_DOWNLOAD_BASE = 'https://github.com/workos/emulate/releases/download';
const DEFAULT_TIMEOUT_MS = 1_000;

export interface AvailableUpdate {
  currentVersion: string;
  latestVersion: string;
  installMethod: InstallMethod;
  notice: string;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface UpdateCheckOptions {
  currentVersion?: string;
  installMethod?: InstallMethod;
  fetch?: Fetcher;
  timeoutMs?: number;
}

interface ShouldCheckOptions {
  json: boolean;
  stderrIsTTY?: boolean;
  env?: NodeJS.ProcessEnv;
  entryPath?: string;
}

function isEnabledEnvironmentValue(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

export function shouldCheckForUpdates({
  json,
  stderrIsTTY = Boolean(process.stderr.isTTY),
  env = process.env,
  entryPath = process.argv[1] ?? '',
}: ShouldCheckOptions): boolean {
  if (json || !stderrIsTTY || isEnabledEnvironmentValue(env.CI)) return false;
  if (isEnabledEnvironmentValue(env.NO_UPDATE_NOTIFIER)) return false;
  if (isEnabledEnvironmentValue(env.WORKOS_EMULATE_DISABLE_UPDATE_CHECK)) return false;

  // Source-mode development should not compare an unreleased checkout with production.
  return !entryPath.replaceAll('\\', '/').endsWith('/src/cli.ts');
}

async function latestNpmVersion(fetcher: Fetcher, signal: AbortSignal): Promise<string | undefined> {
  const response = await fetcher(NPM_LATEST_URL, {
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) return undefined;

  const payload: unknown = await response.json();
  if (typeof payload !== 'object' || payload === null || !('version' in payload)) return undefined;
  return typeof payload.version === 'string' ? payload.version : undefined;
}

async function latestReadyBinaryVersion(fetcher: Fetcher, signal: AbortSignal): Promise<string | undefined> {
  const response = await fetcher(GITHUB_LATEST_URL, {
    method: 'HEAD',
    redirect: 'manual',
    signal,
  });

  const location = response.headers.get('location') ?? '';
  const match = /\/releases\/tag\/([^/?#]+)/.exec(location);
  if (!match) return undefined;

  const tag = decodeURIComponent(match[1]);
  const version = tag.replace(/^v/, '');
  if (!valid(version)) return undefined;

  // release-please makes the release public before the binary workflow runs.
  // Gate the notice on checksums.txt so users are never sent to incomplete assets.
  const checksumResponse = await fetcher(`${GITHUB_DOWNLOAD_BASE}/${encodeURIComponent(tag)}/checksums.txt`, {
    method: 'HEAD',
    redirect: 'follow',
    signal,
  });
  return checksumResponse.ok ? version : undefined;
}

/**
 * Return an available update for the running installation channel.
 * Network, timeout, registry, and parsing errors are intentionally silent.
 */
export async function checkForUpdates(options: UpdateCheckOptions = {}): Promise<AvailableUpdate | undefined> {
  const currentVersion = options.currentVersion ?? VERSION;
  const installMethod = options.installMethod ?? detectInstallMethod();
  const fetcher = options.fetch ?? globalThis.fetch;

  if (!valid(currentVersion)) return undefined;

  try {
    const signal = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const latestVersion =
      installMethod === 'npm'
        ? await latestNpmVersion(fetcher, signal)
        : await latestReadyBinaryVersion(fetcher, signal);

    if (!latestVersion || !valid(latestVersion) || !lt(currentVersion, latestVersion)) return undefined;

    return {
      currentVersion,
      latestVersion,
      installMethod,
      notice: upgradeNotice(installMethod),
    };
  } catch {
    return undefined;
  }
}
