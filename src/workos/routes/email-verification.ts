import { type RouteContext, notFound, parseJsonBody, WorkOSApiError } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatEmailVerification,
  formatUser,
  emailsMatch,
  issueEmailVerificationCode,
  latestOneTimeCode,
  redeemOneTimeCode,
  verifyOneTimeCode,
} from '../helpers.js';

export function emailVerificationRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.get('/user_management/email_verification/:id', (c) => {
    const ev = ws.emailVerifications.get(c.req.param('id'));
    if (!ev) throw notFound('Email Verification', c.req.param('id'));
    return c.json(formatEmailVerification(ev));
  });

  app.post('/user_management/users/:id/email_verification/send', (c) => {
    const user = ws.users.get(c.req.param('id'));
    if (!user) throw notFound('User', c.req.param('id'));

    // Retires any earlier code: only the latest is ever compared, here and at the grant.
    const ev = issueEmailVerificationCode(ws, user);

    return c.json(formatEmailVerification(ev), 201);
  });

  /**
   * Production verifies the code against the user's latest email challenge — so only the most
   * recently sent code counts, an earlier one is simply incorrect — and only once the code has
   * passed does it notice a mailbox that was already verified. Its five failures are this
   * endpoint's own `email_verification_*` codes, not the authenticate grants' `one_time_code_*`
   * family, and the user comes back wrapped, the `VerifyEmailResponse` the SDKs unwrap.
   */
  app.post('/user_management/users/:id/email_verification/confirm', async (c) => {
    const user = ws.users.get(c.req.param('id'));
    if (!user) throw notFound('User', c.req.param('id'));

    const body = await parseJsonBody(c);
    const code = body.code as string | undefined;
    if (!code) {
      throw new WorkOSApiError(400, 'code is required', 'invalid_request');
    }

    // A code proves the inbox it was sent to: production keys the email factor it checks the
    // code against by the user's current address (`findInternalEmailFactorByUserlandUser`), so a
    // code issued before the address changed verifies nothing. A user never sent a code at their
    // current address has no challenge to verify against: production's `findLatestByFactorOrThrow`
    // is a 404 here, not a wrong code. It names the factor id it searched under, which the
    // emulator has no counterpart for, so no id is reported.
    const ev = latestOneTimeCode(
      ws.emailVerifications.findBy('user_id', user.id).filter((v) => emailsMatch(v.email, user.email)),
    );
    if (!ev) throw notFound('Authentication Challenge');

    switch (verifyOneTimeCode(ws.emailVerifications, ev, code)) {
      case 'expired':
        throw new WorkOSApiError(400, 'Email verification code has expired.', 'email_verification_code_expired');
      case 'previously_used':
        throw new WorkOSApiError(
          400,
          'Email verification code has previously been used.',
          'email_verification_code_previously_used',
        );
      case 'too_many_attempts':
        throw new WorkOSApiError(
          400,
          'Email verification had too many attempts.',
          'email_verification_too_many_attempts',
        );
      case 'invalid':
        throw new WorkOSApiError(400, 'Email verification code is incorrect.', 'email_verification_code_incorrect');
      case 'valid':
        break;
    }
    redeemOneTimeCode(ws.emailVerifications, ev);

    if (user.email_verified) {
      throw new WorkOSApiError(400, 'Email has been previously verified.', 'email_previously_verified');
    }

    ws.users.update(user.id, { email_verified: true });
    return c.json({ user: formatUser(ws.users.get(user.id)!) });
  });
}
