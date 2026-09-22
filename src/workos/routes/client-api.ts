import { type RouteContext, notFound, parseJsonBody, validationError } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';

/**
 * The `aud` on a Client API token. The spec documents the request and the `{ token }` response
 * but says nothing about the claims inside, so this is an emulator convention: it keeps a Client
 * API token distinguishable from the session and widget tokens the same key signs.
 */
const CLIENT_API_TOKEN_AUDIENCE = 'client';

/** The spec calls the token "short-lived"; five minutes is the shortest plausible reading. */
const CLIENT_API_TOKEN_TTL_SECONDS = 300;

export function clientApiRoutes(ctx: RouteContext): void {
  const { app, jwt, store } = ctx;
  const ws = getWorkOSStore(store);

  // The emulator does not serve the Client GraphQL API, so the token is mintable and verifiable
  // against JWKS but has nothing to authenticate against.
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
    // something that cannot be looked up. `/widgets/token` skips this check; the spec
    // documents 404 on this route, so it is answered here. Membership is deliberately not
    // checked: pairing any user with any organization is how a test sets up a scenario.
    if (!ws.organizations.get(organizationId)) throw notFound('Organization');
    if (!ws.users.get(userId)) throw notFound('User');

    const token = jwt.sign(
      { sub: userId, org_id: organizationId, aud: CLIENT_API_TOKEN_AUDIENCE },
      { expiresIn: CLIENT_API_TOKEN_TTL_SECONDS },
    );

    return c.json({ token }, 201);
  });
}
