import { type RouteContext, parseJsonBody, WorkOSApiError, generateId } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatSSOProfile, expiresIn, isExpired, assertLocalRedirectUri, emitAuthenticationEvent } from '../helpers.js';
import type { WorkOSConnection } from '../entities.js';
import type { EventBus } from '../event-bus.js';
import { STORE_KEY_PREFIXES, STORE_KEYS } from '../constants.js';
import { renderLoginPage } from '../login-page.js';

interface SSOAuthorizeParams {
  redirectUri: string;
  state: string | null;
  connectionId: string | null;
  organizationId: string | null;
  domainHint: string | null;
  email: string | null;
}

export function ssoRoutes(ctx: RouteContext): void {
  const { app, store, jwt } = ctx;
  const ws = getWorkOSStore(store);

  function resolveAndRedirect(c: any, params: SSOAuthorizeParams) {
    const { redirectUri, state, connectionId, organizationId, domainHint, email: loginHint } = params;

    assertLocalRedirectUri(redirectUri);

    let connection: WorkOSConnection | undefined;

    if (connectionId) {
      connection = ws.connections.get(connectionId);
    } else if (organizationId) {
      connection = ws.connections.findBy('organization_id', organizationId).find((cn) => cn.state === 'active');
    } else if (domainHint) {
      connection = ws.connections
        .all()
        .find((cn) => cn.state === 'active' && cn.domains.some((d) => d.domain === domainHint));
    }

    if (!connection || connection.state !== 'active') {
      throw new WorkOSApiError(404, 'No active connection found', 'connection_not_found');
    }

    const email = loginHint ?? `user@${connection.domains[0]?.domain ?? 'example.com'}`;
    let profile = ws.ssoProfiles.findOneBy('email', email);
    if (!profile || profile.connection_id !== connection.id) {
      profile = ws.ssoProfiles.insert({
        object: 'profile',
        connection_id: connection.id,
        connection_type: connection.connection_type,
        organization_id: connection.organization_id,
        idp_id: `idp_${generateId('usr')}`,
        email,
        first_name: email.split('@')[0],
        last_name: null,
        groups: [],
        raw_attributes: { email },
      });
    }

    const authCode = ws.ssoAuthorizations.insert({
      code: generateId('sso_code'),
      connection_id: connection.id,
      organization_id: connection.organization_id,
      profile_id: profile.id,
      redirect_uri: redirectUri,
      state,
      expires_at: expiresIn(10),
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', authCode.code);
    if (state) redirect.searchParams.set('state', state);
    return c.redirect(redirect.toString());
  }

  app.get('/sso/authorize', (c) => {
    const url = new URL(c.req.url);
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const connectionId = url.searchParams.get('connection');
    const organizationId = url.searchParams.get('organization');
    const domainHint = url.searchParams.get('domain_hint');
    const loginHint = url.searchParams.get('login_hint');

    if (!redirectUri) {
      throw new WorkOSApiError(400, 'Missing required parameter: redirect_uri', 'invalid_request');
    }

    const interactive = store.getData<boolean>(STORE_KEYS.interactiveAuth);
    if (interactive) {
      const hiddenFields: Record<string, string> = { redirect_uri: redirectUri };
      if (state) hiddenFields.state = state;
      if (connectionId) hiddenFields.connection = connectionId;
      if (organizationId) hiddenFields.organization = organizationId;
      if (domainHint) hiddenFields.domain_hint = domainHint;

      return c.html(
        renderLoginPage({
          title: 'SSO Login',
          subtitle: 'Sign in with your corporate identity.',
          emailHint: loginHint ?? undefined,
          formAction: '/sso/authorize',
          hiddenFields,
        }),
      );
    }

    return resolveAndRedirect(c, {
      redirectUri,
      state,
      connectionId,
      organizationId,
      domainHint,
      email: loginHint,
    });
  });

  app.post('/sso/authorize', async (c) => {
    const form = await c.req.parseBody();
    const redirectUri = form.redirect_uri as string;
    if (!redirectUri) {
      throw new WorkOSApiError(400, 'Missing required parameter: redirect_uri', 'invalid_request');
    }

    return resolveAndRedirect(c, {
      redirectUri,
      state: (form.state as string) ?? null,
      connectionId: (form.connection as string) ?? null,
      organizationId: (form.organization as string) ?? null,
      domainHint: (form.domain_hint as string) ?? null,
      email: (form.email as string) ?? null,
    });
  });

  app.post('/sso/token', async (c) => {
    const body = await parseJsonBody(c);
    const grantType = body.grant_type as string;
    const code = body.code as string;

    if (grantType !== 'authorization_code') {
      throw new WorkOSApiError(400, 'Unsupported grant_type', 'invalid_request');
    }
    if (!code) {
      throw new WorkOSApiError(400, 'code is required', 'invalid_request');
    }

    const auth = ws.ssoAuthorizations.findOneBy('code', code);
    if (!auth) {
      const error = new WorkOSApiError(400, 'Invalid authorization code', 'invalid_code');
      emitAuthenticationEvent({
        eventBus: store.getData<EventBus>(STORE_KEYS.eventBus),
        method: 'SSO',
        status: 'failed',
        error: { code: error.code, message: error.message },
        ipAddress: c.req.header('x-forwarded-for') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
      });
      throw error;
    }
    if (isExpired(auth.expires_at)) {
      ws.ssoAuthorizations.delete(auth.id);
      const expiredProfile = ws.ssoProfiles.get(auth.profile_id);
      const error = new WorkOSApiError(400, 'Authorization code has expired', 'expired_code');
      emitAuthenticationEvent({
        eventBus: store.getData<EventBus>(STORE_KEYS.eventBus),
        method: 'SSO',
        status: 'failed',
        email: expiredProfile?.email,
        userId: ws.users.findOneBy('email', expiredProfile?.email ?? '')?.id,
        error: { code: error.code, message: error.message },
        ipAddress: c.req.header('x-forwarded-for') ?? null,
        userAgent: c.req.header('user-agent') ?? null,
        sso: {
          organization_id: auth.organization_id,
          connection_id: expiredProfile?.connection_id ?? null,
          session_id: null,
        },
      });
      throw error;
    }

    const profile = ws.ssoProfiles.get(auth.profile_id);
    if (!profile) {
      throw new WorkOSApiError(500, 'Profile not found', 'server_error');
    }

    ws.ssoAuthorizations.delete(auth.id);

    const accessToken = jwt.sign({
      sub: profile.id,
      aud: (body.client_id as string) ?? 'workos-emulate',
      org_id: auth.organization_id,
    });

    store.setData(`${STORE_KEY_PREFIXES.ssoToken}${accessToken}`, profile.id);

    // SSO is profile-based; a user-management user may not exist for this email
    emitAuthenticationEvent({
      eventBus: store.getData<EventBus>(STORE_KEYS.eventBus),
      method: 'SSO',
      status: 'succeeded',
      email: profile.email,
      userId: ws.users.findOneBy('email', profile.email)?.id ?? null,
      ipAddress: c.req.header('x-forwarded-for') ?? null,
      userAgent: c.req.header('user-agent') ?? null,
      sso: {
        organization_id: auth.organization_id ?? profile.organization_id,
        connection_id: profile.connection_id,
        session_id: null,
      },
    });

    return c.json({
      profile: formatSSOProfile(profile),
      access_token: accessToken,
    });
  });

  app.get('/sso/profile', (c) => {
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      throw new WorkOSApiError(401, 'Unauthorized', 'unauthorized');
    }
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();

    const profileId = store.getData<string>(`${STORE_KEY_PREFIXES.ssoToken}${token}`);
    if (!profileId) {
      try {
        const payload = jwt.verify(token);
        const profile = ws.ssoProfiles.get(payload.sub);
        if (profile) return c.json(formatSSOProfile(profile));
      } catch {
        // fall through
      }
      throw new WorkOSApiError(401, 'Invalid access token', 'unauthorized');
    }

    const profile = ws.ssoProfiles.get(profileId);
    if (!profile) {
      throw new WorkOSApiError(404, 'Profile not found', 'not_found');
    }

    return c.json(formatSSOProfile(profile));
  });

  app.get('/sso/jwks', (c) => {
    return c.json(jwt.getJWKS());
  });

  // SSO Single Logout — generate logout token
  app.post('/sso/logout/authorize', async (c) => {
    const body = await parseJsonBody(c);
    const profileId = body.profile_id as string;
    if (!profileId) {
      throw new WorkOSApiError(400, 'profile_id is required', 'invalid_request');
    }

    const profile = ws.ssoProfiles.get(profileId);
    if (!profile) {
      throw new WorkOSApiError(404, 'Profile not found', 'not_found');
    }

    const logoutToken = generateId('sso_logout');
    store.setData(`${STORE_KEY_PREFIXES.ssoLogout}${logoutToken}`, profile.id);

    return c.json({
      logout_token: logoutToken,
      logout_url: `${ctx.baseUrl}/sso/logout?logout_token=${logoutToken}`,
    });
  });

  // SSO Single Logout — redirect (public, no auth)
  app.get('/sso/logout', (c) => {
    const url = new URL(c.req.url);
    const logoutToken = url.searchParams.get('logout_token');

    if (!logoutToken) {
      throw new WorkOSApiError(400, 'logout_token is required', 'invalid_request');
    }

    const profileId = store.getData<string>(`${STORE_KEY_PREFIXES.ssoLogout}${logoutToken}`);
    if (!profileId) {
      throw new WorkOSApiError(400, 'Invalid logout token', 'invalid_logout_token');
    }

    store.setData(`${STORE_KEY_PREFIXES.ssoLogout}${logoutToken}`, undefined);
    return c.json({ success: true });
  });
}
