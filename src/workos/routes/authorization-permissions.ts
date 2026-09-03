import {
  type RouteContext,
  WorkOSApiError,
  notFound,
  validationError,
  parseJsonBody,
  parseListParams,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatPermission, formatListResponse } from '../helpers.js';
import { DEFAULT_RESOURCE_TYPE_SLUG, isValidResourceTypeSlug } from '../constants.js';

export function authorizationPermissionRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/authorization/permissions', async (c) => {
    const body = await parseJsonBody(c);
    const slug = body.slug as string;
    const name = body.name as string;
    const resourceTypeSlug = body.resource_type_slug;

    if (!slug || typeof slug !== 'string') {
      throw validationError('slug is required', [{ field: 'slug', code: 'required' }]);
    }
    if (!name || typeof name !== 'string') {
      throw validationError('name is required', [{ field: 'name', code: 'required' }]);
    }
    // Resource types are not modeled by the emulator (no registry, no endpoint),
    // so any non-empty slug is accepted. Production requires a defined type.
    if (!isValidResourceTypeSlug(resourceTypeSlug)) {
      throw validationError('resource_type_slug must be a non-empty string', [
        { field: 'resource_type_slug', code: 'invalid' },
      ]);
    }

    const existing = ws.permissions.findOneBy('slug', slug);
    if (existing) {
      // Production answers a taken slug with 409 permission_slug_conflict, not a 422 field error.
      throw new WorkOSApiError(409, 'Permission with this slug already exists', 'permission_slug_conflict');
    }

    const permission = ws.permissions.insert({
      object: 'permission',
      slug,
      name,
      description: (body.description as string) ?? null,
      resource_type_slug: resourceTypeSlug ?? DEFAULT_RESOURCE_TYPE_SLUG,
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
    if (!permission) throw notFound('Permission');
    return c.json(formatPermission(permission));
  });

  // The spec (and every SDK) updates a permission with PATCH; there is no PUT.
  app.patch('/authorization/permissions/:slug', async (c) => {
    const slug = c.req.param('slug');
    const permission = ws.permissions.findOneBy('slug', slug);
    if (!permission) throw notFound('Permission');

    const body = await parseJsonBody(c);
    const updates: Record<string, unknown> = {};
    if ('name' in body) updates.name = body.name;
    if ('description' in body) updates.description = body.description ?? null;

    const updated = ws.permissions.update(permission.id, updates);
    return c.json(formatPermission(updated!));
  });

  app.delete('/authorization/permissions/:slug', (c) => {
    const slug = c.req.param('slug');
    const permission = ws.permissions.findOneBy('slug', slug);
    if (!permission) throw notFound('Permission');

    // Cascade: remove from all role-permission joins
    ws.rolePermissions.deleteBy('permission_id', permission.id);

    ws.permissions.delete(permission.id);
    return c.body(null, 204);
  });
}
