/**
 * A configured JWT template has to reach the token. The emulator previously stored a
 * template and returned it from the API while signing tokens that never carried its
 * claims, so these tests assert on the decoded token rather than on the stored template.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { createEmulator, type Emulator } from '../index.js';

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

  it('signs nothing extra when no template is configured', async () => {
    emulator = await createEmulator({ port: 0, seed });
    const { body } = await login(emulator.url);
    expect(Object.keys(decode(body.access_token)).sort()).toEqual([
      'aud',
      'exp',
      'iat',
      'iss',
      'org_id',
      'permissions',
      'role',
      'roles',
      'sid',
      'sub',
    ]);
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
