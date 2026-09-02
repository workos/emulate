import { randomBytes, createHash, createCipheriv } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { domainToASCII } from 'node:url';
import {
  WorkOSApiError,
  validationError,
  generateId,
  ID_PREFIXES,
  type ApiKeyMap,
  type CursorPaginatedResult,
  type Entity,
  type Store,
} from '../core/index.js';
import { EVENTS, STORE_KEYS, type AuthenticationEventData, type WorkOSEventName } from './constants.js';
import type { WorkOSStore } from './store.js';
import type { EventBus } from './event-bus.js';
import type {
  WorkOSOrganization,
  WorkOSOrganizationDomain,
  WorkOSOrganizationMembership,
  WorkOSGroup,
  WorkOSUser,
  WorkOSSession,
  WorkOSEmailVerification,
  WorkOSPasswordReset,
  WorkOSMagicAuth,
  WorkOSAuthenticationFactor,
  WorkOSIdentity,
  WorkOSConnection,
  WorkOSSSOProfile,
  WorkOSPipeConnection,
  WorkOSInvitation,
  WorkOSRedirectUri,
  WorkOSCorsOrigin,
  WorkOSAuthorizedApplication,
  WorkOSConnectedAccount,
  ConnectedAccountState,
  WorkOSAuthenticationChallenge,
  WorkOSDeviceAuthorization,
  WorkOSRole,
  WorkOSPermission,
  WorkOSAuthorizationResource,
  WorkOSRoleAssignment,
  WorkOSDirectory,
  WorkOSDirectoryUser,
  WorkOSDirectoryGroup,
  WorkOSAuditLogAction,
  WorkOSAuditLogEvent,
  WorkOSAuditLogExport,
  WorkOSFeatureFlag,
  WorkOSFlagTarget,
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

const DOMAIN_EXCLUDE = new Set([...INTERNAL_FIELDS, 'verification_token', 'verification_prefix']);

export function formatDomain(domain: WorkOSOrganizationDomain): Record<string, unknown> {
  return formatEntity(domain, { exclude: DOMAIN_EXCLUDE });
}

export function formatMembership(m: WorkOSOrganizationMembership, ws: WorkOSStore): Record<string, unknown> {
  // Real WorkOS `organization_membership` REST responses always carry `directory_managed`,
  // `custom_attributes`, `roles`, and an embedded `user`. The emulator previously omitted
  // them, which breaks strict SDK deserializers (e.g. the WorkOS Python SDK's
  // `OrganizationMembership.from_dict`, whose required-key lookup raises on the first
  // missing field). `directory_managed` is `false` for any API-created membership (no
  // directory-sync surface), `custom_attributes` defaults to `{}`, `roles` is the single
  // primary role, and the `user` is resolved from `user_id`.
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
  return {
    ...formatEntity(m),
    directory_managed: false,
    custom_attributes: {},
    roles: [m.role],
    user: formatUser(user),
  };
}

// Webhook events carry a slimmer membership than the REST responses: the real WorkOS
// `organization_membership.*` event payload requires `directory_managed` and
// `custom_attributes`, but NOT `roles` or an embedded `user` (see EVENT_DATA_REQUIREMENTS).
// Keep the event shape spec-accurate instead of reusing the REST serializer.
export function formatMembershipEvent(m: WorkOSOrganizationMembership): Record<string, unknown> {
  return {
    ...formatEntity(m),
    directory_managed: false,
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
    directory_managed: false,
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

export function formatEmailVerification(ev: WorkOSEmailVerification): Record<string, unknown> {
  return formatEntity(ev);
}

export function formatPasswordReset(pr: WorkOSPasswordReset): Record<string, unknown> {
  return formatEntity(pr);
}

export function formatMagicAuth(ma: WorkOSMagicAuth): Record<string, unknown> {
  return formatEntity(ma);
}

export function formatAuthFactor(f: WorkOSAuthenticationFactor): Record<string, unknown> {
  return formatEntity(f);
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

export function formatConnection(conn: WorkOSConnection): Record<string, unknown> {
  return formatEntity(conn);
}

export function formatSSOProfile(p: WorkOSSSOProfile): Record<string, unknown> {
  return formatEntity(p);
}

export function formatPipeConnection(pc: WorkOSPipeConnection): Record<string, unknown> {
  return formatEntity(pc);
}

export function formatInvitation(inv: WorkOSInvitation): Record<string, unknown> {
  return formatEntity(inv);
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
    state: 'accepted',
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
        role: { slug: roleSlug },
        status: 'active',
        external_id: null,
        metadata: {},
      });
    } else if (existing.status !== 'active') {
      ws.organizationMemberships.update(existing.id, { status: 'active', role: { slug: roleSlug } });
    }
  }

  return inv.organization_id;
}

export function formatRedirectUri(r: WorkOSRedirectUri): Record<string, unknown> {
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

const AUTH_CHALLENGE_EXCLUDE = new Set([...INTERNAL_FIELDS, 'code']);

export function formatAuthChallenge(c: WorkOSAuthenticationChallenge): Record<string, unknown> {
  return formatEntity(c, { exclude: AUTH_CHALLENGE_EXCLUDE });
}

export function formatRole(role: WorkOSRole): Record<string, unknown> {
  return formatEntity(role);
}

export function formatPermission(p: WorkOSPermission): Record<string, unknown> {
  return {
    ...formatEntity(p),
    system: false,
    resource_type_slug: 'organization',
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
    source: { type: 'direct', group_role_assignment_id: null },
    created_at: ra.created_at,
    updated_at: ra.updated_at,
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

export function formatDirectoryUser(u: WorkOSDirectoryUser): Record<string, unknown> {
  return formatEntity(u);
}

export function formatDirectoryGroup(g: WorkOSDirectoryGroup): Record<string, unknown> {
  return formatEntity(g);
}

export function formatAuditLogAction(a: WorkOSAuditLogAction): Record<string, unknown> {
  return formatEntity(a);
}

export function formatAuditLogEvent(e: WorkOSAuditLogEvent): Record<string, unknown> {
  return formatEntity(e);
}

export function formatAuditLogExport(ex: WorkOSAuditLogExport): Record<string, unknown> {
  return formatEntity(ex);
}

export function formatFeatureFlag(f: WorkOSFeatureFlag): Record<string, unknown> {
  return formatEntity(f);
}

export function formatFlagTarget(t: WorkOSFlagTarget): Record<string, unknown> {
  return formatEntity(t);
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

  return {
    ...base,
    application_type: 'oauth',
    redirect_uris: a.redirect_uris.map((uri) => ({ uri, default: false })),
    uses_pkce: false,
    is_first_party: true,
  };
}

const CLIENT_SECRET_EXCLUDE = new Set([...INTERNAL_FIELDS, 'value']);

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

const EVENT_EXCLUDE = new Set([...INTERNAL_FIELDS, 'updated_at']);

export function formatEvent(e: WorkOSEvent): Record<string, unknown> {
  return formatEntity(e, { exclude: EVENT_EXCLUDE });
}

export function formatWebhookEndpoint(
  ep: WorkOSWebhookEndpoint,
  opts?: { includeSecret?: boolean },
): Record<string, unknown> {
  return {
    object: 'webhook_endpoint',
    id: ep.id,
    endpoint_url: ep.endpoint_url,
    secret: opts?.includeSecret ? ep.secret : `${ep.secret.slice(0, 8)}****`,
    enabled: ep.enabled,
    events: ep.events,
    description: ep.description,
    created_at: ep.created_at,
    updated_at: ep.updated_at,
  };
}

export function sealSession(
  data: { access_token: string; refresh_token: string; session_id: string },
  apiKey: string,
): string {
  const key = createHash('sha256').update(apiKey).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}
