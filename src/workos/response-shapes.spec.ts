/**
 * Response shape conformance: asserts the hand-written `format*` helpers produce
 * objects whose field sets match the OpenAPI spec — the contract customers see
 * on the wire. The spec requirements come from src/workos/generated/
 * response-shapes.ts (regenerate with `npm run gen:shapes`); this test pins the
 * emulator's actual output against them.
 *
 * Three assertions per resource:
 *   1. forward  — every spec-required field is present (modulo tracked gaps)
 *   2. reverse  — no field the spec doesn't define is returned (modulo tracked
 *                 extras); this is the guard that catches leaked internals
 *   3. leak     — no known secret field is ever returned, unconditionally
 *
 * Divergences are not swept under the rug: they live in the ledgers below as
 * exact sets. Closing a divergence (emit the field) forces deleting its ledger
 * entry, and any *new* divergence fails the build — drift can't accrue silently.
 */
import { describe, it, expect } from 'vitest';
import { Store } from '../core/index.js';
import { getWorkOSStore } from './store.js';
import {
  formatUser,
  formatOrganization,
  formatConnection,
  formatDirectory,
  formatDirectoryGroup,
  formatDirectoryUser,
  formatRole,
  formatPermission,
} from './helpers.js';
import { RESPONSE_SHAPE_REQUIREMENTS } from './generated/response-shapes.js';
import type {
  WorkOSUser,
  WorkOSOrganization,
  WorkOSConnection,
  WorkOSDirectory,
  WorkOSDirectoryGroup,
  WorkOSDirectoryUser,
  WorkOSRole,
  WorkOSPermission,
} from './entities.js';

const TS = '2026-01-01T00:00:00.000Z';
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

// Representative entities. Internal/secret fields (e.g. password_hash) are
// populated on purpose so the leak guard actually has something to catch.
const user: WorkOSUser = {
  id: 'user_01',
  object: 'user',
  email: 'alice@example.com',
  first_name: 'Alice',
  last_name: 'Smith',
  email_verified: true,
  profile_picture_url: null,
  last_sign_in_at: null,
  external_id: null,
  metadata: {},
  locale: null,
  password_hash: 'sha256-deadbeef',
  impersonator: null,
  created_at: TS,
  updated_at: TS,
};

const organization: WorkOSOrganization = {
  id: 'org_01',
  object: 'organization',
  name: 'Acme',
  external_id: null,
  metadata: {},
  stripe_customer_id: null,
  created_at: TS,
  updated_at: TS,
};

const connection: WorkOSConnection = {
  id: 'conn_01',
  object: 'connection',
  organization_id: 'org_01',
  connection_type: 'GenericSAML',
  name: 'Acme SSO',
  state: 'active',
  domains: [],
  created_at: TS,
  updated_at: TS,
};

const directory: WorkOSDirectory = {
  id: 'directory_01',
  object: 'directory',
  name: 'Acme Directory',
  organization_id: 'org_01',
  domain: 'acme.com',
  type: 'okta scim v2.0',
  state: 'linked',
  external_key: 'ext_abc',
  created_at: TS,
  updated_at: TS,
};

const directoryGroup: WorkOSDirectoryGroup = {
  id: 'directory_grp_01',
  object: 'directory_group',
  directory_id: 'directory_01',
  organization_id: 'org_01',
  idp_id: 'idp_grp_1',
  name: 'Admins',
  raw_attributes: {},
  created_at: TS,
  updated_at: TS,
};

const directoryUser: WorkOSDirectoryUser = {
  id: 'directory_user_01',
  object: 'directory_user',
  directory_id: 'directory_01',
  organization_id: 'org_01',
  idp_id: 'idp_usr_1',
  first_name: 'Bob',
  last_name: 'Jones',
  email: 'bob@acme.com',
  username: 'bjones',
  state: 'active',
  role: { slug: 'member' },
  custom_attributes: {},
  raw_attributes: {},
  groups: [],
  created_at: TS,
  updated_at: TS,
};

const role: WorkOSRole = {
  id: 'role_01',
  object: 'role',
  slug: 'admin',
  name: 'Admin',
  description: null,
  type: 'EnvironmentRole',
  organization_id: null,
  is_default_role: false,
  priority: 0,
  created_at: TS,
  updated_at: TS,
};

const permission: WorkOSPermission = {
  id: 'perm_01',
  object: 'permission',
  slug: 'posts:read',
  name: 'Read Posts',
  description: null,
  created_at: TS,
  updated_at: TS,
};

const store = new Store();
const ws = getWorkOSStore(store);

const CASES: ReadonlyArray<{ objectType: string; output: Record<string, unknown> }> = [
  { objectType: 'user', output: formatUser(user) },
  { objectType: 'organization', output: formatOrganization(organization, ws, { domains: [] }) },
  { objectType: 'connection', output: formatConnection(connection) },
  { objectType: 'directory', output: formatDirectory(directory) },
  { objectType: 'directory_group', output: formatDirectoryGroup(directoryGroup) },
  { objectType: 'directory_user', output: formatDirectoryUser(directoryUser) },
  { objectType: 'role', output: formatRole(role) },
  { objectType: 'permission', output: formatPermission(permission) },
];

/**
 * Spec-required fields the emulator does not yet return. Each is a real, tracked
 * gap between the emulator's data model and the current spec — not noise.
 */
const KNOWN_MISSING_REQUIRED: Record<string, readonly string[]> = {
  // Spec models a connection `status` distinct from `state`; the emulator's
  // WorkOSConnection carries only `state`.
  connection: ['status'],
  // The emulator's Role predates the spec's authorization Role: it has no
  // `permissions` array or `resource_type_slug`.
  role: ['permissions', 'resource_type_slug'],
  // The emulator's Permission lacks the spec's `resource_type_slug` and `system`.
  permission: ['resource_type_slug', 'system'],
};

/**
 * Fields the emulator returns that the spec schema does not define. Legitimate
 * model differences only — never a secret (asserted by the meta-test below).
 */
const KNOWN_EXTRA_FIELDS: Record<string, readonly string[]> = {
  // The emulator's legacy Role is environment/organization-scoped with default
  // and priority semantics the spec's authorization Role does not model.
  role: ['is_default_role', 'organization_id', 'priority'],
};

/** Internal fields that must never appear in an API response, for any resource. */
const SECRET_FIELDS = new Set<string>([
  'password_hash',
  'code',
  'code_challenge',
  'code_challenge_method',
  'token',
  'secret',
  'value',
  'key',
]);

describe('response shape conformance (format* helpers vs OpenAPI spec)', () => {
  it('covers exactly the resources in the generated requirements catalog', () => {
    expect(sorted(CASES.map((c) => c.objectType))).toEqual(sorted(Object.keys(RESPONSE_SHAPE_REQUIREMENTS)));
  });

  it('never lets a known-extra ledger entry excuse a secret field', () => {
    for (const [objectType, fields] of Object.entries(KNOWN_EXTRA_FIELDS)) {
      for (const field of fields) {
        expect(SECRET_FIELDS.has(field), `${objectType}.${field} is a secret and cannot be ledgered as extra`).toBe(
          false,
        );
      }
    }
  });

  for (const { objectType, output } of CASES) {
    const requirement = RESPONSE_SHAPE_REQUIREMENTS[objectType];
    const outputKeys = Object.keys(output);

    describe(objectType, () => {
      it('returns every spec-required field (modulo tracked gaps)', () => {
        const missing = sorted(requirement.required.filter((field) => !outputKeys.includes(field)));
        expect(missing).toEqual(sorted(KNOWN_MISSING_REQUIRED[objectType] ?? []));
      });

      it('returns no field absent from the spec schema (modulo tracked extras)', () => {
        const props = new Set(requirement.properties);
        const extra = sorted(outputKeys.filter((key) => !props.has(key)));
        expect(extra).toEqual(sorted(KNOWN_EXTRA_FIELDS[objectType] ?? []));
      });

      it('never leaks an internal/secret field', () => {
        const leaked = sorted(outputKeys.filter((key) => SECRET_FIELDS.has(key)));
        expect(leaked).toEqual([]);
      });
    });
  }
});
