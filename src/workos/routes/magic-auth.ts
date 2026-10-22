import { type RouteContext, notFound, parseJsonBody, WorkOSApiError } from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import { formatMagicAuth, findUserByEmail, issueMagicAuthCode, requireEmailString } from '../helpers.js';

export function magicAuthRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.get('/user_management/magic_auth/:id', (c) => {
    const ma = ws.magicAuths.get(c.req.param('id'));
    if (!ma) throw notFound('MagicAuth', c.req.param('id'));
    return c.json(formatMagicAuth(ma));
  });

  app.post('/user_management/magic_auth', async (c) => {
    const body = await parseJsonBody(c);
    // This handler now creates users, so its input guard is the only thing standing between a
    // typo and a permanent ghost account. A bare presence check was enough when the endpoint
    // could only ever read. A malformed address is reported apart from an absent one — the two
    // have the same fix only if the caller is told which one happened, and "email is required"
    // describes an address that was in fact supplied exactly backwards.
    const email = requireEmailString(body.email, { requireShape: true });
    if (!email) {
      throw new WorkOSApiError(400, 'email is required', 'invalid_request');
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

    // The newest code is the only one the magic-auth grant will compare against, so this
    // retires any earlier code for the user, as production does.
    const ma = issueMagicAuthCode(ws, user);

    return c.json(formatMagicAuth(ma), 201);
  });
}
