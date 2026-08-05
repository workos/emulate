/**
 * Seeding organization entitlements. The slugs land in the `entitlements` claim of access
 * tokens scoped to that organization — the only surface exposing them, since the spec's
 * organization shape has no such field.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { createEmulator, type Emulator } from '../index.js';
import { validateSeedConfig } from './config-validator.js';

describe('Seeding organization entitlements', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  const decode = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8')) as Record<string, unknown>;

  it('mints seeded entitlements into org-scoped access tokens', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        users: [{ email: 'alice@acme.com', password: 'test123', email_verified: true }],
        organizations: [
          {
            name: 'Acme Corp',
            entitlements: ['audit-logs', 'sso'],
            memberships: [{ email: 'alice@acme.com' }],
          },
        ],
      },
    });

    const res = await fetch(`${emulator.url}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'password',
        email: 'alice@acme.com',
        password: 'test123',
        client_id: 'client_test',
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };
    expect(decode(body.access_token).entitlements).toEqual(['audit-logs', 'sso']);
  });

  it('rejects entitlements that are not an array of strings', () => {
    const { valid, errors } = validateSeedConfig({
      organizations: [{ name: 'Acme', entitlements: 'sso' as unknown as string[] }],
    });
    expect(valid).toBe(false);
    expect(errors.find((e) => e.path === 'organizations[0].entitlements')).toBeDefined();
  });
});
