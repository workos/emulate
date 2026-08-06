import { type RouteContext, notFound, parseJsonBody, WorkOSApiError } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatMagicAuth,
  generateCode,
  expiresIn,
  findUserByEmail,
  isEmailShaped,
  requireEmailString,
} from '../helpers.js';

export function magicAuthRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.get('/user_management/magic_auth/:id', (c) => {
    const ma = ws.magicAuths.get(c.req.param('id'));
    if (!ma) throw notFound('Magic Auth');
    return c.json(formatMagicAuth(ma));
  });

  app.post('/user_management/magic_auth', async (c) => {
    const body = await parseJsonBody(c);
    // This handler now creates users, so its input guard is the only thing standing between a
    // typo and a permanent ghost account. A bare presence check was enough when the endpoint
    // could only ever read.
    const email = requireEmailString(body.email);
    if (!email) {
      throw new WorkOSApiError(400, 'email is required', 'invalid_request');
    }
    // Reported apart from absence: the two have the same fix only if the caller is told which
    // one happened, and "email is required" describes an address that was in fact supplied
    // exactly backwards.
    if (!isEmailShaped(email)) {
      throw new WorkOSApiError(400, 'email must be a valid email address', 'invalid_request');
    }

    // Magic Auth doubles as sign-up: production creates the user at code-creation
    // time (the response already carries its user_id), not at authenticate.
    // The lookup is case-insensitive because the creating branch below is: an exact-match
    // miss on 'User@x.test' vs 'user@x.test' used to be a harmless 404 and would now fork
    // the account in two. The address is stored as given — production preserves case.
    const user =
      findUserByEmail(ws, email) ??
      ws.users.insert({
        object: 'user',
        email,
        name: null,
        first_name: null,
        last_name: null,
        email_verified: false,
        profile_picture_url: null,
        last_sign_in_at: null,
        external_id: null,
        metadata: {},
        locale: null,
        password_hash: null,
        impersonator: null,
      });

    const ma = ws.magicAuths.insert({
      object: 'magic_auth',
      user_id: user.id,
      email: user.email,
      code: generateCode(),
      expires_at: expiresIn(10),
    });

    return c.json(formatMagicAuth(ma), 201);
  });
}
