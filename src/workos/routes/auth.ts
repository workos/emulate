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
  resolveSessionResponseAuthMethod,
  emitAuthenticationEvent,
  generateCode,
  formatAuthChallenge,
  acceptInvitation,
} from '../helpers.js';
import { renderConfiguredJwtTemplate } from '../jwt-template.js';
import type { EventBus } from '../event-bus.js';
import type { WorkOSInvitation } from '../entities.js';
import { STORE_KEYS, STORE_KEY_PREFIXES } from '../constants.js';
import { renderLoginPage } from '../login-page.js';

interface PendingAuth {
  user_id: string;
  organization_id: string | null;
  auth_method: string;
  /** Carried across an MFA challenge so the second factor doesn't drop a pending invitation. */
  invitation_token?: string | null;
}

/**
 * The grants whose request schema carries `invitation_token`. Production has nowhere to put one on
 * any other grant, so it is ignored rather than honored there — accepting it everywhere would let
 * a call that works against the emulator silently skip the invitation in production.
 */
const INVITATION_TOKEN_GRANTS = new Set([
  'authorization_code',
  'password',
  'urn:workos:oauth:grant-type:magic-auth',
  'urn:workos:oauth:grant-type:magic-auth:code',
]);

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

    /** Resolve an invitation token, rejecting one that is unknown, expired or already used. */
    const resolveInvitation = (token: string): WorkOSInvitation => {
      const inv = ws.invitations.findOneBy('token', token);
      if (!inv || inv.state !== 'pending' || isExpired(inv.expires_at)) {
        throw new WorkOSApiError(
          400,
          'The invitation is invalid, expired, or has already been accepted',
          'invitation_invalid',
        );
      }
      return inv;
    };

    // Resolved before the grant runs so a bad invitation cannot burn the one-time code or
    // authorization code the same request carries; the recipient check waits until the grant has
    // told us who is signing in.
    let invitation: WorkOSInvitation | null =
      INVITATION_TOKEN_GRANTS.has(grantType) && body.invitation_token
        ? resolveInvitation(body.invitation_token as string)
        : null;

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
        invitation_token: invitation?.token ?? null,
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

        // A deferred invitation is revalidated before the challenge and pending token are consumed.
        // One revoked or expired during the challenge still fails the request, but the state behind
        // it survives, so a retry reports the same invitation_invalid rather than degrading into a
        // confusing invalid_pending_authentication_token once the record is gone.
        const deferredInvitation = pending.invitation_token ? resolveInvitation(pending.invitation_token) : null;

        ws.authChallenges.delete(challenge.id);
        store.setData(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`, undefined);

        user = ws.users.get(pending.user_id);
        organizationId = pending.organization_id;
        // Accepted further down, now that the second factor has proven who is signing in.
        invitation = deferredInvitation;
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

        // Production only scopes a session to an organization the user actually belongs to.
        // Unvalidated, a client could select any organization id and receive a token whose
        // org_id claim production would never issue. Checked before the pending token is
        // consumed, so a client that picks the wrong organization can retry with the right one.
        const selectable = ws.organizationMemberships
          .findBy('organization_id', orgId)
          .find((m) => m.user_id === pending.user_id && m.status === 'active');
        if (!selectable) {
          throw new WorkOSApiError(
            400,
            'The user is not an active member of the selected organization',
            'organization_membership_not_found',
          );
        }

        // An invitation deferred to the selection step (one naming no organization of its own) is
        // revalidated on the same before-consumption rule as the MFA grant above.
        const deferredInvitation = pending.invitation_token ? resolveInvitation(pending.invitation_token) : null;

        store.setData(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`, undefined);

        user = ws.users.get(pending.user_id);
        organizationId = orgId;
        invitation = deferredInvitation;
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

    // Accepting an invitation is the one way a caller can name the organization on a grant that
    // takes no organization_id, so an invitation's organization wins over anything the grant itself
    // chose and settles the resolution below.
    // Rejected before anything is consumed, so a token addressed to somebody else costs the caller
    // neither their credential nor the invitation. Compared case-insensitively: an invitation to
    // Foo@example.com is for the same person as foo@example.com, and rejecting on letter case alone
    // would be a false negative.
    if (invitation && invitation.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new WorkOSApiError(
        400,
        'The invitation was issued for a different email address',
        'invitation_cannot_be_used_for_email',
      );
    }
    // The organization is read here, but the invitation is not spent until this request is known to
    // be issuing a session — see the acceptance below the resolution step.
    if (invitation?.organization_id) organizationId = invitation.organization_id;

    // Resolve the organization for any fresh login that hasn't already picked one. Production
    // does this on every grant: a single active membership is selected implicitly, several
    // return organization_selection_required so the client can choose. Only three of the grants
    // above set organizationId themselves, and authorization_code reads it off a code minted
    // with organization_id: null — so without this step magic-auth, password, email-verification,
    // device_code and the whole AuthKit hosted flow could each mint only an unscoped session,
    // and anything authorizing on the org_id claim rejected every token the emulator issued.
    //
    // Runs before the session is created so the session records the resolved organization and a
    // selection-required response leaves behind neither a session nor a sign-in timestamp. A
    // refresh is excluded: it reuses a session whose scope is already settled, and an explicit
    // body.organization_id stays the only way to move an existing session between orgs.
    if (isFreshLogin && !organizationId) {
      const selectableOrgs: Array<{ id: string; name: string }> = [];
      for (const m of ws.organizationMemberships.findBy('user_id', user.id)) {
        // 'pending' is an unaccepted invitation and 'inactive' a deactivated member; neither is
        // an organization production would scope a session to.
        if (m.status !== 'active') continue;
        const org = ws.organizations.get(m.organization_id);
        if (org) selectableOrgs.push({ id: org.id, name: org.name });
      }

      if (selectableOrgs.length === 1) {
        organizationId = selectableOrgs[0].id;
      } else if (selectableOrgs.length > 1) {
        // The spec documents the organization_selection_required code but not this response body
        // (as with mfa_challenge above); the pending token, organization list and user mirror
        // WorkOS. The pending token carries the method so the session the organization-selection
        // grant eventually creates reports the original factor rather than 'unknown', and any
        // still-unspent invitation so the selection step can finish accepting it.
        const pendingToken = generateId('pending');
        store.setData(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`, {
          user_id: user.id,
          organization_id: null,
          auth_method: sessionAuthMethod ?? authMethod,
          invitation_token: invitation?.token ?? null,
        });
        return c.json(
          {
            code: 'organization_selection_required',
            message: 'The user must choose an organization to finish their authentication.',
            pending_authentication_token: pendingToken,
            organizations: selectableOrgs,
            user: formatUser(user),
          },
          403,
        );
      }
    }

    // Past every continuation check, so this request is the one issuing a session. Spending the
    // invitation only now is what stops a one-time invitation being burned by an mfa_challenge or
    // organization_selection_required response the client may never come back from — and it still
    // lands before the role lookup below, which reads the membership it creates.
    if (invitation) {
      acceptInvitation(invitation, user, ws, store.getData<EventBus>(STORE_KEYS.eventBus));
    }

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

    const accessToken = jwt.sign(
      {
        sub: user.id,
        sid: session.id,
        org_id: organizationId ?? undefined,
        role: roleSlug,
        // Production emits the plural `roles` alongside `role`; the emulator models one role per
        // membership, so it is that role as a single-element array.
        roles: roleSlug ? [roleSlug] : undefined,
        permissions: permissionSlugs,
        aud: clientId ?? 'workos-emulate',
      },
      { claims: renderConfiguredJwtTemplate(store, ws, updatedUser, organizationId) },
    );

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
      // rather than inventing a provider. A refresh reuses an existing session, so it echoes that
      // session's original method; a fresh login mirrors the session's sessionAuthMethod precedence.
      authentication_method: isFreshLogin
        ? resolveResponseAuthMethod(sessionAuthMethod ?? authMethod, {
            oauthProvider: updatedUser.oauth_provider,
          })
        : resolveSessionResponseAuthMethod(session.auth_method, {
            oauthProvider: updatedUser.oauth_provider,
          }),
      sealed_session: sealedSession,
      impersonator: updatedUser.impersonator ?? undefined,
    });
  };

  app.post('/user_management/authenticate', authenticateHandler);
  app.post('/x/authkit/users/authenticate', authenticateHandler);
}
