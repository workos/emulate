import { createHash } from 'node:crypto';
import { type RouteContext, notFound, parseJsonBody, WorkOSApiError, generateId } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatUser,
  formatDeviceAuthorization,
  verifyPassword,
  isExpired,
  expiresIn,
  assertLocalRedirectUri,
  sealSession,
  AUTH_METHOD_SESSION_VALUES,
  resolveResponseAuthMethod,
  emitAuthenticationEvent,
  generateCode,
  formatAuthChallenge,
} from '../helpers.js';
import type { EventBus } from '../event-bus.js';
import { STORE_KEYS, STORE_KEY_PREFIXES } from '../constants.js';
import { renderLoginPage } from '../login-page.js';

interface PendingAuth {
  user_id: string;
  organization_id: string | null;
  auth_method: string;
}

interface AuthorizeParams {
  redirectUri: string;
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  loginHint: string | null;
}

export function authRoutes(ctx: RouteContext): void {
  const { app, store, jwt } = ctx;
  const ws = getWorkOSStore(store);

  function resolveAndRedirect(c: any, params: AuthorizeParams) {
    const { redirectUri, state, codeChallenge, codeChallengeMethod, loginHint } = params;

    assertLocalRedirectUri(redirectUri);

    let user;
    if (loginHint) {
      user = ws.users.findOneBy('email', loginHint);
      if (!user) {
        const redirect = new URL(redirectUri);
        redirect.searchParams.set('error', 'user_not_found');
        if (state) redirect.searchParams.set('state', state);
        return c.redirect(redirect.toString());
      }
    } else {
      const users = ws.users.all();
      user = users[0];
    }

    if (!user) {
      const redirect = new URL(redirectUri);
      redirect.searchParams.set('error', 'no_users');
      if (state) redirect.searchParams.set('state', state);
      return c.redirect(redirect.toString());
    }

    const authCode = ws.authCodes.insert({
      user_id: user.id,
      organization_id: null,
      code: generateId('auth_code'),
      redirect_uri: redirectUri,
      expires_at: expiresIn(10),
      code_challenge: codeChallenge ?? null,
      code_challenge_method: codeChallengeMethod ?? null,
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', authCode.code);
    if (state) redirect.searchParams.set('state', state);
    return c.redirect(redirect.toString());
  }

  app.get('/user_management/authorize', (c) => {
    const url = new URL(c.req.url);
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const codeChallenge = url.searchParams.get('code_challenge');
    const codeChallengeMethod = url.searchParams.get('code_challenge_method');
    const loginHint = url.searchParams.get('login_hint');

    if (!redirectUri) {
      throw new WorkOSApiError(400, 'redirect_uri is required', 'invalid_request');
    }

    const interactive = store.getData<boolean>(STORE_KEYS.interactiveAuth);
    if (interactive) {
      const hiddenFields: Record<string, string> = { redirect_uri: redirectUri };
      if (state) hiddenFields.state = state;
      if (codeChallenge) hiddenFields.code_challenge = codeChallenge;
      if (codeChallengeMethod) hiddenFields.code_challenge_method = codeChallengeMethod;

      return c.html(
        renderLoginPage({
          title: 'Sign In',
          subtitle: 'Enter your email to sign in to your account.',
          emailHint: loginHint ?? undefined,
          formAction: '/user_management/authorize',
          hiddenFields,
        }),
      );
    }

    return resolveAndRedirect(c, { redirectUri, state, codeChallenge, codeChallengeMethod, loginHint });
  });

  app.post('/user_management/authorize', async (c) => {
    const form = await c.req.parseBody();
    const redirectUri = form.redirect_uri as string;
    if (!redirectUri) {
      throw new WorkOSApiError(400, 'redirect_uri is required', 'invalid_request');
    }

    return resolveAndRedirect(c, {
      redirectUri,
      state: (form.state as string) ?? null,
      codeChallenge: (form.code_challenge as string) ?? null,
      codeChallengeMethod: (form.code_challenge_method as string) ?? null,
      loginHint: (form.email as string) ?? null,
    });
  });

  // Device authorization endpoint
  app.post('/user_management/authorize/device', async (c) => {
    const body = await parseJsonBody(c);
    const clientId = body.client_id as string;
    if (!clientId) {
      throw new WorkOSApiError(400, 'client_id is required', 'invalid_request');
    }

    // Auto-approve with first user for emulator convenience
    const users = ws.users.all();
    const user = users[0] ?? null;

    const deviceAuth = ws.deviceAuthorizations.insert({
      device_code: generateId('dev_code'),
      user_code: Math.random().toString(36).slice(2, 10).toUpperCase(),
      user_id: user?.id ?? null,
      client_id: clientId,
      expires_at: expiresIn(15),
      interval: 5,
    });

    return c.json(formatDeviceAuthorization(deviceAuth));
  });

  // AuthKit SDK uses /x/authkit/users/authenticate for the same flow
  const authenticateHandler = async (c: any) => {
    const body = await parseJsonBody(c);
    const grantType = body.grant_type as string | undefined;
    const clientId = body.client_id as string | undefined;
    const clientSecret = body.client_secret as string | undefined;

    if (!grantType) {
      throw new WorkOSApiError(400, 'grant_type is required', 'invalid_request');
    }

    const requestIp = c.req.header('x-forwarded-for') ?? null;
    const requestUserAgent = c.req.header('user-agent') ?? null;

    /** Emit the spec's authentication.*_failed event for a credential failure, then throw. */
    const failAuth: (
      method: string,
      info: { email?: string | null; userId?: string | null },
      error: WorkOSApiError,
    ) => never = (method, info, error) => {
      emitAuthenticationEvent({
        eventBus: store.getData<EventBus>(STORE_KEYS.eventBus),
        method,
        status: 'failed',
        userId: info.userId,
        email: info.email,
        ipAddress: requestIp,
        userAgent: requestUserAgent,
        error: { code: error.code, message: error.message },
      });
      throw error;
    };

    /**
     * Initiate the MFA second factor. Records the primary method on a pending-auth token so
     * the eventual session reports it (not 'unknown'), creates a challenge for the factor, and
     * returns the spec's `mfa_challenge` code plus the fields a client needs to complete the
     * urn:workos:oauth:grant-type:mfa-totp grant. (The spec documents the mfa_challenge code but
     * not this response body; the pending_authentication_token/challenge fields mirror WorkOS.)
     */
    const issueMfaChallenge = (
      mfaUser: { id: string },
      orgId: string | null,
      primaryMethod: string,
      factor: { id: string },
    ) => {
      const pendingToken = generateId('pending');
      store.setData(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`, {
        user_id: mfaUser.id,
        organization_id: orgId,
        auth_method: primaryMethod,
      });
      const challenge = ws.authChallenges.insert({
        object: 'authentication_challenge',
        user_id: mfaUser.id,
        factor_id: factor.id,
        expires_at: expiresIn(10),
        code: generateCode(),
      });
      return c.json(
        {
          code: 'mfa_challenge',
          message: 'Multi-factor authentication is required to continue.',
          pending_authentication_token: pendingToken,
          authentication_challenge: formatAuthChallenge(challenge),
        },
        403,
      );
    };

    let user;
    let organizationId: string | null = null;
    let authMethod: string;
    // The session's auth_method can differ from the event method: an MFA completion emits
    // authentication.mfa_succeeded but the session records the primary factor that was
    // challenged (e.g. 'password'). Left undefined, the session falls back to authMethod.
    let sessionAuthMethod: string | undefined;
    // A token refresh rotates credentials for an existing session; it is not a fresh login,
    // so it creates no new session and emits no authentication.*_succeeded event. Genuine
    // authentications leave this true; refresh_token flips it off and sets refreshSessionId.
    let isFreshLogin = true;
    let refreshSessionId: string | null = null;

    switch (grantType) {
      case 'authorization_code': {
        const code = body.code as string;
        if (!code) throw new WorkOSApiError(400, 'code is required', 'invalid_request');

        const authCode = ws.authCodes.findOneBy('code', code);
        if (!authCode) failAuth('OAuth', {}, new WorkOSApiError(400, 'Invalid code', 'invalid_code'));
        if (isExpired(authCode.expires_at)) {
          failAuth(
            'OAuth',
            { userId: authCode.user_id, email: ws.users.get(authCode.user_id)?.email },
            new WorkOSApiError(400, 'Code has expired', 'expired_code'),
          );
        }

        if (authCode.code_challenge) {
          const codeVerifier = body.code_verifier as string;
          if (!codeVerifier) {
            throw new WorkOSApiError(400, 'code_verifier is required', 'invalid_request');
          }
          const method = authCode.code_challenge_method ?? 'S256';
          let challenge: string;
          if (method === 'S256') {
            challenge = createHash('sha256').update(codeVerifier).digest('base64url');
          } else {
            challenge = codeVerifier;
          }
          if (challenge !== authCode.code_challenge) {
            failAuth(
              'OAuth',
              { userId: authCode.user_id, email: ws.users.get(authCode.user_id)?.email },
              new WorkOSApiError(400, 'Invalid code_verifier', 'invalid_code_verifier'),
            );
          }
        }

        user = ws.users.get(authCode.user_id);
        organizationId = authCode.organization_id;
        ws.authCodes.delete(authCode.id);
        authMethod = 'OAuth';
        break;
      }

      case 'password': {
        const email = body.email as string;
        const password = body.password as string;
        if (!email || !password) {
          throw new WorkOSApiError(400, 'email and password are required', 'invalid_request');
        }

        user = ws.users.findOneBy('email', email);
        if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
          failAuth(
            'Password',
            { email, userId: user?.id },
            new WorkOSApiError(401, 'Invalid credentials', 'invalid_credentials'),
          );
        }
        authMethod = 'Password';

        // A user with enrolled factors must clear a second factor before a session is issued:
        // hand back a pending token (recording 'Password' as the primary method) and a challenge.
        const passwordFactors = ws.authFactors.findBy('user_id', user.id);
        if (passwordFactors.length > 0) {
          return issueMfaChallenge(user, organizationId, 'Password', passwordFactors[0]);
        }
        break;
      }

      // Accept both old and new grant type names for magic-auth
      case 'urn:workos:oauth:grant-type:magic-auth':
      case 'urn:workos:oauth:grant-type:magic-auth:code': {
        const code = body.code as string;
        const email = body.email as string;
        if (!code || !email) {
          throw new WorkOSApiError(400, 'code and email are required', 'invalid_request');
        }

        const magicAuth = ws.magicAuths.all().find((ma) => ma.code === code && ma.email === email);
        if (!magicAuth) {
          failAuth('MagicAuth', { email }, new WorkOSApiError(400, 'Invalid code', 'invalid_code'));
        }
        if (isExpired(magicAuth.expires_at)) {
          failAuth(
            'MagicAuth',
            { email: magicAuth.email, userId: magicAuth.user_id },
            new WorkOSApiError(400, 'Code has expired', 'expired_code'),
          );
        }

        user = ws.users.get(magicAuth.user_id);
        ws.magicAuths.delete(magicAuth.id);
        authMethod = 'MagicAuth';
        break;
      }

      // Accept both old and new grant type names for email-verification
      case 'urn:workos:oauth:grant-type:email-verification':
      case 'urn:workos:oauth:grant-type:email-verification:code': {
        const code = body.code as string;
        const userId = body.user_id as string;
        if (!code || !userId) {
          throw new WorkOSApiError(400, 'code and user_id are required', 'invalid_request');
        }

        const ev = ws.emailVerifications.findBy('user_id', userId).find((v) => v.code === code);
        if (!ev) {
          failAuth(
            'EmailVerification',
            { userId, email: ws.users.get(userId)?.email },
            new WorkOSApiError(400, 'Invalid code', 'invalid_code'),
          );
        }
        if (isExpired(ev.expires_at)) {
          failAuth(
            'EmailVerification',
            { email: ev.email, userId: ev.user_id },
            new WorkOSApiError(400, 'Code has expired', 'expired_code'),
          );
        }

        ws.users.update(userId, { email_verified: true });
        ws.emailVerifications.delete(ev.id);
        user = ws.users.get(userId);
        authMethod = 'EmailVerification';
        break;
      }

      case 'refresh_token': {
        const token = body.refresh_token as string;
        if (!token) {
          throw new WorkOSApiError(400, 'refresh_token is required', 'invalid_request');
        }

        const refreshToken = ws.refreshTokens.findOneBy('token', token);
        if (!refreshToken) {
          throw new WorkOSApiError(400, 'Invalid refresh token', 'invalid_grant');
        }
        if (isExpired(refreshToken.expires_at)) {
          ws.refreshTokens.delete(refreshToken.id);
          throw new WorkOSApiError(400, 'Refresh token has expired', 'invalid_grant');
        }

        user = ws.users.get(refreshToken.user_id);
        // Allow body.organization_id to switch org context (switchToOrganization)
        organizationId = (body.organization_id as string) ?? refreshToken.organization_id;

        // Rotate within the existing session: capture it for reuse, delete the old token,
        // and issue a new one below — no new session, no authentication event.
        refreshSessionId = refreshToken.session_id;
        ws.refreshTokens.delete(refreshToken.id);
        authMethod = 'OAuth';
        isFreshLogin = false;
        break;
      }

      case 'urn:workos:oauth:grant-type:mfa-totp': {
        const code = body.code as string;
        const pendingToken = body.pending_authentication_token as string;
        const challengeId = body.authentication_challenge_id as string;

        if (!code || !pendingToken || !challengeId) {
          throw new WorkOSApiError(
            400,
            'code, pending_authentication_token, and authentication_challenge_id are required',
            'invalid_request',
          );
        }

        const pending = store.getData<PendingAuth>(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`);
        if (!pending) {
          throw new WorkOSApiError(400, 'Invalid pending authentication token', 'invalid_pending_authentication_token');
        }

        const challenge = ws.authChallenges.get(challengeId);
        if (!challenge) {
          throw new WorkOSApiError(400, 'Invalid authentication challenge', 'invalid_request');
        }
        if (isExpired(challenge.expires_at)) {
          ws.authChallenges.delete(challenge.id);
          failAuth(
            'MFA',
            { userId: pending.user_id, email: ws.users.get(pending.user_id)?.email },
            new WorkOSApiError(400, 'Challenge has expired', 'expired_challenge'),
          );
        }

        // Verify code against the challenge's stored code
        if (challenge.code && code !== challenge.code) {
          failAuth(
            'MFA',
            { userId: pending.user_id, email: ws.users.get(pending.user_id)?.email },
            new WorkOSApiError(400, 'Invalid one-time code', 'invalid_one_time_code'),
          );
        }

        ws.authChallenges.delete(challenge.id);
        store.setData(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`, undefined);

        user = ws.users.get(pending.user_id);
        organizationId = pending.organization_id;
        // Event is authentication.mfa_succeeded; the session records the primary factor the
        // pending token was issued for (MFA is a second factor, not a session auth method).
        authMethod = 'MFA';
        sessionAuthMethod = pending.auth_method;
        break;
      }

      case 'urn:workos:oauth:grant-type:organization-selection': {
        const pendingToken = body.pending_authentication_token as string;
        const orgId = body.organization_id as string;

        if (!pendingToken || !orgId) {
          throw new WorkOSApiError(
            400,
            'pending_authentication_token and organization_id are required',
            'invalid_request',
          );
        }

        const pending = store.getData<PendingAuth>(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`);
        if (!pending) {
          throw new WorkOSApiError(400, 'Invalid pending authentication token', 'invalid_pending_authentication_token');
        }

        const org = ws.organizations.get(orgId);
        if (!org) throw notFound('Organization');

        store.setData(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`, undefined);

        user = ws.users.get(pending.user_id);
        organizationId = orgId;
        authMethod = pending.auth_method;
        break;
      }

      case 'urn:ietf:params:oauth:grant-type:device_code': {
        const deviceCode = body.device_code as string;
        if (!deviceCode) {
          throw new WorkOSApiError(400, 'device_code is required', 'invalid_request');
        }

        const deviceAuth = ws.deviceAuthorizations.findOneBy('device_code', deviceCode);
        if (!deviceAuth) {
          throw new WorkOSApiError(400, 'Invalid device code', 'invalid_grant');
        }
        if (isExpired(deviceAuth.expires_at)) {
          ws.deviceAuthorizations.delete(deviceAuth.id);
          throw new WorkOSApiError(400, 'Device code has expired', 'expired_token');
        }
        if (!deviceAuth.user_id) {
          throw new WorkOSApiError(400, 'Authorization pending', 'authorization_pending');
        }

        user = ws.users.get(deviceAuth.user_id);
        ws.deviceAuthorizations.delete(deviceAuth.id);
        authMethod = 'OAuth';
        break;
      }

      default:
        throw new WorkOSApiError(400, `Unsupported grant_type: ${grantType}`, 'invalid_request');
    }

    if (!user) throw notFound('User');

    // A fresh login creates a new session (firing session.created); a refresh_token rotation
    // reuses the existing session, so it emits neither session.created nor an auth event.
    let session;
    if (isFreshLogin) {
      ws.users.update(user.id, { last_sign_in_at: new Date().toISOString() });
      session = ws.sessions.insert({
        object: 'session',
        user_id: user.id,
        organization_id: organizationId,
        ip_address: requestIp,
        user_agent: requestUserAgent,
        auth_method: AUTH_METHOD_SESSION_VALUES[sessionAuthMethod ?? authMethod] ?? 'unknown',
        status: 'active',
        expires_at: expiresIn(30 * 24 * 60), // matches refresh token lifetime
        ended_at: null,
      });
    } else {
      const existing = refreshSessionId ? ws.sessions.get(refreshSessionId) : undefined;
      if (!existing) throw new WorkOSApiError(400, 'Invalid refresh token', 'invalid_grant');
      session = existing;
    }
    const updatedUser = ws.users.get(user.id)!;

    // Resolve role + permissions for org-scoped sessions
    let roleSlug: string | undefined;
    let permissionSlugs: string[] | undefined;
    if (organizationId) {
      const membership = ws.organizationMemberships
        .findBy('organization_id', organizationId)
        .find((m) => m.user_id === user.id);
      if (membership) {
        roleSlug = membership.role.slug;
        const role = ws.roles
          .findBy('slug', membership.role.slug)
          .find((r) => r.organization_id === organizationId || r.type === 'EnvironmentRole');
        if (role) {
          const rps = ws.rolePermissions.findBy('role_id', role.id);
          permissionSlugs = rps
            .map((rp) => ws.permissions.get(rp.permission_id))
            .filter(Boolean)
            .map((p) => p!.slug);
        }
      }
    }

    const accessToken = jwt.sign({
      sub: user.id,
      sid: session.id,
      org_id: organizationId ?? undefined,
      role: roleSlug,
      permissions: permissionSlugs,
      aud: clientId ?? 'workos-emulate',
    });

    // Store a real refresh token
    const newRefreshToken = ws.refreshTokens.insert({
      token: generateId('ref'),
      user_id: user.id,
      organization_id: organizationId,
      session_id: session.id,
      expires_at: expiresIn(30 * 24 * 60), // 30 days
    });

    // Compute sealed session when client_secret is provided
    const apiKey = c.req
      .header('Authorization')
      ?.replace(/^Bearer\s+/i, '')
      .trim();
    const sealKey = clientSecret ?? apiKey;
    const sealedSession = sealKey
      ? sealSession(
          { access_token: accessToken, refresh_token: newRefreshToken.token, session_id: session.id },
          sealKey,
        )
      : null;

    // Emit authentication event (hybrid Option B for action-specific events)
    if (isFreshLogin) {
      emitAuthenticationEvent({
        eventBus: store.getData<EventBus>(STORE_KEYS.eventBus),
        method: authMethod,
        status: 'succeeded',
        userId: user.id,
        email: updatedUser.email,
        ipAddress: session.ip_address,
        userAgent: session.user_agent,
      });
    }

    return c.json({
      user: formatUser(updatedUser),
      organization_id: organizationId,
      access_token: accessToken,
      refresh_token: newRefreshToken.token,
      // The response enum is PascalCase/provider-specific — the internal 'OAuth'/'MFA'/
      // 'EmailVerification' categories aren't valid here. Resolve to a spec-valid value, or
      // undefined (key omitted, like impersonator below) when the concrete method is unknown
      // rather than inventing a provider. Mirrors the session's sessionAuthMethod precedence.
      authentication_method: resolveResponseAuthMethod(sessionAuthMethod ?? authMethod, {
        oauthProvider: updatedUser.oauth_provider,
      }),
      sealed_session: sealedSession,
      impersonator: updatedUser.impersonator ?? undefined,
    });
  };

  app.post('/user_management/authenticate', authenticateHandler);
  app.post('/x/authkit/users/authenticate', authenticateHandler);
}
