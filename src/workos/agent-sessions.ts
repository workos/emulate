import type { WorkOSStore } from './store.js';
import type {
  WorkOSAgentBlueprint,
  WorkOSAgentInstance,
  WorkOSAgentInstanceSession,
  WorkOSSession,
} from './entities.js';
import { getRolePermissions, resolvePrimaryRole } from './role-helpers.js';

/**
 * Longest `agent_delegated` chain production will mint; every hop persists a session and
 * the root walk is O(depth), so the cap only closes an unbounded-growth lever.
 */
export const MAX_AGENT_CHAIN_DEPTH = 32;

export const AGENT_SUBJECT_PROFILE = 'ai_agent';
export const USER_SUBJECT_PROFILE = 'user';

export const AGENT_SESSION_SETTING_LIMITS = {
  max_age_seconds: 31_536_000,
  access_token_ttl_seconds: 3_600,
  refresh_token_ttl_seconds: 5_184_000,
} as const;

export const DEFAULT_AGENT_SESSION_SETTINGS = {
  max_age_seconds: 3600,
  access_token_ttl_seconds: 300,
  refresh_token_ttl_seconds: 3600,
} as const;

/**
 * A user session still able to back delegation: present, active, and unexpired. Revoked
 * sessions are deleted by the sessions routes, so absence reads as ended.
 */
export function isUserSessionLive(session: WorkOSSession | undefined, now = Date.now()): session is WorkOSSession {
  return !!session && session.status === 'active' && new Date(session.expires_at).getTime() > now;
}

export function isOrganizationInvocable(blueprint: WorkOSAgentBlueprint, organizationId: string): boolean {
  const ids = blueprint.invocable_by.organization_ids;
  return ids.length === 0 || ids.includes(organizationId);
}

/**
 * Permission slugs a membership's primary role grants, resolved the same way the
 * authorization endpoints and user access tokens do so the three never disagree.
 */
export function membershipPermissionSlugs(ws: WorkOSStore, organizationId: string, roleSlug: string): string[] {
  const role = resolvePrimaryRole(ws, organizationId, roleSlug);
  return role ? getRolePermissions(ws, role.id).map((p) => p.slug) : [];
}

export function isRoleInvocable(blueprint: WorkOSAgentBlueprint, roleSlug: string): boolean {
  const slugs = blueprint.invocable_by.role_slugs;
  return slugs.length === 0 || slugs.includes(roleSlug);
}

/** Blueprint ceiling narrowed to what the delegating member's role grants; order follows the ceiling. */
export function intersectPermissions(blueprint: WorkOSAgentBlueprint, granted: string[]): string[] {
  const held = new Set(granted);
  return blueprint.permissions.filter((slug) => held.has(slug));
}

export interface ChainRoot {
  root: WorkOSAgentInstanceSession;
  /** Hops between the presented session and its root; 0 for an unchained session. */
  depth: number;
  ancestorRevoked: boolean;
}

/**
 * Walk `parent_session_id` provenance to the chain root. Every hop is on the same instance,
 * so a missing parent means the chain was torn down and the walk stops where it is.
 */
export function findChainRoot(ws: WorkOSStore, session: WorkOSAgentInstanceSession): ChainRoot {
  let current = session;
  let depth = 0;
  let ancestorRevoked = false;
  while (current.parent_session_id !== null && depth < MAX_AGENT_CHAIN_DEPTH) {
    const parent = ws.agentInstanceSessions.get(current.parent_session_id);
    if (!parent) break;
    if (parent.revoked_at !== null) ancestorRevoked = true;
    current = parent;
    depth += 1;
  }
  return { root: current, depth, ancestorRevoked };
}

/**
 * Revoke a session and every descendant chained from it. Only rows whose `revoked_at`
 * flips from null are touched, so the update hook emits one `agent.instance.session.revoked`
 * per session that was actually live. Returns how many sessions were revoked.
 */
export function revokeAgentSessionTree(
  ws: WorkOSStore,
  sessionId: string,
  revokedAt = new Date().toISOString(),
): number {
  let count = 0;
  const pending = [sessionId];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const session = ws.agentInstanceSessions.get(id);
    if (!session) continue;
    if (session.revoked_at === null) {
      ws.agentInstanceSessions.update(id, { revoked_at: revokedAt });
      count += 1;
    }
    for (const child of ws.agentInstanceSessions.findBy('parent_session_id', id)) pending.push(child.id);
  }
  return count;
}

/**
 * Tear down an instance the way production does: live sessions are revoked (so their
 * revocation events fire) before every session row and the instance itself are removed.
 */
export function deleteAgentInstance(ws: WorkOSStore, instance: WorkOSAgentInstance): void {
  const sessions = ws.agentInstanceSessions.findBy('agent_instance_id', instance.id);
  for (const session of sessions) {
    if (session.revoked_at === null && new Date(session.expires_at).getTime() > Date.now()) {
      ws.agentInstanceSessions.update(session.id, { revoked_at: new Date().toISOString() });
    }
  }
  for (const session of sessions) ws.agentInstanceSessions.delete(session.id);
  ws.agentInstances.delete(instance.id);
}

export function deleteAgentBlueprint(ws: WorkOSStore, blueprint: WorkOSAgentBlueprint): void {
  for (const instance of ws.agentInstances.findBy('agent_blueprint_id', blueprint.id)) {
    deleteAgentInstance(ws, instance);
  }
  ws.agentBlueprints.delete(blueprint.id);
}

/**
 * Agent sessions delegated from a user session die with it. Called when a user session is
 * revoked; chained sessions record only their parent, so revoking each root cascades.
 */
export function revokeAgentSessionsForUserSession(ws: WorkOSStore, userSessionId: string): void {
  for (const root of ws.agentInstanceSessions.findBy('user_session_id', userSessionId)) {
    revokeAgentSessionTree(ws, root.id);
  }
}
