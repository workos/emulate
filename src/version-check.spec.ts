import { describe, expect, it } from 'bun:test';
import { checkForUpdates, shouldCheckForUpdates } from './version-check.js';

function response(status: number, options: { body?: unknown; location?: string } = {}): Response {
  return new Response(options.body === undefined ? null : JSON.stringify(options.body), {
    status,
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.location ? { Location: options.location } : {}),
    },
  });
}

describe('checkForUpdates', () => {
  it('uses the npm registry for npm installations', async () => {
    const calls: string[] = [];
    const update = await checkForUpdates({
      currentVersion: '0.3.0',
      installMethod: 'npm',
      fetch: async (input) => {
        calls.push(String(input));
        return response(200, { body: { version: '0.4.0' } });
      },
    });

    expect(calls).toEqual(['https://registry.npmjs.org/@workos%2Femulate/latest']);
    expect(update).toEqual({
      currentVersion: '0.3.0',
      latestVersion: '0.4.0',
      installMethod: 'npm',
      notice: 'Upgrade: npm install -g @workos/emulate@latest',
    });
  });

  it('requires checksums before announcing a GitHub binary release', async () => {
    const calls: string[] = [];
    const update = await checkForUpdates({
      currentVersion: '0.3.0',
      installMethod: 'download',
      fetch: async (input) => {
        calls.push(String(input));
        if (calls.length === 1) {
          return response(302, { location: 'https://github.com/workos/emulate/releases/tag/v0.4.0' });
        }
        return response(200);
      },
    });

    expect(calls).toEqual([
      'https://github.com/workos/emulate/releases/latest',
      'https://github.com/workos/emulate/releases/download/v0.4.0/checksums.txt',
    ]);
    expect(update?.latestVersion).toBe('0.4.0');
    expect(update?.notice).toContain('/releases/latest');
  });

  it('stays quiet while binary assets are incomplete', async () => {
    let call = 0;
    const update = await checkForUpdates({
      currentVersion: '0.3.0',
      installMethod: 'homebrew',
      fetch: async () => {
        call++;
        return call === 1
          ? response(302, { location: 'https://github.com/workos/emulate/releases/tag/v0.4.0' })
          : response(404);
      },
    });

    expect(update).toBeUndefined();
  });

  it('stays quiet when current, ahead, invalid, or offline', async () => {
    const npmResponse = (version: string) => async () => response(200, { body: { version } });

    expect(
      await checkForUpdates({
        currentVersion: '0.4.0',
        installMethod: 'npm',
        fetch: npmResponse('0.4.0'),
      }),
    ).toBeUndefined();
    expect(
      await checkForUpdates({
        currentVersion: '0.5.0',
        installMethod: 'npm',
        fetch: npmResponse('0.4.0'),
      }),
    ).toBeUndefined();
    expect(
      await checkForUpdates({
        currentVersion: 'development',
        installMethod: 'npm',
        fetch: npmResponse('0.4.0'),
      }),
    ).toBeUndefined();
    expect(
      await checkForUpdates({
        currentVersion: '0.3.0',
        installMethod: 'npm',
        fetch: async () => {
          throw new Error('offline');
        },
      }),
    ).toBeUndefined();
  });
});

describe('shouldCheckForUpdates', () => {
  const base = { json: false, stderrIsTTY: true, env: {}, entryPath: '/usr/local/bin/workos-emulate' };

  it('checks in an interactive human invocation', () => {
    expect(shouldCheckForUpdates(base)).toBe(true);
  });

  it('skips JSON, non-TTY, CI, opt-out, and source development', () => {
    expect(shouldCheckForUpdates({ ...base, json: true })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, stderrIsTTY: false })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, env: { CI: 'true' } })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, env: { NO_UPDATE_NOTIFIER: '1' } })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, env: { WORKOS_EMULATE_DISABLE_UPDATE_CHECK: 'true' } })).toBe(false);
    expect(shouldCheckForUpdates({ ...base, entryPath: '/repo/src/cli.ts' })).toBe(false);
  });
});
