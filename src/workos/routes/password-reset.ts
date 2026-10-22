import { type RouteContext, notFound, parseJsonBody, WorkOSApiError, type ApiErrorItem } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatPasswordReset,
  formatUser,
  generateVerificationToken,
  hashPassword,
  expiresIn,
  isExpired,
  findUserByEmail,
  requireEmailString,
  revokeSessionsForUser,
} from '../helpers.js';
import { passwordPolicyErrors } from '../password-policy.js';
import { STORE_KEYS, EVENTS } from '../constants.js';
import type { EventBus } from '../event-bus.js';

/** Production's `PASSWORD_RESET_TOKEN_EXPIRATION_IN_MINUTES` (`userland-password-resetter.ts`). */
export const PASSWORD_RESET_TOKEN_TTL_MINUTES = 15;

export function passwordResetRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.get('/user_management/password_reset/:id', (c) => {
    const pr = ws.passwordResets.get(c.req.param('id'));
    if (!pr) throw notFound('Password Reset', c.req.param('id'));
    return c.json(formatPasswordReset(pr));
  });

  app.post('/user_management/password_reset', async (c) => {
    const body = await parseJsonBody(c);
    const email = requireEmailString(body.email);
    if (!email) {
      throw new WorkOSApiError(400, 'email is required', 'invalid_request');
    }

    // Case-insensitively, like every other lookup by email: an account Magic Auth created as
    // 'User@x.test' must not be unresettable by the address the caller actually has.
    const user = findUserByEmail(ws, email);
    if (!user) throw notFound('User', email);

    const token = generateVerificationToken();
    const pr = ws.passwordResets.insert({
      object: 'password_reset',
      user_id: user.id,
      email: user.email,
      password_reset_token: token,
      // Production builds this link from the password-reset redirect configured in the dashboard.
      // The emulator has no such setting, so — like an invitation's accept_invitation_url — the
      // link points at the emulator itself, carrying the token under the `token` query parameter
      // the confirm endpoint documents.
      password_reset_url: `${ctx.baseUrl}/user_management/password_reset/confirm?token=${token}`,
      expires_at: expiresIn(PASSWORD_RESET_TOKEN_TTL_MINUTES),
    });

    return c.json(formatPasswordReset(pr), 201);
  });

  app.post('/user_management/password_reset/confirm', async (c) => {
    const body = await parseJsonBody(c);
    const token = body.token as string | undefined;
    const newPassword = body.new_password as string | undefined;

    if (!token) {
      throw new WorkOSApiError(400, 'token is required', 'invalid_request');
    }
    if (!newPassword) {
      throw new WorkOSApiError(400, 'new_password is required', 'invalid_request');
    }

    // Production looks the user up by the token, so a token it has never issued is a 404 for
    // the user, not a 400 for the token.
    const pr = ws.passwordResets.all().find((r) => r.password_reset_token === token);
    if (!pr) {
      throw new WorkOSApiError(
        404,
        `Could not locate user with provided token: '${token}'`,
        'password_reset_token_not_found',
      );
    }

    const user = ws.users.get(pr.user_id);
    if (!user) {
      ws.passwordResets.delete(pr.id);
      throw notFound('User', pr.user_id);
    }

    // An expired token and a password that breaks the policy are reported together, in that
    // order, the way production's resetter collects them before refusing.
    const errors: ApiErrorItem[] = [];
    if (isExpired(pr.expires_at)) {
      errors.push({ code: 'password_reset_token_expired', message: 'The password reset token has expired.' });
    }
    errors.push(...passwordPolicyErrors(newPassword, user.email));
    if (errors.length > 0) {
      throw new WorkOSApiError(400, 'Could not reset password.', 'password_reset_error', errors);
    }

    // The response carries the user as production serializes it: the record it looked up by the
    // token, before the reset touched it.
    const userBeforeReset = formatUser(user);

    ws.users.update(user.id, {
      password_hash: hashPassword(newPassword),
      // The link reached the inbox, which is the proof email verification asks for.
      email_verified: true,
    });
    ws.passwordResets.delete(pr.id);
    // The reset is how an account is taken back from whoever else is signed in to it.
    revokeSessionsForUser(ws, user.id);

    // Manual emit: the spec event fires on confirmation, not on a collection insert
    const eventBus = store.getData<EventBus>(STORE_KEYS.eventBus);
    eventBus?.emit({ event: EVENTS.passwordResetSucceeded, data: formatPasswordReset(pr) });

    return c.json({ user: userBeforeReset });
  });
}
