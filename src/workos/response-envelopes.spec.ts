/**
 * Envelope conformance: asserts the top-level response body each route assembles
 * matches the OpenAPI spec. The companion to response-shapes.spec.ts, which
 * checks the *resource* inside the envelope.
 *
 * This layer needs its own loop because an envelope has no `object`
 * discriminator for the resource catalog to key on, and because it is built
 * inline in the route handler rather than by a format* helper. That is precisely
 * where an invention slips through: `POST /api_keys/validations` returned
 * `{ valid: boolean }` for several releases while the spec said
 * `{ api_key: ApiKey | null }`, so every SDK reading `response.api_key` saw
 * every key as invalid.
 *
 * Requirements come from src/workos/generated/response-shapes.ts (regenerate
 * with `npm run gen:shapes`); the cases below exercise each operation for real
 * against a running emulator and diff the top-level key set.
 *
 * Two assertions per operation, mirroring the resource loop:
 *   1. forward — every spec-required top-level field is present
 *   2. reverse — no top-level field the spec doesn't define is returned
 *
 * Adding an operation to ENVELOPE_SCHEMA_MAP without adding a case here fails
 * the coverage test, so a catalog entry can't sit unexercised.
 *
 * Scope: response *bodies*, not status codes. Some routes return 200 where the
 * spec says 201 (`/portal/generate_link`, `/widgets/token`); status conformance
 * is a separate axis and this loop only requires a 2xx.
 */
import { describe, it, expect, beforeAll } from 'bun:test';
import { createServer, type ApiKeyMap } from '../core/index.js';
import { workosPlugin, seedFromConfig } from './index.js';
import { getWorkOSStore } from './store.js';
import { RESPONSE_ENVELOPE_REQUIREMENTS } from './generated/response-shapes.js';

const API_KEY = 'sk_test_envelope';
const BASE_URL = 'http://localhost:0';
const apiKeys: ApiKeyMap = { [API_KEY]: { environment: 'test' } };
const headers = { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' };

const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

type App = ReturnType<typeof createServer>['app'];

/** IDs resolved during setup that the request callbacks need. */
interface Fixtures {
  organizationId: string;
  userId: string;
  membershipId: string;
  clientId: string;
  passwordResetToken: string;
  passwordResetId: string;
}

/** Each case names a catalog operation and returns that operation's live response body. */
interface EnvelopeCase {
  operation: string;
  request: (app: App, f: Fixtures) => Response | Promise<Response>;
}

const get = (path: string) => (app: App) => app.request(path, { headers });
const post = (path: string, body?: unknown) => (app: App) =>
  app.request(path, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });

const CASES: readonly EnvelopeCase[] = [
  {
    operation: 'POST /api_keys/validations',
    request: post('/api_keys/validations', { value: API_KEY }),
  },
  {
    operation: 'POST /portal/generate_link',
    request: (app, f) => post('/portal/generate_link', { intent: 'sso', organization: f.organizationId })(app),
  },
  {
    operation: 'POST /widgets/token',
    request: (app, f) =>
      post('/widgets/token', {
        organization_id: f.organizationId,
        user_id: f.userId,
        scopes: ['widgets:users-table:manage'],
      })(app),
  },
  {
    operation: 'POST /user_management/password_reset',
    request: post('/user_management/password_reset', { email: 'alice@acme.com' }),
  },
  {
    operation: 'GET /user_management/password_reset/{id}',
    request: (app, f) => get(`/user_management/password_reset/${f.passwordResetId}`)(app),
  },
  {
    operation: 'POST /user_management/password_reset/confirm',
    request: (app, f) =>
      post('/user_management/password_reset/confirm', {
        token: f.passwordResetToken,
        new_password: 'new-secret-123',
      })(app),
  },
  {
    operation: 'POST /user_management/users/{id}/email_verification/send',
    request: (app, f) => post(`/user_management/users/${f.userId}/email_verification/send`)(app),
  },
  {
    operation: 'POST /authorization/organization_memberships/{organization_membership_id}/check',
    request: (app, f) =>
      post(`/authorization/organization_memberships/${f.membershipId}/check`, { permission: 'posts:read' })(app),
  },
  {
    operation: 'GET /sso/jwks/{clientId}',
    request: (app, f) => get(`/sso/jwks/${f.clientId}`)(app),
  },
  { operation: 'GET /organizations', request: get('/organizations') },
  { operation: 'GET /user_management/users', request: get('/user_management/users') },
  { operation: 'GET /connect/applications', request: get('/connect/applications') },
  { operation: 'GET /webhook_endpoints', request: get('/webhook_endpoints') },
  { operation: 'GET /events', request: get('/events') },
  {
    operation: 'GET /organizations/{organizationId}/api_keys',
    request: (app, f) => get(`/organizations/${f.organizationId}/api_keys`)(app),
  },
  { operation: 'GET /feature-flags', request: get('/feature-flags') },
  {
    operation: 'GET /organizations/{organizationId}/feature-flags',
    request: (app, f) => get(`/organizations/${f.organizationId}/feature-flags`)(app),
  },
  {
    operation: 'GET /user_management/users/{userId}/feature-flags',
    request: (app, f) => get(`/user_management/users/${f.userId}/feature-flags`)(app),
  },
];

/**
 * Spec-defined top-level fields the emulator does not return. Each is a real,
 * tracked gap — closing one forces deleting its entry here, and any *new* gap
 * fails the build.
 */
const KNOWN_MISSING_REQUIRED: Record<string, readonly string[]> = {
  // The emulator returns the `email_verification` resource — including its `code` — so a
  // test harness can complete the flow without an email channel. Production returns
  // `{ user }` and delivers the code out of band, which a local emulator cannot do. This
  // is the same deliberate trade as magic auth; see the SECRET_FIELDS scope note in
  // response-shapes.spec.ts.
  'POST /user_management/users/{id}/email_verification/send': ['user'],
};

/** Top-level fields the emulator returns that the spec envelope does not define. */
const KNOWN_EXTRA_FIELDS: Record<string, readonly string[]> = {
  // Same trade as above: the whole email_verification resource, in place of `{ user }`.
  'POST /user_management/users/{id}/email_verification/send': [
    'object',
    'id',
    'user_id',
    'email',
    'code',
    'expires_at',
    'created_at',
    'updated_at',
  ],
};

describe('response envelope conformance (route bodies vs OpenAPI spec)', () => {
  const bodies = new Map<string, Record<string, unknown>>();

  beforeAll(async () => {
    const server = createServer(workosPlugin, { port: 0, baseUrl: BASE_URL, apiKeys });
    seedFromConfig(server.store, BASE_URL, {
      organizations: [{ name: 'Acme Corp' }],
      users: [{ email: 'alice@acme.com', password: 'secret123' }],
      permissions: [{ slug: 'posts:read', name: 'Read Posts' }],
      roles: [{ slug: 'member', name: 'Member', permissions: ['posts:read'] }],
      // Subscribed to an event this test never triggers, not the catch-all `[]`. Webhook
      // endpoints are seeded before api keys and connect applications, so a catch-all would
      // fire deliveries at a port nothing is listening on — and those in-flight fetches
      // outlive this file and land in whichever suite runs next.
      webhookEndpoints: [{ endpoint_url: 'http://localhost:5005/webhooks', events: ['dsync.activated'] }],
      connectApplications: [{ name: 'Billing', type: 'm2m', organization: 'Acme Corp', client_id: 'client_billing' }],
      apiKeys: [{ name: 'Envelope Key', organization: 'Acme Corp', value: API_KEY, permissions: ['posts:read'] }],
      // On for everyone, so both evaluation routes return a non-empty page for the fixtures.
      featureFlags: [{ slug: 'envelope-flag', name: 'Envelope Flag', default_value: true }],
    });

    const ws = getWorkOSStore(server.store);
    const organizationId = ws.organizations.findOneBy('name', 'Acme Corp')!.id;
    const userId = ws.users.findOneBy('email', 'alice@acme.com')!.id;

    // A membership carrying a role, so the permission check has something to authorize
    // against; and password resets, so confirm resolves a real token and GET-by-id a real record.
    const membershipId = ws.organizationMemberships.insert({
      object: 'organization_membership',
      user_id: userId,
      organization_id: organizationId,
      status: 'active',
      role: { slug: 'member' },
      metadata: {},
      external_id: null,
    }).id;
    const insertPasswordReset = (token: string) =>
      ws.passwordResets.insert({
        object: 'password_reset',
        user_id: userId,
        email: 'alice@acme.com',
        password_reset_token: token,
        password_reset_url: `${BASE_URL}/user_management/password_reset/confirm?token=${token}`,
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    // Two resets: confirm spends the one it is handed, so GET-by-id reads another and the two
    // cases do not depend on the order they run in.
    const passwordResetToken = insertPasswordReset('pw_reset_envelope').password_reset_token;
    const passwordResetId = insertPasswordReset('pw_reset_envelope_get').id;

    const fixtures: Fixtures = {
      organizationId,
      userId,
      membershipId,
      clientId: 'client_billing',
      passwordResetToken,
      passwordResetId,
    };

    for (const { operation, request } of CASES) {
      const res = await request(server.app, fixtures);
      expect(res.status, `${operation} did not return 2xx`).toBeLessThan(300);
      bodies.set(operation, (await res.json()) as Record<string, unknown>);
    }
  });

  it('covers exactly the operations in the generated requirements catalog', () => {
    expect(sorted(CASES.map((c) => c.operation))).toEqual(sorted(Object.keys(RESPONSE_ENVELOPE_REQUIREMENTS)));
  });

  for (const { operation } of CASES) {
    const requirement = RESPONSE_ENVELOPE_REQUIREMENTS[operation];

    describe(operation, () => {
      it('returns every spec-required top-level field (modulo tracked gaps)', () => {
        const keys = Object.keys(bodies.get(operation) ?? {});
        const missing = sorted(requirement.required.filter((field) => !keys.includes(field)));
        expect(missing).toEqual(sorted(KNOWN_MISSING_REQUIRED[operation] ?? []));
      });

      it('returns no top-level field absent from the spec envelope (modulo tracked extras)', () => {
        const props = new Set(requirement.properties);
        const extra = sorted(Object.keys(bodies.get(operation) ?? {}).filter((key) => !props.has(key)));
        expect(extra).toEqual(sorted(KNOWN_EXTRA_FIELDS[operation] ?? []));
      });
    });
  }

  it('exercises every list operation against a non-empty page', () => {
    // Guards the loop above: an empty `data` array would let both field assertions pass
    // without the route having actually formatted a resource.
    const lists = CASES.filter(({ operation }) =>
      RESPONSE_ENVELOPE_REQUIREMENTS[operation].properties.includes('data'),
    );
    expect(lists.length).toBeGreaterThan(0);
    for (const { operation } of lists) {
      const data = (bodies.get(operation) as { data: unknown[] }).data;
      expect(data.length, `${operation} returned an empty page`).toBeGreaterThan(0);
    }
  });

  it('validates an api key that resolves to a resource', () => {
    // An `api_key: null` body would satisfy the field assertions vacuously.
    expect((bodies.get('POST /api_keys/validations') as { api_key: unknown }).api_key).not.toBeNull();
  });
});
