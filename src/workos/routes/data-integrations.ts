import {
  type RouteContext,
  parseJsonBody,
  badRequest,
  WorkOSApiError,
  notFound,
  validationError,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  assertActiveMember,
  assertAllowedRedirectUri,
  generateVerificationToken,
  expiresIn,
  isExpired,
  findConnectedAccount,
  findOrganizationConnectedAccount,
  vendAccessToken,
} from '../helpers.js';
import type { ConnectionOwner, WorkOSUser } from '../entities.js';

const CONNECTION_OWNERS: ConnectionOwner[] = ['user', 'organization'];

/** Who a request acts for: `user_id` always, and the organization when it owns or scopes the account. */
interface Owner {
  connectionOwner: ConnectionOwner;
  user: WorkOSUser;
  organizationId: string | null;
}

export function dataIntegrationRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  /**
   * The owner `/credentials` names in its body. Naming an organization, for
   * either owner, requires the user to be an active member of it: the spec's 403 covers both an
   * organization connection and an organization-scoped personal one. A malformed body is the
   * spec's 400 for this route, not the 422 `/token` answers.
   */
  function resolveOwner(body: Record<string, unknown>): Owner {
    if (typeof body.user_id !== 'string' || !body.user_id) throw badRequest('user_id must be a string');
    const organizationId = body.organization_id ?? null;
    if (organizationId !== null && (typeof organizationId !== 'string' || !organizationId)) {
      throw badRequest('organization_id must be a string');
    }
    const connectionOwner = (body.connection_owner ?? 'user') as ConnectionOwner;
    if (!CONNECTION_OWNERS.includes(connectionOwner)) {
      throw badRequest(`connection_owner must be one of the following values: ${CONNECTION_OWNERS.join(', ')}`);
    }
    if (connectionOwner === 'organization' && !organizationId) {
      throw badRequest('organization_id is required when connection_owner is organization');
    }

    const user = ws.users.get(body.user_id);
    if (!user) throw notFound('User', body.user_id);
    if (organizationId) {
      if (!ws.organizations.get(organizationId)) throw notFound('Organization', organizationId);
      assertActiveMember(ws, organizationId, user.id);
    }
    return { connectionOwner, user, organizationId };
  }

  // Authorize (public endpoint — no auth required)
  app.get('/data-integrations/:slug/authorize', (c) => {
    const slug = c.req.param('slug');
    const url = new URL(c.req.url);
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state') ?? null;

    if (!redirectUri) {
      throw new WorkOSApiError(400, 'redirect_uri is required', 'invalid_request');
    }
    assertAllowedRedirectUri(redirectUri, store);

    const code = generateVerificationToken();
    ws.dataIntegrationAuths.insert({
      slug,
      code,
      redirect_uri: redirectUri,
      state,
      expires_at: expiresIn(10),
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    if (state) redirect.searchParams.set('state', state);

    return c.redirect(redirect.toString(), 302);
  });

  // The spec's credential vend, for user- and organization-owned accounts alike.
  app.post('/data-integrations/:slug/credentials', async (c) => {
    const slug = c.req.param('slug');
    const owner = resolveOwner(await parseJsonBody(c));

    const account =
      owner.connectionOwner === 'organization'
        ? findOrganizationConnectedAccount(ws, owner.organizationId!, slug)
        : findConnectedAccount(ws, owner.user.id, slug, owner.organizationId);
    if (!account) return c.json({ active: false, error: 'not_installed' });
    // A personal account scoped to an organization needs the membership even when the request
    // leaves `organization_id` out and the account is the only one for the provider.
    if (account.organization_id) assertActiveMember(ws, account.organization_id, owner.user.id);

    const vended = vendAccessToken(ws, account);
    if (!vended) return c.json({ active: false, error: 'needs_reauthorization' });
    return c.json({
      active: true,
      credential: {
        object: 'credential',
        auth_method: 'oauth',
        value: vended.access_token,
        expires_at: vended.token_expires_at,
        scopes: vended.scopes,
        missing_scopes: [],
        config: {},
      },
    });
  });

  // Retrieve a connected account's token (the spec's request), or exchange a legacy authorization code.
  app.post('/data-integrations/:slug/token', async (c) => {
    const slug = c.req.param('slug');
    const body = await parseJsonBody(c);

    if (body.code === undefined) {
      if (body.user_id === undefined) {
        throw validationError('user_id is required', [{ field: 'user_id', code: 'required' }]);
      }
      if (typeof body.user_id !== 'string' || !body.user_id) {
        throw validationError('user_id must be a non-empty string', [{ field: 'user_id', code: 'invalid' }]);
      }
      const organizationId = body.organization_id ?? null;
      if (organizationId !== null && (typeof organizationId !== 'string' || !organizationId)) {
        throw validationError('organization_id must be a non-empty string', [
          { field: 'organization_id', code: 'invalid' },
        ]);
      }
      if (!ws.users.get(body.user_id)) throw notFound('User', body.user_id);
      if (organizationId && !ws.organizations.get(organizationId)) throw notFound('Organization', organizationId);

      const account = findConnectedAccount(ws, body.user_id, slug, organizationId);
      if (!account) return c.json({ active: false, error: 'not_installed' });

      const vended = vendAccessToken(ws, account);
      if (!vended) return c.json({ active: false, error: 'needs_reauthorization' });

      return c.json({
        active: true,
        access_token: {
          object: 'access_token',
          access_token: vended.access_token,
          expires_at: vended.token_expires_at,
          scopes: vended.scopes,
          missing_scopes: [],
        },
      });
    }

    const code = body.code as string | undefined;

    if (!code) {
      throw new WorkOSApiError(400, 'code is required', 'invalid_request');
    }

    const auth = ws.dataIntegrationAuths.findOneBy('code', code);
    if (!auth || auth.slug !== slug) {
      throw new WorkOSApiError(400, 'Invalid authorization code', 'invalid_grant');
    }

    if (isExpired(auth.expires_at)) {
      ws.dataIntegrationAuths.delete(auth.id);
      throw new WorkOSApiError(400, 'Authorization code has expired', 'invalid_grant');
    }

    ws.dataIntegrationAuths.delete(auth.id);

    return c.json({
      access_token: `di_mock_${slug}_${generateVerificationToken().slice(0, 8)}`,
      token_type: 'bearer',
      expires_in: 3600,
    });
  });
}
