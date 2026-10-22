import { validationError, WorkOSApiError } from '../core/index.js';
import type { WorkOSOrganizationMembership, WorkOSRole } from './entities.js';
import type { WorkOSStore } from './store.js';

/**
 * A membership's role slugs the way production lists them: the priority role first, then the
 * rest in the organization's role priority order. A slug resolves the way the authorization
 * endpoints resolve it — an organization role shadows an environment role — and the priority is
 * read at call time, so a change to it shows on the next read without rewriting memberships.
 * Slugs that name no defined role keep the order they were written in, after the defined ones.
 * Rows written before `roles` existed carry only the singular `role`, which reads as a one-role
 * list.
 */
export function membershipRoleSlugs(
  ws: WorkOSStore,
  m: Pick<WorkOSOrganizationMembership, 'organization_id' | 'role' | 'roles'>,
): string[] {
  return orderRoleSlugs(
    ws,
    m.organization_id,
    (m.roles ?? [m.role]).map((r) => r.slug),
  );
}

/** `slugs` deduplicated and in role priority order; see membershipRoleSlugs. */
export function orderRoleSlugs(ws: WorkOSStore, organizationId: string, slugs: readonly string[]): string[] {
  const unique = [...new Set(slugs)];
  if (unique.length < 2) return unique;
  const rank = new Map(unique.map((slug) => [slug, rolePriority(ws, organizationId, slug)]));
  // Array.prototype.sort is stable, so equal priorities keep their written order.
  return unique.sort((a, b) => rank.get(a)! - rank.get(b)!);
}

/**
 * The role a slug names for an organization, the way production's `findActiveBySlug` resolves
 * it: the organization's own role under that slug, else the environment role.
 */
function findRole(ws: WorkOSStore, organizationId: string, slug: string): WorkOSRole | undefined {
  const candidates = ws.roles.findBy('slug', slug);
  return (
    candidates.find((r) => r.organization_id === organizationId) ??
    candidates.find((r) => r.type === 'EnvironmentRole' && r.organization_id === null)
  );
}

function rolePriority(ws: WorkOSStore, organizationId: string, slug: string): number {
  const role = findRole(ws, organizationId, slug);
  return role ? role.priority : Number.MAX_SAFE_INTEGER;
}

/**
 * The two environment roles production creates with every environment (`roles-orchestrator.ts`:
 * `member`, the default role, and `admin`). They exist before anything is seeded, so a slug naming
 * one is always valid here too, whether or not the seed defines them.
 */
const BUILT_IN_ROLE_SLUGS = new Set(['member', 'admin']);

/**
 * The first of `slugs` that names no role an organization membership can hold — no role of
 * that organization, no environment role, and not one of the built-in two — or undefined when
 * all resolve. Production answers such a slug with `invalid_role`; the status differs by route
 * (422 on memberships, 400 on invitations), so the caller raises the error.
 */
export function undefinedRoleSlug(
  ws: WorkOSStore,
  organizationId: string,
  slugs: readonly string[],
): string | undefined {
  return slugs.find((slug) => !BUILT_IN_ROLE_SLUGS.has(slug) && !findRole(ws, organizationId, slug));
}

/**
 * The fields a role-set write stores: `role` is the priority role and `roles` the whole set in
 * priority order, so every writer goes through here and the two never disagree.
 */
export function membershipRoleFields(
  ws: WorkOSStore,
  organizationId: string,
  slugs: readonly string[],
): Pick<WorkOSOrganizationMembership, 'role' | 'roles'> {
  const ordered = orderRoleSlugs(ws, organizationId, slugs);
  return { role: { slug: ordered[0] }, roles: ordered.map((slug) => ({ slug })) };
}

/**
 * The role slugs a membership request body names: `role_slugs` for several roles (what
 * production accepts once multiple roles are enabled) or the singular `role_slug`, never both.
 * Undefined when the body names neither, so an update can leave the roles alone.
 */
export function roleSlugsFromBody(body: Record<string, unknown>): string[] | undefined {
  if ('role_slug' in body && 'role_slugs' in body) {
    throw validationError('The role_slug parameter cannot be used when role_slugs is provided.', [
      { field: 'role_slug', code: 'invalid' },
    ]);
  }
  if ('role_slugs' in body) {
    const slugs = body.role_slugs;
    if (!Array.isArray(slugs) || !slugs.every(isSlug)) {
      throw validationError('role_slugs must be an array of role slugs', [{ field: 'role_slugs', code: 'invalid' }]);
    }
    // An empty array passes production's request validation and is refused by the controller
    // as a role that names nothing, under the same code an unknown slug gets.
    if (slugs.length === 0) throw invalidRole(422);
    return slugs as string[];
  }
  if ('role_slug' in body) {
    if (!isSlug(body.role_slug)) {
      throw validationError('role_slug must be a role slug', [{ field: 'role_slug', code: 'invalid' }]);
    }
    return [body.role_slug];
  }
  return undefined;
}

const isSlug = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Production's answer to a role slug that resolves to no role: the body is the same everywhere,
 * the status is the route's — 422 from the membership endpoints, 400 from invitations.
 */
export function invalidRole(status: 400 | 422): WorkOSApiError {
  return new WorkOSApiError(status, 'The role is invalid.', 'invalid_role');
}
