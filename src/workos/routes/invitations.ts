import {
  type RouteContext,
  notFound,
  parseJsonBody,
  validationError,
  WorkOSApiError,
  parseListParams,
} from '../../core/index.js';
import { getWorkOSStore } from '../store.js';
import {
  formatInvitation,
  generateVerificationToken,
  formatListResponse,
  acceptInvitation,
  provisionInvitee,
  liveMembershipFor,
  findUserByEmail,
  emailsMatch,
  requireEmailField,
  invitationState,
  invitationExpiresIn,
  INVITATION_DEFAULT_EXPIRY_DAYS,
  INVITATION_MIN_EXPIRY_DAYS,
  INVITATION_MAX_EXPIRY_DAYS,
} from '../helpers.js';
import { invalidRole, undefinedRoleSlug } from '../membership-roles.js';
import type { EventBus } from '../event-bus.js';
import { STORE_KEYS, EVENTS } from '../constants.js';

export function invitationRoutes(ctx: RouteContext): void {
  const { app, store } = ctx;
  const ws = getWorkOSStore(store);

  app.post('/user_management/invitations', async (c) => {
    const body = await parseJsonBody(c);
    // The same guard the two user-creation routes apply, for a related reason. Accepting a
    // non-string here used to be survivable because everything downstream compared the address
    // with `!==`; resolving the recipient case-insensitively means calling `toLowerCase` on it,
    // so a stored number turned both the email filter and accepting the invitation into a 500.
    // And an address that could only be a typo makes an invitation nobody can accept: acceptance
    // resolves a user by this email, so a typo is spent silently, enrolling no one.
    const email = requireEmailField(body.email, { requireShape: true });

    const organizationId = (body.organization_id as string) ?? null;
    if (organizationId && !ws.organizations.get(organizationId)) throw notFound('Organization', organizationId);
    const inviterUserId = (body.inviter_user_id as string) ?? null;
    if (inviterUserId && !ws.users.get(inviterUserId)) throw notFound('User', inviterUserId);

    // Production resolves the role before anything else about the invitation: the slug must
    // name a role of the organization or of the environment. Without an organization there is
    // no membership to grant, so the slug is not looked at.
    const roleSlug = (body.role_slug as string) ?? null;
    if (organizationId && roleSlug && undefinedRoleSlug(ws, organizationId, [roleSlug])) throw invalidRole(400);

    const expiresInDays = body.expires_in_days === undefined ? INVITATION_DEFAULT_EXPIRY_DAYS : body.expires_in_days;
    if (typeof expiresInDays !== 'number' || !Number.isInteger(expiresInDays)) {
      throw validationError('expires_in_days must be an integer', [{ field: 'expires_in_days', code: 'invalid' }]);
    }
    if (expiresInDays > INVITATION_MAX_EXPIRY_DAYS) {
      throw new WorkOSApiError(
        400,
        `Expires in days must be less than or equal to ${INVITATION_MAX_EXPIRY_DAYS}.`,
        'expires_in_days_too_long',
      );
    }
    if (expiresInDays < INVITATION_MIN_EXPIRY_DAYS) {
      throw new WorkOSApiError(
        400,
        `Expires in days must be greater than ${INVITATION_MIN_EXPIRY_DAYS}.`,
        'expires_in_days_too_short',
      );
    }

    const pendingInviteFor = (orgId: string | null) =>
      ws.invitations
        .all()
        .some(
          (inv) => emailsMatch(inv.email, email) && inv.organization_id === orgId && invitationState(inv) === 'pending',
        );

    if (organizationId) {
      // Production refuses a second open invitation to the same organization, and refuses to
      // invite someone who already holds an active membership there. An inactive or pending
      // membership is re-invited instead (see provisionInvitee).
      if (pendingInviteFor(organizationId)) {
        throw new WorkOSApiError(
          400,
          'Email already invited to organization.',
          'email_already_invited_to_organization',
        );
      }
      const recipient = findUserByEmail(ws, email);
      if (recipient && liveMembershipFor(ws, organizationId, recipient.id)?.status === 'active') {
        throw new WorkOSApiError(400, 'User already a member of organization.', 'user_already_organization_member');
      }
    } else {
      // An invitation to the environment alone is a sign-up link: production refuses one for
      // an address that already has an open one, or that already has an account. (Production
      // lets an account that only an organization invitation created through, as the invitee
      // has not completed sign-up; the emulator records no such distinction and refuses any
      // existing account.)
      if (pendingInviteFor(null)) {
        throw new WorkOSApiError(400, 'Email already invited.', 'email_already_invited');
      }
      if (findUserByEmail(ws, email)) {
        throw new WorkOSApiError(400, 'User already exists.', 'user_already_exists');
      }
    }

    const token = generateVerificationToken();
    const inv = ws.invitations.insert({
      object: 'invitation',
      email,
      token,
      accept_invitation_url: `${ctx.baseUrl}/user_management/invitations/accept?token=${token}`,
      organization_id: organizationId,
      inviter_user_id: inviterUserId,
      role_slug: roleSlug,
      expires_at: invitationExpiresIn(expiresInDays),
      accepted_at: null,
      revoked_at: null,
      accepted_user_id: null,
    });

    provisionInvitee(inv, ws);

    return c.json(formatInvitation(inv), 201);
  });

  app.get('/user_management/invitations', (c) => {
    const url = new URL(c.req.url);
    const params = parseListParams(url);
    const emailFilter = url.searchParams.get('email') ?? undefined;
    const orgFilter = url.searchParams.get('organization_id') ?? undefined;

    const result = ws.invitations.list({
      ...params,
      filter: (inv) => {
        // Case-insensitively, like every other lookup by email.
        if (emailFilter && !emailsMatch(inv.email, emailFilter)) return false;
        if (orgFilter && inv.organization_id !== orgFilter) return false;
        return true;
      },
    });

    return c.json(formatListResponse(result, formatInvitation));
  });

  app.get('/user_management/invitations/by_token/:token', (c) => {
    const inv = ws.invitations.findOneBy('token', c.req.param('token'));
    if (!inv) throw notFound('Invite', c.req.param('token'));
    return c.json(formatInvitation(inv));
  });

  app.get('/user_management/invitations/:id', (c) => {
    const inv = ws.invitations.get(c.req.param('id'));
    if (!inv) throw notFound('Invite', c.req.param('id'));
    return c.json(formatInvitation(inv));
  });

  // Accepting and revoking want a pending invitation; production reports anything else — an
  // expired one included — under one code.
  const inviteNotPending = () => new WorkOSApiError(400, 'Invite is not pending.', 'invite_not_pending');

  app.post('/user_management/invitations/:id/accept', (c) => {
    const inv = ws.invitations.get(c.req.param('id'));
    if (!inv) throw notFound('Invite', c.req.param('id'));
    if (invitationState(inv) !== 'pending') throw inviteNotPending();

    // Case-insensitively: an exact match here enrolled nobody for an account stored under a
    // different case, spending the invitation and emitting invitation.accepted with no membership
    // to show for it. The authenticate flow already compares the two addresses this way, and Magic
    // Auth sign-up makes accounts under whatever case the caller sent.
    acceptInvitation(inv, findUserByEmail(ws, inv.email), ws, store.getData<EventBus>(STORE_KEYS.eventBus));

    const updated = ws.invitations.get(inv.id)!;
    return c.json(formatInvitation(updated));
  });

  app.post('/user_management/invitations/:id/revoke', (c) => {
    const inv = ws.invitations.get(c.req.param('id'));
    if (!inv) throw notFound('Invite', c.req.param('id'));
    if (invitationState(inv) !== 'pending') throw inviteNotPending();

    ws.invitations.update(inv.id, { revoked_at: new Date().toISOString() });
    const eventBus = store.getData<EventBus>(STORE_KEYS.eventBus);
    eventBus?.emit({ event: EVENTS.invitationRevoked, data: formatInvitation(ws.invitations.get(inv.id)!) });
    const updated = ws.invitations.get(inv.id)!;
    return c.json(formatInvitation(updated));
  });

  app.post('/user_management/invitations/:id/resend', (c) => {
    const inv = ws.invitations.get(c.req.param('id'));
    if (!inv) throw notFound('Invite', c.req.param('id'));

    // Resending sends the pending invitation again; it does not reopen one that has lapsed,
    // been accepted or been revoked. Production names which under a code of its own.
    const state = invitationState(inv);
    if (state === 'expired') throw new WorkOSApiError(400, 'Invite has expired.', 'invite_expired');
    if (state === 'revoked') throw new WorkOSApiError(400, 'Invite has been revoked.', 'invite_revoked');
    if (state === 'accepted') throw new WorkOSApiError(400, 'Invite has already been accepted.', 'invite_accepted');

    const newToken = generateVerificationToken();
    ws.invitations.update(inv.id, {
      token: newToken,
      accept_invitation_url: `${ctx.baseUrl}/user_management/invitations/accept?token=${newToken}`,
      expires_at: invitationExpiresIn(INVITATION_DEFAULT_EXPIRY_DAYS),
    });

    const eventBus = store.getData<EventBus>(STORE_KEYS.eventBus);
    eventBus?.emit({ event: EVENTS.invitationResent, data: formatInvitation(ws.invitations.get(inv.id)!) });
    const updated = ws.invitations.get(inv.id)!;
    return c.json(formatInvitation(updated));
  });
}
