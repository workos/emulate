import { createHash } from 'node:crypto';
import {
  type RouteContext,
  notFound,
  parseOAuthBody,
  WorkOSApiError,
  OauthApiError,
  generateId,
  generateUlid,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { resolvePrimaryRole, getRolePermissions } from '../role-helpers.js';
import { tokenFeatureFlags } from './feature-flags.js';
import {
  formatUser,
  formatDeviceAuthorization,
  verifyPassword,
  isExpired,
  expiresIn,
  assertAllowedRedirectUri,
  AUTH_METHOD_SESSION_VALUES,
  resolveResponseAuthMethod,
  resolveSessionResponseAuthMethod,
  emitAuthenticationEvent,
  generateCode,
  formatAuthChallenge,
  acceptInvitation,
  findUserByEmail,
  requireEmailString,
  emailsMatch,
} from '../helpers.js';
import { renderConfiguredJwtTemplate } from '../jwt-template.js';
import type { EventBus } from '../event-bus.js';
import type { WorkOSInvitation, WorkOSSSOAuthorization, WorkOSUser } from '../entities.js';
import { STORE_KEYS, STORE_KEY_PREFIXES } from '../constants.js';
import {
  renderLoginPage,
  renderDeviceVerifyPage,
  renderOrganizationSelectPage,
  renderPasswordPage,
  renderCodePage,
} from '../login-page.js';

interface PendingAuth {
  user_id: string;
  organization_id: string | null;
  auth_method: string;
  /** Carried across an MFA challenge so the second factor doesn't drop a pending invitation. */
  invitation_token?: string | null;
}

/**
 * A password the interactive page has already checked, and how far past it the login has got.
 * Every page that can follow — email verification, the second factor, the organization choice —
 * carries a token for one of these rather than the password itself, so a secret never sits in a
 * hidden field, and a POST that leaves the token out cannot skip a check.
 */
interface InteractiveLogin {
  user_id: string;
  /** The primary method, 'Password': what the session will record. */
  auth_method: string;
  expires_at: string;
  /** The gate cleared last, 'EmailVerification' or 'MFA', which the exchange reports the way the API grant for it would. */
  step_up_method: string | null;
  /** The email_verification whose code the verification page is waiting for, while that gate is open. */
  email_verification_id: string | null;
  /** The authentication_challenge whose code the one-time-code page is waiting for, while that gate is open. */
  challenge_id: string | null;
  /** Whether the second factor has been cleared for this login; the factor stays enrolled, so the record has to say. */
  mfa_verified: boolean;
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
  clientId: string | null;
  /** Which organization the session should be scoped to, when the caller already knows. */
  organizationId: string | null;
  /** What the interactive password page submitted; null until the form reaches that step. */
  password: string | null;
  /** What a verification page submitted — the emailed or the authenticator code; null until the form reaches such a step. */
  code: string | null;
  /** Proof from an earlier password page that this login is already verified, carried across every page after it. */
  pendingToken: string | null;
}

export function authRoutes(ctx: RouteContext): void {
  const { app, store, jwt } = ctx;
  const ws = getWorkOSStore(store);

  /**
   * The organizations a session could be scoped to. 'pending' is an unaccepted invitation and
   * 'inactive' a deactivated member; neither is one production would scope a session to.
   */
  function activeOrganizationsFor(userId: string): Array<{ id: string; name: string }> {
    const orgs: Array<{ id: string; name: string }> = [];
    for (const m of ws.organizationMemberships.findBy('user_id', userId)) {
      if (m.status !== 'active') continue;
      const org = ws.organizations.get(m.organization_id);
      if (org) orgs.push({ id: org.id, name: org.name });
    }
    return orgs;
  }

  /**
   * The authorize parameters a page carries through its form, so the POST that follows finishes
   * the request the GET started. `email` and `organization_id` are added by the pages that know
   * them.
   */
  function carriedFields(params: AuthorizeParams): Record<string, string> {
    const fields: Record<string, string> = { redirect_uri: params.redirectUri };
    if (params.state) fields.state = params.state;
    if (params.codeChallenge) fields.code_challenge = params.codeChallenge;
    if (params.codeChallengeMethod) fields.code_challenge_method = params.codeChallengeMethod;
    if (params.clientId) fields.client_id = params.clientId;
    return fields;
  }

  function resolveAndRedirect(c: any, params: AuthorizeParams) {
    const {
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod,
      loginHint,
      clientId,
      organizationId,
      password,
      code,
      pendingToken,
    } = params;

    assertAllowedRedirectUri(redirectUri, store);

    let user;
    if (loginHint) {
      // Case-insensitively, like every other lookup by email: Magic Auth stores the case it was
      // handed, so an account created as 'User@x.test' has to be reachable as 'user@x.test'.
      user = findUserByEmail(ws, loginHint);
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

    // A caller-supplied organization only means anything if the user is actually in it. Minting
    // a code for one they are not a member of would put that org_id on the token with no role or
    // permissions behind it, which is a session no membership justifies and, for anything
    // authorizing on org_id, the wrong tenant entirely.
    if (organizationId && !activeOrganizationsFor(user.id).some((o) => o.id === organizationId)) {
      throw new WorkOSApiError(
        400,
        `User is not an active member of organization ${organizationId}`,
        'invalid_request',
      );
    }

    const interactive = store.getData<boolean>(STORE_KEYS.interactiveAuth);

    // The password step. Hosted AuthKit asks a user who has a password for it straight after
    // the email, before any organization question, and that order is kept here. Opt-in, because
    // the one-step email page is what every existing browser suite was written against. Only a
    // user who has a password is asked: a passwordless account has nothing to check, and a page
    // demanding a secret nobody set would be a dead end rather than fidelity.
    //
    // A verified login is remembered under a short-lived token rather than re-sent, so no later
    // page carries the password, and a POST that arrives without a valid token lands back on the
    // password page instead of skipping it. The same token carries the login through the gates
    // the `password` grant puts between a correct password and a session — an unverified
    // mailbox, then an enrolled second factor — so the browser flow cannot sign in an account
    // the API would have stopped.
    let login: InteractiveLogin | null = null;
    // The token `login` is stored under, once a page after the password has needed one.
    let loginToken: string | null = null;
    /**
     * Drop the record an expired login's open gate was waiting on: the email_verification or
     * authentication_challenge only that login could have redeemed. Otherwise every abandoned
     * gated login would keep one such record for the emulator's lifetime after its token went.
     */
    const releaseGate = (stale: InteractiveLogin) => {
      if (stale.email_verification_id) ws.emailVerifications.delete(stale.email_verification_id);
      if (stale.challenge_id) ws.authChallenges.delete(stale.challenge_id);
    };
    /**
     * Persist `login` under its token for the page about to be served, minting the token the
     * first time. A page that is never submitted leaves its token behind, and nothing would
     * present it again to trip the expiry check, so expired entries are swept at each mint, each
     * with the gate record it references: the store holds at most the logins from the last ten
     * minutes rather than one per abandoned login.
     */
    const carryLogin = (): string => {
      if (!loginToken) {
        store.deleteDataByPrefix(STORE_KEY_PREFIXES.interactiveLogin, (v) => {
          const stale = v as InteractiveLogin;
          if (!isExpired(stale.expires_at)) return false;
          releaseGate(stale);
          return true;
        });
        loginToken = generateId('pending');
      }
      store.setData(`${STORE_KEY_PREFIXES.interactiveLogin}${loginToken}`, login);
      return loginToken;
    };

    if (interactive && store.getData<boolean>(STORE_KEYS.interactivePassword) && user.password_hash) {
      const key = pendingToken ? `${STORE_KEY_PREFIXES.interactiveLogin}${pendingToken}` : null;
      let verified = key ? store.getData<InteractiveLogin>(key) : undefined;
      if (key && verified && isExpired(verified.expires_at)) {
        // Nothing will ever redeem an expired token, so drop it, and the record its gate was
        // waiting on, rather than leave them behind.
        releaseGate(verified);
        store.deleteData(key);
        verified = undefined;
      }

      const fields = carriedFields(params);
      if (organizationId) fields.organization_id = organizationId;
      // Back to the email page with the same authorize parameters, minus the address itself:
      // "a different account" means a different email.
      const backHref = `/user_management/authorize?${new URLSearchParams(fields).toString()}`;
      /**
       * The failure the matching API grant records, so a webhook consumer sees a browser login
       * fail the way an API one does. The page is then re-rendered rather than the callback
       * reached: a mistyped secret is something the user retries, not an outcome the app acts on.
       */
      const failStep = (method: string, error: { code: string; message: string }) =>
        emitAuthenticationEvent({
          eventBus: store.getData<EventBus>(STORE_KEYS.eventBus),
          method,
          status: 'failed',
          userId: user.id,
          email: user.email,
          ipAddress: c.req.header('x-forwarded-for') ?? null,
          userAgent: c.req.header('user-agent') ?? null,
          error,
        });

      if (verified && verified.user_id === user.id) {
        login = verified;
        loginToken = pendingToken;
      } else {
        const page = (error?: string) =>
          renderPasswordPage({
            email: user.email,
            formAction: '/user_management/authorize',
            hiddenFields: { ...fields, email: user.email },
            backHref,
            error,
          });

        if (password === null) return c.html(page());

        if (!verifyPassword(password, user.password_hash)) {
          failStep('Password', { code: 'invalid_credentials', message: `Invalid credentials for '${user.email}'.` });
          return c.html(page('Incorrect password. Try again.'), 401);
        }
        login = {
          user_id: user.id,
          auth_method: 'Password',
          expires_at: expiresIn(10),
          step_up_method: null,
          email_verification_id: null,
          challenge_id: null,
          mfa_verified: false,
        };
      }

      // The gates, in the order hosted AuthKit shows them and the `password` grant checks them:
      // the unverified mailbox first, since challenging a second factor for an account whose
      // first contact detail is unproven would hand out a challenge production never issues.
      // Each is a page that carries the token, so a POST that skips one — an organization
      // choice, say — lands back on the gate it skipped. A code is spent on the gate it clears.
      let unspentCode = code;
      const codePage = (options: { title: string; lead: string; error?: string }) =>
        c.html(
          renderCodePage({
            ...options,
            email: user.email,
            formAction: '/user_management/authorize',
            hiddenFields: { ...fields, email: user.email, pending_authentication_token: carryLogin() },
            backHref,
          }),
          options.error ? 401 : 200,
        );

      if (!user.email_verified) {
        const verificationPage = (error?: string) =>
          codePage({ title: 'Verify your email', lead: 'Enter the code we sent to', error });
        let pending = login.email_verification_id ? ws.emailVerifications.get(login.email_verification_id) : undefined;
        let error: string | undefined;
        if (pending && isExpired(pending.expires_at)) {
          ws.emailVerifications.delete(pending.id);
          pending = undefined;
          if (unspentCode !== null) {
            failStep('EmailVerification', { code: 'expired_code', message: 'Code has expired' });
            error = 'That code has expired. A new one has been sent.';
          }
        }
        if (!pending) {
          // Creating the record is what delivers the code, on the email_verification.created
          // webhook, the way every emailed code leaves the emulator.
          pending = ws.emailVerifications.insert({
            object: 'email_verification',
            user_id: user.id,
            email: user.email,
            code: generateCode(),
            expires_at: expiresIn(10),
          });
          login.email_verification_id = pending.id;
          return verificationPage(error);
        }
        if (unspentCode === null) return verificationPage();
        if (pending.code !== unspentCode) {
          failStep('EmailVerification', { code: 'invalid_code', message: 'Invalid code' });
          return verificationPage('Incorrect code. Try again.');
        }
        // What the email-verification grant does with a good code, short of the session it would
        // issue: the mailbox is proven for good, not only for this login.
        ws.users.update(user.id, { email_verified: true });
        ws.emailVerifications.delete(pending.id);
        login.email_verification_id = null;
        login.step_up_method = 'EmailVerification';
        unspentCode = null;
      }

      const factors = ws.authFactors.findBy('user_id', user.id);
      if (factors.length > 0 && !login.mfa_verified) {
        const challengePage = (error?: string) =>
          codePage({
            title: 'Enter your one-time code',
            lead: 'Enter the code from the authenticator enrolled for',
            error,
          });
        let pending = login.challenge_id ? ws.authChallenges.get(login.challenge_id) : undefined;
        let error: string | undefined;
        if (pending && isExpired(pending.expires_at)) {
          ws.authChallenges.delete(pending.id);
          pending = undefined;
          if (unspentCode !== null) {
            failStep('MFA', { code: 'expired_challenge', message: 'Challenge has expired' });
            error = 'That code has expired. A new challenge has been issued.';
          }
        }
        if (!pending) {
          // The challenge the `password` grant's mfa_challenge step creates, for the same factor.
          // Its code is delivered nowhere, as a TOTP code is not; a test reads it from the stored
          // challenge, as it does to finish the mfa-totp grant.
          pending = ws.authChallenges.insert({
            object: 'authentication_challenge',
            user_id: user.id,
            factor_id: factors[0].id,
            expires_at: expiresIn(10),
            code: generateCode(),
          });
          login.challenge_id = pending.id;
          return challengePage(error);
        }
        if (unspentCode === null) return challengePage();
        if (pending.code && unspentCode !== pending.code) {
          failStep('MFA', { code: 'invalid_one_time_code', message: 'Invalid one-time code' });
          return challengePage('Incorrect code. Try again.');
        }
        ws.authChallenges.delete(pending.id);
        login.challenge_id = null;
        login.mfa_verified = true;
        login.step_up_method = 'MFA';
      }
    }

    // Hosted AuthKit asks which organization here, before it mints anything, so the client's
    // exchange always succeeds. Resolving it at the exchange instead would answer a browser
    // client with organization_selection_required, which it cannot act on mid-callback.
    // Interactive only: a headless caller drives the documented API and handles that response
    // itself, and this is the one mode that can put a page in front of a human.
    if (!organizationId && interactive) {
      const selectable = activeOrganizationsFor(user.id);
      if (selectable.length > 1) {
        const hiddenFields: Record<string, string> = { ...carriedFields(params), email: user.email };
        // The verified login rides along under its token, so an organization POST that leaves
        // it out cannot skip the checks that got here.
        if (login) hiddenFields.pending_authentication_token = carryLogin();

        return c.html(
          renderOrganizationSelectPage({
            email: user.email,
            organizations: selectable,
            formAction: '/user_management/authorize',
            hiddenFields,
          }),
        );
      }
    }

    const authCode = ws.authCodes.insert({
      user_id: user.id,
      organization_id: organizationId,
      code: generateId('auth_code'),
      redirect_uri: redirectUri,
      expires_at: expiresIn(10),
      code_challenge: codeChallenge ?? null,
      code_challenge_method: codeChallengeMethod ?? null,
      client_id: clientId,
      auth_method: login?.auth_method ?? null,
      step_up_method: login?.step_up_method ?? null,
    });
    // One code per verified login: the token is spent once it has minted something. Deleted
    // rather than overwritten, so a long-lived emulator does not keep one entry per login.
    if (loginToken) store.deleteData(`${STORE_KEY_PREFIXES.interactiveLogin}${loginToken}`);

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
    const clientId = url.searchParams.get('client_id');
    const organizationId = url.searchParams.get('organization_id');

    if (!redirectUri) {
      throw new WorkOSApiError(400, 'redirect_uri is required', 'invalid_request');
    }

    // Checked before the interactive branch, which renders the redirect_uri into a hidden field
    // and defers every check to the POST. A host the emulator will not redirect to should fail
    // here, not after someone has filled the form in.
    assertAllowedRedirectUri(redirectUri, store);

    const interactive = store.getData<boolean>(STORE_KEYS.interactiveAuth);
    if (interactive) {
      const hiddenFields: Record<string, string> = { redirect_uri: redirectUri };
      if (state) hiddenFields.state = state;
      if (codeChallenge) hiddenFields.code_challenge = codeChallenge;
      if (codeChallengeMethod) hiddenFields.code_challenge_method = codeChallengeMethod;
      if (clientId) hiddenFields.client_id = clientId;
      // Carried through the login page so a caller that already knows the organization skips
      // the selection page after the POST, rather than losing the GET's pre-selection here.
      if (organizationId) hiddenFields.organization_id = organizationId;

      return c.html(
        renderLoginPage({
          title: 'Sign In',
          subtitle: 'Enter your email to sign in to your account.',
          emailHint: loginHint ?? undefined,
          formAction: '/user_management/authorize',
          hiddenFields,
          // Every user the emulator holds, seeded or created through the API since; the page
          // sorts them. Behind --interactive, and the same list is already readable from
          // GET /user_management/users, so this discloses nothing it did not already hand out.
          users: ws.users.all().map((u) => ({ email: u.email, name: u.name })),
        }),
      );
    }

    return resolveAndRedirect(c, {
      redirectUri,
      state,
      codeChallenge,
      codeChallengeMethod,
      loginHint,
      clientId,
      organizationId,
      password: null,
      code: null,
      pendingToken: null,
    });
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
      clientId: (form.client_id as string) ?? null,
      organizationId: (form.organization_id as string) ?? null,
      // A string, even an empty one, is an attempt; absent means the form has not asked yet.
      password: typeof form.password === 'string' ? form.password : null,
      code: typeof form.code === 'string' ? form.code : null,
      pendingToken: (form.pending_authentication_token as string) ?? null,
    });
  });

  // Device verification page. The emulator auto-approves device authorization with the first
  // seeded user, so this is a confirmation page rather than a user_code entry form. It exists so
  // the resolvable verification_uri returned by the authorize endpoint does not 404 in a browser.
  app.get('/user_management/authorize/device/verify', (c) => {
    return c.html(
      renderDeviceVerifyPage({
        title: 'Device approved',
        message:
          'WorkOS Emulate auto-approves device authorization with the first seeded user, so polling /user_management/authenticate will succeed immediately.',
      }),
    );
  });

  // Device authorization endpoint
  app.post('/user_management/authorize/device', async (c) => {
    const body = await parseOAuthBody(c);
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

    return c.json(formatDeviceAuthorization(deviceAuth, ctx.baseUrl));
  });

  // AuthKit SDK uses /x/authkit/users/authenticate for the same flow
  const authenticateHandler = async (c: any) => {
    // Production's /user_management/authenticate accepts both JSON and
    // application/x-www-form-urlencoded on every grant (Nest's default urlencoded parser is
    // active, and the edge proxy documents both media types for this path) -- not just
    // device_code, despite the docs only showing form-encoded for that grant. RFC 6749 §3.2
    // requires the form encoding. parseOAuthBody dispatches on Content-Type and returns the
    // same Record<string, unknown> the grant handlers index into, so every grant parses
    // identically to production.
    const body = await parseOAuthBody(c);
    const grantType = body.grant_type as string | undefined;
    const clientId = body.client_id as string | undefined;

    // Every malformed-request failure on this endpoint is OAuth-shaped, and not by inference:
    // the spec's authenticate 400 lists `invalid_request` among its {error, error_description}
    // variants and nowhere among its {code, message} ones. So the shape here is decided by the
    // *failure*, not only by the grant — a grant whose credential failures are plain
    // (`password`, Magic Auth) still reports a missing parameter OAuth-style.
    if (!grantType) {
      throw new OauthApiError(400, 'invalid_request', 'grant_type is required.');
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
      info: {
        email?: string | null;
        userId?: string | null;
        /** Required on every authentication.sso_* event, per the spec's event data. */
        sso?: { organization_id: string | null; connection_id: string | null; session_id: string | null };
      },
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
        sso: info.sso,
      });
      throw error;
    };

    /**
     * Redeem an /sso/authorize code into the user-management user it signs in, provisioning one
     * when the federated profile has no account yet — AuthKit does the same on a first SSO login,
     * and /sso/authorize mints a profile for any address it is handed, so refusing here would
     * report a code the emulator had just issued as invalid.
     *
     * Provisioning deliberately lands before the shared template gate below: a JWT template that
     * cannot render fails the request but keeps the user, the same way the gate already keeps the
     * membership acceptInvitation persists. Both are real domain progress — the user is the exact
     * record a successful retry would create — and the burned code matches what a template failure
     * costs every other one-time grant.
     */
    const redeemSsoAuthorization = (ssoAuth: WorkOSSSOAuthorization, code: string): WorkOSUser => {
      const profile = ws.ssoProfiles.get(ssoAuth.profile_id);

      if (isExpired(ssoAuth.expires_at)) {
        ws.ssoAuthorizations.delete(ssoAuth.id);
        failAuth(
          'SSO',
          {
            email: profile?.email,
            userId: findUserByEmail(ws, profile?.email ?? '')?.id ?? null,
            sso: {
              organization_id: ssoAuth.organization_id,
              connection_id: ssoAuth.connection_id,
              session_id: null,
            },
          },
          new OauthApiError(400, 'invalid_grant', `The code '${code}' has expired or is invalid.`),
        );
      }

      // The same emulator-state failure /sso/token names, for the same reason: an authorization
      // pointing at a profile that no longer exists is not a request anyone can fix by sending
      // something else, so it stays plain rather than OAuth-shaped.
      if (!profile) throw new WorkOSApiError(500, 'Profile not found', 'server_error');

      // The shared recipient check below runs only after the grant, and by then this helper has
      // spent the one-time authorization and possibly provisioned an account — a mismatched
      // invitation would fail the request yet leave a user behind with no session. The profile
      // already names who is signing in, so ask before anything is consumed; a rejected caller
      // keeps the code and retries without the invitation.
      if (invitation && !emailsMatch(invitation.email, profile.email)) {
        throw new WorkOSApiError(
          400,
          'The invitation was issued for a different email address',
          'invitation_cannot_be_used_for_email',
        );
      }

      ws.ssoAuthorizations.delete(ssoAuth.id);

      const existing = findUserByEmail(ws, profile.email);
      if (existing) return existing;
      return ws.users.insert({
        object: 'user',
        email: profile.email,
        name: null,
        first_name: profile.first_name,
        last_name: profile.last_name,
        // The IdP asserted the address, which is what verification proves.
        email_verified: true,
        profile_picture_url: null,
        last_sign_in_at: null,
        external_id: null,
        metadata: {},
        locale: null,
        password_hash: null,
        impersonator: null,
      });
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

    /**
     * Gate a sign-in whose credential proves nothing about the mailbox. Production answers an
     * unverified user with `email_verification_required` instead of a session, and that response
     * is what sends them to a verification screen. A fresh email_verification is created, so the
     * code reaches a test the way every other emulator flow delivers one — on the
     * `email_verification.created` webhook — and the pending token carries the primary method
     * (so the eventual session reports it rather than 'unknown') plus any still-unspent
     * invitation, on the same deferral rule the MFA challenge uses.
     */
    const issueEmailVerification = (
      unverified: { id: string; email: string },
      orgId: string | null,
      primaryMethod: string,
    ) => {
      const pendingToken = generateId('pending');
      store.setData(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`, {
        user_id: unverified.id,
        organization_id: orgId,
        auth_method: primaryMethod,
        invitation_token: invitation?.token ?? null,
      });
      const verification = ws.emailVerifications.insert({
        object: 'email_verification',
        user_id: unverified.id,
        email: unverified.email,
        code: generateCode(),
        expires_at: expiresIn(10),
      });
      // 403 with {code, message}, like mfa_challenge and organization_selection_required: the
      // spec lists all three as authenticate's step-up codes under 403, never under its 400.
      return c.json(
        {
          code: 'email_verification_required',
          message: 'Email ownership must be verified before authentication.',
          pending_authentication_token: pendingToken,
          email_verification_id: verification.id,
          email: unverified.email,
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
    // The client_id bound to the originating grant (auth code or refresh token). Falls back
    // to the request's client_id when the grant carries none: direct grants (password, magic
    // auth) have no originating authorization, and codes minted by a client-less /authorize —
    // a leniency production doesn't permit — store null. In both cases the redemption request
    // is the only client identity the emulator ever has.
    let grantClientId: string | undefined;
    // The connection an SSO sign-in came through, carried to the authentication.sso_succeeded
    // event, whose spec payload requires an `sso` block. Null for every other grant.
    let ssoContext: { organization_id: string | null; connection_id: string | null } | null = null;

    switch (grantType) {
      case 'authorization_code': {
        const code = body.code as string;
        if (!code) throw new OauthApiError(400, 'invalid_request', 'code is required.');

        // Production does not distinguish unknown from expired codes: both fail OAuth-style
        // as invalid_grant with the same description.
        const authCode = ws.authCodes.findOneBy('code', code);
        if (!authCode) {
          // A code minted by /sso/authorize is redeemable here too. The two endpoints wrote to
          // different stores, so an app that starts SSO with `sso.getAuthorizationUrl` — sending
          // people straight to their IdP rather than through a hosted screen — and finishes at
          // AuthKit's callback got invalid_grant for a code the emulator had just issued.
          // /sso/token still redeems the same code for a bare profile; this is the path that
          // produces a session, and the only one that records auth_method 'sso'.
          const ssoAuth = ws.ssoAuthorizations.findOneBy('code', code);
          if (ssoAuth) {
            user = redeemSsoAuthorization(ssoAuth, code);
            organizationId = ssoAuth.organization_id;
            ssoContext = { organization_id: ssoAuth.organization_id, connection_id: ssoAuth.connection_id };
            // An SSO authorization records no client_id, so the redeeming request is the only
            // client identity there is — the same fallback a client-less /authorize gets.
            grantClientId = clientId;
            authMethod = 'SSO';
            break;
          }
          failAuth(
            'OAuth',
            {},
            new OauthApiError(400, 'invalid_grant', `The code '${code}' has expired or is invalid.`),
          );
        }
        if (isExpired(authCode.expires_at)) {
          failAuth(
            'OAuth',
            { userId: authCode.user_id, email: ws.users.get(authCode.user_id)?.email },
            new OauthApiError(400, 'invalid_grant', `The code '${code}' has expired or is invalid.`),
          );
        }

        if (authCode.code_challenge) {
          const codeVerifier = body.code_verifier as string;
          if (!codeVerifier) {
            throw new OauthApiError(400, 'invalid_request', 'code_verifier is required.');
          }
          const method = authCode.code_challenge_method ?? 'S256';
          let challenge: string;
          if (method === 'S256') {
            challenge = createHash('sha256').update(codeVerifier).digest('base64url');
          } else {
            challenge = codeVerifier;
          }
          if (challenge !== authCode.code_challenge) {
            // A failed verifier is a failure of the authorization_code grant, so it fails the
            // same OAuth-style way an unknown code does (RFC 7636 §4.6). Leaving it plain put
            // the shape of a failure at odds with the reason for it, on the one path every
            // PKCE client takes. The spec does enumerate `invalid_grant` for authenticate, as
            // an {error, error_description} variant, so this is not inference from RFC alone.
            failAuth(
              'OAuth',
              { userId: authCode.user_id, email: ws.users.get(authCode.user_id)?.email },
              new OauthApiError(400, 'invalid_grant', `The code '${code}' has expired or is invalid.`),
            );
          }
        }

        user = ws.users.get(authCode.user_id);
        // The third grant to need this guard, and the one an AuthKit callback actually takes:
        // deleting a user leaves its authorization codes behind (only sessions, memberships,
        // factors, identities, password resets, email verifications and magic auths cascade),
        // so a code can outlive its user. Without it the shared lookup below answers with a 404
        // the spec shapes as a bare {message} — no `error` for the client that is matching on
        // invalid_grant, and no authentication.oauth_failed event either. Thrown before the
        // delete, so a failure the caller cannot fix does not also cost them the code.
        if (!user) {
          failAuth(
            'OAuth',
            { userId: authCode.user_id },
            new OauthApiError(400, 'invalid_grant', `The code '${code}' has expired or is invalid.`),
          );
        }
        // A code outlives the membership that justified it easily enough: ten minutes is long
        // enough for one to be revoked in between. Neither obvious response is right. Trusting
        // the stored organization issues a session, tokens, a role and permissions for one the
        // user no longer belongs to. Clearing it and re-resolving is worse in a quieter way: a
        // user left with exactly one other membership is signed into that tenant instead,
        // without being told, having picked the first.
        //
        // So the grant fails. Its premise is gone, and the client's move is to authorize again,
        // where the selection page shows what is actually available now. Worded like the other
        // invalid-code failures rather than naming the membership, since the caller is
        // unauthenticated at this point and the distinction is not theirs to learn.
        if (
          authCode.organization_id &&
          !activeOrganizationsFor(authCode.user_id).some((o) => o.id === authCode.organization_id)
        ) {
          failAuth(
            'OAuth',
            { userId: authCode.user_id, email: ws.users.get(authCode.user_id)?.email },
            new OauthApiError(400, 'invalid_grant', `The code '${code}' has expired or is invalid.`),
          );
        }
        organizationId = authCode.organization_id;
        // Bind the token's client_id to the authorization grant, not the unvalidated
        // redemption-time request parameter.
        grantClientId = authCode.client_id ?? undefined;
        ws.authCodes.delete(authCode.id);
        // The interactive password page records how it verified the user and, when the login had
        // a gate to clear on the way, which one came last. The exchange then reports what the API
        // grant for that step reports: the gate's event, with the session recording the primary
        // method, exactly as the mfa-totp and email-verification grants leave it. The auto-redirect
        // verifies nothing and leaves both null, so the grant stays the OAuth it always was.
        authMethod = authCode.step_up_method ?? authCode.auth_method ?? 'OAuth';
        if (authCode.step_up_method && authCode.auth_method) sessionAuthMethod = authCode.auth_method;
        break;
      }

      case 'password': {
        const email = requireEmailString(body.email);
        const password = body.password as string;
        if (!email || !password) {
          throw new OauthApiError(400, 'invalid_request', 'email and password are required.');
        }

        user = findUserByEmail(ws, email);
        if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
          // Verified live: 400 (not 401) with the email interpolated. `password` is an RFC 6749
          // grant that nonetheless fails with the plain shape, which is why the credential
          // failures rendered OAuth-style are an explicit allowlist — authorization_code,
          // refresh_token, device_code — rather than "standard grants fail OAuth-style". The
          // malformed-request failure just above is a different question, and the spec answers
          // it the other way for every grant.
          failAuth(
            'Password',
            { email, userId: user?.id },
            new WorkOSApiError(400, `Invalid credentials for '${email}'.`, 'invalid_credentials'),
          );
        }
        authMethod = 'Password';

        // Checked before the factor challenge below: an unverified mailbox is the earlier gate,
        // and challenging a second factor for an account whose first contact detail is unproven
        // would hand out a challenge production never issues.
        if (!user.email_verified) {
          return issueEmailVerification(user, organizationId, 'Password');
        }

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
        const email = requireEmailString(body.email);
        if (!code || !email) {
          throw new OauthApiError(400, 'invalid_request', 'code and email are required.');
        }

        // Case-insensitively, because code creation resolves the user that way: a code requested
        // for 'user@x.test' against a stored 'User@X.test' is recorded under the stored casing,
        // so an exact match here would hand back a code that the address it was requested for
        // could never redeem.
        const magicAuth = ws.magicAuths.all().find((ma) => ma.code === code && emailsMatch(ma.email, email));
        if (!magicAuth) {
          failAuth('MagicAuth', { email }, new WorkOSApiError(400, 'Invalid one-time code', 'invalid_one_time_code'));
        }
        if (isExpired(magicAuth.expires_at)) {
          failAuth(
            'MagicAuth',
            { email: magicAuth.email, userId: magicAuth.user_id },
            new WorkOSApiError(400, `One-time code for '${magicAuth.email}' has expired.`, 'one_time_code_expired'),
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
        // The SDKs send `pending_authentication_token` and nothing else identifying the user
        // (`serializeAuthenticateWithEmailVerificationOptions` in @workos-inc/node), which is the
        // token the password grant's gate above hands out. `user_id` stays accepted for callers
        // already driving this grant the emulator's old way.
        const pendingToken = body.pending_authentication_token as string | undefined;
        let pending: PendingAuth | undefined;
        if (pendingToken) {
          pending = store.getData<PendingAuth>(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`);
          if (!pending) {
            throw new WorkOSApiError(
              400,
              'Invalid pending authentication token',
              'invalid_pending_authentication_token',
            );
          }
        }
        const userId = pending?.user_id ?? (body.user_id as string);
        if (!code || !userId) {
          throw new OauthApiError(
            400,
            'invalid_request',
            'code and pending_authentication_token (or user_id) are required.',
          );
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

        // Revalidated before the pending token is consumed, on the same rule the MFA grant
        // states: an invitation revoked mid-flow fails the request without destroying the state
        // behind it, so a retry still reports invitation_invalid.
        const deferredInvitation = pending?.invitation_token ? resolveInvitation(pending.invitation_token) : null;

        ws.users.update(userId, { email_verified: true });
        ws.emailVerifications.delete(ev.id);
        if (pendingToken) store.setData(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`, undefined);
        user = ws.users.get(userId);
        organizationId = pending?.organization_id ?? null;
        invitation = deferredInvitation;
        // Event is authentication.email_verification_succeeded; the session records the method
        // that was gated (e.g. 'password'), since verification is a gate rather than a way to
        // sign in. Without a pending token there is nothing to record, and the session falls
        // back to 'unknown' as before.
        authMethod = 'EmailVerification';
        sessionAuthMethod = pending?.auth_method;
        break;
      }

      case 'refresh_token': {
        const token = body.refresh_token as string;
        if (!token) {
          throw new OauthApiError(400, 'invalid_request', 'refresh_token is required.');
        }

        const refreshToken = ws.refreshTokens.findOneBy('token', token);
        if (!refreshToken) {
          throw new OauthApiError(400, 'invalid_grant', 'Invalid refresh token.');
        }
        if (isExpired(refreshToken.expires_at)) {
          ws.refreshTokens.delete(refreshToken.id);
          throw new OauthApiError(400, 'invalid_grant', 'Refresh token has expired.');
        }

        user = ws.users.get(refreshToken.user_id);
        // A token whose user was deleted is as invalid as an unknown one — verified live;
        // without this the shared lookup below would answer with a plain 404.
        if (!user) {
          throw new OauthApiError(400, 'invalid_grant', 'Invalid refresh token.');
        }
        // Allow body.organization_id to switch org context (switchToOrganization)
        organizationId = (body.organization_id as string) ?? refreshToken.organization_id;

        // Rotate within the existing session: capture it for reuse, delete the old token,
        // and issue a new one below — no new session, no authentication event.
        refreshSessionId = refreshToken.session_id;
        // Carry the original client_id forward across refresh rotations.
        grantClientId = refreshToken.client_id ?? undefined;
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
          throw new OauthApiError(
            400,
            'invalid_request',
            'code, pending_authentication_token, and authentication_challenge_id are required.',
          );
        }

        const pending = store.getData<PendingAuth>(`${STORE_KEY_PREFIXES.pendingAuth}${pendingToken}`);
        if (!pending) {
          throw new WorkOSApiError(400, 'Invalid pending authentication token', 'invalid_pending_authentication_token');
        }

        const challenge = ws.authChallenges.get(challengeId);
        if (!challenge) {
          throw new OauthApiError(400, 'invalid_request', 'Invalid authentication challenge.');
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
          throw new OauthApiError(
            400,
            'invalid_request',
            'pending_authentication_token and organization_id are required.',
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
          throw new OauthApiError(400, 'invalid_request', 'device_code is required.');
        }

        // The spec renders every device-flow code as {error, error_description}, so the three
        // this endpoint can reach — invalid_grant, expired_token, authorization_pending — are
        // rendered that way. (The spec also defines slow_down and access_denied; the emulator
        // never emits them, having no polling-interval or user-denial surface.) These previously
        // used the plain envelope while already carrying OAuth error codes, so a polling client
        // matching `error` saw nothing and one matching `code` worked: the exact inverse of
        // every other grant here.
        const deviceAuth = ws.deviceAuthorizations.findOneBy('device_code', deviceCode);
        if (!deviceAuth) {
          throw new OauthApiError(400, 'invalid_grant', 'Invalid device code.');
        }
        if (isExpired(deviceAuth.expires_at)) {
          ws.deviceAuthorizations.delete(deviceAuth.id);
          throw new OauthApiError(400, 'expired_token', 'The device code has expired.');
        }
        if (!deviceAuth.user_id) {
          throw new OauthApiError(400, 'authorization_pending', 'The authorization request is still pending.');
        }

        user = ws.users.get(deviceAuth.user_id);
        // Mirrors the refresh_token guard: an approved code whose user was deleted is as invalid
        // as an unknown one, and without this the shared lookup below answers a polling client
        // with a plain 404 — the one shape this endpoint otherwise never returns, on the grant
        // whose whole contract is that the client reads `error` to decide whether to keep going.
        // Thrown before the delete, so nothing is consumed on a failure the caller cannot fix.
        if (!user) {
          throw new OauthApiError(400, 'invalid_grant', 'Invalid device code.');
        }
        ws.deviceAuthorizations.delete(deviceAuth.id);
        authMethod = 'OAuth';
        break;
      }

      // `unsupported_grant_type` appears exactly once in the spec, under /sso/token, and nowhere
      // in authenticate's 400 — which does list `invalid_request`. The asymmetry reads as real
      // rather than an omission: authenticate's body is a oneOf discriminated on grant_type, so
      // an unrecognized one fails body validation rather than reaching a grant handler that could
      // decline it. Keeping the code the spec gives us, and saying what it means in the
      // description instead of naming a code the endpoint never returns.
      default:
        throw new OauthApiError(400, 'invalid_request', `The grant type is not supported: ${grantType}`);
    }

    if (!user) throw notFound('User');

    // Accepting an invitation is the one way a caller can name the organization on a grant that
    // takes no organization_id, so an invitation's organization wins over anything the grant itself
    // chose and settles the resolution below.
    // Rejected before anything is consumed, so a token addressed to somebody else costs the caller
    // neither their credential nor the invitation. Compared case-insensitively: an invitation to
    // Foo@example.com is for the same person as foo@example.com, and rejecting on letter case alone
    // would be a false negative.
    if (invitation && !emailsMatch(invitation.email, user.email)) {
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
      const selectableOrgs = activeOrganizationsFor(user.id);

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

    // Render template claims before anything is persisted. A template that cannot render fails the
    // request, and rendering here means that failure leaves no orphaned session, no bumped
    // last_sign_in_at, and no session.created/user.updated webhook implying a login that never
    // completed. It has to follow acceptInvitation above, whose membership the context reads; the
    // pre-update `user` record is equivalent, since no template variable exposes last_sign_in_at.
    const templateClaims = renderConfiguredJwtTemplate(store, ws, user, organizationId);

    // A fresh login creates a new session (firing session.created); a refresh_token rotation
    // reuses the existing session, so it emits neither session.created nor an auth event.
    let session;
    if (isFreshLogin) {
      const verifyEmail = authMethod === 'MagicAuth' && !user.email_verified;
      if (verifyEmail) {
        // A redeemed magic-auth code proves mailbox ownership; production marks the email
        // verified via the standard update path, which emits user.updated. Folded into the
        // sign-in write so it is one write, one event, and nothing persists before the
        // template gate above — which keeps a failed render from implying a login that
        // never completed.
        ws.users.update(user.id, {
          last_sign_in_at: new Date().toISOString(),
          email_verified: true,
        });
      } else {
        // No real attribute change: production stamps last_sign_in_at via a dedicated,
        // silent updateWithSignIn path (a raw, debounced DB write) that bypasses the
        // event-emitting update(), so a login fires session.created without a spurious
        // user.updated. See https://github.com/workos/emulate/issues/55.
        ws.users.updateSilent(user.id, { last_sign_in_at: new Date().toISOString() });
      }
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
      if (!existing) throw new OauthApiError(400, 'invalid_grant', 'Invalid refresh token.');
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
        // Same resolution as the authorization endpoints, so the token's
        // permissions claim agrees with /check and effective-permissions.
        const role = resolvePrimaryRole(ws, organizationId, membership.role.slug);
        if (role) {
          permissionSlugs = getRolePermissions(ws, role.id).map((p) => p.slug);
        }
      }
    }

    // Prefer the client_id bound to the originating grant (auth code or refresh token)
    // over the unvalidated redemption-time request parameter.
    const tokenClientId = grantClientId ?? clientId;
    // `aud` keeps its placeholder when no client is bound; `iss` does not get one. A grant with
    // no client_id would otherwise mint `{issuer}/user_management/workos-emulate`, an issuer URL
    // whose discovery document 404s — production mints no such thing, and a client discovering
    // from `iss` would follow it nowhere. Absent a client, `iss` is the bare configured issuer,
    // which is a real value and production's `'Legacy'` shape.
    const tokenAudience = tokenClientId ?? 'workos-emulate';

    // Entitlements and feature flags re-resolve at every mint — including refresh grants — so
    // a plan change or flag toggle lands in the next token. Both claims are omitted rather
    // than minted as [] when nothing resolves, matching the docs marking them optional.
    const entitlements = organizationId ? ws.organizations.get(organizationId)?.entitlements : undefined;
    const flagSlugs = tokenFeatureFlags(ws, user.id, organizationId);

    const accessToken = jwt.sign(
      {
        sub: user.id,
        sid: session.id,
        jti: generateUlid(),
        org_id: organizationId ?? undefined,
        role: roleSlug,
        // Production emits the plural `roles` alongside `role`; the emulator models one role per
        // membership, so it is that role as a single-element array.
        roles: roleSlug ? [roleSlug] : undefined,
        permissions: permissionSlugs,
        client_id: tokenClientId,
        // session.created_at gives the documented semantics: stamped at sign-in, unchanged by
        // refresh (which reuses the session). If in-session re-authentication is ever modelled,
        // this needs a dedicated session.authenticated_at to read instead.
        auth_time: Math.floor(new Date(session.created_at).getTime() / 1000),
        // RFC 8693 actor claim; the docs put the impersonator's email in the nested sub. The
        // emulator models impersonation as user config, so it is read off the user record.
        act: updatedUser.impersonator ? { sub: updatedUser.impersonator.email } : undefined,
        entitlements: entitlements?.length ? entitlements : undefined,
        feature_flags: flagSlugs.length ? flagSlugs : undefined,
        aud: tokenAudience,
      },
      { claims: templateClaims, issuerClientId: tokenClientId },
    );

    // Store a real refresh token
    const newRefreshToken = ws.refreshTokens.insert({
      token: generateId('ref'),
      user_id: user.id,
      organization_id: organizationId,
      session_id: session.id,
      expires_at: expiresIn(30 * 24 * 60), // 30 days
      client_id: tokenClientId ?? null,
    });

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
        // Required on authentication.sso_* by the spec's event data. This is the only SSO path
        // that reaches a session, so it is also the only one that can report a session_id.
        sso: ssoContext ? { ...ssoContext, session_id: session.id } : undefined,
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
      // Production never returns sealed_session for API requests: the SDKs seal client-side
      // with a caller-supplied cookie password the server never sees. A non-null value here
      // pushes authkit-nextjs session cookies past the 4096-byte browser cap (issue #93).
      sealed_session: null,
      impersonator: updatedUser.impersonator ?? undefined,
    });
  };

  app.post('/user_management/authenticate', authenticateHandler);
  app.post('/x/authkit/users/authenticate', authenticateHandler);
}
