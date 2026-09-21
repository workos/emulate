import { type RouteContext, notFound, parseListParams } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatDirectory,
  formatDirectoryUser,
  formatDirectoryGroup,
  formatListResponse,
  findUserByEmail,
  emailsMatch,
  liveMembershipFor,
} from '../helpers.js';

export function directoryRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  // List directories
  app.get('/directories', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const orgFilter = url.searchParams.get('organization_id') ?? undefined;
    const search = url.searchParams.get('search') ?? undefined;

    const result = ws.directories.list({
      ...params,
      filter: (d) => {
        if (orgFilter && d.organization_id !== orgFilter) return false;
        if (search && !d.name.toLowerCase().includes(search.toLowerCase())) return false;
        return true;
      },
    });

    return c.json(formatListResponse(result, formatDirectory));
  });

  // Get directory
  app.get('/directories/:id', (c) => {
    const dir = ws.directories.get(c.req.param('id'));
    if (!dir) throw notFound('Directory');
    return c.json(formatDirectory(dir));
  });

  // Delete directory (cascade users + groups)
  app.delete('/directories/:id', (c) => {
    const dir = ws.directories.get(c.req.param('id'));
    if (!dir) throw notFound('Directory');

    // Hand each membership back to whatever still has a claim on it: a surviving directory
    // in the same organization owns the role it maps, and with no survivor the membership
    // is the application's again.
    // First survivor wins the role, so the order must be declaration order. `all()` reads the
    // item map, which keeps insertion order across updates; `findBy` reads an index set that
    // `Collection.update` re-appends to, and `created_at` is too coarse to sort a seed run back.
    // Directory state is deliberately ignored, matching the seed path: an unlinked
    // directory still lists the user and still claims them once relinked.
    const survivors = ws.directories
      .all()
      .filter((d) => d.id !== dir.id && d.organization_id === dir.organization_id)
      .flatMap((d) => ws.directoryUsers.findBy('directory_id', d.id));
    for (const u of ws.directoryUsers.findBy('directory_id', dir.id)) {
      const email = u.email;
      if (!email) continue;
      const authKitUser = findUserByEmail(ws, email);
      if (!authKitUser) continue;
      const membership = liveMembershipFor(ws, dir.organization_id ?? '', authKitUser.id);
      // Only a membership a directory already claimed: deleting one directory must not
      // seize a membership the application owns.
      if (!membership?.directory_managed) continue;

      if (!survivors.some((s) => emailsMatch(s.email ?? '', email))) {
        ws.organizationMemberships.update(membership.id, { directory_managed: false });
        continue;
      }
      // Role-less survivors claim the membership but not the role, the same way seeding
      // lets a directory with no mapping leave the role to the next one.
      const roleSurvivor = survivors.find((s) => s.role && emailsMatch(s.email ?? '', email));
      if (roleSurvivor?.role && roleSurvivor.role.slug !== membership.role.slug) {
        ws.organizationMemberships.update(membership.id, { role: { slug: roleSurvivor.role.slug } });
      }
    }

    ws.directoryUsers.deleteBy('directory_id', dir.id);
    ws.directoryGroups.deleteBy('directory_id', dir.id);

    ws.directories.delete(dir.id);
    return c.body(null, 204);
  });

  // List directory users
  app.get('/directory_users', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const directoryId = url.searchParams.get('directory') ?? undefined;
    const groupId = url.searchParams.get('group') ?? undefined;
    const idpId = url.searchParams.get('idp_id') ?? undefined;
    const email = url.searchParams.get('email') ?? undefined;

    const result = ws.directoryUsers.list({
      ...params,
      filter: (u) => {
        if (directoryId && u.directory_id !== directoryId) return false;
        if (groupId && !u.groups.some((g) => g.id === groupId)) return false;
        if (idpId && u.idp_id !== idpId) return false;
        if (email && u.email?.toLowerCase() !== email.toLowerCase()) return false;
        return true;
      },
    });

    return c.json(formatListResponse(result, formatDirectoryUser));
  });

  // Get directory user
  app.get('/directory_users/:id', (c) => {
    const user = ws.directoryUsers.get(c.req.param('id'));
    if (!user) throw notFound('DirectoryUser');
    return c.json(formatDirectoryUser(user));
  });

  // List directory groups
  app.get('/directory_groups', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const directoryId = url.searchParams.get('directory') ?? undefined;
    const userId = url.searchParams.get('user') ?? undefined;

    // Resolve the user's group membership once rather than per candidate group. An unknown
    // user id yields an empty set, so the filter matches nothing.
    const userGroupIds = userId ? new Set(ws.directoryUsers.get(userId)?.groups.map((g) => g.id) ?? []) : undefined;

    const result = ws.directoryGroups.list({
      ...params,
      filter: (g) => {
        if (directoryId && g.directory_id !== directoryId) return false;
        if (userGroupIds && !userGroupIds.has(g.id)) return false;
        return true;
      },
    });

    return c.json(formatListResponse(result, formatDirectoryGroup));
  });

  // Get directory group
  app.get('/directory_groups/:id', (c) => {
    const group = ws.directoryGroups.get(c.req.param('id'));
    if (!group) throw notFound('DirectoryGroup');
    return c.json(formatDirectoryGroup(group));
  });
}
