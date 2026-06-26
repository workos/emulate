/**
 * Seeding M2M Connect Applications and API key resources, over real HTTP via
 * createEmulator(). Covers the issue #7 use case: declare an M2M app (with a
 * pinned client_id/secret) and API keys in seed config so a dockerized local
 * dev environment has usable credentials on startup.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createEmulator, type Emulator } from '../index.js';
import { validateSeedConfig } from './config-validator.js';

describe('Seeding M2M applications and API keys', () => {
  let emulator: Emulator | undefined;

  afterEach(async () => {
    await emulator?.close();
    emulator = undefined;
  });

  const auth = (apiKey: string) => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' });

  /** Resolve the first seeded organization's id, authenticating with the given key. */
  const firstOrgId = async (apiKey: string) => {
    const res = await fetch(`${emulator!.url}/organizations`, { headers: auth(apiKey) });
    return ((await res.json()) as any).data[0].id as string;
  };

  it('seeds an m2m connect application with a pinned client_id', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        connectApplications: [
          {
            name: 'Backend Service',
            type: 'm2m',
            organization: 'Acme Corp',
            scopes: ['posts:read', 'posts:write'],
            client_id: 'client_seeded_m2m',
            client_secret: 'secret_seeded_value',
          },
        ],
      },
    });

    const res = await fetch(`${emulator.url}/connect/applications`, { headers: auth(emulator.apiKey) });
    expect(res.status).toBe(200);
    const list = (await res.json()) as any;
    expect(list.data).toHaveLength(1);

    const app = list.data[0];
    expect(app.object).toBe('connect_application');
    expect(app.application_type).toBe('m2m');
    expect(app.name).toBe('Backend Service');
    expect(app.client_id).toBe('client_seeded_m2m');
    expect(app.scopes).toEqual(['posts:read', 'posts:write']);
    expect(app.organization_id).toMatch(/^org_/);
    // The m2m shape omits oauth-only fields.
    expect(app.redirect_uris).toBeUndefined();
  });

  it('defaults connectApplications type to m2m and generates a client_id', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        connectApplications: [{ name: 'Default Type App', organization: 'Acme Corp' }],
      },
    });

    const res = await fetch(`${emulator.url}/connect/applications`, { headers: auth(emulator.apiKey) });
    const list = (await res.json()) as any;
    expect(list.data[0].application_type).toBe('m2m');
    expect(list.data[0].client_id).toMatch(/^client_/);
  });

  it('seeds API key resources that authenticate requests', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        apiKeys: [{ name: 'CI Key', organization: 'Acme Corp', value: 'sk_test_ci', permissions: ['posts:read'] }],
      },
    });

    // The seeded value is registered in the auth allow-list, so it authenticates.
    const validateRes = await fetch(`${emulator.url}/api_keys/validations`, {
      method: 'POST',
      headers: auth('sk_test_ci'),
      body: JSON.stringify({ key: 'sk_test_ci' }),
    });
    expect(validateRes.status).toBe(200);
    expect(((await validateRes.json()) as any).valid).toBe(true);

    // And it appears as a spec-aligned api_key resource.
    const oid = await firstOrgId('sk_test_ci');
    const listRes = await fetch(`${emulator.url}/organizations/${oid}/api_keys`, { headers: auth('sk_test_ci') });
    const list = (await listRes.json()) as any;
    const key = list.data.find((k: any) => k.name === 'CI Key');
    expect(key).toBeDefined();
    expect(key.owner.type).toBe('organization');
    expect(key.owner.id).toMatch(/^org_/);
    expect(key.permissions).toEqual(['posts:read']);
    expect(key.obfuscated_value).toBe('sk_...t_ci');
    // The raw secret is never serialized.
    expect(key.key).toBeUndefined();
  });

  it('still honors the legacy apiKeys map (auth allow-list) form', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: { apiKeys: { sk_test_legacy: { environment: 'test' } } },
    });

    expect(emulator.apiKey).toBe('sk_test_legacy');
    const res = await fetch(`${emulator.url}/connect/applications`, { headers: auth('sk_test_legacy') });
    expect(res.status).toBe(200);
  });

  it('scopes the organization api_keys listing to the path organization', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Org A' }, { name: 'Org B' }],
        apiKeys: [
          { name: 'A Key', organization: 'Org A', value: 'sk_test_a' },
          { name: 'B Key', organization: 'Org B', value: 'sk_test_b' },
        ],
      },
    });

    const orgs = (await (await fetch(`${emulator.url}/organizations`, { headers: auth('sk_test_a') })).json()) as any;
    const orgA = orgs.data.find((o: any) => o.name === 'Org A');

    const listRes = await fetch(`${emulator.url}/organizations/${orgA.id}/api_keys`, { headers: auth('sk_test_a') });
    const list = (await listRes.json()) as any;
    const names = list.data.map((k: any) => k.name);
    expect(names).toContain('A Key');
    expect(names).not.toContain('B Key');
  });

  it('does not leave the well-known default key authorized when array-form keys are seeded', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        apiKeys: [{ name: 'Only Key', organization: 'Acme Corp', value: 'sk_test_only' }],
      },
    });

    // The seeded key is the primary, not sk_test_default.
    expect(emulator.apiKey).toBe('sk_test_only');
    // The well-known default does not authenticate.
    expect((await fetch(`${emulator.url}/connect/applications`, { headers: auth('sk_test_default') })).status).toBe(
      401,
    );
    // The seeded key does.
    expect((await fetch(`${emulator.url}/connect/applications`, { headers: auth('sk_test_only') })).status).toBe(200);
  });

  it('throws when a seeded m2m application references an unknown organization', async () => {
    await expect(
      createEmulator({
        port: 0,
        seed: {
          organizations: [{ name: 'Acme Corp' }],
          connectApplications: [{ name: 'Typo Svc', type: 'm2m', organization: 'Acme Crop' }],
        },
      }),
    ).rejects.toThrow(/organization not found/i);
  });

  it('throws when a seeded api key references an unknown organization', async () => {
    await expect(
      createEmulator({
        port: 0,
        seed: {
          organizations: [{ name: 'Acme Corp' }],
          apiKeys: [{ name: 'Bad Key', organization: 'Acme Crop', value: 'sk_test_bad' }],
        },
      }),
    ).rejects.toThrow(/organization not found/i);
  });

  it('creates an expired seeded api key as a resource but does not let it authenticate', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        apiKeys: [
          {
            name: 'Expired Key',
            organization: 'Acme Corp',
            value: 'sk_test_expired',
            expires_at: '2000-01-01T00:00:00.000Z',
          },
          { name: 'Live Key', organization: 'Acme Corp', value: 'sk_test_live2' },
        ],
      },
    });

    // The expired key is rejected by the auth middleware...
    const protectedRes = await fetch(`${emulator.url}/connect/applications`, { headers: auth('sk_test_expired') });
    expect(protectedRes.status).toBe(401);

    // ...and reported invalid, even though its resource still exists.
    const validateRes = await fetch(`${emulator.url}/api_keys/validations`, {
      method: 'POST',
      headers: auth('sk_test_live2'),
      body: JSON.stringify({ key: 'sk_test_expired' }),
    });
    expect(((await validateRes.json()) as any).valid).toBe(false);

    const oid = await firstOrgId('sk_test_live2');
    const listRes = await fetch(`${emulator.url}/organizations/${oid}/api_keys`, { headers: auth('sk_test_live2') });
    const list = (await listRes.json()) as any;
    expect(list.data.find((k: any) => k.name === 'Expired Key')).toBeDefined();
  });

  it('stops authenticating a seeded api key after it is deleted', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        apiKeys: [{ name: 'Doomed Key', organization: 'Acme Corp', value: 'sk_test_doomed' }],
      },
    });

    // It authenticates before deletion.
    expect((await fetch(`${emulator.url}/connect/applications`, { headers: auth('sk_test_doomed') })).status).toBe(200);

    const oid = await firstOrgId('sk_test_doomed');
    const listRes = await fetch(`${emulator.url}/organizations/${oid}/api_keys`, { headers: auth('sk_test_doomed') });
    const record = ((await listRes.json()) as any).data.find((k: any) => k.name === 'Doomed Key');
    const delRes = await fetch(`${emulator.url}/api_keys/${record.id}`, {
      method: 'DELETE',
      headers: auth('sk_test_doomed'),
    });
    expect(delRes.status).toBe(204);

    // After deletion the value no longer authenticates.
    expect((await fetch(`${emulator.url}/connect/applications`, { headers: auth('sk_test_doomed') })).status).toBe(401);
  });

  it('keeps array-form keys authenticating, and in sync with validations, after reset()', async () => {
    emulator = await createEmulator({
      port: 0,
      seed: {
        organizations: [{ name: 'Acme Corp' }],
        apiKeys: [{ name: 'CI Key', organization: 'Acme Corp', value: 'sk_test_reset' }],
      },
    });
    expect((await fetch(`${emulator.url}/connect/applications`, { headers: auth('sk_test_reset') })).status).toBe(200);

    emulator.reset();

    // Real-request auth still works (middleware reads the same map that was re-seeded)...
    expect((await fetch(`${emulator.url}/connect/applications`, { headers: auth('sk_test_reset') })).status).toBe(200);
    // ...and validations agrees — no split between the two maps.
    const validateRes = await fetch(`${emulator.url}/api_keys/validations`, {
      method: 'POST',
      headers: auth('sk_test_reset'),
      body: JSON.stringify({ key: 'sk_test_reset' }),
    });
    expect(((await validateRes.json()) as any).valid).toBe(true);
  });
});

describe('Seed config validation for M2M apps and API keys', () => {
  const findError = (config: Parameters<typeof validateSeedConfig>[0], pathFragment: string) => {
    const { valid, errors } = validateSeedConfig(config);
    expect(valid).toBe(false);
    return errors.find((e) => e.path.includes(pathFragment));
  };

  it('rejects an m2m application without an organization', () => {
    expect(
      findError({ connectApplications: [{ name: 'No Org' }] }, 'connectApplications[0].organization'),
    ).toBeDefined();
  });

  it('rejects an unknown connect application type', () => {
    expect(
      findError(
        { connectApplications: [{ name: 'Bad', type: 'saml' as never, organization: 'Acme' }] },
        'connectApplications[0].type',
      ),
    ).toBeDefined();
  });

  it('rejects an api key with neither organization nor user_id', () => {
    expect(findError({ apiKeys: [{ name: 'Orphan' }] }, 'apiKeys[0].organization')).toBeDefined();
  });

  it('rejects an api key value that does not start with sk_', () => {
    expect(
      findError({ apiKeys: [{ name: 'Bad', organization: 'Acme', value: 'nope' }] }, 'apiKeys[0].value'),
    ).toBeDefined();
  });

  it('accepts a valid m2m application and api key', () => {
    const result = validateSeedConfig({
      organizations: [{ name: 'Acme' }],
      connectApplications: [{ name: 'Svc', organization: 'Acme', scopes: ['posts:read'] }],
      apiKeys: [{ name: 'Key', organization: 'Acme', value: 'sk_test_ok' }],
    });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('does not validate the legacy apiKeys map form as resources', () => {
    const result = validateSeedConfig({ apiKeys: { sk_test_x: { environment: 'test' } } });
    expect(result.valid).toBe(true);
  });
});
