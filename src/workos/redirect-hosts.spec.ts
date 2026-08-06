/**
 * Configurable redirect hosts.
 *
 * The authorize endpoints refuse to redirect anywhere but localhost so the emulator cannot be
 * used as an open redirect. Test environments that fake production-like hostnames need to widen
 * that, so extra hosts are configurable — without the default ever becoming "anything goes".
 */
import { describe, it, expect } from 'bun:test';
import { createServer, type ApiKeyMap } from '../core/index.js';
import { createEmulator } from '../index.js';
import { workosPlugin } from './index.js';
import { STORE_KEYS } from './constants.js';
import { normalizeRedirectHost, normalizeRedirectHosts } from './helpers.js';

const apiKeys: ApiKeyMap = { sk_test_redirect: { environment: 'test' } };
const headers = { Authorization: 'Bearer sk_test_redirect', 'Content-Type': 'application/json' };

function createTestApp(allowedRedirectHosts?: string[]) {
  const { app, store } = createServer(workosPlugin, { port: 0, baseUrl: 'http://localhost:0', apiKeys });
  if (allowedRedirectHosts) store.setData(STORE_KEYS.allowedRedirectHosts, allowedRedirectHosts);
  return { app, store };
}

const json = (res: Response) => res.json() as Promise<any>;

describe('normalizeRedirectHost', () => {
  it('keeps a bare hostname, lowercased', () => {
    expect(normalizeRedirectHost('App.Example.Test')).toBe('app.example.test');
  });

  it('reduces a whole origin to its hostname', () => {
    expect(normalizeRedirectHost('https://app.example.test:8443/callback')).toBe('app.example.test');
  });

  it('strips a bare host:port', () => {
    expect(normalizeRedirectHost('app.example.test:3000')).toBe('app.example.test');
  });

  it('brackets bare IPv6 and leaves bracketed IPv6 alone', () => {
    expect(normalizeRedirectHost('::1')).toBe('[::1]');
    expect(normalizeRedirectHost('[fd00::1]:3000')).toBe('[fd00::1]');
  });

  it('passes wildcards through', () => {
    expect(normalizeRedirectHost('*')).toBe('*');
    expect(normalizeRedirectHost('*.example.test')).toBe('*.example.test');
  });

  it('rejects input that could never match', () => {
    expect(() => normalizeRedirectHost('https://')).toThrow('Invalid redirect host');
    expect(() => normalizeRedirectHost('two hosts')).toThrow('Invalid redirect host');
  });

  it('rejects patterns that look plausible but can never match a hostname', () => {
    for (const bad of [
      '*example.test', // wildcard without the separating dot
      '*.', // wildcard with nothing to anchor to
      'app.example.test/path', // a path is not part of a hostname
      'app.example.test:notaport', // would otherwise be bracketed as bogus IPv6
      '-leading.example.test',
      'trailing-.example.test',
      'double..dot.test',
      '*.*.example.test',
    ]) {
      expect(() => normalizeRedirectHost(bad)).toThrow('Invalid redirect host');
    }
  });

  it('still accepts the forms it documents', () => {
    for (const good of [
      'localhost',
      '127.0.0.1',
      '[::1]',
      '[fd00::1]:3000',
      'app.example.test',
      'app.example.test:3000',
      'https://app.example.test:8443/callback',
      '*.example.test',
      'xn--80ak6aa92e.test', // punycode
      '*',
    ]) {
      expect(() => normalizeRedirectHost(good)).not.toThrow();
    }
  });

  it('drops blank entries from a list', () => {
    expect(normalizeRedirectHosts(['app.example.test', '  ', ''])).toEqual(['app.example.test']);
  });
});

describe('redirect host validation (default: localhost only)', () => {
  const { app } = createTestApp();

  it('rejects a non-localhost AuthKit redirect_uri', async () => {
    const res = await app.request('/user_management/authorize?redirect_uri=https://app.example.test/callback');
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('invalid_redirect_uri');
    expect(body.message).toContain('must point to localhost');
  });

  it('rejects a non-localhost SSO redirect_uri', async () => {
    const res = await app.request('/sso/authorize?connection=conn_missing&redirect_uri=https://app.example.test/cb');
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('invalid_redirect_uri');
  });

  it('rejects a non-localhost data integration redirect_uri', async () => {
    const res = await app.request('/data-integrations/salesforce/authorize?redirect_uri=https://app.example.test/cb');
    expect(res.status).toBe(400);
  });

  it('rejects a non-localhost logout return_to', async () => {
    const res = await app.request(
      '/user_management/sessions/logout?session_id=session_x&return_to=https://app.example.test/bye',
    );
    expect(res.status).toBe(400);
    expect((await json(res)).code).toBe('invalid_redirect_uri');
  });

  it('still allows the localhost family', async () => {
    for (const uri of ['http://localhost:3000/cb', 'http://127.0.0.1:3000/cb', 'http://[::1]:3000/cb']) {
      const res = await app.request(`/data-integrations/salesforce/authorize?redirect_uri=${encodeURIComponent(uri)}`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
    }
  });
});

describe('redirect host validation (configured hosts)', () => {
  it('accepts a configured host on the AuthKit authorize endpoint', async () => {
    const { app } = createTestApp(['app.example.test']);
    await app.request('/user_management/users', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: 'redirect@test.com' }),
    });

    const res = await app.request('/user_management/authorize?redirect_uri=https://app.example.test/callback', {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('Location')!);
    expect(location.host).toBe('app.example.test');
    expect(location.searchParams.get('code')).toBeTruthy();
  });

  it('accepts a configured host on the logout and data integration endpoints', async () => {
    const { app } = createTestApp(['app.example.test']);

    const logout = await app.request(
      '/user_management/sessions/logout?session_id=session_x&return_to=https://app.example.test/bye',
      { redirect: 'manual' },
    );
    expect(logout.status).toBe(302);

    const integration = await app.request(
      '/data-integrations/salesforce/authorize?redirect_uri=https://app.example.test/cb',
      { redirect: 'manual' },
    );
    expect(integration.status).toBe(302);
  });

  it('gets past the redirect check on the SSO endpoint', async () => {
    const { app } = createTestApp(['app.example.test']);
    const res = await app.request('/sso/authorize?connection=conn_missing&redirect_uri=https://app.example.test/cb');
    // The host is accepted, so the request fails on the missing connection instead.
    expect(res.status).toBe(404);
    expect((await json(res)).code).toBe('connection_not_found');
  });

  it('still rejects hosts that were not configured', async () => {
    const { app } = createTestApp(['app.example.test']);
    const res = await app.request('/user_management/authorize?redirect_uri=https://evil.example.com/callback');
    expect(res.status).toBe(400);
    const body = await json(res);
    expect(body.code).toBe('invalid_redirect_uri');
    expect(body.message).toContain('app.example.test');
  });

  it('matches subdomains of a wildcard, but not its apex', async () => {
    const { app } = createTestApp(['*.example.test']);

    const sub = await app.request('/data-integrations/salesforce/authorize?redirect_uri=https://app.example.test/cb', {
      redirect: 'manual',
    });
    expect(sub.status).toBe(302);

    const apex = await app.request('/data-integrations/salesforce/authorize?redirect_uri=https://example.test/cb', {
      redirect: 'manual',
    });
    expect(apex.status).toBe(400);
  });

  it('accepts any host when configured with *', async () => {
    const { app } = createTestApp(['*']);
    const res = await app.request('/data-integrations/salesforce/authorize?redirect_uri=https://anything.invalid/cb', {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });

  it('rejects a malformed redirect_uri regardless of configuration', async () => {
    const { app } = createTestApp(['*']);
    const res = await app.request('/data-integrations/salesforce/authorize?redirect_uri=not-a-url');
    expect(res.status).toBe(400);
    expect((await json(res)).message).toBe('Invalid redirect_uri');
  });
});

describe('createEmulator({ allowedRedirectHosts })', () => {
  it('applies the configured hosts, normalizing origins, and survives reset()', async () => {
    const emulator = await createEmulator({ port: 0, allowedRedirectHosts: ['https://app.example.test:8443'] });
    try {
      const authorize = () =>
        fetch(`${emulator.url}/data-integrations/salesforce/authorize?redirect_uri=https://app.example.test/cb`, {
          redirect: 'manual',
        });

      expect((await authorize()).status).toBe(302);
      emulator.reset();
      expect((await authorize()).status).toBe(302);
    } finally {
      await emulator.close();
    }
  });

  it('fails at startup on a host that could never match', async () => {
    await expect(createEmulator({ port: 0, allowedRedirectHosts: ['https://'] })).rejects.toThrow(
      'Invalid redirect host',
    );
  });

  it('leaves the localhost-only default in place when unset', async () => {
    const emulator = await createEmulator({ port: 0 });
    try {
      const res = await fetch(
        `${emulator.url}/data-integrations/salesforce/authorize?redirect_uri=https://app.example.test/cb`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(400);
    } finally {
      await emulator.close();
    }
  });
});
