import { type RouteContext, notFound, parseListParams } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatDirectory,
  formatDirectoryUser,
  formatDirectoryGroup,
  formatListResponse,
  findUserByEmail,
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

    // Release the memberships this directory managed, so an app can exercise
    // "directory disconnected, the membership is the app's again".
    for (const u of ws.directoryUsers.findBy('directory_id', dir.id)) {
      if (!u.email) continue;
      const authKitUser = findUserByEmail(ws, u.email);
      if (!authKitUser) continue;
      const membership = ws.organizationMemberships
        .findBy('organization_id', dir.organization_id ?? '')
        .find((m) => m.user_id === authKitUser.id);
      if (membership?.directory_managed) {
        ws.organizationMemberships.update(membership.id, { directory_managed: false });
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
