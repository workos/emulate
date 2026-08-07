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

  // `isIPv6` accepts every legal spelling of an address, but a request only ever arrives in the
  // one `URL.hostname` produces — so an entry that is not canonicalized starts the emulator and
  // then matches nothing, the silent no-match this validation exists to prevent.
  it('canonicalizes IPv6 to the single form a request carries', () => {
    expect(normalizeRedirectHost('[fd00:0:0:0:0:0:0:1]')).toBe('[fd00::1]');
    expect(normalizeRedirectHost('[FD00::0001]')).toBe('[fd00::1]');
    expect(normalizeRedirectHost('fd00:0:0:0:0:0:0:1')).toBe('[fd00::1]');
    expect(normalizeRedirectHost('[::ffff:127.0.0.1]')).toBe('[::ffff:7f00:1]');
    expect(normalizeRedirectHost('https://[fd00:0:0:0:0:0:0:1]:8443')).toBe('[fd00::1]');
  });

  // The same asymmetry as IPv6, in the family people actually type: `URL` rewrites every IPv4
  // shorthand it accepts, so an entry written any way but dotted-quad matched nothing.
  it('canonicalizes IPv4 shorthand to the dotted quad a request carries', () => {
    expect(normalizeRedirectHost('10.1')).toBe('10.0.0.1');
    expect(normalizeRedirectHost('192.168.001.1')).toBe('192.168.1.1');
    expect(normalizeRedirectHost('0x7f.0.0.1')).toBe('127.0.0.1');
    expect(normalizeRedirectHost('2130706433')).toBe('127.0.0.1');
    expect(normalizeRedirectHost('https://10.1:8443/cb')).toBe('10.0.0.1');
    expect(normalizeRedirectHost('*.10.1')).toBe('*.10.0.0.1');
  });

  // IPv4-shaped and not an address: `URL` refuses these, so they can never be a `URL.hostname`.
  it('rejects an IPv4-shaped host that is not an address', () => {
    for (const bad of ['999.999.999.999', '1.2.3.4.5', '256.0.0.1']) {
      expect(() => normalizeRedirectHost(bad)).toThrow('Invalid redirect host');
    }
  });

  // `URL.hostname` keeps the trailing dot a request carried, so both sides are stripped.
  it('drops a trailing dot, so an absolute name matches the way it is written', () => {
    expect(normalizeRedirectHost('app.example.test.')).toBe('app.example.test');
    expect(normalizeRedirectHost('*.example.test.')).toBe('*.example.test');
    expect(normalizeRedirectHost('https://app.example.test./cb')).toBe('app.example.test');
  });

  it('passes wildcards through', () => {
    expect(normalizeRedirectHost('*')).toBe('*');
    expect(normalizeRedirectHost('*.example.test')).toBe('*.example.test');
  });

  it('rejects input that could never match', () => {
    expect(() => normalizeRedirectHost('https://')).toThrow('Invalid redirect host');
    expect(() => normalizeRedirectHost('two hosts')).toThrow('Invalid redirect host');
  });

  // A request carries the punycode `URL.hostname` produced, so a configured entry has to reach
  // the same form or the bare spelling of an internationalized host could never match.
  it('punycodes an internationalized hostname, bare or wildcarded', () => {
    expect(normalizeRedirectHost('møller.test')).toBe('xn--mller-vua.test');
    expect(normalizeRedirectHost('MØLLER.test')).toBe('xn--mller-vua.test');
    expect(normalizeRedirectHost('*.møller.test')).toBe('*.xn--mller-vua.test');
    // Which is what the origin form already yielded, since URL punycodes on the way through.
    expect(normalizeRedirectHost('https://møller.test')).toBe('xn--mller-vua.test');
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
      '[:::]', // IPv6-shaped characters, not an address
      '[....]',
      '[fd00::1', // never closed
      'møller.test/path', // punycoding must not smuggle a path through
      '*..', // stripping the trailing dot must not quietly leave `*.`
      '.', // nor turn a lone dot into an empty pattern that matches by accident
    ]) {
      expect(() => normalizeRedirectHost(bad)).toThrow('Invalid redirect host');
    }
  });

  // `*` is the one entry that widens to every host, so it may only be spelled that way. Stripping
  // a port or a scheme off something else and landing on it turns what reads as a narrowing into
  // the fully-open wildcard — the accident `stripTrailingDot` already guards for `*.`.
  it('refuses a wildcard that only became bare `*` by having something stripped off it', () => {
    for (const bad of ['*:3000', 'https://*', 'https://*:8443', '*:0']) {
      expect(() => normalizeRedirectHost(bad)).toThrow('write "*" to allow any host');
    }
    // The one spelling that does mean every host still works.
    expect(normalizeRedirectHost('*')).toBe('*');
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
      'møller.test', // and the same host written the way its owner spells it
      // Not DNS-conformant, but `URL` passes underscores through, so a compose service name is a
      // host a request really arrives with — rejecting it failed loudly on a config that works.
      'my_host.example.test',
      '_dmarc.example.test',
      '*.my_host.example.test',
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
    // Names both ways in, since a programmatic caller has no flag to pass.
    expect(body.message).toContain('--redirect-hosts');
    expect(body.message).toContain('allowedRedirectHosts');
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

  // URL parsing *removes* these instead of failing on them, so `http://local\thost/` used to
  // validate as localhost and then be handed to the redirect raw — a Location header carrying a
  // control character, or a 500 where the URI was simply malformed.
  it('refuses a URI carrying characters URL parsing would strip', async () => {
    const raws = ['http://local\thost:3000/cb', 'http://localhost:3000/cb\r\nX-Injected: 1', 'http://loc\nalhost/cb'];
    for (const raw of raws) {
      const res = await app.request(
        `/user_management/sessions/logout?session_id=session_x&return_to=${encodeURIComponent(raw)}`,
        { redirect: 'manual' },
      );
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.code).toBe('invalid_redirect_uri');
      expect(body.message).toBe('Invalid redirect_uri');
    }
  });

  // Only the characters that can actually split a header are refused. A space cannot, and
  // `searchParams.get` decodes `+` to one — so rejecting 0x20 turned an unencoded `+` in the
  // inner query (base64 state, a `+` in an email) into a 400 on a redirect that had worked.
  it('allows a space where a raw `+` in the inner query decoded to one', async () => {
    const res = await app.request(
      '/data-integrations/salesforce/authorize?redirect_uri=http://localhost:3000/cb?token=YWJj+ZGVm',
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('Location')).toContain('token=YWJj+ZGVm');
  });

  // A space is legal in the `return_to` a request carries and not in the `Location` it produces,
  // so logout re-serializes rather than echoing — the way the authorize endpoints already did.
  it('encodes a space out of the logout Location instead of echoing it raw', async () => {
    const res = await app.request(
      '/user_management/sessions/logout?session_id=session_x&return_to=http://localhost:3000/cb?token=YWJj+ZGVm',
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get('Location')!;
    expect(location).not.toContain(' ');
    expect(location).toBe('http://localhost:3000/cb?token=YWJj%20ZGVm');
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

  // A resolver-absolute name reaches `URL.hostname` with its dot intact, so a host configured
  // without one has to match it anyway — otherwise the two spellings of the same host disagree.
  it('matches an absolute (trailing-dot) request host against a dotless entry', async () => {
    const { app } = createTestApp(['app.example.test']);
    const res = await app.request('/data-integrations/salesforce/authorize?redirect_uri=https://app.example.test./cb', {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
  });

  // `URL` passes an underscore through untouched, so a compose service name is a host a request
  // really does arrive with — refusing to configure it failed loudly on a config that works.
  it('matches an underscored host, which URL.hostname carries verbatim', async () => {
    const { app } = createTestApp(normalizeRedirectHosts(['my_host.example.test']));
    const res = await app.request(
      '/data-integrations/salesforce/authorize?redirect_uri=http://my_host.example.test/cb',
      {
        redirect: 'manual',
      },
    );
    expect(res.status).toBe(302);
  });

  it('accepts a canonicalized IPv6 host written any legal way', async () => {
    // Through the real normalization the CLI and createEmulator both use — configuring the
    // uncanonicalized literal directly is exactly the case that used to match nothing.
    const { app } = createTestApp(normalizeRedirectHosts(['[FD00:0:0:0:0:0:0:1]']));
    const res = await app.request(
      `/data-integrations/salesforce/authorize?redirect_uri=${encodeURIComponent('http://[fd00::1]:3000/cb')}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
  });

  it('accepts an IPv4 host written in any shorthand URL accepts', async () => {
    const { app } = createTestApp(normalizeRedirectHosts(['10.1']));
    for (const host of ['10.1', '10.0.0.1', '0xa.0.0.1']) {
      const res = await app.request(`/data-integrations/salesforce/authorize?redirect_uri=http://${host}/cb`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(302);
    }
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

describe('redirect URI schemes', () => {
  // A script URI can borrow an allowed authority it never navigates to, so matching on the host
  // alone let `javascript://localhost/…` through the guard the localhost check exists to be.
  it('refuses a script scheme that parses with an allowed hostname', async () => {
    const { app } = createTestApp();
    for (const uri of ['javascript://localhost/%0aalert(1)', 'javascript://127.0.0.1/%0aalert(1)']) {
      const res = await app.request(`/data-integrations/salesforce/authorize?redirect_uri=${encodeURIComponent(uri)}`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.code).toBe('invalid_redirect_uri');
      expect(body.message).toContain('scheme javascript is not allowed');
    }
  });

  // `*` widens which host may be redirected to; it does not widen what a redirect may execute.
  it('refuses script schemes even when any host is allowed', async () => {
    const { app } = createTestApp(['*']);
    for (const uri of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd']) {
      const res = await app.request(`/data-integrations/salesforce/authorize?redirect_uri=${encodeURIComponent(uri)}`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('invalid_redirect_uri');
    }
  });

  // The denylist covers the schemes it names, and a denylist is always one scheme short. Each of
  // these parses with an empty hostname, so `*` — which only ever answers "is this host allowed"
  // — waved them through on an authority they never had. Refused by shape now, not by name.
  it('refuses a URI with no authority for the host check to speak about', async () => {
    const { app } = createTestApp(['*']);
    for (const uri of [
      'view-source:javascript:alert(1)',
      'jar:http://localhost/!/x',
      'about:blank',
      'mailto:a@b.test',
    ]) {
      const res = await app.request(`/data-integrations/salesforce/authorize?redirect_uri=${encodeURIComponent(uri)}`, {
        redirect: 'manual',
      });
      expect(res.status).toBe(400);
      const body = await json(res);
      expect(body.code).toBe('invalid_redirect_uri');
      expect(body.message).toContain('is not allowed');
    }
  });

  // Native clients (RFC 8252) redirect to a custom scheme, which carries no script.
  it('still allows a custom app scheme whose host is allowed', async () => {
    const { app } = createTestApp(['callback']);
    const res = await app.request(
      `/data-integrations/salesforce/authorize?redirect_uri=${encodeURIComponent('myapp://callback/done')}`,
      { redirect: 'manual' },
    );
    expect(res.status).toBe(302);
  });
});

/**
 * Interactive mode renders the redirect_uri into a hidden field and only reaches the host check on
 * the POST, so a disallowed host used to serve a working sign-in form and fail after the form was
 * filled in — the same check, arriving a page too late.
 */
describe('redirect host validation (interactive mode)', () => {
  function createInteractiveApp(allowedRedirectHosts?: string[]) {
    const { app, store } = createTestApp(allowedRedirectHosts);
    store.setData(STORE_KEYS.interactiveAuth, true);
    return app;
  }

  const paths = [
    '/user_management/authorize?redirect_uri=https://app.example.test/cb',
    '/sso/authorize?connection=conn_x&redirect_uri=https://app.example.test/cb',
  ];

  it('refuses a disallowed host at the GET rather than rendering a login page', async () => {
    for (const path of paths) {
      const res = await createInteractiveApp().request(path);
      expect(res.status).toBe(400);
      expect((await json(res)).code).toBe('invalid_redirect_uri');
    }
  });

  it('still renders the login page when the host is allowed', async () => {
    for (const path of paths) {
      const res = await createInteractiveApp(['app.example.test']).request(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('value="https://app.example.test/cb"');
    }
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

/**
 * The flag and the environment variable are the two ways a compose file or a CI command reaches
 * this feature, and neither is exercised by anything above: `createEmulator` is handed a list
 * that the CLI is responsible for splitting, collecting and preferring over the environment.
 */
describe('--redirect-hosts / WORKOS_EMULATE_REDIRECT_HOSTS', () => {
  const CLI = new URL('../cli.ts', import.meta.url).pathname;

  /**
   * The startup line only, not the whole stream: a served emulator never closes stdout, so
   * reading to EOF would wait for the process this function is about to make requests against.
   */
  async function readStartupLine(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    let buffered = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffered += new TextDecoder().decode(value);
        const line = buffered.split('\n').find((l) => l.startsWith('{'));
        if (line && buffered.includes('\n')) return line;
        if (done) throw new Error(`CLI printed no startup JSON: ${buffered}`);
      }
    } finally {
      reader.releaseLock();
    }
  }

  /** Start the CLI, hand its `--json` URL to `body`, and make sure the process is reaped. */
  async function withCli(
    args: string[],
    env: Record<string, string>,
    body: (url: string) => Promise<void>,
  ): Promise<void> {
    const proc = Bun.spawn([process.execPath, CLI, '--port', '0', '--json', ...args], {
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1', WORKOS_EMULATE_REDIRECT_HOSTS: '', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    try {
      const line = await readStartupLine(proc.stdout);
      await body((JSON.parse(line) as { url: string }).url);
    } finally {
      proc.kill();
      await proc.exited;
    }
  }

  const authorize = (url: string, host: string) =>
    fetch(`${url}/data-integrations/salesforce/authorize?redirect_uri=https://${host}/cb`, { redirect: 'manual' });

  it('collects hosts from repeated, comma-separated and inline forms of the flag', async () => {
    await withCli(
      ['--redirect-hosts', 'a.example.test,b.example.test', '--redirect-hosts=c.example.test'],
      {},
      async (url) => {
        for (const host of ['a.example.test', 'b.example.test', 'c.example.test']) {
          expect((await authorize(url, host)).status).toBe(302);
        }
        expect((await authorize(url, 'd.example.test')).status).toBe(400);
      },
    );
  }, 20000);

  it('reads the environment variable', async () => {
    await withCli([], { WORKOS_EMULATE_REDIRECT_HOSTS: 'env.example.test, *.env.example.test' }, async (url) => {
      expect((await authorize(url, 'env.example.test')).status).toBe(302);
      expect((await authorize(url, 'sub.env.example.test')).status).toBe(302);
      expect((await authorize(url, 'other.example.test')).status).toBe(400);
    });
  }, 20000);

  it('prefers the flag over the environment', async () => {
    await withCli(
      ['--redirect-hosts', 'flag.example.test'],
      { WORKOS_EMULATE_REDIRECT_HOSTS: 'env.example.test' },
      async (url) => {
        expect((await authorize(url, 'flag.example.test')).status).toBe(302);
        expect((await authorize(url, 'env.example.test')).status).toBe(400);
      },
    );
  }, 20000);

  // An occurrence that contributes nothing left an empty array behind, which is not nullish and
  // so also discarded the environment variable — a flag that configured nothing, twice over.
  it('exits rather than accept a flag that contributes no hosts', async () => {
    const proc = Bun.spawn([process.execPath, CLI, '--port', '0', '--json', '--redirect-hosts', ','], {
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1', WORKOS_EMULATE_REDIRECT_HOSTS: 'env.example.test' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await Bun.readableStreamToText(proc.stderr);
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain('--redirect-hosts requires at least one host');
  }, 20000);

  it('exits with the validation error rather than starting on an unmatchable host', async () => {
    const proc = Bun.spawn([process.execPath, CLI, '--port', '0', '--json', '--redirect-hosts', 'https://'], {
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const stderr = await Bun.readableStreamToText(proc.stderr);
    expect(await proc.exited).toBe(1);
    expect(stderr).toContain('Invalid redirect host');
  }, 20000);
});
