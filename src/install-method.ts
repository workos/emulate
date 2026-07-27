import { realpathSync } from 'node:fs';

export type InstallMethod = 'homebrew' | 'npm' | 'download';

const RELEASES_URL = 'https://github.com/workos/emulate/releases/latest';

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function runtimePaths(): string[] {
  const originalPaths = [process.argv[1], process.execPath].filter((path): path is string => Boolean(path));
  const paths = [...originalPaths];

  for (const path of originalPaths) {
    try {
      paths.push(realpathSync(path));
    } catch {
      // The original path remains useful when a launcher or symlink cannot be resolved.
    }
  }

  return [...new Set(paths)];
}

/**
 * Infer how the CLI was installed from its entrypoint and executable paths.
 *
 * npm takes precedence because a Node installed by Homebrew can execute a
 * globally installed npm package. Resolving argv[1] exposes the package's real
 * node_modules path even when the command itself is a global bin symlink.
 */
export function detectInstallMethod(paths: string[] = runtimePaths()): InstallMethod {
  const normalized = paths.map(normalizePath);

  if (normalized.some((path) => path.includes('/node_modules/'))) {
    return 'npm';
  }

  if (
    normalized.some(
      (path) => path.includes('/Cellar/') || path.includes('/opt/homebrew/') || path.includes('/.linuxbrew/'),
    )
  ) {
    return 'homebrew';
  }

  return 'download';
}

export function upgradeNotice(method: InstallMethod): string {
  switch (method) {
    case 'homebrew':
      return 'Upgrade: brew upgrade workos/tap/workos-emulate';
    case 'npm':
      return 'Upgrade: npm install -g @workos/emulate@latest';
    case 'download':
      return `Download: ${RELEASES_URL}`;
  }
}
