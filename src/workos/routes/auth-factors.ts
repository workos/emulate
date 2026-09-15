import { type RouteContext, notFound, parseJsonBody, WorkOSApiError } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  BASE32_SECRET,
  expiresIn,
  formatAuthChallenge,
  formatAuthFactor,
  formatAuthFactorEnrolled,
  generateCode,
  newTotp,
} from '../helpers.js';

export function authFactorRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/user_management/users/:userlandUserId/auth_factors', async (c) => {
    const userId = c.req.param('userlandUserId');
    const user = ws.users.get(userId);
    if (!user) throw notFound('User');

    const body = await parseJsonBody(c);
    const type = (body.type as string) ?? 'totp';
    const secret = body.totp_secret;
    // A JSON number of 2–7 digits would pass the regex by coercion and be stored as a number.
    if (secret !== undefined && (typeof secret !== 'string' || !BASE32_SECRET.test(secret))) {
      throw new WorkOSApiError(422, 'TOTP secret must be a valid Base32 string', 'invalid_totp_secret');
    }

    const factor = ws.authFactors.insert({
      object: 'authentication_factor',
      user_id: user.id,
      type: type as 'totp',
      totp: newTotp(
        (body.totp_issuer as string) ?? 'WorkOS Emulator',
        (body.totp_user as string) ?? user.email,
        secret,
      ),
    });

    // Enrollment answers with the challenge whose verification completes it, as production does.
    // A TOTP code is delivered nowhere, so the stored code is what a test reads to verify it.
    const challenge = ws.authChallenges.insert({
      object: 'authentication_challenge',
      user_id: user.id,
      factor_id: factor.id,
      expires_at: expiresIn(10),
      code: generateCode(),
    });

    return c.json(
      {
        authentication_factor: formatAuthFactorEnrolled(factor),
        authentication_challenge: formatAuthChallenge(challenge),
      },
      201,
    );
  });

  app.get('/user_management/users/:userlandUserId/auth_factors', (c) => {
    const userId = c.req.param('userlandUserId');
    const user = ws.users.get(userId);
    if (!user) throw notFound('User');

    const factors = ws.authFactors.findBy('user_id', user.id);
    return c.json({
      object: 'list',
      data: factors.map(formatAuthFactor),
      list_metadata: { before: null, after: null },
    });
  });
}
