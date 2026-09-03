import type { WorkOSFeatureFlag } from './entities.js';
import type { WorkOSStore } from './store.js';

/** Same `environment_<name>` convention Vault objects are scoped by. */
export function environmentIdFor(environment?: string): string {
  return `environment_${environment ?? 'test'}`;
}

/** `{ id, name }` of the API key acting on a flag; see `apiKeyActor` for how it is resolved. */
export type FlagActor = { id: string; name: string };

/**
 * The emulator's standing placeholder, for events that fire with no request behind them.
 * The collection hooks behind `flag.created/updated/deleted` run without request context —
 * a direct `getWorkOSStore()` insert fires them too — so there is no caller to name.
 */
const PLACEHOLDER_ACTOR: FlagActor = { id: 'api_key_emulator', name: 'Emulator API key' };

/**
 * `access_type` summarises a flag's reach in one word, the way the dashboard shows it:
 * `all` when the default value carries every resource, `some` when only targets are on,
 * `none` when the flag reaches nobody (disabled, or enabled with neither).
 */
export function flagAccessType(ws: WorkOSStore, flag: WorkOSFeatureFlag): 'none' | 'some' | 'all' {
  if (!flag.enabled) return 'none';
  if (flag.default_value) return 'all';
  return ws.flagTargets.findBy('flag_slug', flag.slug).length > 0 ? 'some' : 'none';
}

/**
 * The base `context` every flag webhook carries. `client_id` is the emulator's standing
 * placeholder — an API-key request has no client identity to report — and `source` is
 * always `api`, since the emulator serves no dashboard or admin portal.
 *
 * The actor is the API key that made the request when the emitting code has one (the target
 * routes do — see `apiKeyActor`), and the placeholder otherwise.
 */
export function flagEventContext(actor: FlagActor = PLACEHOLDER_ACTOR): Record<string, unknown> {
  return {
    client_id: 'workos-emulate',
    actor: { id: actor.id, source: 'api', name: actor.name },
  };
}

/**
 * The targeting half of a `flag.rule_updated` context. Only that event defines `access_type`
 * and `configured_targets`, so the other three flag events must not carry them.
 *
 * A target whose user or organization no longer resolves is left out rather than reported
 * with a blank name or email: the spec marks both required, and the delete routes cascade
 * targets, so such a row only exists when a caller has edited the store directly.
 */
export function flagRuleState(ws: WorkOSStore, flag: WorkOSFeatureFlag): Record<string, unknown> {
  const targets = ws.flagTargets.findBy('flag_slug', flag.slug);
  return {
    access_type: flagAccessType(ws, flag),
    configured_targets: {
      organizations: targets
        .filter((t) => t.resource_type === 'organization')
        .flatMap((t) => {
          const org = ws.organizations.get(t.resource_id);
          return org ? [{ id: org.id, name: org.name }] : [];
        }),
      users: targets
        .filter((t) => t.resource_type === 'user')
        .flatMap((t) => {
          const user = ws.users.get(t.resource_id);
          return user ? [{ id: user.id, email: user.email }] : [];
        }),
    },
  };
}

/**
 * The full `flag.rule_updated` context. `previous_attributes` is required on this event, so
 * the caller has to capture `flagRuleState` before mutating the targets and hand it back here.
 *
 * Only the rule changed: a target mutation leaves the flag object's own attributes as they
 * were, so `previous_attributes.data` is omitted rather than restating current values as
 * "previous". The spec requires neither `data` nor `context` inside `previous_attributes`.
 */
export function flagRuleUpdatedContext(
  ws: WorkOSStore,
  flag: WorkOSFeatureFlag,
  previous: Record<string, unknown>,
  actor?: FlagActor,
): Record<string, unknown> {
  return {
    ...flagEventContext(actor),
    ...flagRuleState(ws, flag),
    previous_attributes: { context: previous },
  };
}
