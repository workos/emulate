import { type RouteContext, WorkOSApiError, notFound, parseJsonBody, parseListParams } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatPermission, formatListResponse } from '../helpers.js';
import { DEFAULT_RESOURCE_TYPE_SLUG } from '../constants.js';
import { removePermissionFromAgentBlueprints } from '../agent-sessions.js';
import { PERMISSION_CREATE_RULES, PERMISSION_UPDATE_RULES, validateBody } from '../authorization-validation.js';

export function authorizationPermissionRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/authorization/permissions', async (c) => {
    const body = await parseJsonBody(c);
    // The slug and its resource type follow production's patterns and lengths; resource
    // types themselves are not modeled by the emulator (no registry, no endpoint), so any
    // well-formed type slug is accepted where production requires a defined type.
    validateBody(body, PERMISSION_CREATE_RULES);
    const slug = body.slug as string;

    const existing = ws.permissions.findOneBy('slug', slug);
    if (existing) {
      // Production answers a taken slug with 409 permission_slug_conflict, not a 422 field error.
      throw new WorkOSApiError(409, 'Permission with this slug already exists', 'permission_slug_conflict');
    }

    const permission = ws.permissions.insert({
      object: 'permission',
      slug,
      name: body.name as string,
      description: (body.description as string | null | undefined) ?? null,
      resource_type_slug: (body.resource_type_slug as string | undefined) ?? DEFAULT_RESOURCE_TYPE_SLUG,
    });

    return c.json(formatPermission(permission), 201);
  });

  app.get('/authorization/permissions', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);

    const result = ws.permissions.list(params);
    return c.json(formatListResponse(result, formatPermission));
  });

  app.get('/authorization/permissions/:slug', (c) => {
    const slug = c.req.param('slug');
    const permission = ws.permissions.findOneBy('slug', slug);
    if (!permission) throw notFound('Permission', slug);
    return c.json(formatPermission(permission));
  });

  // The spec (and every SDK) updates a permission with PATCH; there is no PUT. Only the name
  // and description are updatable; production refuses any other property, the slug included.
  app.patch('/authorization/permissions/:slug', async (c) => {
    const body = await parseJsonBody(c);
    validateBody(body, PERMISSION_UPDATE_RULES);
    const slug = c.req.param('slug');
    const permission = ws.permissions.findOneBy('slug', slug);
    if (!permission) throw notFound('Permission', slug);

    const updates: Record<string, unknown> = {};
    if (typeof body.name === 'string') updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description ?? null;

    const updated = ws.permissions.update(permission.id, updates);
    return c.json(formatPermission(updated!));
  });

  app.delete('/authorization/permissions/:slug', (c) => {
    const slug = c.req.param('slug');
    const permission = ws.permissions.findOneBy('slug', slug);
    if (!permission) throw notFound('Permission', slug);

    // Cascade: remove from all role-permission joins and every agent blueprint ceiling
    ws.rolePermissions.deleteBy('permission_id', permission.id);
    removePermissionFromAgentBlueprints(ws, permission.slug);

    ws.permissions.delete(permission.id);
    return c.body(null, 204);
  });
}
