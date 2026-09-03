import { type RouteContext, WorkOSApiError, cursorPaginate, notFound, parseListParams } from '../../core/index.js';
import { getWorkOSStore, type WorkOSStore } from '../store.js';
import type { WorkOSFeatureFlag } from '../entities.js';
import { apiKeyActor, formatFeatureFlag, formatFeatureFlagEvent, formatListResponse } from '../helpers.js';
import { environmentIdFor, flagRuleState, flagRuleUpdatedContext } from '../flag-context.js';
import { EVENTS, STORE_KEYS } from '../constants.js';
import type { EventBus } from '../event-bus.js';

/**
 * Production targets are addressed by a prefixed resource id and nothing else — the route
 * takes no body — so the prefix is the only thing that says whether a target is a user or
 * an organization.
 */
function resourceKind(resourceId: string): 'user' | 'organization' | null {
  if (resourceId.startsWith('user_')) return 'user';
  if (resourceId.startsWith('org_')) return 'organization';
  return null;
}

function invalidResourceId(): WorkOSApiError {
  return new WorkOSApiError(400, 'Invalid resource id', 'invalid_resource_id_format');
}

function isTargeted(ws: WorkOSStore, slug: string, resourceIds: string[]): boolean {
  const targets = ws.flagTargets.findBy('flag_slug', slug);
  return targets.some((t) => t.enabled && resourceIds.includes(t.resource_id));
}

/**
 * Whether a flag is on for a set of resource ids (a user, an organization, or a user plus the
 * organizations they belong to). A disabled flag is off for everyone; otherwise a target
 * switches the flag on, and resources matching no target fall back to `default_value`.
 * Targeting is additive — production's create-target route carries no body, so a target can
 * only turn a flag on, never off.
 */
function flagIsOn(ws: WorkOSStore, flag: WorkOSFeatureFlag, resourceIds: string[]): boolean {
  if (!flag.enabled) return false;
  return isTargeted(ws, flag.slug, resourceIds) || flag.default_value === true;
}

/**
 * The organizations whose targets a user inherits: active memberships only. A `pending` member
 * has not joined yet and an `inactive` one has been removed, and authenticate gates organization
 * scoping on the same status — so counting either here would report a flag through an
 * organization no session of that user's can ever be scoped to.
 */
export function organizationIdsForUser(ws: WorkOSStore, userId: string): string[] {
  return ws.organizationMemberships
    .findBy('user_id', userId)
    .filter((m) => m.status === 'active')
    .map((m) => m.organization_id);
}

/** Flags resolving on for the given resource ids, newest first, as whole `Flag` objects. */
function enabledFlagsFor(ws: WorkOSStore, resourceIds: string[]): WorkOSFeatureFlag[] {
  return ws.featureFlags.all().filter((flag) => flagIsOn(ws, flag, resourceIds));
}

/**
 * Flag slugs minted into an access token: production's `feature_flags` claim is the same set
 * `GET /user_management/users/{id}/feature-flags` returns, so it resolves through the same
 * rule. The session's organization is the only one considered — the token is org-scoped, and
 * a flag targeted at some *other* org the user belongs to is not on for this session.
 */
export function tokenFeatureFlags(ws: WorkOSStore, userId: string, organizationId: string | null): string[] {
  const resourceIds = organizationId ? [userId, organizationId] : [userId];
  return enabledFlagsFor(ws, resourceIds).map((flag) => flag.slug);
}

export function featureFlagRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  const flagBySlug = (slug: string): WorkOSFeatureFlag => {
    const flag = ws.featureFlags.findOneBy('slug', slug);
    if (!flag) throw notFound('FeatureFlag');
    return flag;
  };

  /**
   * `flag.rule_updated` is the target-change event; the flag object itself is unchanged, so
   * this cannot ride on the collection's update hook. `previous` is the rule state captured
   * before the mutation — the spec marks `previous_attributes` required on this event.
   *
   * The actor is the API key that made the request, resolved the way Vault's `updated_by` is;
   * this is the one flag event emitted with a request in hand, so it is the one that can say
   * who acted rather than falling back to the emulator's placeholder key.
   *
   * The environment is the emulator's default rather than the caller's: flags are not
   * environment-scoped in the store, so reporting the requesting key's environment here would
   * make this event disagree with the collection-hook events about the same flag.
   */
  const emitRuleUpdated = (flag: WorkOSFeatureFlag, previous: Record<string, unknown>, apiKey?: string) => {
    const environmentId = environmentIdFor();
    store.getData<EventBus>(STORE_KEYS.eventBus)?.emit({
      event: EVENTS.flagRuleUpdated,
      data: formatFeatureFlagEvent(flag, environmentId),
      environment_id: environmentId,
      context: flagRuleUpdatedContext(ws, flag, previous, apiKeyActor(ws, apiKey)),
    });
  };

  const setEnabled = (slug: string, enabled: boolean) => {
    const flag = flagBySlug(slug);
    // Already in the requested state: skip the write so a no-op call does not emit a
    // spurious flag.updated webhook.
    if (flag.enabled === enabled) return formatFeatureFlag(flag);
    return formatFeatureFlag(ws.featureFlags.update(flag.id, { enabled })!);
  };

  app.get('/feature-flags', (c) => {
    const params = parseListParams(new URL(c.req.url));
    return c.json(formatListResponse(ws.featureFlags.list({ ...params }), formatFeatureFlag));
  });

  app.get('/feature-flags/:slug', (c) => c.json(formatFeatureFlag(flagBySlug(c.req.param('slug')))));

  // The spec's verb is PUT. POST is kept as an alias because the emulator shipped these two
  // routes under it, and nothing in production claims POST for a different operation.
  app.put('/feature-flags/:slug/enable', (c) => c.json(setEnabled(c.req.param('slug'), true)));
  app.post('/feature-flags/:slug/enable', (c) => c.json(setEnabled(c.req.param('slug'), true)));
  app.put('/feature-flags/:slug/disable', (c) => c.json(setEnabled(c.req.param('slug'), false)));
  app.post('/feature-flags/:slug/disable', (c) => c.json(setEnabled(c.req.param('slug'), false)));

  const addTarget = (slug: string, resourceId: string) => {
    const flag = flagBySlug(slug);
    const kind = resourceKind(resourceId);
    if (!kind) throw invalidResourceId();

    // The spec answers 404 for a user or organization that does not exist, not just for an
    // unknown flag, so a typo'd id cannot masquerade as a silently ineffective target.
    if (kind === 'user' && !ws.users.get(resourceId)) throw notFound('User');
    if (kind === 'organization' && !ws.organizations.get(resourceId)) throw notFound('Organization');

    const existing = ws.flagTargets.findBy('flag_slug', flag.slug).find((t) => t.resource_id === resourceId);
    if (existing) return { flag, changed: false, previous: undefined };

    const previous = flagRuleState(ws, flag);
    ws.flagTargets.insert({
      object: 'flag_target',
      flag_slug: flag.slug,
      resource_id: resourceId,
      resource_type: kind,
      enabled: true,
    });
    return { flag, changed: true, previous };
  };

  // Documented as POST; PUT is accepted too, as the emulator previously exposed it there.
  app.post('/feature-flags/:slug/targets/:resourceId', (c) => {
    const { flag, changed, previous } = addTarget(c.req.param('slug'), c.req.param('resourceId'));
    if (changed && previous) emitRuleUpdated(flag, previous, c.get('auth')?.apiKey);
    return c.body(null, 204);
  });
  app.put('/feature-flags/:slug/targets/:resourceId', (c) => {
    const { flag, changed, previous } = addTarget(c.req.param('slug'), c.req.param('resourceId'));
    if (changed && previous) emitRuleUpdated(flag, previous, c.get('auth')?.apiKey);
    return c.body(null, 204);
  });

  app.delete('/feature-flags/:slug/targets/:resourceId', (c) => {
    const flag = flagBySlug(c.req.param('slug'));
    const resourceId = c.req.param('resourceId');
    const kind = resourceKind(resourceId);
    if (!kind) throw invalidResourceId();

    // The same existence checks the create route runs. Without them a typo'd id is swallowed
    // as a successful removal, so a test asserting "the target is gone" passes against the
    // emulator and fails against production, which 404s.
    if (kind === 'user' && !ws.users.get(resourceId)) throw notFound('User');
    if (kind === 'organization' && !ws.organizations.get(resourceId)) throw notFound('Organization');

    const target = ws.flagTargets.findBy('flag_slug', flag.slug).find((t) => t.resource_id === resourceId);
    // Idempotent: the spec's 404 covers an unknown flag, user or organization, not a target
    // that was already removed, and a delete that has nothing left to do has succeeded.
    if (target) {
      const previous = flagRuleState(ws, flag);
      ws.flagTargets.delete(target.id);
      emitRuleUpdated(flag, previous, c.get('auth')?.apiKey);
    }
    return c.body(null, 204);
  });

  /**
   * The Node SDK runtime client's polling endpoint (`createRuntimeClient()`, `isEnabled()`,
   * `getAllFlags()`). It is not in the OpenAPI spec but is what the SDK actually fetches, so
   * without it the runtime client never leaves its bootstrap state.
   *
   * The body is a bare `{ [slug]: entry }` map, not a list envelope, and carries every flag —
   * the client evaluates `enabled` and the targets itself, and diffs successive polls to emit
   * `change` events, so filtering here would hide transitions from it.
   */
  app.get('/sdk/feature-flags', (c) => {
    // Null-prototype: a flag slugged `__proto__` would otherwise be swallowed by the assignment
    // rather than appearing in the map the SDK swaps into its store.
    const body: Record<string, unknown> = Object.create(null);
    for (const flag of ws.featureFlags.all()) {
      const targets = ws.flagTargets.findBy('flag_slug', flag.slug);
      const byKind = (kind: 'user' | 'organization') =>
        targets.filter((t) => t.resource_type === kind).map((t) => ({ id: t.resource_id, enabled: t.enabled }));
      body[flag.slug] = {
        slug: flag.slug,
        enabled: flag.enabled,
        default_value: flag.default_value,
        // `custom_targets` is omitted deliberately: the SDK documents it as absent until the
        // API's custom-targets rollout, and its evaluator defaults it to [].
        targets: { users: byKind('user'), organizations: byKind('organization') },
      };
    }
    return c.json(body);
  });

  // Both evaluation endpoints return a FlagList of whole Flag objects and list only the flags
  // that resolve on — not every flag with a value attached.
  const listEnabled = (requestUrl: string, resourceIds: string[]) => {
    const params = parseListParams(new URL(requestUrl));
    return formatListResponse(cursorPaginate(enabledFlagsFor(ws, resourceIds), params), formatFeatureFlag);
  };

  app.get('/organizations/:organizationId/feature-flags', (c) => {
    const orgId = c.req.param('organizationId');
    if (!ws.organizations.get(orgId)) throw notFound('Organization');
    return c.json(listEnabled(c.req.url, [orgId]));
  });

  app.get('/user_management/users/:userId/feature-flags', (c) => {
    const userId = c.req.param('userId');
    if (!ws.users.get(userId)) throw notFound('User');
    // Documented as including "any organizations that the user is a member of", so every org
    // membership contributes its targets — unlike the org-scoped access token claim.
    return c.json(listEnabled(c.req.url, [userId, ...organizationIdsForUser(ws, userId)]));
  });
}
