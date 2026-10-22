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
  normalizeEmail,
  requireEmailField,
  revokeApiKeysForOwner,
} from '../helpers.js';
import { deleteAgentInstancesForMembership } from '../agent-sessions.js';
import { passwordStrengthError } from '../password-policy.js';

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
      // The spec (UserlandUsersController_create in @workos/openapi-spec) documents no 409 for this
      // endpoint: a taken email is a 400 `user_creation_error` carrying the reason in `errors`, and
      // `email_not_available` is the detail production sends. Keep this specific to user creation;
      // other 409 contracts remain independently meaningful to their SDK callers.
      throw new WorkOSApiError(400, 'Could not create user.', 'user_creation_error', [
        { code: 'email_not_available', message: 'This email is not available.' },
      ]);
    }

    if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
      throw validationError('name must be a string or null', [{ field: 'name', code: 'invalid_type' }]);
    }

    const password = body.password as string | undefined;
    if (password) {
      const tooWeak = passwordStrengthError(password, email);
      if (tooWeak) throw tooWeak;
    }

    // An external_id names one user; production reports a taken one the way it reports a
    // taken email, as a reason inside `user_creation_error`.
    const externalId = (body.external_id as string) ?? null;
    if (externalId && ws.users.findOneBy('external_id', externalId)) {
      throw new WorkOSApiError(400, 'Could not create user.', 'user_creation_error', [
        { code: 'external_id_already_used', message: 'External ID has already been used' },
      ]);
    }

    const user = ws.users.insert({
      object: 'user',
      email,
      name: (body.name as string | null) ?? null,
      first_name: (body.first_name as string) ?? null,
      last_name: (body.last_name as string) ?? null,
      email_verified: (body.email_verified as boolean) ?? false,
      profile_picture_url: null,
      last_sign_in_at: null,
      external_id: externalId,
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
    if (!user) throw notFound('User', c.req.param('id'));
    return c.json(formatUser(user));
  });

  app.get('/user_management/users/external_id/:external_id', (c) => {
    const user = ws.users.findOneBy('external_id', c.req.param('external_id'));
    if (!user) throw notFound('User', c.req.param('external_id'));
    return c.json(formatUser(user));
  });

  app.put('/user_management/users/:id', async (c) => {
    const user = ws.users.get(c.req.param('id'));
    if (!user) throw notFound('User', c.req.param('id'));

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

    // Verification is a fact about the address that this endpoint can assert, not retract:
    // `true` verifies an unverified user, `false` on one is ignored, and `false` on a verified
    // user is refused.
    if (body.email_verified === false && user.email_verified) {
      throw new WorkOSApiError(
        400,
        'The user email has already been verified and cannot be unverified.',
        'email_already_verified',
      );
    }
    if (body.email_verified === true) updates.email_verified = true;

    if ('password' in body && body.password) {
      const tooWeak = passwordStrengthError(body.password as string, user.email);
      if (tooWeak) throw tooWeak;
      updates.password_hash = hashPassword(body.password as string);
    }

    if (body.email) {
      // Reported in the 400 shape production's email change answers in, not the 422 the create
      // route gives a malformed address.
      const normalized = normalizeEmail(body.email, { requireShape: true });
      if (!normalized.ok) {
        throw new WorkOSApiError(400, 'Email must be a valid email address.', 'invalid_email');
      }
      const email = normalized.email;
      if (!emailsMatch(email, user.email)) {
        const holder = findUserByEmail(ws, email);
        if (holder && holder.id !== user.id) {
          throw new WorkOSApiError(400, 'This email is not available.', 'email_not_available');
        }
        updates.email = email;
        // A new address is unproven until something verifies it; `email_verified: true` in the
        // same request still wins, as it does in production, which applies it afterwards.
        if (body.email_verified !== true) updates.email_verified = false;
      }
    }

    if ('external_id' in body) {
      const externalId = (body.external_id as string) ?? null;
      const holder = externalId ? ws.users.findOneBy('external_id', externalId) : undefined;
      if (holder && holder.id !== user.id) {
        throw new WorkOSApiError(
          400,
          'The external_id provided has already been assigned to another user.',
          'external_id_already_used',
        );
      }
      updates.external_id = externalId;
    }
    if ('metadata' in body) updates.metadata = body.metadata ?? {};

    const updated = ws.users.update(user.id, updates);
    return c.json(formatUser(updated!));
  });

  app.delete('/user_management/users/:id', (c) => {
    const user = ws.users.get(c.req.param('id'));
    if (!user) throw notFound('User', c.req.param('id'));

    for (const s of ws.sessions.findBy('user_id', user.id)) {
      ws.sessions.delete(s.id);
    }
    for (const m of ws.organizationMemberships.findBy('user_id', user.id)) {
      deleteAgentInstancesForMembership(ws, m.id);
      // Same cascade as deleting the membership directly: its role assignments go with it.
      ws.roleAssignments.deleteBy('organization_membership_id', m.id);
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
    if (!user) throw notFound('User', c.req.param('id'));

    // A bare array, per the spec: this endpoint is not paginated and returns no list envelope.
    return c.json(ws.identities.findBy('user_id', user.id).map(formatIdentity));
  });
}
