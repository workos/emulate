import { describe, expect, it } from 'bun:test';
import { detectInstallMethod, upgradeNotice } from './install-method.js';

describe('install method detection', () => {
  it('detects npm from a package entrypoint even when Node came from Homebrew', () => {
    expect(
      detectInstallMethod([
        '/opt/homebrew/Cellar/node/24.0.0/bin/node',
        '/opt/homebrew/lib/node_modules/@workos/emulate/dist/cli.js',
      ]),
    ).toBe('npm');
  });

  it('detects npm on Windows', () => {
    expect(detectInstallMethod(['C:\\Users\\test\\npm\\node_modules\\@workos\\emulate\\dist\\cli.js'])).toBe('npm');
  });

  it('detects macOS and Linux Homebrew installations', () => {
    expect(detectInstallMethod(['/opt/homebrew/Cellar/workos-emulate/0.4.0/bin/workos-emulate'])).toBe('homebrew');
    expect(detectInstallMethod(['/home/linuxbrew/.linuxbrew/Cellar/workos-emulate/0.4.0/bin/workos-emulate'])).toBe(
      'homebrew',
    );
  });

  it('treats an arbitrary standalone executable as a direct download', () => {
    expect(detectInstallMethod(['/usr/local/bin/workos-emulate'])).toBe('download');
  });
});

describe('upgrade notice', () => {
  it('matches each installation channel', () => {
    expect(upgradeNotice('npm')).toBe('Upgrade: npm install -g @workos/emulate@latest');
    expect(upgradeNotice('homebrew')).toBe('Upgrade: brew upgrade workos/tap/workos-emulate');
    expect(upgradeNotice('download')).toContain('https://github.com/workos/emulate/releases/latest');
  });
});
