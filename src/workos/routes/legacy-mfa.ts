import { type RouteContext, notFound, parseJsonBody, WorkOSApiError } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatAuthFactor,
  formatAuthFactorEnrolled,
  formatAuthChallenge,
  expiresIn,
  generateCode,
  newTotp,
  redeemOneTimeCode,
  touchFactorVerified,
  verifyOneTimeCode,
} from '../helpers.js';

export function legacyMfaRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  // Enroll factor (legacy path — not tied to user management users)
  app.post('/auth/factors/enroll', async (c) => {
    const body = await parseJsonBody(c);
    const type = (body.type as string) ?? 'totp';
    const issuer = (body.totp_issuer as string) ?? 'WorkOS Emulator';
    const totpUser = (body.totp_user as string) ?? 'legacy@emulator';

    const factor = ws.authFactors.insert({
      object: 'authentication_factor',
      user_id: 'legacy',
      type: type as 'totp',
      last_verified_at: null,
      totp: newTotp(issuer, totpUser),
    });

    return c.json(formatAuthFactorEnrolled(factor), 201);
  });

  // Get factor
  app.get('/auth/factors/:id', (c) => {
    const factor = ws.authFactors.get(c.req.param('id'));
    if (!factor) throw notFound('Authentication Factor', c.req.param('id'));
    return c.json(formatAuthFactor(factor));
  });

  // Delete factor
  app.delete('/auth/factors/:id', (c) => {
    const factor = ws.authFactors.get(c.req.param('id'));
    if (!factor) throw notFound('Authentication Factor', c.req.param('id'));
    ws.authFactors.delete(factor.id);
    return c.body(null, 204);
  });

  // Create challenge
  app.post('/auth/factors/:id/challenge', async (c) => {
    const factor = ws.authFactors.get(c.req.param('id'));
    if (!factor) throw notFound('Authentication Factor', c.req.param('id'));

    const code = generateCode();
    const challenge = ws.authChallenges.insert({
      object: 'authentication_challenge',
      user_id: factor.user_id,
      factor_id: factor.id,
      expires_at: expiresIn(10),
      code,
      attempts: 0,
      verified_at: null,
    });

    return c.json(formatAuthChallenge(challenge), 201);
  });

  /**
   * Verify challenge. Production answers a wrong code with `valid: false` — the verification
   * ran and the answer was no — and reserves its errors for a challenge that cannot be verified
   * at all: one already verified or expired is a 422 naming the challenge, and one that has
   * had its three attempts is the authenticate grants' 400 `one_time_code_too_many_attempts`
   * (the one exception it shares with them, kept at 400 for compatibility; see the comment on
   * `AuthenticationChallengeTooManyAttemptsException`). The success status is 201, the Nest
   * default for a POST and what the spec documents.
   */
  app.post('/auth/challenges/:id/verify', async (c) => {
    // The body is read before the challenge, not after: the read-compare-count below has to see
    // the attempts every earlier request recorded, and a challenge fetched before this await
    // would be a snapshot that overlapping requests all count their miss against once.
    const body = await parseJsonBody(c);
    const code = body.code as string;
    if (!code) {
      throw new WorkOSApiError(400, 'code is required', 'invalid_request');
    }

    const challenge = ws.authChallenges.get(c.req.param('id'));
    if (!challenge) throw notFound('Authentication Challenge', c.req.param('id'));

    const outcome = verifyOneTimeCode(ws.authChallenges, challenge, code);
    switch (outcome) {
      case 'previously_used':
        throw new WorkOSApiError(
          422,
          `The authentication challenge '${challenge.id}' has already been verified.`,
          'authentication_challenge_previously_verified',
        );
      case 'too_many_attempts':
        throw new WorkOSApiError(
          400,
          'One-time code has had too many failed attempts.',
          'one_time_code_too_many_attempts',
        );
      case 'expired':
        throw new WorkOSApiError(
          422,
          `The authentication challenge '${challenge.id}' has expired.`,
          'authentication_challenge_expired',
        );
      case 'invalid':
        return c.json({ challenge: formatAuthChallenge(challenge), valid: false }, 201);
      case 'valid':
        redeemOneTimeCode(ws.authChallenges, challenge);
        // This is how a factor becomes enrolled: verifying its enrollment challenge is what
        // puts it in the factor list and in front of the password grant.
        touchFactorVerified(ws, challenge.factor_id);
        return c.json({ challenge: formatAuthChallenge(challenge), valid: true }, 201);
    }
  });
}
