/**
 * ID prefix conformance: asserts the prefixes the emulator mints ids with match the
 * prefixes the OpenAPI spec's own `id` examples use. The spec requirements come from
 * src/workos/generated/response-shapes.ts (regenerate with `npm run gen:shapes`), where
 * they are discovered structurally — every object the spec gives a prefixed `id` example
 * for is catalogued, nothing is curated.
 *
 * Response shape conformance cannot catch this: a field set says nothing about what goes
 * in the fields, so `id: "ra_01…"` satisfies a spec that documents `role_assignment_01…`.
 * Prefixes are load-bearing for consumers — SDK fixtures, routing by id, and anything
 * that string-matches an id — so a wrong one is a contract break that looks like nothing.
 *
 * Divergences live in the ledgers below, as exact sets with a reason each. Closing one —
 * the spec grows an example, or a prefix is brought into line — fails until its ledger
 * entry is deleted, and a new divergence fails outright, so drift can't accrue silently.
 */
import { describe, it, expect } from 'bun:test';
import { ID_PREFIXES } from '../core/index.js';
import { ID_PREFIX_REQUIREMENTS } from './generated/response-shapes.js';

/**
 * ID_PREFIXES keys the emulator spells differently from the spec's `object`
 * discriminator. Only the name differs; the prefix is still required to match.
 */
const OBJECT_TYPE_ALIASES: Record<string, string> = {
  authorized_application: 'authorized_connect_application',
  client_secret: 'connect_application_secret',
};

/**
 * Objects the emulator mints ids for that the spec gives no object-level `id` example
 * for — mostly records that exist only inside the emulator, or spec resources the spec
 * itself never shows an id for. Each prefix here is chosen by hand, so each says why.
 */
const NO_SPEC_ID_EXAMPLE: Record<string, string> = {
  audit_log_action: 'AuditLogActionJson carries no `id` — actions are identified by `name`.',
  audit_log_event: 'Ingestion (AuditLogEventDto) is write-only; no id-bearing event object is documented.',
  authorization_code: 'OAuth codes are opaque strings in the spec (`code`), not a resource; the emulator stores one.',
  data_integration_auth: 'Emulator-internal: the OAuth handoff behind a data integration install.',
  device_authorization: 'The device grant is addressed by `device_code`/`user_code`; the record is emulator-internal.',
  external_auth_session:
    'Not an object in the spec, but its `external_auth_id` example is `ext_auth_…`, which this matches.',
  flag_target: 'Targets are inline on the flag (Flag.targets); there is no standalone target resource.',
  group_membership: 'Membership appears only as CreateGroupMembershipDto — no resource, so no id.',
  identity: '/user_management/users/{id}/identities returns objects keyed by `idp_id`, with no `id` at all.',
  pipe_connection: 'Emulator-internal: the Pipes connection record behind a connected account.',
  radar_attempt:
    'No object-level example, but `/radar/attempts/{id}` documents `radar_att_01HZBC6N1EB1ZY7KG32X` and ' +
    'RadarStandaloneResponse.attempt_id repeats it — so the prefix is pinned to that.',
  refresh_token: 'Refresh tokens are opaque strings in the spec; the emulator stores a record behind one.',
  role_permission: 'The role↔permission join is emulator-internal; the spec exposes permissions on the role.',
  sso_authorization: 'Emulator-internal: the authorize → callback handoff for SSO.',
};

/**
 * Prefixes that knowingly differ from the spec's example, and why. These are the entries
 * to delete — not extend — when the divergence is closed.
 */
const TRACKED_DIVERGENCES: Record<string, string> = {
  connection_domain:
    'The spec contradicts itself: Connection.domains[] examples an `org_domain_…` id, while the ' +
    'connection.* event payloads example `conn_domain_…` for the same object. The emulator follows the ' +
    'events, which is what production emits.',
};

const prefixes: Record<string, string> = { ...ID_PREFIXES };
const specObjectType = (key: string): string => OBJECT_TYPE_ALIASES[key] ?? key;

describe('ID prefix conformance', () => {
  it('mints the prefix the spec documents for every object the spec gives an example for', () => {
    const actual: Record<string, string> = {};
    const expected: Record<string, string> = {};
    for (const [key, prefix] of Object.entries(prefixes)) {
      const requirement = ID_PREFIX_REQUIREMENTS[specObjectType(key)];
      if (!requirement || key in TRACKED_DIVERGENCES) continue;
      actual[key] = prefix;
      expected[key] = requirement.prefix;
    }
    expect(actual).toEqual(expected);
  });

  it('accounts for every object it mints ids for — matched against the spec, or ledgered', () => {
    const unaccounted = Object.keys(prefixes).filter(
      (key) => !ID_PREFIX_REQUIREMENTS[specObjectType(key)] && !(key in NO_SPEC_ID_EXAMPLE),
    );
    expect(unaccounted).toEqual([]);
  });

  it('has no stale no-example ledger entry — the spec grew an example, so the entry must go', () => {
    const covered = Object.keys(NO_SPEC_ID_EXAMPLE).filter((key) => ID_PREFIX_REQUIREMENTS[specObjectType(key)]);
    expect(covered).toEqual([]);
  });

  it('has no stale divergence — a tracked divergence that now matches the spec must be deleted', () => {
    const closed = Object.keys(TRACKED_DIVERGENCES).filter((key) => {
      const requirement = ID_PREFIX_REQUIREMENTS[specObjectType(key)];
      return requirement !== undefined && requirement.prefix === prefixes[key];
    });
    expect(closed).toEqual([]);
  });

  it('ledgers only objects the emulator actually mints ids for', () => {
    const unknown = [...Object.keys(NO_SPEC_ID_EXAMPLE), ...Object.keys(TRACKED_DIVERGENCES)].filter(
      (key) => !(key in prefixes),
    );
    expect(unknown).toEqual([]);
  });

  it('extracted a prefix for the objects whose ids customers read back', () => {
    // A guard on the guard: if the extractor silently stopped finding examples, every
    // assertion above would pass vacuously.
    for (const objectType of ['user', 'organization', 'event', 'invitation', 'role_assignment']) {
      expect(ID_PREFIX_REQUIREMENTS[objectType]?.prefix).toBeString();
    }
  });
});
