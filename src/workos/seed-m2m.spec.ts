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
    const listRes = await fetch(`${emulator.url}/organizations/org/api_keys`, { headers: auth('sk_test_ci') });
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
