/**
 * Hosted AuthKit applies organization and domain policies once the email is known: an
 * organization that requires SSO takes the sign-in to its IdP. Both settings are seeded, and a
 * seed that sets neither keeps the hosted flow.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createEmulator, type Emulator, type EmulatorSeedConfig } from '../index.js';
import { validateSeedConfig } from './config-validator.js';

const callback = 'http://localhost:3000/callback';

describe('Hosted AuthKit SSO policies', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  /**
   * Acme requires SSO and its domain policy covers acme.test. Globex requires SSO with no domain
   * policy, Initech allows other methods; both verify shared.test. Plain has no connection.
   */
  const seed: EmulatorSeedConfig = {
    users: [
      { email: 'first@elsewhere.test' },
      { email: 'ann@acme.test' },
      { email: 'gus@shared.test' },
      { email: 'ian@shared.test' },
      { email: 'both@shared.test' },
      { email: 'guest@elsewhere.test' },
    ],
    organizations: [
      {
        name: 'Plain',
        memberships: [{ email: 'first@elsewhere.test' }, { email: 'ann@acme.test' }],
      },
      {
        name: 'Acme',
        domains: [{ domain: 'acme.test', state: 'verified' }],
        require_sso: true,
        domain_policy: ['acme.test'],
      },
      {
        name: 'Globex',
        domains: [{ domain: 'shared.test', state: 'verified' }],
        require_sso: true,
        memberships: [{ email: 'gus@shared.test' }, { email: 'both@shared.test' }, { email: 'guest@elsewhere.test' }],
      },
      {
        name: 'Initech',
        domains: [{ domain: 'shared.test', state: 'verified' }],
        memberships: [{ email: 'ian@shared.test' }, { email: 'both@shared.test' }],
      },
    ],
    connections: [
      { name: 'Acme SAML', organization: 'Acme', connection_type: 'GenericSAML' },
      { name: 'Globex SAML', organization: 'Globex', connection_type: 'GenericSAML' },
      { name: 'Initech SAML', organization: 'Initech', connection_type: 'GenericSAML' },
    ],
  };

  async function boot(options: { interactiveAuth?: boolean } = {}) {
    emulator = await createEmulator({ port: 0, seed, ...options });
    const res = await fetch(`${emulator.url}/organizations`, { headers: { Authorization: 'Bearer sk_test_default' } });
    const { data } = (await res.json()) as { data: Array<{ id: string; name: string }> };
    return Object.fromEntries(data.map((o) => [o.name, o.id]));
  }

  /** Start at the hosted endpoint and follow to the callback, reporting the SSO hop if any. */
  async function follow(query: Record<string, string>) {
    const params = new URLSearchParams({
      client_id: 'client_x',
      provider: 'authkit',
      redirect_uri: callback,
      ...query,
    });
    const first = await fetch(`${emulator!.url}/user_management/authorize?${params}`, { redirect: 'manual' });
    expect(first.status).toBe(302);
    const location = first.headers.get('location')!;
    if (!location.startsWith('/sso/authorize?')) return { hop: null, landed: new URL(location) };
    const second = await fetch(`${emulator!.url}${location}`, { redirect: 'manual' });
    expect(second.status).toBe(302);
    return { hop: new URL(location, emulator!.url), landed: new URL(second.headers.get('location')!) };
  }

  async function exchange(code: string, extra: Record<string, string> = {}) {
    const res = await fetch(`${emulator!.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code, client_id: 'client_x', ...extra }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  it('a domain policy that requires SSO wins over the selected organization', async () => {
    const orgs = await boot();
    const { hop, landed } = await follow({
      login_hint: 'ann@acme.test',
      organization_id: orgs.Plain,
      state: 'abc',
      code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
      code_challenge_method: 'S256',
    });
    expect(hop?.searchParams.get('organization')).toBe(orgs.Acme);
    expect(hop?.searchParams.get('client_id')).toBe('client_x');
    expect(hop?.searchParams.get('redirect_uri')).toBe(callback);
    expect(hop?.searchParams.get('state')).toBe('abc');
    expect(hop?.searchParams.get('login_hint')).toBe('ann@acme.test');
    expect(hop?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(landed.searchParams.get('state')).toBe('abc');

    const { status, body } = await exchange(landed.searchParams.get('code')!, {
      code_verifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    });
    expect(status).toBe(200);
    expect(body.authentication_method).toBe('SSO');
    expect(body.organization_id).toBe(orgs.Acme);
    expect(body.user.email).toBe('ann@acme.test');
  });

  it('a domain policy governs an address with no account yet', async () => {
    const orgs = await boot();
    const { hop, landed } = await follow({ login_hint: 'new@acme.test' });
    expect(hop?.searchParams.get('organization')).toBe(orgs.Acme);

    const { body } = await exchange(landed.searchParams.get('code')!);
    expect(body.authentication_method).toBe('SSO');
    expect(body.user.email).toBe('new@acme.test');
  });

  it('pre-selecting an organization that requires SSO sends its member to SSO', async () => {
    const orgs = await boot();
    const { hop, landed } = await follow({ login_hint: 'guest@elsewhere.test', organization_id: orgs.Globex });
    expect(hop?.searchParams.get('organization')).toBe(orgs.Globex);

    const { body } = await exchange(landed.searchParams.get('code')!);
    expect(body.authentication_method).toBe('SSO');
    expect(body.organization_id).toBe(orgs.Globex);
  });

  it('the sole membership among the organizations that verified the domain decides', async () => {
    const orgs = await boot();
    const sso = await follow({ login_hint: 'gus@shared.test' });
    expect(sso.hop?.searchParams.get('organization')).toBe(orgs.Globex);

    // Initech verified the same domain and allows other methods.
    const hosted = await follow({ login_hint: 'ian@shared.test' });
    expect(hosted.hop).toBeNull();
    expect((await exchange(hosted.landed.searchParams.get('code')!)).body.authentication_method).not.toBe('SSO');
  });

  it('stays on the hosted flow when no single organization decides', async () => {
    const orgs = await boot();
    // A member of both organizations that verified the domain.
    expect((await follow({ login_hint: 'both@shared.test' })).hop).toBeNull();
    // A guest of an SSO-only organization who did not select it.
    expect((await follow({ login_hint: 'guest@elsewhere.test' })).hop).toBeNull();
    // Selecting the organization that allows other methods.
    expect((await follow({ login_hint: 'both@shared.test', organization_id: orgs.Initech })).hop).toBeNull();
    // No login_hint: the first user, whom no policy governs.
    expect((await follow({})).hop).toBeNull();
  });

  it('with --interactive, the email page hands a governed address to the SSO login page', async () => {
    const orgs = await boot({ interactiveAuth: true });
    const res = await fetch(`${emulator!.url}/user_management/authorize`, {
      method: 'POST',
      redirect: 'manual',
      body: new URLSearchParams({ client_id: 'client_x', redirect_uri: callback, email: 'ann@acme.test' }),
    });
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location.startsWith('/sso/authorize?')).toBe(true);
    expect(new URLSearchParams(location.split('?')[1]).get('organization')).toBe(orgs.Acme);

    const html = await (await fetch(`${emulator!.url}${location}`)).text();
    expect(html).toContain('SSO Login');
    expect(html).toContain('ann@acme.test');
  });

  it('an organization that requires SSO but holds no connection keeps the hosted flow', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'ann@acme.test' }],
        organizations: [
          {
            name: 'Acme',
            domains: [{ domain: 'acme.test', state: 'verified' }],
            require_sso: true,
            domain_policy: ['acme.test'],
          },
        ],
      },
    });
    expect((await follow({ login_hint: 'ann@acme.test' })).hop).toBeNull();
  });

  it('rejects a domain policy the seed cannot back', () => {
    const { valid, errors } = validateSeedConfig({
      organizations: [
        {
          name: 'Acme',
          domains: [
            { domain: 'acme.test', state: 'verified' },
            { domain: 'pending.test', state: 'pending' },
          ],
          require_sso: 'yes' as unknown as boolean,
          domain_policy: ['ACME.test', 'pending.test', 'other.test'],
        },
        {
          name: 'Rival',
          domains: [{ domain: 'acme.test', state: 'verified' }],
          domain_policy: ['acme.test'],
        },
      ],
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.path)).toEqual([
      'organizations[0].require_sso',
      'organizations[0].domain_policy[1]',
      'organizations[0].domain_policy[2]',
      'organizations[1].domain_policy[0]',
    ]);
  });
});
