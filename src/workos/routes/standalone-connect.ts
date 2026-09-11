import {
  type RouteContext,
  WorkOSApiError,
  generateId,
  notFound,
  parseJsonBody,
  validationError,
} from '../../core/index.js';
import { assertAllowedRedirectUri, expiresIn, findUserByEmail, isEmailShaped, isExpired } from '../helpers.js';
import { getWorkOSStore } from '../store.js';
import type { WorkOSUser } from '../entities.js';

export function standaloneConnectRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  // Server-to-server: unlike the /oauth2 browser routes, this requires an API key.
  app.post('/authkit/oauth2/complete', async (c) => {
    const body = await parseJsonBody(c);
    const externalAuthId = body.external_auth_id;
    if (typeof externalAuthId !== 'string' || !externalAuthId.trim()) {
      throw validationError('external_auth_id is required', [{ field: 'external_auth_id', code: 'required' }]);
    }
    if (!body.user || typeof body.user !== 'object' || Array.isArray(body.user)) {
      throw validationError('user is required', [{ field: 'user', code: 'required' }]);
    }
    const input = body.user as Record<string, unknown>;
    for (const field of ['id', 'email']) {
      if (typeof input[field] !== 'string' || !input[field].trim()) {
        throw validationError(`user.${field} is required`, [{ field: `user.${field}`, code: 'required' }]);
      }
    }
    const externalId = input.id as string;
    const email = (input.email as string).trim();
    if (!isEmailShaped(email)) {
      throw new WorkOSApiError(400, 'Invalid email address', 'invalid_email');
    }

    const profile: Partial<Pick<WorkOSUser, 'name' | 'first_name' | 'last_name' | 'metadata'>> = {};
    for (const field of ['name', 'first_name', 'last_name'] as const) {
      if (input[field] !== undefined) {
        if (typeof input[field] !== 'string') {
          throw validationError(`user.${field} must be a string`, [{ field: `user.${field}`, code: 'invalid' }]);
        }
        profile[field] = input[field];
      }
    }
    if (input.metadata !== undefined) {
      if (
        !input.metadata ||
        typeof input.metadata !== 'object' ||
        Array.isArray(input.metadata) ||
        !Object.values(input.metadata).every((value) => typeof value === 'string')
      ) {
        throw validationError('user.metadata must be an object of strings', [
          { field: 'user.metadata', code: 'invalid' },
        ]);
      }
      profile.metadata = input.metadata as Record<string, string>;
    }

    const session = ws.externalAuthSessions.get(externalAuthId);
    if (!session || isExpired(session.expires_at)) throw notFound('External authentication session');
    if (session.completed_at) {
      throw new WorkOSApiError(
        400,
        'External authentication session already completed',
        'external_auth_session_already_completed',
      );
    }

    const existing = ws.users.findOneBy('external_id', externalId);
    const emailOwner = findUserByEmail(ws, email);
    if (emailOwner && emailOwner.id !== existing?.id) {
      throw new WorkOSApiError(400, 'Email belongs to another user', 'email_not_available');
    }
    // Collection hooks emit user.created/user.updated; omitted profile fields survive an update.
    const user = existing
      ? ws.users.update(existing.id, { ...profile, email, email_verified: true })!
      : ws.users.insert({
          object: 'user',
          email,
          external_id: externalId,
          email_verified: true,
          name: null,
          first_name: null,
          last_name: null,
          metadata: {},
          profile_picture_url: null,
          last_sign_in_at: null,
          locale: null,
          password_hash: null,
          impersonator: null,
          ...profile,
        });
    ws.externalAuthSessions.update(session.id, { user_id: user.id, completed_at: new Date().toISOString() });

    // Read baseUrl at request time so an ephemeral-port server returns its bound address.
    const redirect = new URL(`${ctx.baseUrl}/oauth2/authorize/complete`);
    redirect.searchParams.set('external_auth_id', session.id);
    return c.json({ redirect_uri: redirect.toString() });
  });

  app.get('/oauth2/authorize/complete', (c) => {
    const session = ws.externalAuthSessions.get(c.req.query('external_auth_id') ?? '');
    if (
      !session ||
      isExpired(session.expires_at) ||
      !session.completed_at ||
      session.redeemed_at ||
      !session.user_id ||
      !ws.users.get(session.user_id)
    ) {
      throw notFound('External authentication session');
    }
    assertAllowedRedirectUri(session.redirect_uri, store);
    const redirect = new URL(session.redirect_uri);
    const authCode = ws.authCodes.insert({
      user_id: session.user_id,
      organization_id: null,
      code: generateId('auth_code'),
      redirect_uri: session.redirect_uri,
      client_id: session.client_id,
      expires_at: expiresIn(10),
      auth_method: 'external_auth',
      step_up_method: null,
      code_challenge: null,
      code_challenge_method: null,
    });
    ws.externalAuthSessions.update(session.id, { redeemed_at: new Date().toISOString() });
    redirect.searchParams.set('code', authCode.code);
    if (session.state !== null) redirect.searchParams.set('state', session.state);
    return c.redirect(redirect.toString(), 302);
  });
}
