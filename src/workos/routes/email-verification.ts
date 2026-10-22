import { type RouteContext, notFound, parseJsonBody, WorkOSApiError } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatEmailVerification, formatUser, generateCode, expiresIn, isExpired, emailsMatch } from '../helpers.js';

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

    const ev = ws.emailVerifications.insert({
      object: 'email_verification',
      user_id: user.id,
      email: user.email,
      code: generateCode(),
      expires_at: expiresIn(10),
    });

    return c.json(formatEmailVerification(ev), 201);
  });

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
    // code issued before the address changed verifies nothing.
    const verifications = ws.emailVerifications.findBy('user_id', user.id);
    const ev = verifications.find((v) => v.code === code && emailsMatch(v.email, user.email));

    if (!ev) {
      throw new WorkOSApiError(400, 'Invalid code', 'invalid_code');
    }
    if (isExpired(ev.expires_at)) {
      throw new WorkOSApiError(400, 'Code has expired', 'expired_code');
    }

    ws.users.update(user.id, { email_verified: true });
    ws.emailVerifications.delete(ev.id);

    const updated = ws.users.get(user.id)!;
    return c.json(formatUser(updated));
  });
}
