/**
 * Linked OAuth identities. Nothing used to write to the identities collection, so
 * `GET /user_management/users/{id}/identities` answered every user, in every state, with an
 * empty list — and a JWT template could only ever see the provider→null map. See #66.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createEmulator, type Emulator } from '../index.js';

describe('User identities', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

  const identitiesOf = async (userId: string) =>
    (await (
      await fetch(`${emulator!.url}/user_management/users/${userId}/identities`, {
        headers: auth(emulator!.apiKey),
      })
    ).json()) as any;

  const firstUser = async () =>
    ((await (await fetch(`${emulator!.url}/user_management/users`, { headers: auth(emulator!.apiKey) })).json()) as any)
      .data[0];

  /** Walk /sso/authorize → /sso/token for `email` through the seeded connection. */
  async function ssoLogin(email: string) {
    const authorize = await fetch(
      `${emulator!.url}/sso/authorize?redirect_uri=http://localhost:3000/callback&domain_hint=acme.test&login_hint=${encodeURIComponent(email)}`,
      { redirect: 'manual' },
    );
    const code = new URL(authorize.headers.get('location')!).searchParams.get('code');
    const token = await fetch(`${emulator!.url}/sso/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    return (await token.json()) as any;
  }

  it('reports the identity a seeded oauth_provider stands for, in the spec shape', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [
          { id: 'user_sso', email: 'sso@acme.test', oauth_provider: 'GoogleOAuth', oauth_idp_id: 'idp_user_123' },
          { id: 'user_plain', email: 'plain@acme.test' },
        ],
      },
    });

    // A bare array of {idp_id, type, provider} — not a list envelope, and no entity fields.
    expect(await identitiesOf('user_sso')).toEqual([
      { idp_id: 'idp_user_123', type: 'OAuth', provider: 'GoogleOAuth' },
    ]);
    // A user told nothing about a provider still has no identity: nothing is invented.
    expect(await identitiesOf('user_plain')).toEqual([]);
  });

  it('links an identity when a login completes through an OAuth connection', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ id: 'user_fed', email: 'fed@acme.test' }],
        organizations: [{ name: 'Acme', domains: [{ domain: 'acme.test', state: 'verified' }] }],
        connections: [
          {
            name: 'Acme SSO',
            organization: 'Acme',
            connection_type: 'GoogleOAuth',
            domains: ['acme.test'],
            profiles: [{ email: 'fed@acme.test', idp_id: 'idp_google_9' }],
          },
        ],
      },
    });

    expect(await identitiesOf('user_fed')).toEqual([]);

    await ssoLogin('fed@acme.test');
    expect(await identitiesOf('user_fed')).toEqual([
      { idp_id: 'idp_google_9', type: 'OAuth', provider: 'GoogleOAuth' },
    ]);

    // A second login through the same provider is the same link, not another one.
    await ssoLogin('fed@acme.test');
    expect(await identitiesOf('user_fed')).toHaveLength(1);
  });

  it('links nothing for a SAML connection, which is not an OAuth identity', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ id: 'user_saml', email: 'saml@acme.test' }],
        organizations: [{ name: 'Acme', domains: [{ domain: 'acme.test', state: 'verified' }] }],
        connections: [
          {
            name: 'Acme SAML',
            organization: 'Acme',
            connection_type: 'OktaSAML',
            domains: ['acme.test'],
            profiles: [{ email: 'saml@acme.test' }],
          },
        ],
      },
    });

    const profile = await ssoLogin('saml@acme.test');
    expect(profile.profile.idp_id).toBeString();
    expect(await identitiesOf('user_saml')).toEqual([]);
  });

  it('lets a JWT template read a linked identity', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [
          {
            email: 'claims@acme.test',
            password: 'test123',
            email_verified: true,
            oauth_provider: 'GoogleOAuth',
            oauth_idp_id: 'idp_user_123',
          },
        ],
        jwtTemplate: {
          content:
            '{"urn:myapp:google": "{{ user.identities.GoogleOAuth }}", "urn:myapp:apple": {{ user.identities.AppleOAuth }}}',
        },
      },
    });

    const res = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'password', email: 'claims@acme.test', password: 'test123' }),
    });
    const { access_token } = (await res.json()) as any;
    const claims = JSON.parse(Buffer.from(access_token.split('.')[1], 'base64url').toString('utf-8'));

    expect(claims['urn:myapp:google']).toBe('idp_user_123');
    // Unlinked providers stay null, so a template can tell "not linked" from a linked id.
    expect(claims['urn:myapp:apple']).toBeUndefined();

    // The endpoint and the template agree about what is linked.
    const user = await firstUser();
    expect(await identitiesOf(user.id)).toEqual([{ idp_id: 'idp_user_123', type: 'OAuth', provider: 'GoogleOAuth' }]);
  });
});
