import { type RouteContext, notFound, parseJsonBody, validationError } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';

/**
 * The `aud` on a Client API token. The spec documents the request and the `{ token }` response
 * but says nothing about the claims inside, so this is an emulator convention: it keeps a Client
 * API token distinguishable from the session and widget tokens the same key signs.
 */
export const CLIENT_API_TOKEN_AUDIENCE = 'client';

/** The spec calls the token "short-lived"; five minutes is the shortest plausible reading. */
const CLIENT_API_TOKEN_TTL_SECONDS = 300;

export function clientApiRoutes(ctx: RouteContext): void {
  const { app, jwt, store } = ctx;
  const ws = getWorkOSStore(store);

  // The token authenticates `POST /client/graphql` (see client-graphql.ts) alongside the widget
  // token and an AuthKit access token, as production's Client API guard accepts all three.
  app.post('/client/token', async (c) => {
    const body = await parseJsonBody(c);
    const organizationId = body.organization_id;
    const userId = body.user_id;

    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw validationError('organization_id is required', [{ field: 'organization_id', code: 'required' }]);
    }
    if (typeof userId !== 'string' || userId.length === 0) {
      throw validationError('user_id is required', [{ field: 'user_id', code: 'required' }]);
    }

    // The token names both principals, so a dangling id would mint a credential scoped to
    // something that cannot be looked up; the spec documents 404 on this route.
    if (!ws.organizations.get(organizationId)) throw notFound('Organization', organizationId);
    if (!ws.users.get(userId)) throw notFound('User', userId);

    // Production mints this token through its widget-session issuer, which refuses a user who
    // holds no *active* membership in the organization — a 404 naming the membership, as
    // `/widgets/token` answers it. `/client/graphql` re-checks the same membership on every
    // request, so a token minted without one could never authenticate there.
    const isMember = ws.organizationMemberships
      .findBy('organization_id', organizationId)
      .some((m) => m.user_id === userId && m.status === 'active');
    if (!isMember) throw notFound('UserOrganizationMembership', organizationId);

    const token = jwt.sign(
      { sub: userId, org_id: organizationId, aud: CLIENT_API_TOKEN_AUDIENCE },
      { expiresIn: CLIENT_API_TOKEN_TTL_SECONDS },
    );

    return c.json({ token }, 201);
  });
}
