import { randomBytes, randomInt, createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { domainToASCII } from 'node:url';
import {
  PlainApiError,
  WorkOSApiError,
  validationError,
  generateId,
  ID_PREFIXES,
  type ApiKeyMap,
  type Collection,
  type CursorPaginatedResult,
  type Entity,
  type Store,
} from '../core/index.js';
import {
  DEFAULT_RESOURCE_TYPE_SLUG,
  EVENTS,
  STORE_KEYS,
  type AuthenticationEventData,
  type WorkOSEventName,
} from './constants.js';
import type { WorkOSStore } from './store.js';
import type { EventBus } from './event-bus.js';
import { membershipRoleFields, membershipRoleSlugs } from './membership-roles.js';
import type {
  WorkOSAgentBlueprint,
  WorkOSAgentInstance,
  WorkOSAgentInstanceSession,
  WorkOSOrganization,
  WorkOSOrganizationDomain,
  WorkOSItContact,
  WorkOSOrganizationMembership,
  WorkOSGroup,
  WorkOSUser,
  WorkOSSession,
  WorkOSAuthkitOauthResource,
  WorkOSEmailVerification,
  WorkOSPasswordReset,
  WorkOSMagicAuth,
  WorkOSAuthenticationFactor,
  WorkOSIdentity,
  WorkOSConnection,
  WorkOSConnectionType,
  WorkOSSSOProfile,
  WorkOSPipeConnection,
  WorkOSInvitation,
  WorkOSRedirectUri,
  WorkOSCorsOrigin,
  WorkOSAuthorizedApplication,
  WorkOSConnectedAccount,
  ConnectedAccountState,
  OneTimeCodeState,
  WorkOSAuthenticationChallenge,
  WorkOSDeviceAuthorization,
  WorkOSRole,
  WorkOSPermission,
  WorkOSAuthorizationResource,
  WorkOSRoleAssignment,
  WorkOSGroupRoleAssignment,
  WorkOSDirectory,
  WorkOSDirectoryUser,
  WorkOSDirectoryGroup,
  WorkOSAuditLogAction,
  WorkOSAuditLogExport,
  WorkOSFeatureFlag,
  WorkOSConnectApplication,
  WorkOSClientSecret,
  WorkOSRadarAttempt,
  WorkOSApiKey,
  WorkOSApiKeyOwner,
  WorkOSEvent,
  WorkOSWebhookEndpoint,
} from './entities.js';

const INTERNAL_FIELDS = new Set<string>(['password_hash', 'code_challenge', 'code_challenge_method']);

export function formatEntity<T extends Entity>(entity: T, opts?: { exclude?: Set<string> }): Record<string, unknown> {
  const exclude = opts?.exclude ?? INTERNAL_FIELDS;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entity)) {
    if (!exclude.has(key)) result[key] = value;
  }
  return result;
}

export function formatListResponse<T>(
  result: CursorPaginatedResult<T>,
  formatter: (item: T) => Record<string, unknown>,
): { object: 'list'; data: Record<string, unknown>[]; list_metadata: { before: string | null; after: string | null } } {
  return {
    object: 'list',
    data: result.data.map(formatter),
    list_metadata: result.list_metadata,
  };
}

export function formatOrganization(
  org: WorkOSOrganization,
  ws: WorkOSStore,
  opts?: { domains?: WorkOSOrganizationDomain[] },
): Record<string, unknown> {
  const domains = (opts?.domains ?? ws.organizationDomains.findBy('organization_id', org.id)).map(formatDomain);

  const result: Record<string, unknown> = {
    object: 'organization',
    id: org.id,
    name: org.name,
    allow_profiles_outside_organization: org.allow_profiles_outside_organization,
    external_id: org.external_id,
    metadata: org.metadata,
    domains,
    created_at: org.created_at,
    updated_at: org.updated_at,
  };

  // Production omits stripe_customer_id when it is null rather than emitting it.
  if (org.stripe_customer_id !== null) {
    result.stripe_customer_id = org.stripe_customer_id;
  }

  return result;
}

/**
 * Both production serializers (the standalone domain and the organization's embedded list) render
 * `verification_token`, `verification_prefix` and `verification_strategy` whenever the domain has
 * them, so the fields appear once DNS verification has started and are absent before.
 */
export function formatDomain(domain: WorkOSOrganizationDomain): Record<string, unknown> {
  return formatEntity(domain);
}

// The owning organization and the whole invitation state stay internal: the spec's ItContact
// documents neither, and an invitation is addressed through the organization's routes.
const IT_CONTACT_EXCLUDE = new Set([
  ...INTERNAL_FIELDS,
  'organization_id',
  'invited_at',
  'invite_intents',
  'invite_setup_link',
]);

export function formatItContact(contact: WorkOSItContact): Record<string, unknown> {
  return formatEntity(contact, { exclude: IT_CONTACT_EXCLUDE });
}

export function formatMembership(m: WorkOSOrganizationMembership, ws: WorkOSStore): Record<string, unknown> {
  // Real WorkOS `organization_membership` REST responses always carry `directory_managed`,
  // `custom_attributes`, `roles`, and an embedded `user`. The emulator previously omitted
  // them, which breaks strict SDK deserializers (e.g. the WorkOS Python SDK's
  // `OrganizationMembership.from_dict`, whose required-key lookup raises on the first
  // missing field). `directory_managed` is stored on the membership — seeding a directory
  // sets it — `custom_attributes` defaults to `{}`, `role` and `roles` are derived from the
  // stored set in role priority order (see membershipRoleSlugs), and the `user` is resolved
  // from `user_id`.
  const user = ws.users.get(m.user_id);
  if (!user) {
    // Every insertion path guarantees a live user (the create route 404s an unknown
    // user, invitation acceptance resolves by email, seeding validates references) and
    // user deletion cascades memberships — a miss here is an emulator bug. Fail loudly
    // rather than emit `user: null`, the exact strict-SDK deserialization break this
    // serializer exists to prevent.
    throw new Error(
      `No user '${m.user_id}' for membership '${m.id}': the user was deleted without cascading, or the membership was inserted without validation`,
    );
  }
  const roles = membershipRoleSlugs(ws, m).map((slug) => ({ slug }));
  return {
    ...formatEntity(m),
    role: roles[0],
    roles,
    directory_managed: m.directory_managed ?? false,
    custom_attributes: {},
    user: formatUser(user),
  };
}

// Webhook events carry a slimmer membership than the REST responses: the real WorkOS
// `organization_membership.*` event payload requires `directory_managed` and
// `custom_attributes` and carries `role` and `roles` like the REST shape, but has no embedded
// `user` (see EVENT_DATA_REQUIREMENTS). Keep the event shape spec-accurate instead of reusing
// the REST serializer.
export function formatMembershipEvent(m: WorkOSOrganizationMembership, ws: WorkOSStore): Record<string, unknown> {
  const roles = membershipRoleSlugs(ws, m).map((slug) => ({ slug }));
  return {
    ...formatEntity(m),
    role: roles[0],
    roles,
    directory_managed: m.directory_managed ?? false,
    custom_attributes: {},
  };
}

/**
 * The slimmer membership shape `GET .../groups/{groupId}/organization-memberships` returns —
 * the spec's `UserlandUserOrganizationMembershipBase`: the identifying fields without the
 * embedded `user` or `roles` the full membership serializer adds. The group-members list
 * endpoint is the only caller; the full `formatMembership` is wrong there because the base
 * schema has no `user` or `roles` property.
 */
export function formatMembershipBase(m: WorkOSOrganizationMembership): Record<string, unknown> {
  return {
    object: 'organization_membership',
    id: m.id,
    user_id: m.user_id,
    organization_id: m.organization_id,
    status: m.status,
    directory_managed: m.directory_managed ?? false,
    custom_attributes: {},
    created_at: m.created_at,
    updated_at: m.updated_at,
  };
}

/** An AuthKit group (`group` object). `formatEntity` yields exactly the spec's `Group` shape. */
export function formatGroup(g: WorkOSGroup): Record<string, unknown> {
  return formatEntity(g);
}

const USER_EXCLUDE = new Set([...INTERNAL_FIELDS, 'impersonator', 'oauth_provider']);

export function formatUser(user: WorkOSUser): Record<string, unknown> {
  return formatEntity(user, { exclude: USER_EXCLUDE });
}

export function formatSession(s: WorkOSSession): Record<string, unknown> {
  return formatEntity(s);
}

/** Maps the emulator's PascalCase authentication_method values to the spec's snake_case event `type`. */
export const AUTH_METHOD_EVENT_TYPES: Record<string, string> = {
  OAuth: 'oauth',
  Password: 'password',
  MagicAuth: 'magic_auth',
  EmailVerification: 'email_verification',
  MFA: 'mfa',
  SSO: 'sso',
};

/**
 * Maps authentication_method values to the session `auth_method` enum (note: magic_code, not magic_auth).
 *
 * The spec's session auth_method enum (cross_app_auth, external_auth, impersonation, magic_code,
 * migrated_session, oauth, passkey, password, sso, unknown) has no value for MFA or email
 * verification. An MFA completion normally records its *primary* factor instead (e.g. 'password'),
 * resolved from the pending-auth token via sessionAuthMethod in the authenticate handler. The MFA
 * and EmailVerification entries here are fallbacks: when no primary method is known they resolve to
 * 'unknown' — a valid enum member, so consumers that validate the field still pass.
 */
export const AUTH_METHOD_SESSION_VALUES: Record<string, string> = {
  OAuth: 'oauth',
  Password: 'password',
  MagicAuth: 'magic_code',
  SSO: 'sso',
  MFA: 'unknown',
  EmailVerification: 'unknown',
};

/**
 * Resolve a spec-valid AuthenticateResponse.authentication_method from the emulator's internal
 * method category, or `undefined` to omit the field when no truthful value is available.
 *
 * The response enum is PascalCase and provider-specific: it has no bare 'OAuth', no 'MFA', no
 * 'EmailVerification', and — unlike the session's auth_method — no 'unknown'. So when the
 * emulator does not actually know the concrete method, it omits the field (which is nullable in
 * the SDKs) rather than inventing a provider:
 *   - 'OAuth' resolves to the user's explicitly configured oauth_provider, else omitted. The
 *     hosted authorize flow carries no provider information, so there is nothing truthful to
 *     default to — a fixed provider would just be a fabricated guess.
 *   - 'MFA' and 'EmailVerification' are verification gates, not methods. The real method is
 *     whatever initiated the flow; callers pass it via the primary method when known (an MFA
 *     challenge records the primary factor on the pending-auth token). When it isn't known, the
 *     field is omitted rather than guessed.
 * Everything already spec-valid (Password, MagicAuth, SSO, Passkey, GoogleOAuth, …) passes through.
 */
export function resolveResponseAuthMethod(
  method: string,
  opts?: { oauthProvider?: string | null },
): string | undefined {
  switch (method) {
    case 'OAuth':
      return opts?.oauthProvider ?? undefined;
    case 'MFA':
    case 'EmailVerification':
      return undefined;
    default:
      return method;
  }
}

/** Maps a session `auth_method` (snake_case) back to a spec-valid response authentication_method. */
const SESSION_AUTH_METHOD_RESPONSE_VALUES: Record<string, string> = {
  password: 'Password',
  magic_code: 'MagicAuth',
  sso: 'SSO',
  passkey: 'Passkey',
  cross_app_auth: 'CrossAppAuth',
  external_auth: 'ExternalAuth',
  impersonation: 'Impersonation',
  migrated_session: 'MigratedSession',
};

/**
 * Resolve the response authentication_method for a refresh_token grant, which reuses an existing
 * session rather than authenticating fresh. Real WorkOS echoes the session's *original* method, so
 * we recover it from the reused session's stored `auth_method` (snake_case) instead of the grant's
 * hard-coded 'OAuth' category — a password login that refreshes truthfully reports 'Password'.
 *
 * Generic 'oauth' has no provider recorded on the session, so it falls back to the user's
 * oauth_provider (else omitted); 'unknown' and any unmapped value are omitted rather than guessed.
 */
export function resolveSessionResponseAuthMethod(
  sessionAuthMethod: string,
  opts?: { oauthProvider?: string | null },
): string | undefined {
  if (sessionAuthMethod === 'oauth') return opts?.oauthProvider ?? undefined;
  return SESSION_AUTH_METHOD_RESPONSE_VALUES[sessionAuthMethod];
}

/** authentication.* event names per method, resolved from the spec-generated catalog. */
export const AUTH_EVENTS: Record<string, { succeeded: WorkOSEventName; failed: WorkOSEventName }> = {
  OAuth: { succeeded: EVENTS.authenticationOauthSucceeded, failed: EVENTS.authenticationOauthFailed },
  Password: { succeeded: EVENTS.authenticationPasswordSucceeded, failed: EVENTS.authenticationPasswordFailed },
  MagicAuth: { succeeded: EVENTS.authenticationMagicAuthSucceeded, failed: EVENTS.authenticationMagicAuthFailed },
  EmailVerification: {
    succeeded: EVENTS.authenticationEmailVerificationSucceeded,
    failed: EVENTS.authenticationEmailVerificationFailed,
  },
  MFA: { succeeded: EVENTS.authenticationMfaSucceeded, failed: EVENTS.authenticationMfaFailed },
  SSO: { succeeded: EVENTS.authenticationSsoSucceeded, failed: EVENTS.authenticationSsoFailed },
};

export function buildAuthenticationEventData(opts: {
  status: 'succeeded' | 'failed';
  method: string;
  userId?: string | null;
  email?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  error?: { code: string; message: string };
  sso?: { organization_id: string | null; connection_id: string | null; session_id: string | null };
}): Record<string, unknown> {
  const data: AuthenticationEventData = {
    type: (AUTH_METHOD_EVENT_TYPES[opts.method] ?? opts.method.toLowerCase()) as AuthenticationEventData['type'],
    status: opts.status,
    user_id: opts.userId ?? null,
    email: opts.email ?? null,
    ip_address: opts.ipAddress ?? null,
    user_agent: opts.userAgent ?? null,
    ...(opts.error ? { error: opts.error } : {}),
    ...(opts.sso ? { sso: opts.sso } : {}),
  };
  return { ...data };
}

/**
 * Emit an authentication event (succeeded or failed) for a given method.
 * This unified helper handles both regular auth events and SSO-specific events.
 */
export function emitAuthenticationEvent(opts: {
  eventBus: EventBus | undefined;
  method: string;
  status: 'succeeded' | 'failed';
  userId?: string | null;
  email?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  error?: { code: string; message: string };
  sso?: { organization_id: string | null; connection_id: string | null; session_id: string | null };
}): void {
  const { eventBus, method, status, ...eventData } = opts;
  if (!eventBus) return;

  const authEvent = AUTH_EVENTS[method];
  if (!authEvent) return;

  const eventName = status === 'succeeded' ? authEvent.succeeded : authEvent.failed;
  eventBus.emit({
    event: eventName,
    data: buildAuthenticationEventData({
      status,
      method,
      ...eventData,
    }),
  });
}

// The attempt count and redemption time are the verifier's bookkeeping; the spec's
// EmailVerification and MagicAuth carry the code and its expiry, nothing about its use.
const ONE_TIME_CODE_EXCLUDE = new Set([...INTERNAL_FIELDS, 'attempts', 'verified_at']);

export function formatEmailVerification(ev: WorkOSEmailVerification): Record<string, unknown> {
  return formatEntity(ev, { exclude: ONE_TIME_CODE_EXCLUDE });
}

// The spec's PasswordReset carries `created_at` but no `updated_at`: a reset is never modified,
// only spent. Every other stored field is already wire-named.
const PASSWORD_RESET_EXCLUDE = new Set([...INTERNAL_FIELDS, 'updated_at']);

export function formatPasswordReset(pr: WorkOSPasswordReset): Record<string, unknown> {
  return formatEntity(pr, { exclude: PASSWORD_RESET_EXCLUDE });
}

export function formatMagicAuth(ma: WorkOSMagicAuth): Record<string, unknown> {
  return formatEntity(ma, { exclude: ONE_TIME_CODE_EXCLUDE });
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Production validates a caller-supplied `totp_secret` against exactly this. */
export const BASE32_SECRET = /^[A-Z2-7]+=*$/;

/**
 * The TOTP details an enrollment stores. Without a caller-supplied secret it mints 32 Base32
 * characters — the 160 bits RFC 4226 recommends — so authenticator apps and TOTP libraries
 * accept the secret verbatim; `uri` is the otpauth form those apps import.
 */
export function newTotp(issuer: string, user: string, secret?: string): WorkOSAuthenticationFactor['totp'] {
  secret ??= Array.from(randomBytes(32), (b) => BASE32_ALPHABET[b & 31]).join('');
  const issuerParam = encodeURIComponent(issuer);
  return {
    issuer,
    user,
    secret,
    uri: `otpauth://totp/${issuerParam}:${encodeURIComponent(user)}?secret=${secret}&issuer=${issuerParam}`,
  };
}

// ponytail: a valid 1×1 PNG, not a scannable code — the spec requires the field and SDKs require a
// string, and the emulator never checks a real TOTP code. Add a QR encoder if a consumer's UI
// test needs to scan it; `uri` already carries everything the code would.
const TOTP_QR_CODE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Whether the factor has verified is a filter on the list, never a field of the factor.
const AUTH_FACTOR_EXCLUDE = new Set([...INTERNAL_FIELDS, 'last_verified_at']);

/** The spec's AuthenticationFactor: what GET and LIST return, secrets stripped. */
export function formatAuthFactor(f: WorkOSAuthenticationFactor): Record<string, unknown> {
  return { ...formatEntity(f, { exclude: AUTH_FACTOR_EXCLUDE }), totp: { issuer: f.totp.issuer, user: f.totp.user } };
}

/** The spec's AuthenticationFactorEnrolled: the one response that shows the secrets. */
export function formatAuthFactorEnrolled(f: WorkOSAuthenticationFactor): Record<string, unknown> {
  return { ...formatEntity(f, { exclude: AUTH_FACTOR_EXCLUDE }), totp: { ...f.totp, qr_code: TOTP_QR_CODE } };
}

/**
 * The factors production counts as enrolled: those whose enrollment challenge has verified.
 * `GET /user_management/users/{id}/auth_factors` lists these and nothing else
 * (`verifiedOnly: true`), and the password grant challenges a second factor only when one
 * exists — so a factor enrolled and never verified is invisible to both, as it is live.
 */
export function verifiedAuthFactors(ws: WorkOSStore, userId: string): WorkOSAuthenticationFactor[] {
  return ws.authFactors.findBy('user_id', userId).filter((f) => f.last_verified_at !== null);
}

/** Production's `touchLastVerifiedAt`: the factor is verified from the moment one of its challenges is. */
export function touchFactorVerified(ws: WorkOSStore, factorId: string): void {
  ws.authFactors.update(factorId, { last_verified_at: new Date().toISOString() });
}

/**
 * The spec's identity is the three federated fields and nothing else — no `object`, no `id`, no
 * timestamps — and its endpoint returns a bare array rather than a list envelope, which is what
 * the SDKs deserialize (`getUserIdentities` maps the response body directly).
 */
export function formatIdentity(i: WorkOSIdentity): Record<string, unknown> {
  return { idp_id: i.idp_id, type: i.type, provider: i.provider };
}

/**
 * Record that `user` signs in through `provider`, idempotently: an identity is a link, and a
 * second login through the same provider is the same link, not another one. Callers pass the
 * provider as a spec-valid AuthenticateResponse value ('GoogleOAuth', 'MicrosoftOAuth', …),
 * which is also what the identity `provider` enum holds.
 */
export function linkOAuthIdentity(ws: WorkOSStore, userId: string, provider: string, idpId: string): void {
  if (ws.identities.findBy('user_id', userId).some((i) => i.provider === provider)) return;
  ws.identities.insert({
    object: 'identity',
    user_id: userId,
    provider,
    idp_id: idpId,
    type: 'OAuth',
  });
}

export function generateVerificationToken(): string {
  return randomBytes(16).toString('hex');
}

export function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Whether a string is shaped enough like an email to be worth storing. Deliberately loose —
 * the emulator is not an address validator, it just refuses input that could only be a typo.
 */
export function isEmailShaped(value: string): boolean {
  const at = value.indexOf('@');
  return at > 0 && at === value.lastIndexOf('@') && at < value.length - 1 && !/\s/.test(value);
}

/** Why a supplied `email` cannot be used, kept apart so a caller can report which one happened. */
export type EmailProblem = 'missing' | 'not_a_string' | 'malformed';

const EMAIL_PROBLEM_MESSAGES: Record<EmailProblem, string> = {
  missing: 'email is required',
  not_a_string: 'email must be a string',
  malformed: 'email must be a valid email address',
};

/** The `errors[].code` each problem carries on the routes that report a 422. */
const EMAIL_PROBLEM_FIELD_CODES: Record<EmailProblem, string> = {
  missing: 'required',
  not_a_string: 'invalid_type',
  malformed: 'invalid',
};

export type NormalizedEmail = { ok: true; email: string } | { ok: false; problem: EmailProblem };

/**
 * Normalize a request's `email` to a trimmed string, or say why it can't be. Not every value
 * handed to this is normalizable, so the problem comes back as a value rather than an exception:
 * the routes disagree about how to report it — `validationError`'s 422 on the user-management
 * CRUD routes, a 400 `invalid_request` on the grants — and only about that.
 *
 * Callers used to type-assert instead, which was survivable while a lookup by email could only
 * miss — `findOneBy` returns undefined for a number as readily as for an unknown address.
 * Resolving case-insensitively means calling `toLowerCase` on it, so the same assertion throws and
 * a malformed request comes back a 500 that tells the caller nothing.
 *
 * `null` is `missing`, not `not_a_string`: in a JSON body it is how a caller spells absence, and
 * the guard exists to name what the caller must fix, not what `typeof` says.
 *
 * `requireShape` is for the routes that create something from the address rather than look one up.
 * A read that misses is a 404 the caller can act on; a write that stores a typo is an account or
 * an invitation nothing can ever reach. Read paths leave it off, so an address that does not
 * resolve still 404s rather than changing error shape.
 */
export function normalizeEmail(value: unknown, opts?: { requireShape?: boolean }): NormalizedEmail {
  if (value === undefined || value === null) return { ok: false, problem: 'missing' };
  if (typeof value !== 'string') return { ok: false, problem: 'not_a_string' };
  const email = value.trim();
  if (!email) return { ok: false, problem: 'missing' };
  if (opts?.requireShape && !isEmailShaped(email)) return { ok: false, problem: 'malformed' };
  return { ok: true, email };
}

/**
 * The trimmed `email` from a request body, as a route that reports 400 `invalid_request` wants it.
 *
 * Absence comes back as `''` rather than throwing, because the grants name it alongside whatever
 * else they also require ("code and email are required") — a message that is more use than one
 * field at a time.
 */
export function requireEmailString(value: unknown, opts?: { requireShape?: boolean }): string {
  const result = normalizeEmail(value, opts);
  if (result.ok) return result.email;
  if (result.problem === 'missing') return '';
  throw new WorkOSApiError(400, EMAIL_PROBLEM_MESSAGES[result.problem], 'invalid_request');
}

/**
 * The trimmed `email` from a request body, as the user-management CRUD routes want it: a 422 with
 * the per-field code, which is the validation shape those routes already answer in.
 */
export function requireEmailField(value: unknown, opts?: { requireShape?: boolean }): string {
  const result = normalizeEmail(value, opts);
  if (result.ok) return result.email;
  throw validationError(EMAIL_PROBLEM_MESSAGES[result.problem], [
    { field: 'email', code: EMAIL_PROBLEM_FIELD_CODES[result.problem] },
  ]);
}

/**
 * Whether two addresses name the same account. Case-insensitive, like every lookup by email, and
 * trimmed for the same reason storage is: a padded copy of an address names the same person, and a
 * filter that skipped the trim would not return what creation had just written.
 */
export function emailsMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Look a user up by email, ignoring case. `findOneBy` is an exact-match index lookup, which is
 * fine for a read but forks the account in two anywhere a miss creates a user instead.
 */
export function findUserByEmail(ws: WorkOSStore, email: string): WorkOSUser | undefined {
  const exact = ws.users.findOneBy('email', email);
  if (exact) return exact;
  return ws.users.all().find((u) => emailsMatch(u.email, email));
}

/**
 * The one membership a user holds in an organization that is not `inactive`. `POST
 * /user_management/organization_memberships` never adds a second live membership (it answers
 * with the existing active one, or a 400 for a pending one) and validateSeedConfig rejects one,
 * so the first match is the only match — and a stale deactivated record is never taken for the
 * live one.
 */
export function liveMembershipFor(
  ws: WorkOSStore,
  organizationId: string,
  userId: string,
): WorkOSOrganizationMembership | undefined {
  return ws.organizationMemberships
    .findBy('organization_id', organizationId)
    .find((m) => m.user_id === userId && m.status !== 'inactive');
}

/**
 * Hash password using SHA256.
 * NOTE: This is intentionally weak for emulator/testing only.
 * Production systems should use bcrypt, scrypt, or Argon2 with proper salt and iterations.
 */
export function hashPassword(password: string): string {
  return createHash('sha256').update(password).digest('hex');
}

export function verifyPassword(password: string, hash: string): boolean {
  return hashPassword(password) === hash;
}

export function expiresIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

export function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}

/**
 * End every session the user holds, the way `POST /user_management/sessions/revoke` ends one:
 * the record is stamped revoked so the `session.revoked` payload its deletion emits says so.
 * Production does this when a password is reset (`revokeByUser`), since the reset is how a user
 * takes an account back from whoever else was signed in to it.
 */
export function revokeSessionsForUser(ws: WorkOSStore, userId: string): void {
  for (const session of ws.sessions.findBy('user_id', userId)) {
    revokeSession(ws, session.id);
  }
}

export function revokeSession(ws: WorkOSStore, sessionId: string): void {
  // Sessions have no onUpdate hook, so this only shapes the session.revoked payload.
  ws.sessions.update(sessionId, { status: 'revoked', ended_at: new Date().toISOString() });
  ws.sessions.delete(sessionId);
}

/** Production's `MAX_AUTHENTICAITON_ATTEMPTS` (sic): comparisons a one-time code allows before it locks. */
export const MAX_ONE_TIME_CODE_ATTEMPTS = 3;

export type OneTimeCodeOutcome = 'valid' | 'invalid' | 'expired' | 'previously_used' | 'too_many_attempts';

type OneTimeCode = Entity & OneTimeCodeState & { code: string; expires_at: string };

/**
 * The newest of a user's codes: the only one production will compare against. It resolves the
 * code to verify by the user — the latest challenge on their email factor — rather than by the
 * code sent, so requesting a second code retires the first even while the first is unexpired.
 * Issuing through `issueEmailVerificationCode` / `issueMagicAuthCode` leaves one record per
 * user, but a record inserted directly (a seed, a test) can sit beside it, and insertion order
 * would not settle which is newer, since an update re-indexes a record to the end.
 */
export function latestOneTimeCode<T extends Entity>(records: T[]): T | undefined {
  return records.reduce<T | undefined>(
    (latest, r) =>
      !latest || r.created_at > latest.created_at || (r.created_at === latest.created_at && r.id > latest.id)
        ? r
        : latest,
    undefined,
  );
}

/**
 * What production's AuthenticationChallengeVerifier answers for `code` against `record`, in its
 * order: a code already redeemed is refused before anything else, then one that has used up its
 * attempts, then one past its expiry — and only then is the code compared. A miss is counted
 * here, so the third miss is the last comparison the code gets: the fourth request, right code
 * or wrong, is `too_many_attempts`. A hit is not spent here; the caller runs `redeemOneTimeCode`
 * once whatever else its request has to check has passed, so a request that fails after the
 * code matched leaves the code redeemable.
 */
export function verifyOneTimeCode<T extends OneTimeCode>(
  collection: Collection<T>,
  record: T,
  code: string,
): OneTimeCodeOutcome {
  if (record.verified_at !== null) return 'previously_used';
  if (record.attempts >= MAX_ONE_TIME_CODE_ATTEMPTS) return 'too_many_attempts';
  if (isExpired(record.expires_at)) return 'expired';
  if (code === record.code) return 'valid';
  collection.update(record.id, { attempts: record.attempts + 1 } as Partial<T>);
  return 'invalid';
}

/**
 * Issue the user a fresh email verification code, retiring any earlier one. Production compares
 * a code against the user's latest challenge only, so once this record exists an earlier code
 * can never be redeemed again — presenting it is a miss against the new code, not
 * `previously_used` — and nothing is lost by dropping its record. One record per user is also
 * what keeps a long-running emulator from holding one per login. The insert is what delivers
 * the code, on the email_verification.created webhook, the way every emailed code leaves the
 * emulator.
 */
export function issueEmailVerificationCode(
  ws: WorkOSStore,
  user: { id: string; email: string },
): WorkOSEmailVerification {
  ws.emailVerifications.deleteBy('user_id', user.id);
  return ws.emailVerifications.insert({
    object: 'email_verification',
    user_id: user.id,
    email: user.email,
    code: generateCode(),
    expires_at: expiresIn(10),
    attempts: 0,
    verified_at: null,
  });
}

/** The Magic Auth counterpart of `issueEmailVerificationCode`, delivered on magic_auth.created. */
export function issueMagicAuthCode(ws: WorkOSStore, user: { id: string; email: string }): WorkOSMagicAuth {
  ws.magicAuths.deleteBy('user_id', user.id);
  return ws.magicAuths.insert({
    object: 'magic_auth',
    user_id: user.id,
    email: user.email,
    code: generateCode(),
    expires_at: expiresIn(10),
    attempts: 0,
    verified_at: null,
  });
}

/** Spend a code `verifyOneTimeCode` found valid: the hit counts as an attempt, and the code answers `previously_used` from now on. */
export function redeemOneTimeCode<T extends OneTimeCode>(collection: Collection<T>, record: T): void {
  collection.update(record.id, {
    attempts: record.attempts + 1,
    verified_at: new Date().toISOString(),
  } as Partial<T>);
}

/**
 * The authenticate grants' one-time-code failures, as production words them. `identifier` is
 * what the message names: the email for Magic Auth and email verification, the challenge id for
 * MFA — production's own distinction, since the first two being challenges underneath is not
 * something it exposes.
 */
export function oneTimeCodeError(outcome: Exclude<OneTimeCodeOutcome, 'valid'>, identifier: string): WorkOSApiError {
  switch (outcome) {
    case 'expired':
      return new WorkOSApiError(400, `One-time code for '${identifier}' has expired.`, 'one_time_code_expired');
    case 'previously_used':
      return new WorkOSApiError(
        400,
        `One-time code for '${identifier}' was previously used.`,
        'one_time_code_previously_used',
      );
    case 'too_many_attempts':
      return new WorkOSApiError(
        400,
        `One-time code for '${identifier}' has had too many failed attempts.`,
        'one_time_code_too_many_attempts',
      );
    case 'invalid':
      return new WorkOSApiError(400, 'Invalid one-time code', 'invalid_one_time_code');
  }
}

export function formatConnection(conn: WorkOSConnection): Record<string, unknown> {
  return formatEntity(conn);
}

/**
 * The types production's one-connection-per-organization count leaves out
 * (`ConnectionCreator.isAtConnectionLimit`, `api/src/connections/connection-creator.ts`). They
 * are environment-level there — an OAuth or Magic Link connection never belongs to an
 * organization — so they never count against the one SSO connection an organization may hold.
 * The emulator lets a seed bind one to an organization, and keeps the same exemption.
 */
const CONNECTION_LIMIT_EXEMPT_TYPES: ReadonlySet<WorkOSConnectionType> = new Set<WorkOSConnectionType>([
  'AppleOAuth',
  'GitHubOAuth',
  'GoogleOAuth',
  'MicrosoftOAuth',
  'MagicLink',
]);

export function countsTowardConnectionLimit(type: WorkOSConnectionType): boolean {
  return !CONNECTION_LIMIT_EXEMPT_TYPES.has(type);
}

/**
 * The organization's SSO connections — the ones production counts toward its limit of one per
 * organization. Deleted connections are gone from the store, which is production's exclusion of
 * the `Deleting` state.
 */
export function organizationSsoConnections(ws: WorkOSStore, organizationId: string): WorkOSConnection[] {
  return ws.connections
    .findBy('organization_id', organizationId)
    .filter((cn) => countsTowardConnectionLimit(cn.connection_type));
}

/**
 * The types `GET /connections` leaves out. Production's listing passes `excludeOauth`,
 * `excludeMagicLink` and `excludeTestIdp` (`api/src/connections/connections.controller.ts`);
 * the OAuth set is `api-services/src/connections/oauth-connection-types.ts`, narrowed here to
 * the members the spec's `connection_type` enum has.
 */
const UNLISTED_CONNECTION_TYPES: ReadonlySet<WorkOSConnectionType> = new Set<WorkOSConnectionType>([
  'AppleOAuth',
  'BitbucketOAuth',
  'GitHubOAuth',
  'GitLabOAuth',
  'GoogleOAuth',
  'IntuitOAuth',
  'LinkedInOAuth',
  'MicrosoftOAuth',
  'SalesforceOAuth',
  'SlackOAuth',
  'VercelMarketplaceOAuth',
  'VercelOAuth',
  'XeroOAuth',
  'MagicLink',
  'TestIdp',
]);

export function isListedConnectionType(type: WorkOSConnectionType): boolean {
  return !UNLISTED_CONNECTION_TYPES.has(type);
}

/**
 * The spec's Profile has no timestamps, and production's serializer
 * (`api/src/sso/utils/serialize-profile.ts`) emits none — `created_at` and `updated_at` are
 * the store's bookkeeping, not part of the wire shape.
 */
const SSO_PROFILE_EXCLUDE = new Set([...INTERNAL_FIELDS, 'created_at', 'updated_at']);

/**
 * The spec's Profile carries `name` (the user's full name, nullable) beside `first_name` and
 * `last_name`, and the SDKs read it as a required key — workos-python's `Profile.from_dict` fails
 * without it (#129). It is emitted as stored, never composed from the two parts: production's
 * reconciler (`api/src/profiles/profile-reconciler.ts`) sets `name` only when the connection's
 * attribute map has a `name` key, and its serializer returns that stored value or null. A
 * derived "Ada Lovelace" would pass against the emulator and come back null from WorkOS.
 */
export function formatSSOProfile(p: WorkOSSSOProfile): Record<string, unknown> {
  return formatEntity(p, { exclude: SSO_PROFILE_EXCLUDE });
}

export function formatPipeConnection(pc: WorkOSPipeConnection): Record<string, unknown> {
  return formatEntity(pc);
}

/**
 * How long an invitation stays open when the request names no `expires_in_days`: production's
 * `invitation_expiry` environment setting, 7 days as created. The request may say 1 to 30.
 */
export const INVITATION_DEFAULT_EXPIRY_DAYS = 7;
export const INVITATION_MIN_EXPIRY_DAYS = 1;
export const INVITATION_MAX_EXPIRY_DAYS = 30;

export function invitationExpiresIn(days: number): string {
  return expiresIn(days * 24 * 60);
}

export type InvitationState = 'pending' | 'accepted' | 'expired' | 'revoked';

/**
 * An invitation's state, derived when it is read the way production derives it
 * (`userland-user-invites/utils/get-invite-state.ts`): revoked wins, then accepted, then expiry
 * by the clock, else pending. Deriving it is what lets an invitation expire on its own — a stored
 * state could only ever be written by a request, and no request arrives at the moment one lapses.
 */
export function invitationState(inv: WorkOSInvitation): InvitationState {
  if (inv.revoked_at !== null) return 'revoked';
  if (inv.accepted_at !== null) return 'accepted';
  if (isExpired(inv.expires_at)) return 'expired';
  return 'pending';
}

export function formatInvitation(inv: WorkOSInvitation): Record<string, unknown> {
  return { ...formatEntity(inv), state: invitationState(inv) };
}

/**
 * What WorkOS creates the moment an invitation to an organization is sent: the recipient's user,
 * when the address has no account yet, and their membership, `pending` with the invitation's role.
 * acceptInvitation activates that same membership; revoking the invitation leaves it behind, as in
 * production. A membership that already exists takes the invitation's role, and an inactive one
 * goes back to `pending` so acceptance activates it again; the REST route refuses to invite an
 * active member before this runs. Shared by the invitations REST route and seeded invitations so
 * the two cannot drift.
 */
export function provisionInvitee(inv: WorkOSInvitation, ws: WorkOSStore): void {
  if (!inv.organization_id || !ws.organizations.get(inv.organization_id)) return;

  const user =
    findUserByEmail(ws, inv.email) ??
    ws.users.insert({
      object: 'user',
      email: inv.email,
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

  const roleSlug = inv.role_slug ?? 'member';
  const roleFields = membershipRoleFields(ws, inv.organization_id, [roleSlug]);
  // A seed may keep a deactivated membership beside the live one for the same user; the live
  // one is the membership, and the stale inactive row must not be revived next to it.
  const held = ws.organizationMemberships
    .findBy('organization_id', inv.organization_id)
    .filter((m) => m.user_id === user.id);
  const existing = held.find((m) => m.status !== 'inactive') ?? held[0];
  if (existing) {
    // A seeded invitation for an active member leaves the membership as it is.
    if (existing.status === 'inactive') {
      ws.organizationMemberships.update(existing.id, { status: 'pending', ...roleFields });
    } else if (existing.status === 'pending') {
      const heldRoles = membershipRoleSlugs(ws, existing);
      if (heldRoles.length !== 1 || heldRoles[0] !== roleSlug) {
        ws.organizationMemberships.update(existing.id, roleFields);
      }
    }
    return;
  }

  ws.organizationMemberships.insert({
    object: 'organization_membership',
    organization_id: inv.organization_id,
    user_id: user.id,
    ...roleFields,
    status: 'pending',
    external_id: null,
    metadata: {},
  });
}

/**
 * Mark an invitation accepted and join its recipient to the organization it names, returning that
 * organization's id (null if the invitation names none). Shared by the invitations REST route and
 * the authenticate grants that accept an `invitation_token` so the two cannot drift; validating
 * the invitation stays with each caller, which report a bad one under different spec error codes.
 *
 * An existing membership is reused rather than duplicated, and a deactivated one is reactivated —
 * a fresh invitation is how a removed member rejoins.
 */
export function acceptInvitation(
  inv: WorkOSInvitation,
  user: WorkOSUser | undefined,
  ws: WorkOSStore,
  eventBus: EventBus | undefined,
): string | null {
  ws.invitations.update(inv.id, {
    accepted_at: new Date().toISOString(),
    accepted_user_id: user?.id ?? null,
  });
  eventBus?.emit({ event: EVENTS.invitationAccepted, data: formatInvitation(ws.invitations.get(inv.id)!) });

  if (!inv.organization_id) return null;

  // The REST route resolves the recipient by email and tolerates an invitation for someone who
  // has not signed up yet: the invitation is still accepted, there is just nobody to enroll.
  if (user) {
    const roleSlug = inv.role_slug ?? 'member';
    const existing = ws.organizationMemberships
      .findBy('organization_id', inv.organization_id)
      .find((m) => m.user_id === user.id);
    if (!existing) {
      ws.organizationMemberships.insert({
        object: 'organization_membership',
        organization_id: inv.organization_id,
        user_id: user.id,
        ...membershipRoleFields(ws, inv.organization_id, [roleSlug]),
        status: 'active',
        external_id: null,
        metadata: {},
      });
    } else if (existing.status !== 'active') {
      ws.organizationMemberships.update(existing.id, {
        status: 'active',
        ...membershipRoleFields(ws, inv.organization_id, [roleSlug]),
      });
    }
  }

  return inv.organization_id;
}

export function formatRedirectUri(r: WorkOSRedirectUri): Record<string, unknown> {
  return formatEntity(r);
}

/**
 * The organizations a session could be scoped to. 'pending' is an unaccepted invitation and
 * 'inactive' a deactivated member; neither is one production would scope a session to.
 */
export function activeOrganizationsFor(ws: WorkOSStore, userId: string): Array<{ id: string; name: string }> {
  const orgs: Array<{ id: string; name: string }> = [];
  for (const m of ws.organizationMemberships.findBy('user_id', userId)) {
    if (m.status !== 'active') continue;
    const org = ws.organizations.get(m.organization_id);
    if (org) orgs.push({ id: org.id, name: org.name });
  }
  return orgs;
}

/**
 * Record a fresh sign-in: stamp the user's last sign-in and create the session it starts. Shared by
 * `/user_management/authenticate` and `/oauth2/token`, so a login through either leaves the same
 * trace. The caller emits the authentication event, which it knows the method of.
 *
 * `verifyEmail` marks the mailbox proven (a redeemed magic-auth code does), folded into the sign-in
 * write so it is one write and one `user.updated`.
 */
export function startLoginSession(
  ws: WorkOSStore,
  input: {
    user: WorkOSUser;
    organizationId: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    /** The method the session records; see AUTH_METHOD_SESSION_VALUES. */
    authMethod: string;
    verifyEmail?: boolean;
  },
): WorkOSSession {
  const { user } = input;
  if (input.verifyEmail) {
    // A redeemed magic-auth code proves mailbox ownership; production marks the email
    // verified via the standard update path, which emits user.updated. Folded into the
    // sign-in write so it is one write, one event, and nothing persists before the
    // template gate above — which keeps a failed render from implying a login that
    // never completed.
    ws.users.update(user.id, {
      last_sign_in_at: new Date().toISOString(),
      email_verified: true,
    });
  } else {
    // No real attribute change: production stamps last_sign_in_at via a dedicated,
    // silent updateWithSignIn path (a raw, debounced DB write) that bypasses the
    // event-emitting update(), so a login fires session.created without a spurious
    // user.updated. See https://github.com/workos/emulate/issues/55.
    ws.users.updateSilent(user.id, { last_sign_in_at: new Date().toISOString() });
  }
  return ws.sessions.insert({
    object: 'session',
    user_id: user.id,
    organization_id: input.organizationId,
    ip_address: input.ipAddress,
    user_agent: input.userAgent,
    auth_method: AUTH_METHOD_SESSION_VALUES[input.authMethod] ?? 'unknown',
    status: 'active',
    expires_at: expiresIn(30 * 24 * 60), // matches refresh token lifetime
    ended_at: null,
  });
}

export function formatAuthkitOauthResource(r: WorkOSAuthkitOauthResource): Record<string, unknown> {
  return formatEntity(r);
}

export function formatCorsOrigin(o: WorkOSCorsOrigin): Record<string, unknown> {
  return formatEntity(o);
}

export function formatAuthorizedApplication(a: WorkOSAuthorizedApplication): Record<string, unknown> {
  return formatEntity(a);
}

// The spec's ConnectedAccount names the provider only in the request path; the slug, the
// integration id, and any imported tokens are the emulator's own bookkeeping.
const CONNECTED_ACCOUNT_INTERNAL_FIELDS = new Set<string>([
  'provider',
  'data_integration_id',
  'access_token',
  'refresh_token',
  'token_expires_at',
]);

export function formatConnectedAccount(a: WorkOSConnectedAccount): Record<string, unknown> {
  return formatEntity(a, { exclude: CONNECTED_ACCOUNT_INTERNAL_FIELDS });
}

/**
 * `pipes.connected_account.*` event payloads carry two fields the REST shape does not — the
 * provider slug and the data integration id. `state` is overridable because `disconnected`
 * exists only in the event a deletion emits; a stored row never holds it.
 */
export function formatConnectedAccountEvent(
  a: WorkOSConnectedAccount,
  state: ConnectedAccountState | 'disconnected' = a.state,
): Record<string, unknown> {
  return {
    ...formatConnectedAccount(a),
    state,
    provider_slug: a.provider,
    data_integration_id: a.data_integration_id,
  };
}

/**
 * One data integration per provider slug: an account is an installation of the environment's
 * integration for that provider, so every account of one slug shares the id. Reused from any
 * live account before minting, keeping the id stable for as long as any account of the slug
 * exists rather than inventing a fresh integration per install.
 */
export function dataIntegrationIdFor(ws: WorkOSStore, slug: string): string {
  const existing = ws.connectedAccounts.findBy('provider', slug)[0];
  return existing?.data_integration_id ?? generateId(ID_PREFIXES.data_integration);
}

/**
 * The connected account a (user, provider) lookup addresses. `organization_id` narrows the
 * match rather than keying it: omitted, a lone account resolves whatever its scope, and
 * several — one provider installed in two organizations — answer the spec's 409 ("several
 * connected accounts match this user for the provider; one must be named").
 */
export function findConnectedAccount(
  ws: WorkOSStore,
  userId: string,
  slug: string,
  organizationId: string | null,
): WorkOSConnectedAccount | undefined {
  const matches = ws.connectedAccounts
    .findBy('user_id', userId)
    .filter((a) => a.provider === slug && (organizationId === null || a.organization_id === organizationId));
  if (matches.length > 1) {
    throw new WorkOSApiError(
      409,
      `Several connected accounts match provider '${slug}' for this user; name one with organization_id`,
      'conflict',
    );
  }
  return matches[0];
}

/**
 * The account keyed by exactly (user, provider, organization scope), with `organization_id`
 * matched rather than filtered: the key import answers 409 on and authorize connects.
 */
export function findExactConnectedAccount(
  ws: WorkOSStore,
  userId: string,
  slug: string,
  organizationId: string | null,
): WorkOSConnectedAccount | undefined {
  return ws.connectedAccounts
    .findBy('user_id', userId)
    .find((a) => a.provider === slug && a.organization_id === organizationId);
}

/**
 * Inserts an OAuth connected account, the one auth method the import DTO, the seed and the
 * authorize flow describe. Fires the `pipes.connected_account.*` event for its state.
 */
export function insertConnectedAccount(
  ws: WorkOSStore,
  account: Pick<
    WorkOSConnectedAccount,
    'user_id' | 'organization_id' | 'provider' | 'state' | 'established_by_user_id'
  > &
    Partial<Pick<WorkOSConnectedAccount, 'scopes' | 'access_token' | 'refresh_token' | 'token_expires_at'>>,
): WorkOSConnectedAccount {
  return ws.connectedAccounts.insert({
    object: 'connected_account',
    data_integration_id: dataIntegrationIdFor(ws, account.provider),
    auth_method: 'oauth',
    api_key_last_4: null,
    scopes: [],
    access_token: null,
    refresh_token: null,
    token_expires_at: null,
    ...account,
  });
}

/**
 * The account an organization owns for a provider. Organization-owned accounts have no
 * `user_id`, which keeps them out of every per-user lookup above.
 */
export function findOrganizationConnectedAccount(
  ws: WorkOSStore,
  organizationId: string,
  slug: string,
): WorkOSConnectedAccount | undefined {
  return ws.connectedAccounts
    .findBy('organization_id', organizationId)
    .find((a) => a.user_id === null && a.provider === slug);
}

/**
 * Acting for an organization's connected account requires an active membership, which the
 * spec answers with a bare 403 `{ message }` otherwise.
 */
export function assertActiveMember(ws: WorkOSStore, organizationId: string, userId: string): void {
  if (liveMembershipFor(ws, organizationId, userId)?.status !== 'active') {
    throw new PlainApiError(
      403,
      `User '${userId}' is not an active member of organization '${organizationId}'.`,
      'forbidden',
    );
  }
}

/**
 * The account with a usable access token, or `undefined` when it needs reauthorization. Shared
 * by `/token` and `/credentials`, which vend the same token in different envelopes.
 */
export function vendAccessToken(ws: WorkOSStore, account: WorkOSConnectedAccount): WorkOSConnectedAccount | undefined {
  const expired = account.token_expires_at !== null && isExpired(account.token_expires_at);
  if (account.state === 'connected' && expired && !account.refresh_token) {
    // Production's refresh attempt fails on an unrefreshable token and flips the account;
    // the collection hook emits reauthorization_needed.
    account = ws.connectedAccounts.update(account.id, { state: 'needs_reauthorization' })!;
  }
  if (account.state !== 'connected') return undefined;

  if (!account.access_token || expired) {
    // A connected account always has a usable token. The emulator cannot reach the provider,
    // so a refresh — or an account that was never given credentials — mints one locally, as
    // the legacy code exchange does. Stored, so repeat calls return the same one.
    account = ws.connectedAccounts.update(account.id, {
      access_token: `di_mock_${account.provider}_${generateVerificationToken().slice(0, 8)}`,
      token_expires_at: account.refresh_token ? expiresIn(60) : null,
    })!;
  }
  return account;
}

/** Redirect URI hosts the emulator's authorize endpoints accept with no configuration. */
export const DEFAULT_ALLOWED_REDIRECT_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Configured entry that accepts any redirect host. */
const ANY_HOST = '*';

/**
 * Normalize a configured redirect host into the form `URL.hostname` produces: lowercase,
 * punycode, no scheme, no port, IPv6 in brackets. Accepts a bare hostname
 * (`app.example.test`), a subdomain wildcard (`*.example.test`), `*`, or a whole origin
 * (`https://app.example.test:8443`), since an origin is what people usually have on hand.
 * Throws on input that would silently never match.
 */
export function normalizeRedirectHost(value: string): string {
  let host = value.trim().toLowerCase();
  if (host === ANY_HOST) return host;

  if (host.includes('://')) {
    try {
      host = new URL(host).hostname;
    } catch {
      host = '';
    }
  } else if (host.startsWith('[')) {
    // Bracketed IPv6, possibly with a port: keep everything through the closing bracket.
    host = host.slice(0, host.indexOf(']') + 1);
  } else {
    if (host.includes(':')) {
      const portIndex = host.lastIndexOf(':');
      const port = host.slice(portIndex + 1);
      // `example.test:3000` is a host and port; anything else with colons is bare IPv6.
      host = /^\d+$/.test(port) && !host.slice(0, portIndex).includes(':') ? host.slice(0, portIndex) : `[${host}]`;
    }
    if (!host.startsWith('[')) host = toAsciiHost(host);
  }

  if (host.startsWith('[')) host = canonicalizeIpv6Host(host);
  host = stripTrailingDot(host);

  // A literal `*` returned above, so arriving at one here means something was stripped off it:
  // `*:3000` and `https://*` both reduce to the fully-open wildcard, and both read as a
  // narrowing — ports and schemes are never part of the host check. Refused rather than quietly
  // widened, the same accident `stripTrailingDot` guards for `*.`.
  if (host === ANY_HOST) {
    throw new Error(`Invalid redirect host: ${JSON.stringify(value)} — write "*" to allow any host`);
  }

  // Shape first, then canonicalize, then shape again. `URL` drops a path rather than failing on
  // one, so `app.example.test/path` has to be refused before anything is allowed to reshape it —
  // and canonicalizing can itself turn a plausible-looking entry into nothing at all.
  if (!isMatchableHostPattern(host)) throw invalidRedirectHost(value);
  host = canonicalizeDnsHost(host);
  if (!isMatchableHostPattern(host)) throw invalidRedirectHost(value);
  return host;
}

function invalidRedirectHost(value: string): Error {
  return new Error(`Invalid redirect host: ${JSON.stringify(value)}`);
}

/**
 * Reduce a validated non-bracketed pattern to the one spelling `URL.hostname` produces, the way
 * `canonicalizeIpv6Host` already does for addresses. `URL` rewrites IPv4 in every shorthand it
 * accepts — `10.1`, `192.168.001.1`, `0x7f.0.0.1` and `2130706433` all arrive as their dotted-quad
 * form — so an entry written any of those ways validated by shape, started the emulator and then
 * matched nothing: the silent no-match the rest of this validation exists to turn into a loud
 * failure. Only ever called on a pattern `isMatchableHostPattern` has accepted, so there is no path
 * or port left for `URL` to strip. Returns '' for what `URL` refuses (`999.999.999.999`,
 * `1.2.3.4.5` — IPv4-shaped and not an address), which the second shape check then rejects.
 */
function canonicalizeDnsHost(host: string): string {
  // Bracketed literals came through `canonicalizeIpv6Host` already.
  if (host.startsWith('[')) return host;
  // `*` is not a host `URL` should be asked about, so convert only what it stands in front of.
  const wildcard = host.startsWith('*.');
  const bare = wildcard ? host.slice(2) : host;
  let canonical: string;
  try {
    canonical = new URL(`http://${bare}/`).hostname;
  } catch {
    return '';
  }
  return wildcard ? `*.${canonical}` : canonical;
}

/**
 * Reduce a bracketed IPv6 literal to the one spelling `URL.hostname` produces. `isIPv6` accepts
 * every legal way of writing an address, but a request for any of them arrives compressed and
 * zero-stripped: `[fd00:0:0:0:0:0:0:1]` and `[FD00::0001]` both come through as `[fd00::1]`, and
 * `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`. Validating without canonicalizing let an ordinary
 * way of writing an address start the emulator and then match nothing — the same silent no-match
 * the shape check exists to turn into a loud failure. Returns '' for anything `URL` refuses,
 * which the shape check then rejects.
 */
function canonicalizeIpv6Host(host: string): string {
  try {
    return new URL(`http://${host}/`).hostname;
  } catch {
    return '';
  }
}

/**
 * Drop one trailing dot, so an absolute name is configured the way it is written. `URL.hostname`
 * keeps the dot a request carried, so both sides are stripped and `app.example.test.` and
 * `app.example.test` name the same host — otherwise neither spelling matched the other.
 */
function stripTrailingDot(host: string): string {
  // Never `*.`, which is a wildcard missing its label rather than an absolute name: stripping
  // there would turn a pattern that matches nothing into `*`, which matches everything.
  if (host === `${ANY_HOST}.` || !host.endsWith('.')) return host;
  return host.slice(0, -1);
}

/**
 * Convert an internationalized hostname to the punycode `URL.hostname` yields, so `møller.test`
 * can be configured the way its owner spells it. Without this, only the origin form
 * (`https://møller.test`) worked — `URL` punycodes on the way through — leaving the bare form
 * with no spelling that could ever match. Returns '' for input that is not a domain at all,
 * which the shape check then rejects.
 */
function toAsciiHost(host: string): string {
  // IDNA conversion may strip URL syntax instead of rejecting it.
  if (/[/\\?#\s]/.test(host)) return '';
  // Everything a hostname may legally contain is printable ASCII; anything else needs IDNA.
  if (!/[^ -~]/.test(host)) return host;
  const wildcard = host.startsWith('*.');
  // `*` is not an IDNA label, so convert only what follows it.
  const ascii = domainToASCII(wildcard ? host.slice(2) : host);
  if (!ascii) return '';
  return wildcard ? `*.${ascii}` : ascii;
}

/**
 * A label as `URL.hostname` may carry it: alphanumeric or underscore, inner hyphens allowed,
 * dot-separated. Underscore is not DNS-conformant but `URL` passes it through untouched, so a
 * Docker service name like `my_host` is a host a request really does arrive with — the question
 * here is whether a pattern can ever equal a `URL.hostname`, not whether a resolver would like it.
 */
const HOSTNAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*$/;

/**
 * Whether a normalized pattern can ever match a `URL.hostname`. Checking only for emptiness and
 * whitespace let `*example.test` (wildcard without the dot), `*.` and `app.example.test/path`
 * through — each accepted at startup and then silently matching nothing, which is exactly the
 * failure this validation exists to prevent.
 */
function isMatchableHostPattern(host: string): boolean {
  if (host === ANY_HOST) return true;
  const bare = host.startsWith('*.') ? host.slice(2) : host;
  if (!bare) return false;
  if (bare.startsWith('[')) {
    // A real address, not just IPv6-shaped characters: `[:::]` and `[....]` would pass a
    // character-class check and then match no hostname, the same silent failure as above.
    return bare.endsWith(']') && isIPv6(bare.slice(1, -1));
  }
  return HOSTNAME.test(bare);
}

/** Normalize a list of configured redirect hosts, dropping blank entries. */
export function normalizeRedirectHosts(values: readonly string[]): string[] {
  return values.filter((value) => value.trim() !== '').map(normalizeRedirectHost);
}

/**
 * Schemes that run in the page instead of navigating to it. The host check alone does not stop
 * them: `javascript://localhost/%0aalert(1)` parses with a hostname of `localhost`, so a script
 * URI reaches the redirect on the strength of an authority it never uses. Custom app schemes
 * (`myapp://callback`, RFC 8252) stay allowed — they are a real redirect target a native client
 * tests against, and they carry no script.
 */
const SCRIPT_REDIRECT_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'blob:', 'file:']);

/**
 * Whether a URI carries a character it may not contain unencoded: a C0 control or DEL. Written as
 * a bound rather than a character-class regex, which is the thing a linter rightly asks about and
 * reads less plainly than the range it stands for.
 *
 * Space (0x20) is deliberately outside the bound. It cannot split a header, so it buys nothing
 * here, and `searchParams.get` decodes `+` to a space — so including it turned an unencoded `+`
 * in the inner query (base64 state, a `+` in an email) into a 400 on a redirect that had worked.
 */
function hasForbiddenUriChar(uri: string): boolean {
  for (let i = 0; i < uri.length; i++) {
    const code = uri.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function hostMatches(hostname: string, pattern: string): boolean {
  if (pattern === ANY_HOST) return true;
  // `*.example.test` covers subdomains only, matching how redirect allow-lists usually read.
  if (pattern.startsWith('*.')) return hostname.endsWith(pattern.slice(1));
  return hostname === pattern;
}

/**
 * Validate that a redirect_uri points to a host the emulator is willing to redirect to.
 * Prevents the emulator from being used as an open redirect. Localhost is always allowed;
 * `allowedRedirectHosts` (`--redirect-hosts`) adds to that for test environments that use
 * production-like hostnames.
 */
export function assertAllowedRedirectUri(uri: string, store: Store): void {
  // Refused before parsing, because parsing *removes* these rather than failing on them: URL
  // strips tabs and newlines and trims leading control characters, so `http://local\thost/`
  // validates as localhost and then goes into the Location header raw, control character and
  // all. Checking the parse result can only ever see the sanitized form.
  if (hasForbiddenUriChar(uri)) {
    throw new WorkOSApiError(400, 'Invalid redirect_uri', 'invalid_redirect_uri');
  }

  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new WorkOSApiError(400, 'Invalid redirect_uri', 'invalid_redirect_uri');
  }

  // Checked before the host, and regardless of configuration: `*` widens which host may be
  // redirected to, never what a redirect is allowed to execute.
  //
  // The empty hostname is half of that, and the half a denylist cannot cover. A URI with no
  // authority is one the host check has nothing to say about, so `*` — which only ever answers
  // "is this host allowed" — waved `view-source:javascript:alert(1)`, `jar:` and `about:` through
  // on an authority they never had. Refused by shape, so the guard does not depend on having
  // enumerated every script-bearing scheme. Custom app schemes keep their host and are
  // unaffected in the `myapp://callback` form.
  //
  // This does refuse RFC 8252's other private-use spelling, the path-only `com.example.app:/cb`,
  // which has no authority to check either. It has never been allowed here (the localhost-only
  // guard rejected it too), and allowing it would mean deciding by heuristic which hostless URIs
  // nest another one — so it stays out until something actually needs it.
  if (SCRIPT_REDIRECT_SCHEMES.has(parsed.protocol) || parsed.hostname === '') {
    throw new WorkOSApiError(
      400,
      `redirect_uri scheme ${parsed.protocol.slice(0, -1)} is not allowed`,
      'invalid_redirect_uri',
    );
  }

  const configured = store.getData<string[]>(STORE_KEYS.allowedRedirectHosts) ?? [];
  const allowed = [...DEFAULT_ALLOWED_REDIRECT_HOSTS, ...configured];
  // Stripped on both sides, so an absolute name matches the entry it was configured as.
  const hostname = stripTrailingDot(parsed.hostname.toLowerCase());
  if (allowed.some((pattern) => hostMatches(hostname, pattern))) return;

  // Names both ways in, since a programmatic caller has no flag to pass.
  const howToWiden = 'Pass --redirect-hosts (or allowedRedirectHosts) to allow other hosts.';
  throw new WorkOSApiError(
    400,
    configured.length > 0
      ? `redirect_uri host ${parsed.hostname} is not allowed; allowed hosts: ${allowed.join(', ')}`
      : `redirect_uri must point to localhost, got ${parsed.hostname}. ${howToWiden}`,
    'invalid_redirect_uri',
  );
}

// `code` stays server-side as production keeps a TOTP challenge's; `user_id` and `factor_id`
// are the store's join columns — the spec's challenge names its factor `authentication_factor_id`
// and carries no user at all.
const AUTH_CHALLENGE_EXCLUDE = new Set([...INTERNAL_FIELDS, 'code', 'user_id', 'factor_id', 'attempts', 'verified_at']);

export function formatAuthChallenge(c: WorkOSAuthenticationChallenge): Record<string, unknown> {
  return { ...formatEntity(c, { exclude: AUTH_CHALLENGE_EXCLUDE }), authentication_factor_id: c.factor_id };
}

export function formatRole(role: WorkOSRole, ws: WorkOSStore): Record<string, unknown> {
  // Production inlines the role's permission slugs; the emulator keeps them in a
  // join table, so resolve them here rather than at every call site.
  const permissions = ws.rolePermissions
    .findBy('role_id', role.id)
    .map((rp) => ws.permissions.get(rp.permission_id)?.slug)
    .filter((slug): slug is string => typeof slug === 'string');
  return {
    ...formatEntity(role),
    permissions,
    // Rows persisted before roles carried a scope still format with the default.
    resource_type_slug: role.resource_type_slug ?? DEFAULT_RESOURCE_TYPE_SLUG,
  };
}

export function formatPermission(p: WorkOSPermission): Record<string, unknown> {
  return {
    ...formatEntity(p),
    // The emulator has no WorkOS-managed system permissions; everything is user-defined.
    system: false,
    // Rows inserted without a scope (direct store inserts, pre-scope releases)
    // still format with the default so the spec-required key is always present.
    resource_type_slug: p.resource_type_slug ?? DEFAULT_RESOURCE_TYPE_SLUG,
  };
}

export function formatAuthorizationResource(r: WorkOSAuthorizationResource): Record<string, unknown> {
  return {
    ...formatEntity(r),
    // Rows persisted by pre-0.11 releases predate these columns; the
    // production shape always carries the keys.
    name: r.name ?? null,
    description: r.description ?? null,
    parent_resource_id: r.parent_resource_id ?? null,
  };
}

export function formatRoleAssignment(ra: WorkOSRoleAssignment): Record<string, unknown> {
  return {
    object: 'role_assignment',
    id: ra.id,
    organization_membership_id: ra.organization_membership_id,
    // role_id is not part of the production shape, but is kept for
    // compatibility with earlier emulator releases.
    role_id: ra.role_id,
    role: { slug: ra.role_slug ?? null },
    resource: {
      id: ra.resource_id ?? null,
      external_id: ra.resource_external_id ?? null,
      resource_type_slug: ra.resource_type_slug ?? null,
    },
    source: {
      type: ra.group_role_assignment_id ? 'group' : 'direct',
      group_role_assignment_id: ra.group_role_assignment_id ?? null,
      group: ra.group ?? null,
    },
    created_at: ra.created_at,
    updated_at: ra.updated_at,
  };
}

export function formatGroupRoleAssignment(gra: WorkOSGroupRoleAssignment): Record<string, unknown> {
  return {
    object: 'group_role_assignment',
    id: gra.id,
    group_id: gra.group_id,
    role: { slug: gra.role_slug },
    resource: {
      id: gra.resource_id,
      external_id: gra.resource_external_id,
      resource_type_slug: gra.resource_type_slug,
    },
    created_at: gra.created_at,
    updated_at: gra.updated_at,
  };
}

export function formatDeviceAuthorization(d: WorkOSDeviceAuthorization, baseUrl: string): Record<string, unknown> {
  return {
    device_code: d.device_code,
    user_code: d.user_code,
    verification_uri: `${baseUrl}/user_management/authorize/device/verify`,
    expires_in: Math.max(0, Math.floor((new Date(d.expires_at).getTime() - Date.now()) / 1000)),
    interval: d.interval,
  };
}

export function formatDirectory(d: WorkOSDirectory): Record<string, unknown> {
  return formatEntity(d);
}

/**
 * The directory states the event catalog uses. `GET /directories` reports `linked` and
 * `unlinked`, but `dsync.*` event payloads keep the older `active` / `inactive` names
 * (the Node SDK maps between them for the REST shape and passes the event state through).
 */
const DIRECTORY_EVENT_STATES: Record<WorkOSDirectory['state'], string> = {
  linked: 'active',
  unlinked: 'inactive',
  deleting: 'deleting',
  invalid_credentials: 'invalid_credentials',
};

/**
 * The `data` of a `dsync.activated` event. Production documents it as the Directory object
 * with the singular `domain` replaced by a `domains` array of Organization Domains
 * (`object`, `id`, `domain`), and requires a string `external_key`. Strict SDK
 * deserializers (e.g. workos-python's `DsyncActivatedData.from_dict`) raise on a missing
 * `domains`, which fails the whole `GET /events` page it appears on.
 */
export function formatDirectoryActivatedEvent(d: WorkOSDirectory, ws: WorkOSStore): Record<string, unknown> {
  const { domain: _domain, ...rest } = formatEntity(d);
  const domains = d.organization_id
    ? ws.organizationDomains
        .findBy('organization_id', d.organization_id)
        .map((od) => ({ object: 'organization_domain', id: od.id, domain: od.domain }))
    : [];
  return { ...rest, state: DIRECTORY_EVENT_STATES[d.state] ?? d.state, domains };
}

/**
 * The `data` of a `dsync.deleted` event: the Directory object without `domain`, `domains`
 * or `external_key`, in the `deleting` state the directory is in when the event fires.
 */
export function formatDirectoryDeletedEvent(d: WorkOSDirectory): Record<string, unknown> {
  const { domain: _domain, external_key: _externalKey, ...rest } = formatEntity(d);
  return { ...rest, state: 'deleting' };
}

export function formatDirectoryUser(u: WorkOSDirectoryUser): Record<string, unknown> {
  return formatEntity(u);
}

export function formatDirectoryGroup(g: WorkOSDirectoryGroup): Record<string, unknown> {
  return formatEntity(g);
}

export function formatAuditLogAction(a: WorkOSAuditLogAction): Record<string, unknown> {
  return formatEntity(a);
}

export function formatAuditLogExport(ex: WorkOSAuditLogExport): Record<string, unknown> {
  return formatEntity(ex);
}

/**
 * The spec's `Flag` object, spelled out rather than derived from the entity: every key it
 * lists is `required`, so a strict SDK deserializer faults on an omission, and the emulator
 * must not add keys production does not send either.
 */
export function formatFeatureFlag(f: WorkOSFeatureFlag): Record<string, unknown> {
  return {
    object: 'feature_flag',
    id: f.id,
    slug: f.slug,
    name: f.name,
    description: f.description,
    owner: f.owner,
    tags: f.tags,
    enabled: f.enabled,
    default_value: f.default_value,
    created_at: f.created_at,
    updated_at: f.updated_at,
  };
}

/**
 * Flag webhook payloads are the REST `Flag` plus `environment_id`, which the REST object
 * itself does not carry.
 */
export function formatFeatureFlagEvent(f: WorkOSFeatureFlag, environmentId: string): Record<string, unknown> {
  const { object, id, ...rest } = formatFeatureFlag(f);
  return { object, id, environment_id: environmentId, ...rest };
}

/**
 * The actor an API-key request acts as — flag event `context.actor`, Vault `updated_by`. The
 * key's record when the caller's key has one (an array-form `apiKeys` seed entry, or a key
 * created over the API), otherwise the emulator's standing placeholder: a map-form `apiKeys`
 * entry authenticates but has no `api_key` resource behind it, so there is nothing to name.
 */
export function apiKeyActor(ws: WorkOSStore, apiKey?: string): { id: string; name: string } {
  const record = apiKey ? ws.apiKeyRecords.findOneBy('key', apiKey) : undefined;
  return { id: record?.id ?? 'api_key_emulator', name: record?.name ?? 'Emulator API key' };
}

/** Generate a Connect Application client_id, e.g. `client_01HXYZ...`. */
export function generateClientId(): string {
  return `client_${generateId('').slice(1)}`;
}

export function formatConnectApplication(a: WorkOSConnectApplication): Record<string, unknown> {
  const base = {
    object: 'connect_application',
    id: a.id,
    client_id: a.client_id,
    description: a.description,
    name: a.name,
    scopes: a.scopes,
    created_at: a.created_at,
    updated_at: a.updated_at,
  };

  if (a.application_type === 'm2m') {
    return { ...base, application_type: 'm2m', organization_id: a.organization_id, audience: a.audience };
  }

  const oauth = {
    ...base,
    application_type: 'oauth',
    redirect_uris: a.redirect_uris.map((uri) => ({ uri, default: false })),
    uses_pkce: a.uses_pkce,
  };

  // The spec's oauth branch is a three-way oneOf on how the application came to exist, and each
  // arm carries a different field set: a first-party app names nothing else, a dynamically
  // registered one says so, and a third-party one must name its owning organization.
  if (a.is_first_party) return { ...oauth, is_first_party: true };
  if (a.was_dynamically_registered) return { ...oauth, is_first_party: false, was_dynamically_registered: true };
  return {
    ...oauth,
    is_first_party: false,
    was_dynamically_registered: false,
    organization_id: a.organization_id,
  };
}

// `application_id` is the emulator's foreign key, not a spec field: the secret is always
// addressed through its application, so the spec's shape never restates the owner.
const CLIENT_SECRET_EXCLUDE = new Set([...INTERNAL_FIELDS, 'value', 'application_id']);

export function formatClientSecret(s: WorkOSClientSecret): Record<string, unknown> {
  return formatEntity(s, { exclude: CLIENT_SECRET_EXCLUDE });
}

export function formatRadarAttempt(a: WorkOSRadarAttempt): Record<string, unknown> {
  return formatEntity(a);
}

/** Mask an API key value the way the spec shows it, e.g. `sk_...3456`. */
export function obfuscateApiKey(key: string): string {
  const prefix = key.startsWith('sk_') ? 'sk_' : key.slice(0, 3);
  return `${prefix}...${key.slice(-4)}`;
}

/**
 * Drop every API key whose owner matches, from both the record store and the auth
 * allow-list. Deleting only the record leaves the secret in the map the middleware holds,
 * where it keeps authenticating for a principal that no longer exists — so the two stores
 * have to fall together, the same pairing `DELETE /api_keys/:id` makes.
 */
export function revokeApiKeysForOwner(
  store: Store,
  ws: WorkOSStore,
  matches: (owner: WorkOSApiKeyOwner) => boolean,
): void {
  const apiKeyMap = store.getData<ApiKeyMap>(STORE_KEYS.apiKeyMap);
  for (const key of ws.apiKeyRecords.all().filter((k) => matches(k.owner))) {
    ws.apiKeyRecords.delete(key.id);
    if (apiKeyMap) delete apiKeyMap[key.key];
  }
}

/** The organization a key is scoped to: the owner org, or the org a user-owned key was issued in. */
export function apiKeyOrganizationId(k: WorkOSApiKey): string {
  return k.owner.type === 'organization' ? k.owner.id : k.owner.organization_id;
}

export interface IssueApiKeyInput {
  name: string;
  owner: WorkOSApiKeyOwner;
  permissions: string[];
  /** ISO-8601 expiry, or null for a key that never expires. */
  expiresAt: string | null;
  /** Auth environment; decides the `sk_live_`/`sk_test_` prefix and travels into the allow-list. */
  environment: string;
}

/**
 * Mint an API key: create the `api_key` record and register the secret in the auth allow-list
 * (the same object the middleware holds by reference) so the new key authenticates real
 * requests. Both the public routes and the widgets surface issue keys through here, so the two
 * stores cannot drift apart. Returns the plaintext secret alongside the record — it is shown to
 * the caller exactly once and never serialized again.
 */
export function issueApiKey(
  store: Store,
  ws: WorkOSStore,
  input: IssueApiKeyInput,
): { record: WorkOSApiKey; value: string } {
  const value = `sk_${input.environment === 'production' ? 'live' : 'test'}_${generateVerificationToken()}`;
  const record = ws.apiKeyRecords.insert({
    object: 'api_key',
    name: input.name,
    key: value,
    environment: input.environment,
    owner: input.owner,
    permissions: input.permissions,
    last_used_at: null,
    expires_at: input.expiresAt,
  });
  const apiKeyMap = store.getData<ApiKeyMap>(STORE_KEYS.apiKeyMap) ?? {};
  apiKeyMap[value] = { environment: input.environment, expiresAt: record.expires_at };
  store.setData(STORE_KEYS.apiKeyMap, apiKeyMap);
  return { record, value };
}

/**
 * Delete one API key from both the record store and the auth allow-list, so the key stops
 * authenticating and not merely stops resolving — see `revokeApiKeysForOwner`.
 */
export function deleteApiKey(store: Store, ws: WorkOSStore, record: WorkOSApiKey): void {
  ws.apiKeyRecords.delete(record.id);
  const apiKeyMap = store.getData<ApiKeyMap>(STORE_KEYS.apiKeyMap);
  if (apiKeyMap) delete apiKeyMap[record.key];
}

export function isApiKeyExpired(record: WorkOSApiKey): boolean {
  return record.expires_at !== null && Date.parse(record.expires_at) <= Date.now();
}

/**
 * Set an API key's expiry: `null` clears it so the key never expires, a future timestamp
 * schedules it, and anything else — a past timestamp or none at all — expires the key now.
 * The allow-list entry moves in step, so the middleware enforces the new expiry on the next
 * request. A key that has already expired cannot be re-scheduled, as in production.
 */
export function expireApiKey(
  store: Store,
  ws: WorkOSStore,
  record: WorkOSApiKey,
  expiresAt: string | null | undefined,
): WorkOSApiKey {
  if (isApiKeyExpired(record)) {
    throw new WorkOSApiError(409, 'API key is already expired', 'api_key_already_expired');
  }
  const next =
    expiresAt === null
      ? null
      : typeof expiresAt === 'string' && Date.parse(expiresAt) > Date.now()
        ? expiresAt
        : new Date().toISOString();
  const updated = ws.apiKeyRecords.update(record.id, { expires_at: next })!;
  const apiKeyMap = store.getData<ApiKeyMap>(STORE_KEYS.apiKeyMap);
  if (apiKeyMap?.[record.key]) apiKeyMap[record.key].expiresAt = next;
  return updated;
}

export function formatApiKeyRecord(k: WorkOSApiKey): Record<string, unknown> {
  return {
    object: 'api_key',
    id: k.id,
    owner: k.owner,
    name: k.name,
    obfuscated_value: obfuscateApiKey(k.key),
    last_used_at: k.last_used_at,
    expires_at: k.expires_at,
    permissions: k.permissions,
    created_at: k.created_at,
    updated_at: k.updated_at,
  };
}

const EVENT_EXCLUDE = new Set([...INTERNAL_FIELDS, 'updated_at', 'organization_id']);

export function formatEvent(e: WorkOSEvent): Record<string, unknown> {
  return formatEntity(e, { exclude: EVENT_EXCLUDE });
}

/**
 * The `WebhookEndpointJson` shape. Production serializes the signing secret on every read —
 * create, get, list and update alike (`webhook-endpoints.serializer.ts`) — so there is no
 * masked variant.
 */
export function formatWebhookEndpoint(ep: WorkOSWebhookEndpoint): Record<string, unknown> {
  return {
    object: 'webhook_endpoint',
    id: ep.id,
    endpoint_url: ep.endpoint_url,
    secret: ep.secret,
    status: ep.status,
    events: ep.events,
    created_at: ep.created_at,
    updated_at: ep.updated_at,
  };
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A webhook signing secret shaped like production's: 25 base62 characters
 * (`WebhookEndpointsService.create`, `generateToken('base62', 25)`), no prefix.
 */
export function generateWebhookSecret(): string {
  return Array.from({ length: 25 }, () => BASE62[randomInt(BASE62.length)]).join('');
}

export function formatAgentBlueprint(b: WorkOSAgentBlueprint): Record<string, unknown> {
  return {
    object: 'agent_blueprint',
    id: b.id,
    name: b.name,
    description: b.description,
    permissions: b.permissions,
    invocable_by: {
      role_slugs: b.invocable_by.role_slugs,
      organization_ids: b.invocable_by.organization_ids,
    },
    session_settings: {
      max_age_seconds: b.session_settings.max_age_seconds,
      access_token_ttl_seconds: b.session_settings.access_token_ttl_seconds,
      refresh_token_ttl_seconds: b.session_settings.refresh_token_ttl_seconds,
    },
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

export function formatAgentInstance(i: WorkOSAgentInstance): Record<string, unknown> {
  return {
    object: 'agent_instance',
    id: i.id,
    agent_blueprint_id: i.agent_blueprint_id,
    organization_id: i.organization_id,
    organization_membership_id: i.organization_membership_id,
    type: i.type,
    created_at: i.created_at,
    updated_at: i.updated_at,
  };
}

/** Status is derived at read time, as in production: no clock ever flips a stored row to `expired`. */
export function agentSessionStatus(s: WorkOSAgentInstanceSession, now = Date.now()): 'active' | 'revoked' | 'expired' {
  if (s.revoked_at !== null) return 'revoked';
  if (new Date(s.expires_at).getTime() <= now) return 'expired';
  return 'active';
}

export function formatAgentInstanceSession(s: WorkOSAgentInstanceSession): Record<string, unknown> {
  return {
    object: 'agent_instance_session',
    id: s.id,
    agent_instance_id: s.agent_instance_id,
    status: agentSessionStatus(s),
    expires_at: s.expires_at,
    revoked_at: s.revoked_at,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

/**
 * Session webhook payloads differ from the REST object: they carry the owning instance's
 * `organization_id` and no `status`, and the created event adds the granted
 * `permission_slugs`. The refresh token never leaves the store either way.
 */
export function formatAgentInstanceSessionEvent(
  s: WorkOSAgentInstanceSession,
  organizationId: string,
  opts?: { permissionSlugs: string[] },
): Record<string, unknown> {
  return {
    object: 'agent_instance_session',
    id: s.id,
    agent_instance_id: s.agent_instance_id,
    organization_id: organizationId,
    expires_at: s.expires_at,
    revoked_at: s.revoked_at,
    created_at: s.created_at,
    updated_at: s.updated_at,
    ...(opts ? { permission_slugs: opts.permissionSlugs } : {}),
  };
}
