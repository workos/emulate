/**
 * A configured JWT template has to reach the token. The emulator previously stored a
 * template and returned it from the API while signing tokens that never carried its
 * claims, so these tests assert on the decoded token rather than on the stored template.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { createEmulator, type Emulator } from '../index.js';
import { getWorkOSStore } from './store.js';
import { buildJwtTemplateContext } from './jwt-template.js';

describe('JWT templates end to end', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  const seed = {
    users: [{ email: 'alice@acme.com', first_name: 'Alice', last_name: 'Smith', password: 'test123' }],
    organizations: [
      {
        name: 'Acme Corp',
        metadata: { tenant_id: 'tenant_123' },
        memberships: [{ email: 'alice@acme.com', role: 'admin', status: 'active' as const }],
      },
    ],
    roles: [{ slug: 'admin', name: 'Admin', permissions: ['posts:write'] }],
    permissions: [{ slug: 'posts:write', name: 'Write Posts' }],
  };

  const decode = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8')) as Record<string, unknown>;

  const login = async (url: string) => {
    const res = await fetch(`${url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        email: 'alice@acme.com',
        password: 'test123',
        client_id: 'client_test',
        client_secret: 'sk_test_default',
      }),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  it('mints seeded template claims into the access token', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        ...seed,
        jwtTemplate: {
          content:
            '{"urn:myapp:name": "{{ user.first_name }} {{ user.last_name }}", "urn:myapp:tenant": "{{ organization.metadata.tenant_id }}", "urn:myapp:verified": {{ user.email_verified }}}',
        },
      },
    });

    const { status, body } = await login(emulator.url);
    expect(status).toBe(200);

    const claims = decode(body.access_token);
    expect(claims['urn:myapp:name']).toBe('Alice Smith');
    expect(claims['urn:myapp:tenant']).toBe('tenant_123');
    expect(claims['urn:myapp:verified']).toBe(false);
    // The claims the emulator resolves are still there.
    expect(claims.sub).toBeString();
    expect(claims.role).toBe('admin');
    expect(claims.permissions).toEqual(['posts:write']);
  });

  it('applies a template set over the API, with no restart', async () => {
    emulator = await createEmulator({ port: 0, seed });

    const put = await fetch(`${emulator.url}/user_management/jwt_template`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${emulator.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '{"urn:myapp:email": "{{ user.email }}"}' }),
    });
    expect(put.status).toBe(200);

    const { body } = await login(emulator.url);
    expect(decode(body.access_token)['urn:myapp:email']).toBe('alice@acme.com');
  });

  it('carries template claims through a refresh', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: { ...seed, jwtTemplate: { content: '{"urn:myapp:email": "{{ user.email }}"}' } },
    });

    const { body } = await login(emulator.url);
    const res = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
        client_id: 'client_test',
        client_secret: 'sk_test_default',
      }),
    });
    expect(res.status).toBe(200);
    const refreshed = (await res.json()) as any;
    expect(decode(refreshed.access_token)['urn:myapp:email']).toBe('alice@acme.com');
  });

  it('lets a template override a resolved claim', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: { ...seed, jwtTemplate: { content: '{"role": "{{ organization_membership.role }}-scoped"}' } },
    });

    const { body } = await login(emulator.url);
    expect(decode(body.access_token).role).toBe('admin-scoped');
  });

  it('fails the boot when a seeded template is invalid', async () => {
    await expect(
      createEmulator({ port: 0, seed: { ...seed, jwtTemplate: { content: '{"sub": "{{ user.id }}"}' } } }),
    ).rejects.toThrow('reserved claims: sub');
  });

  it('fails the sign-in loudly when a template cannot render', async () => {
    emulator = await createEmulator({
      port: 0,
      // Valid against the probe values, but renders past the byte limit for this user.
      seed: {
        ...seed,
        users: [{ email: 'alice@acme.com', first_name: 'x'.repeat(4000), password: 'test123' }],
        jwtTemplate: { content: '{"urn:myapp:name": "{{ user.first_name }}"}' },
      },
    });

    const { status, body } = await login(emulator.url);
    expect(status).toBe(422);
    expect(body.message).toContain('over the 3072-byte limit');
  });

  // The 422 must arrive before any session state is written. Rendering after the session insert
  // left an orphaned session — plus a bumped last_sign_in_at and the webhooks that go with them —
  // for a sign-in that never returned a token.
  it('persists nothing when a template cannot render', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        ...seed,
        users: [{ email: 'alice@acme.com', first_name: 'x'.repeat(4000), password: 'test123' }],
        jwtTemplate: { content: '{"urn:myapp:name": "{{ user.first_name }}"}' },
      },
    });

    const ws = getWorkOSStore(emulator.store);
    expect(await login(emulator.url).then((r) => r.status)).toBe(422);

    expect(ws.sessions.all()).toHaveLength(0);
    expect(ws.refreshTokens.all()).toHaveLength(0);
    expect(ws.users.findOneBy('email', 'alice@acme.com')?.last_sign_in_at).toBeNull();
  });

  it('renders the full organization_domain in template claims', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        ...seed,
        organizations: [
          {
            name: 'Acme Corp',
            domains: [{ domain: 'acme.com', state: 'verified' as const }],
            memberships: [{ email: 'alice@acme.com', role: 'admin', status: 'active' as const }],
          },
        ],
        jwtTemplate: {
          content: '{"urn:example:domains": {{ organization.domains }}}',
        },
      },
    });

    const { status, body } = await login(emulator.url);
    expect(status).toBe(200);

    const claims = decode(body.access_token);
    const domains = claims['urn:example:domains'] as Array<Record<string, unknown>>;
    expect(domains).toHaveLength(1);
    expect(domains[0].object).toBe('organization_domain');
    expect(domains[0].organization_id).toBeString();
    expect(domains[0].domain).toBe('acme.com');
    expect(domains[0].state).toBe('verified');
    expect(domains[0].verification_strategy).toBe('manual');
    expect(domains[0].created_at).toBeString();
    expect(domains[0].updated_at).toBeString();
    // verification_token/verification_prefix must not leak into the claim.
    const flat = JSON.stringify(domains);
    expect(flat).not.toContain('verification_token');
    expect(flat).not.toContain('verification_prefix');
  });

  it('signs nothing extra when no template is configured', async () => {
    emulator = await createEmulator({ port: 0, seed });
    const { body } = await login(emulator.url);
    expect(Object.keys(decode(body.access_token)).sort()).toEqual([
      'aud',
      'auth_time',
      'client_id',
      'exp',
      'iat',
      'iss',
      'jti',
      'org_id',
      'permissions',
      'role',
      'roles',
      'sid',
      'sub',
    ]);
  });

  // The context objects must mirror the production WorkOS JWT template context shapes,
  // which were measured by minting real tokens against api.workos.com.
  describe('buildJwtTemplateContext mirrors production shapes', () => {
    it('builds the user context with all prod fields and no last_sign_in_at', async () => {
      emulator = await createEmulator({ port: 0, seed });
      const ws = getWorkOSStore(emulator.store);
      const user = ws.users.findOneBy('email', 'alice@acme.com')!;

      const ctx = buildJwtTemplateContext(ws, user, null);
      const u = ctx.user!;

      expect(u.object).toBe('user');
      expect(u.id).toBeString();
      expect(u.email).toBe('alice@acme.com');
      expect(u.first_name).toBe('Alice');
      expect(u.last_name).toBe('Smith');
      expect(u.email_verified).toBe(false);
      expect(u.profile_picture_url).toBeNull();
      expect(u.created_at).toBeString();
      expect(u.updated_at).toBeString();
      expect(u.metadata).toEqual({});
      expect(u.external_id).toBeNull();
      expect(u.locale).toBeNull();
      expect(u.last_sign_in_at).toBeUndefined();
      expect(u.password_hash).toBeUndefined();
      expect(u.impersonator).toBeUndefined();
      expect(u.oauth_provider).toBeUndefined();

      const identities = u.identities as Record<string, null>;
      expect(identities).toEqual({
        AppleOAuth: null,
        GitHubOAuth: null,
        GoogleOAuth: null,
        GrokOAuth: null,
        IntuitOAuth: null,
        LinkedInOAuth: null,
        MicrosoftOAuth: null,
        VercelMarketplaceOAuth: null,
        VercelOAuth: null,
        SalesforceOAuth: null,
      });
    });

    it('builds the organization context with prod fields and no null stripe_customer_id', async () => {
      emulator = await createEmulator({
        port: 0,
        seed: {
          ...seed,
          organizations: [
            {
              name: 'Acme Corp',
              domains: [{ domain: 'acme.com', state: 'verified' as const }],
              memberships: [{ email: 'alice@acme.com', role: 'admin', status: 'active' as const }],
            },
          ],
        },
      });
      const ws = getWorkOSStore(emulator.store);
      const user = ws.users.findOneBy('email', 'alice@acme.com')!;
      const org = ws.organizations.findOneBy('name', 'Acme Corp')!;

      const ctx = buildJwtTemplateContext(ws, user, org.id);
      const o = ctx.organization!;

      expect(o.object).toBe('organization');
      expect(o.id).toBe(org.id);
      expect(o.name).toBe('Acme Corp');
      expect(o.allow_profiles_outside_organization).toBe(false);
      expect(o.created_at).toBeString();
      expect(o.updated_at).toBeString();
      expect(o.metadata).toEqual({});
      expect(o.external_id).toBeNull();
      // stripe_customer_id is omitted when null (prod drops it).
      expect(o.stripe_customer_id).toBeUndefined();

      const domains = o.domains as Array<Record<string, unknown>>;
      expect(domains).toHaveLength(1);
      const d = domains[0];
      expect(Object.keys(d).sort()).toEqual(
        [
          'object',
          'id',
          'organization_id',
          'domain',
          'state',
          'verification_strategy',
          'created_at',
          'updated_at',
        ].sort(),
      );
      expect(d.verification_token).toBeUndefined();
      expect(d.verification_prefix).toBeUndefined();
    });

    it('builds the membership context with prod-only fields', async () => {
      emulator = await createEmulator({ port: 0, seed });
      const ws = getWorkOSStore(emulator.store);
      const user = ws.users.findOneBy('email', 'alice@acme.com')!;
      const org = ws.organizations.findOneBy('name', 'Acme Corp')!;

      const ctx = buildJwtTemplateContext(ws, user, org.id);
      const m = ctx.organization_membership!;

      expect(m.object).toBe('organization_membership');
      expect(m.id).toBeString();
      expect(m.role).toBe('admin');
      expect(m.roles).toEqual(['admin']);
      expect(m.created_at).toBeString();
      expect(m.updated_at).toBeString();
      expect(m.custom_attributes).toEqual({});
      // Prod omits these from the context (they are on the API response but not the context).
      expect(m.external_id).toBeUndefined();
      expect(m.metadata).toBeUndefined();
      expect(m.organization_id).toBeUndefined();
      expect(m.user_id).toBeUndefined();
      expect(m.status).toBeUndefined();
    });
  });
});

describe('Pinned signing key and issuer', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

  const jwks = async (url: string) => (await fetch(`${url}/sso/jwks/client_test`)).json() as Promise<any>;

  it('publishes a JWKS that survives a restart', async () => {
    emulator = await createEmulator({ port: 0, signingKey: { privateKey: pem } });
    const first = await jwks(emulator.url);
    await emulator.close();

    emulator = await createEmulator({ port: 0, signingKey: { privateKey: pem } });
    expect(await jwks(emulator.url)).toEqual(first);
  });

  it('publishes a different JWKS on restart without a pinned key', async () => {
    emulator = await createEmulator({ port: 0 });
    const first = await jwks(emulator.url);
    await emulator.close();

    emulator = await createEmulator({ port: 0 });
    expect((await jwks(emulator.url)).keys[0].n).not.toBe(first.keys[0].n);
  });

  it('advertises a pinned kid', async () => {
    emulator = await createEmulator({ port: 0, signingKey: { privateKey: pem, kid: 'ci_key' } });
    expect((await jwks(emulator.url)).keys[0].kid).toBe('ci_key');
  });

  it('mints a pinned issuer instead of the emulator URL', async () => {
    emulator = await createEmulator({
      port: 0,
      issuer: 'https://api.workos.com',
      seed: { users: [{ email: 'alice@acme.com', password: 'test123' }] },
    });

    const res = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        email: 'alice@acme.com',
        password: 'test123',
        client_id: 'client_test',
        client_secret: 'sk_test_default',
      }),
    });
    const body = (await res.json()) as any;
    const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url').toString('utf-8'));
    expect(claims.iss).toBe('https://api.workos.com');
  });

  it('defaults the issuer to the emulator URL', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: { users: [{ email: 'alice@acme.com', password: 'test123' }] },
    });

    const res = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        email: 'alice@acme.com',
        password: 'test123',
        client_id: 'client_test',
        client_secret: 'sk_test_default',
      }),
    });
    const body = (await res.json()) as any;
    const claims = JSON.parse(Buffer.from(body.access_token.split('.')[1], 'base64url').toString('utf-8'));
    expect(claims.iss).toBe(emulator.url);
  });
});
