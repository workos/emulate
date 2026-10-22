import type { RouteContext } from '../../core/index.js';
import { ROLE_CREATE_RULES } from '../authorization-validation.js';
import { environmentRoles, findEnvRole, requireEnvRole, registerRoleRoutes } from '../role-helpers.js';

export function authorizationRoleRoutes(ctx: RouteContext): void {
  registerRoleRoutes(ctx, {
    pathPrefix: '/authorization/roles',
    roleType: 'EnvironmentRole',
    requireRole: (ws, c) => requireEnvRole(ws, c.req.param('slug')!),
    findRole: (ws, _c, slug) => findEnvRole(ws, slug),
    createRules: ROLE_CREATE_RULES,
    slugFor: (body) => body.slug as string,
    // The spec: "List all environment roles in priority order." Unpaged, like the organization list.
    listRoles: (ws) => environmentRoles(ws),
    insertDefaults: () => ({ organization_id: null }),
    duplicateMessage: 'Role with this slug already exists',
    duplicateCode: 'role_slug_conflict',
  });
}
