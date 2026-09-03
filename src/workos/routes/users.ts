import {
  type RouteContext,
  notFound,
  validationError,
  parseJsonBody,
  WorkOSApiError,
  parseListParams,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatUser,
  formatIdentity,
  hashPassword,
  formatListResponse,
  findUserByEmail,
  emailsMatch,
  requireEmailField,
  revokeApiKeysForOwner,
} from '../helpers.js';

export function userRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/user_management/users', async (c) => {
    const body = await parseJsonBody(c);
    // The same guard the magic auth handler applies, for the same reason: this route creates
    // users, and an address that could only be a typo becomes an account nothing can reach.
    // Holding the two paths to one standard is what stops `{email: 'nope'}` being a 422 on one
    // and a 201 on the other — shared rather than restated, since a second copy is how the two
    // drifted over `null` in the first place.
    const email = requireEmailField(body.email, { requireShape: true });

    // Case-insensitively, for the same reason the magic auth handler resolves that way: an
    // exact-match miss on 'User@x.test' vs 'user@x.test' let both be created, and then the two
    // creation paths disagreed about which account an address names — with magic auth resolving
    // the ambiguity by insertion order.
    const existing = findUserByEmail(ws, email);
    if (existing) {
      throw new WorkOSApiError(409, 'A user with this email already exists', 'user_already_exists');
    }

    if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
      throw validationError('name must be a string or null', [{ field: 'name', code: 'invalid_type' }]);
    }

    const password = body.password as string | undefined;
    const user = ws.users.insert({
      object: 'user',
      email,
      name: (body.name as string | null) ?? null,
      first_name: (body.first_name as string) ?? null,
      last_name: (body.last_name as string) ?? null,
      email_verified: (body.email_verified as boolean) ?? false,
      profile_picture_url: null,
      last_sign_in_at: null,
      external_id: (body.external_id as string) ?? null,
      metadata: (body.metadata as Record<string, string>) ?? {},
      locale: null,
      password_hash: password ? hashPassword(password) : null,
      impersonator: null,
    });

    return c.json(formatUser(user), 201);
  });

  app.get('/user_management/users', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const emailFilter = url.searchParams.get('email') ?? undefined;
    const orgFilter = url.searchParams.get('organization_id') ?? undefined;

    let orgUserIds: Set<string> | undefined;
    if (orgFilter) {
      orgUserIds = new Set(ws.organizationMemberships.findBy('organization_id', orgFilter).map((m) => m.user_id));
    }

    const result = ws.users.list({
      ...params,
      filter: (user) => {
        // Case-insensitively, like every other lookup by email. This is the lookup an SDK's
        // listUsers({ email }) reaches for, so it is how a caller finds the account a Magic Auth
        // sign-up just made — and that account is stored under whatever case created it.
        if (emailFilter && !emailsMatch(user.email, emailFilter)) return false;
        if (orgUserIds && !orgUserIds.has(user.id)) return false;
        return true;
      },
    });

    return c.json(formatListResponse(result, formatUser));
  });

  app.get('/user_management/users/:id', (c) => {
    const user = ws.users.get(c.req.param('id'));
    if (!user) throw notFound('User');
    return c.json(formatUser(user));
  });

  app.get('/user_management/users/external_id/:external_id', (c) => {
    const user = ws.users.findOneBy('external_id', c.req.param('external_id'));
    if (!user) throw notFound('User');
    return c.json(formatUser(user));
  });

  app.put('/user_management/users/:id', async (c) => {
    const user = ws.users.get(c.req.param('id'));
    if (!user) throw notFound('User');

    const body = await parseJsonBody(c);
    const updates: Record<string, unknown> = {};

    if ('name' in body) {
      if (typeof body.name !== 'string' && body.name !== null) {
        throw validationError('name must be a string or null', [{ field: 'name', code: 'invalid_type' }]);
      }
      updates.name = body.name;
    }
    if ('first_name' in body) updates.first_name = body.first_name ?? null;
    if ('last_name' in body) updates.last_name = body.last_name ?? null;
    if ('email_verified' in body) updates.email_verified = body.email_verified;
    if ('external_id' in body) updates.external_id = body.external_id ?? null;
    if ('metadata' in body) updates.metadata = body.metadata ?? {};
    if ('password' in body && body.password) {
      updates.password_hash = hashPassword(body.password as string);
    }

    const updated = ws.users.update(user.id, updates);
    return c.json(formatUser(updated!));
  });

  app.delete('/user_management/users/:id', (c) => {
    const user = ws.users.get(c.req.param('id'));
    if (!user) throw notFound('User');

    for (const s of ws.sessions.findBy('user_id', user.id)) {
      ws.sessions.delete(s.id);
    }
    for (const m of ws.organizationMemberships.findBy('user_id', user.id)) {
      ws.organizationMemberships.delete(m.id);
    }
    for (const f of ws.authFactors.findBy('user_id', user.id)) {
      ws.authFactors.delete(f.id);
    }
    // Flag targets name the user by id. Left behind, they would keep the user in every
    // flag.rule_updated `configured_targets` and could never be removed over the API, since
    // the target routes 404 on the missing user before they look at the target.
    ws.flagTargets.deleteBy('resource_id', user.id);
    for (const i of ws.identities.findBy('user_id', user.id)) {
      ws.identities.delete(i.id);
    }
    for (const pr of ws.passwordResets.findBy('user_id', user.id)) {
      ws.passwordResets.delete(pr.id);
    }
    for (const ev of ws.emailVerifications.findBy('user_id', user.id)) {
      ws.emailVerifications.delete(ev.id);
    }
    for (const ma of ws.magicAuths.findBy('user_id', user.id)) {
      ws.magicAuths.delete(ma.id);
    }
    // Through the delete hook this also emits pipes.connected_account.disconnected for each:
    // the accounts stop existing with the user, and their stored tokens go with them.
    for (const ca of ws.connectedAccounts.findBy('user_id', user.id)) {
      ws.connectedAccounts.delete(ca.id);
    }
    // Keys the user created stop working with the user; left registered, they would keep
    // authenticating requests on behalf of a principal that no longer exists.
    revokeApiKeysForOwner(store, ws, (o) => o.type === 'user' && o.id === user.id);

    ws.users.delete(user.id);
    return c.body(null, 204);
  });

  app.get('/user_management/users/:id/identities', (c) => {
    const user = ws.users.get(c.req.param('id'));
    if (!user) throw notFound('User');

    // A bare array, per the spec: this endpoint is not paginated and returns no list envelope.
    return c.json(ws.identities.findBy('user_id', user.id).map(formatIdentity));
  });
}
