# Production parity

The emulator answers what production answers, under production's codes, so a suite that passes
here does not meet a surprise against the real API. This page collects those rules by feature, one
section per row of [SUPPORTED.md](../SUPPORTED.md) in the same order, and names the places the
emulator knowingly differs. Which routes exist is in SUPPORTED.md; how data gets in is in
[seeding.md](seeding.md).

## Organizations

`external_id` is unique across organizations: `400 external_id_already_used` on create and update.

### Domains

Domains are stored lowercased and validated as production does: a `domain_data` entry needs a
`state` of `pending` or `verified`, and a malformed domain, a domain listed twice or a public
consumer domain (production's list, vendored) is `422` before the organization is written; the
organization's own duplicate on `POST /organization_domains` is `409 domain_already_exists`, but two
organizations may share a domain, since production enforces uniqueness only behind a flag.
`POST /organization_domains/{id}/verify` starts DNS verification — `201`, `pending`, the `dns`
strategy and a fresh token; `400 domain_already_verified` once verified — and resolves no DNS, so a
domain gets verified only by seeding `state: verified` or sending `domain_data[].state: verified`,
which on update recreates the domain under a new id as production does.

### IT contacts

IT contacts are stored lowercased, capped at 20 per organization, and listed whole under null
cursors, as production does. An organization is held to one active Admin Portal invitation —
inviting any contact while one is active conflicts, the holder included — but nothing is emailed:
the setup link an invitation would send is recorded on the contact and served by no route. Revoking
clears the organization's invitation through any contact, since no route reports which one holds
it. The `403` and `503` these routes document are not implemented — the store is not
environment-scoped, so the forbidden case cannot arise — but both can be injected through the error
hooks.

## User Management

The email-change confirm and send endpoints and the waitlist endpoints are not implemented.

`PUT /user_management/users/{id}` applies `email` — a malformed address is `400 invalid_email`, one another user holds is `400 email_not_available`, and a changed address is unverified until something verifies it; an email-verification code sent to the old address is a `404`, since production checks a code against the factor of the user's current address, which has no challenge yet — and refuses `email_verified: false` on a verified user with `400 email_already_verified`. An `external_id` another user holds is `400 external_id_already_used` on update, and on create a `400 user_creation_error` carrying `external_id_already_used`.

### Passwords are held to production's policy

`POST /user_management/users`, `PUT /user_management/users/{id}` and `POST /user_management/password_reset/confirm` refuse a password production would refuse, at the settings a new environment is born with: at least 10 characters, at most 72 bytes (bcrypt's limit), not containing the account's email address, and a [zxcvbn](https://github.com/zxcvbn-ts/zxcvbn) score of 3 or more — scored with the same library, dictionaries and keyboard graphs production configures, so the same passwords pass and fail (`correct horse battery staple` passes; `password123` does not). The create and update routes answer `400 password_strength_error` and the reset `400 password_reset_error`, each with an `errors` array naming every broken rule (`password_too_short`, `password_too_long`, `password_contains_email`, `password_too_weak`, and on the reset `password_reset_token_expired`) with production's detail fields (`minimum_length`, `warning`, `suggestions`). The breached-password lookup (`password_pwned`) is not performed: it is off by default in production and needs the network. Seeded `password:` values are written as given, so a seed's `test123` still signs in; only what arrives over the API is checked.

A password reset token lasts 15 minutes. Confirming one sets the password, signs the user out of every session (each emits `session.revoked`), and verifies the email, as production does; a token the emulator never issued is a `404 password_reset_token_not_found`.

## Authentication

The grants at `POST /user_management/authenticate` and `POST /oauth2/token` are hand-written rather
than generated from the spec, the one deliberate exception to the emulator's codegen.

### Organization-scoped sessions

Every fresh login resolves an organization the way production does, so tokens carry the claims your authorization code reads:

- **One active membership** — selected implicitly. The response returns `organization_id` and the access token carries `org_id`, `role`, `roles`, and `permissions`. A membership can hold several roles — `role_slugs` on `POST`/`PUT /user_management/organization_memberships`, or `roles:` in the seed — in which case `role` is the highest-priority role held, `roles` lists them all in priority order, and `permissions` is the union of what they grant.
- **No memberships** — `organization_id` is `null` and the token carries no `org_id`. Nothing is invented.
- **Several active memberships** — a `403` asking the client to choose, exactly as WorkOS does:

```json
{
  "code": "organization_selection_required",
  "message": "The user must choose an organization to finish their authentication.",
  "pending_authentication_token": "pending_...",
  "organizations": [
    { "id": "org_...", "name": "Alpha Corp" },
    { "id": "org_...", "name": "Beta Corp" }
  ],
  "user": { "object": "user", "id": "user_...", "email": "member@example.com" }
}
```

Finish the sign-in by exchanging that token for a session scoped to the chosen organization — the emulator rejects an organization the user is not an active member of with `organization_membership_not_found`:

```bash
curl -X POST http://localhost:4100/user_management/authenticate \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"urn:workos:oauth:grant-type:organization-selection","pending_authentication_token":"pending_...","organization_id":"org_..."}'
```

Only `active` memberships count — an unaccepted invitation or a deactivated member is never selected. Passing `invitation_token` to the `authorization_code`, `password`, or Magic Auth grants accepts the invitation as part of the login, joining the user to the invited organization and scoping the session to it, so there is no selection step; a token that is unknown, expired, or already used is rejected with `invitation_invalid`, and one addressed to somebody else with `invitation_cannot_be_used_for_email`. Once a session exists, only an explicit `organization_id` on a refresh (`switchToOrganization`) moves it between organizations — and only into one the user is an active member of. A refresh naming an organization the user does not belong to, or belongs to inactively, answers `{"error": "organization_membership_not_found", "error_description": "User is not a member of the organization."}`; one naming an organization that does not exist answers `organization_not_found`. Neither rotates the token, and a switch that succeeds mints the membership's `role`, `roles` and `permissions` the way a fresh login would.

A `pending_authentication_token` is good only for the step that issued it, as in production: one from `organization_selection_required` finishes on the organization-selection grant, one from `mfa_challenge` on the `mfa-totp` grant, and one from `email_verification_required` on the email-verification grant. Spending it on another answers `400` with the bare `{"message": "The pending_authentication_token is not valid for this request."}` — no `code`, which is what production sends — and leaves the token unspent for the right grant, so a challenge cannot be skipped by taking its token to the organization-selection step. The `mfa-totp` grant also refuses a challenge that belongs to a different user than the token, with `{"code": "user_mismatch", …}`.

### Email verification gates the password grant

A password sign-in by a user whose `email_verified` is `false` does not return a session. Production answers `email_verification_required`, and that response is what sends the user to a verification screen — so the emulator does too:

```json
{
  "code": "email_verification_required",
  "message": "Email ownership must be verified before authentication.",
  "pending_authentication_token": "pending_...",
  "email_verification_id": "email_verification_...",
  "email": "bob@example.com"
}
```

The gate creates an email verification, so the code arrives on the `email_verification.created` webhook like every other emailed code. Finish the sign-in with the token and the code — exactly what the SDKs' `authenticateWithEmailVerification` sends:

```bash
curl -X POST http://localhost:4100/user_management/authenticate \
  -H "Content-Type: application/json" \
  -d '{"grant_type":"urn:workos:oauth:grant-type:email-verification:code","pending_authentication_token":"pending_...","code":"123456"}'
```

The resulting session records the method that was gated (`password`), not the verification step. The pending token is the only way to name the user: production's request schema for this grant has no `user_id`, so the emulator reads none either, and a request without the token is a malformed one (`invalid_request`). Fixtures that sign in with a password want `email_verified: true`, in a seed file or on `POST /user_management/users`.

### SSO logins produce a session

A code from `GET /sso/authorize` redeems at `POST /user_management/authenticate` with `grant_type=authorization_code`, so an app that sends people straight to their IdP with `sso.getAuthorizationUrl` and finishes at AuthKit's callback gets a real session — one whose `auth_method` is `sso`, so authorization code that hides password management for federated users can be exercised. `POST /sso/token` still redeems the same code for a bare profile and access token, which is the standalone SSO product and creates no session; a code is spent by whichever endpoint gets it first.

The session is scoped to the connection's organization. A profile with no user-management account yet gets one, verified — the IdP asserted the address — the way AuthKit provisions on a first SSO login.

As with `/user_management/authorize`, `/sso/authorize` is public and signs in whoever `login_hint` names: there is no IdP here to prove an identity with, and inventing a profile for any address is what lets a test drive an SSO login at all. Both endpoints will therefore hand out a session for any account you ask them for. That is the emulator being a test double, not an authorization server — do not point anything at it that you would not also let sign in as your users.

### `/user_management/authorize` honors the SSO selectors

Production's `provider`, `connection_id` and `organization_id` are exclusive, and the two ids initiate SSO: the person goes to that connection's IdP, not to the hosted sign-in. A `getAuthorizationUrl({ connectionId })` or `({ organizationId })` URL is therefore handed to `/sso/authorize`, the emulator's stand-in for the IdP, which mints the code the callback receives; the exchange redeems it as an SSO login scoped to the connection's organization, as above. With `--interactive` that is the SSO login page, not the email page.

| Request                                                            | Outcome                                                                                                                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection_id`                                                    | `302` to `/sso/authorize?connection=…`                                                                                                                                 |
| `organization_id` alone, organization holds an SSO connection      | `302` to `/sso/authorize?organization=…`                                                                                                                               |
| `organization_id` alone, no SSO connection                         | Hosted sign-in with the organization pre-selected. Production refuses to initiate SSO here; the emulator stays lenient so suites that pre-select this way keep working |
| `provider` (`authkit` or a social provider) with `organization_id` | Hosted sign-in with the organization pre-selected, as production                                                                                                       |
| `connect_request`                                                  | Unchanged: the validated `/oauth2/authorize` request supplies its own parameters                                                                                       |

`client_id`, `redirect_uri`, `state`, `login_hint`, `code_challenge` and `code_challenge_method` travel with the request, and `client_id` is required on this path as `/sso/authorize` requires it. The code is bound to that `client_id` the way a hosted code is, so the token names the client that started the authorization whatever `client_id` the redeeming request sends. A PKCE challenge binds the SSO code the way it binds a hosted one: the exchange needs the matching `code_verifier` (`invalid_request` without one, `invalid_grant` on a mismatch, and the code is unspent either way), and `POST /sso/token` refuses the code outright as `invalid_grant`, also without spending it, since production's standalone token endpoint takes no verifier and a bound code is AuthKit's alone to redeem.

### Refresh tokens rotate, with a 30-second replay grace period

The emulator issues a new refresh token on every refresh and retires the one you presented, the way [AuthKit documents](https://workos.com/docs/authkit/session-resilience). Replaying the retired token is safe and idempotent: it answers `200` with the _same_ rotated `refresh_token` as the first exchange, a freshly minted access token for the same session, and no new session or authentication event, so concurrent refreshes (a hot reload firing several requests at once, a retry after a slow network) converge on one result instead of signing the user out. A client that fell further behind still converges: a token two rotations old resolves to the newest token in its chain. The grace period is the documented 30 seconds (production reads the length from a feature flag, so the public docs are the figure the emulator matches), measured the way production measures it, from the moment the rotated token is itself used: a client whose rotation response was lost can come back with the old token at any point in the session's life, and once the new token has been used the old one stays good for 30 seconds more, then is terminally invalid. Replaying it after that returns `{"error": "invalid_grant", "error_description": "Refresh token already exchanged."}`.

### Access tokens live five minutes

`/user_management/authenticate` mints access tokens whose `exp` is 300 seconds after `iat`, on every grant and every refresh: production's default "Access token duration" on the application's Sessions tab. Earlier emulator versions minted an hour. The seed's [`sessionSettings`](seeding.md#session-settings) changes the figure the way the dashboard does; nothing at runtime can, and a JWT template may not set `exp`.

### Authentication failure shapes

`POST /user_management/authenticate` does not use one error shape for every failure. Which shape you get depends on the failure, not only on the grant: any malformed request is OAuth-shaped, and among credential failures three grants are OAuth-shaped and the rest plain.

| Failure                                                                      | Body                                                                                                                          | Node SDK raises                |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `grant_type` outside production's public list, legacy names too              | `{"code": "invalid_request_parameters", "message": "…", "errors": […]}` (422)                                                 | `UnprocessableEntityException` |
| Malformed request — missing parameter, any grant                             | `{"error": "invalid_request", "error_description": "…"}`                                                                      | `OauthException`               |
| `authorization_code` — unknown, expired, bad verifier, user gone             | `{"error": "invalid_grant", "error_description": "…"}`                                                                        | `OauthException`               |
| `refresh_token` — unknown, expired, already exchanged, user gone             | `{"error": "invalid_grant", "error_description": "…"}`                                                                        | `OauthException`               |
| `refresh_token` — switch to an organization the user is not in               | `{"error": "organization_membership_not_found\|organization_not_found", …}`                                                   | `OauthException`               |
| Device code — pending, expired, unknown, or user deleted                     | `{"error": "authorization_pending\|expired_token\|invalid_grant", …}`                                                         | `OauthException`               |
| `password` — wrong password                                                  | `{"code": "invalid_credentials", "message": "…"}` (400)                                                                       | `GenericServerException`       |
| Magic Auth, email verification, MFA — wrong, expired, reused, or locked code | `{"code": "invalid_one_time_code\|one_time_code_expired\|one_time_code_previously_used\|one_time_code_too_many_attempts", …}` | `GenericServerException`       |
| Pending token spent on a grant other than its own                            | `{"message": "…"}` (400, no `code`)                                                                                           | `GenericServerException`       |
| `mfa-totp` — challenge belongs to another user                               | `{"code": "user_mismatch", "message": "…"}` (400)                                                                             | `GenericServerException`       |
| Step-up (MFA, org selection, email verification)                             | `{"code": "…", "message": "…"}` (403)                                                                                         | `AuthenticationException`      |

`password` is an RFC 6749 grant, but production fails its credentials with the plain shape, so the emulator does too — while a `password` request that omits a parameter still answers `invalid_request` OAuth-style. Both halves come from the spec, whose authenticate 400 lists `invalid_request` and `invalid_grant` only as `{error, error_description}` and `invalid_credentials` and the one-time-code errors only as `{code, message}`. A `grant_type` production does not list fails body validation there before any grant runs, and the emulator answers with the same 422: `invalid_request_parameters`, with one `grant_type_required` error whose message spells out the accepted list. The legacy `urn:workos:oauth:grant-type:magic-auth` and `urn:workos:oauth:grant-type:email-verification` names (without the `:code` suffix) are outside that list and fail the same way. A grant production does list but the emulator does not implement — the Radar challenges and email completion — is reported as `invalid_request` rather than `unsupported_grant_type`, which the spec gives to `/sso/token` alone.

`/sso/token` is OAuth-shaped throughout, matching its spec definition.

### Magic Auth doubles as sign-up

`POST /user_management/magic_auth` creates the user when the email has none, so a sign-up flow needs no separate `POST /user_management/users` first. Production does the same at code-creation time rather than at authenticate: the 201 already carries a `user_id`, the user is immediately listable with `email_verified: false`, and the email it sends uses the "Sign up" template.

Redeeming a Magic Auth code sets `email_verified` to `true`, matching the live authenticate response for the same flow. This applies to **any** user who was not already verified, not only ones the endpoint just created, so a fixture seeded `email_verified: false` comes back verified after its first Magic Auth login.

An email is resolved case-insensitively (`User@x.test` and `user@x.test` are the same account, stored under whichever case created it), and one that could only be a typo is rejected rather than turned into an account nothing can reach. `POST /user_management/users` applies both — so it answers 409 for an address that differs from an existing one only in case, rather than creating a second account no lookup can tell apart from the first.

Every lookup by email is case-insensitive, not just Magic Auth's, so an account created by a Magic Auth sign-up is reachable by whatever casing the caller has: the password grant, `login_hint` on the authorize endpoints, `POST /user_management/password_reset`, the `email` filter on `GET /user_management/users` and `GET /user_management/invitations`, accepting an invitation, the `user_id` on SSO authentication events, the profile `/sso/authorize` resolves from a `login_hint`, and the email a seeded organization membership joins its user by. Seeded `users` are held to the same uniqueness the API enforces — two entries differing only in case are a config error, since a seed was otherwise the one way left to produce the pair of accounts no lookup can tell apart.

A field named `email` must be a string wherever it is accepted. A number or object is a `400` (`422` on `POST /user_management/users` and `POST /user_management/invitations`, which keep those routes' validation shape) naming the type, distinct from the `email is required` reported for one that is genuinely absent — which includes an explicit `null`, since that is how a JSON body spells absence. Addresses are trimmed before they are stored or compared, so a padded copy of an address finds the account written under it.

The typo guard applies wherever an address is written rather than looked up: both routes that create users, `POST /user_management/invitations` (acceptance resolves the recipient by email, so a typo is an invitation that is spent without enrolling anyone), and seeded `users`, `invitations`, and organization `memberships`. Read paths are left alone — an address that resolves to nothing is still a `404` you can act on, not a validation error.

### One-time codes are single-use, latest-only, and lock after three misses

A Magic Auth code, an email verification code, and an MFA challenge are one authentication challenge underneath in production, verified by one rule, and the emulator verifies all three the same way:

- **Only the latest Magic Auth or email verification code counts.** Those grants look up the code by the user, not the user by the code, so `POST /user_management/magic_auth` twice for one address retires the first code — it is `invalid_one_time_code`, and the miss counts against the second — and `POST /user_management/users/{id}/email_verification/send` does the same. The retired record is dropped when its replacement is issued, so `GET /user_management/magic_auth/{id}` or `…/email_verification/{id}` of an earlier code is a `404`. An address with no account, or an account never sent a code, is a `404` at the grant too: there is nothing to compare against. An MFA challenge is named by its id, so issuing another does not retire it.
- **Three misses lock it.** Each wrong code is `invalid_one_time_code` and counts. From the fourth request on, right code or wrong, the answer is `one_time_code_too_many_attempts`; the way forward is a new code, which starts over. A pending token survives the lockout, so the same login finishes with the fresh code.
- **A redeemed code stays redeemed.** Presenting it again is `one_time_code_previously_used`, checked before the code is even compared — so a replay with a wrong code says previously used, not invalid — until a newer code supersedes it, after which it is a miss like any other.
- **An expired code** is `one_time_code_expired`.

Messages name the email for Magic Auth and email verification (`One-time code for 'bob@example.com' has expired.`) and the challenge id for MFA, as production's do. Each failure emits the matching `authentication.*_failed` event with the same `error.code`.

`POST /user_management/users/{id}/email_verification/confirm` applies the same rules under its own codes — `email_verification_code_incorrect`, `email_verification_code_expired`, `email_verification_code_previously_used`, `email_verification_too_many_attempts` — and reports `email_previously_verified` only once a fresh code has passed for a mailbox already verified. Its response is the spec's `{ "user": … }` envelope, which the SDKs' `verifyEmail` unwraps.

`POST /auth/challenges/{id}/verify` (the SDKs' `verifyChallenge`) answers a wrong code with `201 { "challenge": …, "valid": false }` — the verification ran and said no — and keeps its errors for a challenge that cannot be verified at all: `422 authentication_challenge_expired`, `422 authentication_challenge_previously_verified`, and `400 one_time_code_too_many_attempts`.

## Organization Memberships

`POST` and `PUT /user_management/organization_memberships` answer a `role_slug` (or any of `role_slugs`) that names no role with `422 invalid_role`. A slug resolves to a role of that organization or of the environment; `member` and `admin` always resolve, since production creates both with every environment, so they need no seeding. `GET /user_management/organization_memberships` wants an `organization_id` or a `user_id` (`400 missing_user_id_or_organization_id`).

One assumption runs through the membership and invitation routes: multiple roles are enabled for the environment, so `role_slugs` is accepted wherever production accepts it with that setting on, and `multiple_roles_not_enabled` is never answered.

## Groups

A second group with the same name in an organization is a `409` whose body is `{"message": "A group with name: … already exists in the organization.", "error": "Conflict"}` with no `code`, as production's conflict renders; `name` is at most 256 characters and `description` a non-empty string of at most 150 (`null` clears it); a group holds at most 500 members (`400 group_membership_limit_exceeded`).

## Invitations

`POST /user_management/invitations`: an open invitation to the same organization is `400 email_already_invited_to_organization`; without an organization, an open invitation for the address is `400 email_already_invited` and an existing account is `400 user_already_exists` (production lets through an account that only an organization invitation created, since its owner has not signed up; the emulator records no such distinction and refuses any existing account); an unknown `role_slug` is `400 invalid_role`; `expires_in_days` must be 1 to 30 (`expires_in_days_too_short`, `expires_in_days_too_long`) and defaults to 7 days; an unknown `organization_id` or `inviter_user_id` is a `404`.

An invitation's `state` is derived when it is read, so one expires on its own once `expires_at` passes. Accepting or revoking anything but a pending invitation is `400 invite_not_pending`; resending one that has expired, been revoked or been accepted is `400 invite_expired`, `invite_revoked` or `invite_accepted`. There is no `DELETE` for an invitation, as there is none in the API — revoke it.

## SSO

`POST /connections` enforces what production's create endpoint enforces, so a suite that passes here does not meet a 400 on the real API:

- **One SSO connection per organization.** A second one is `400 {"message": "Organization 'org_…' already has a Connection.", "code": "connection_already_exists_for_organization", "organization_id": "org_…"}` — production's body exactly, which the OpenAPI spec does not list. Delete the connection first to replace it. OAuth connections do not count: they are environment-level in production, and an organization a seed binds one to can still hold its SSO connection. The same rule holds for directories, where the seed is the only way to create one: a second directory for an organization fails the boot.
- **SAML and OIDC types only**, with the protocol's options present: `saml_options` carries `idp_metadata_url` or the manual IdP fields (`idp_sso_url` and at least one `idp_signing_certs` entry), `oidc_options` carries `discovery_endpoint`, `client_id` and a `client_secret` (or `token_authentication_method: private_key_jwt`). `connection_type` may be omitted and is then `GenericSAML` or `GenericOIDC` — production infers a vendor from the IdP, which the emulator cannot do. An OAuth or internal type is `connection_type_not_supported`; the cross-field failures (`connection_type_or_options_required`, `both_saml_and_oidc_options_provided`, `connection_type_conflicts_with_options`, `saml_options_required`, `oidc_options_required`, `incomplete_saml_options`, `ambiguous_saml_options`, `client_secret_required`) carry production's codes and messages. Certificates are not parsed and URLs are not fetched.
- **A created connection starts `validating`** and announces nothing, as in production, where an IdP response has to prove the configuration first. The first login through it — `/sso/authorize` sends a `validating` connection through exactly as an active one — turns it `active` and emits `connection.activated`. A seeded connection keeps its declared `state` (default `active`) and its `domains`; the create endpoint has no `domains` field and ignores one, so a connection it makes has none. `name` defaults to the organization's name.
- `GET /connections` lists SSO connections only: the OAuth, Magic Link and TestIdp types are left out, as production's listing leaves them out.

The authorization and token endpoints check what production checks:

- `GET /sso/authorize` requires `client_id`. Without one production lands on its own error page as `client_id_invalid`, before the `redirect_uri` is read; the emulator has no such page and registers no clients, so an absent id is `400 {"message": "Missing or invalid client_id.", "code": "client_id_invalid"}` and any id that is present is accepted.
- An `inactive` connection is not a 404 but a redirect back to `redirect_uri` with `error=connection_unlinked`, production's description of the selector (`The connection 'conn_…' is inactive.`, or the organization, domain or provider variant), the `state`, and an `error_uri` pointing at the error-code reference — so a callback handler sees the failure the way it would in production.
- `POST /sso/token` requires `client_id` and `client_secret`. The secret is an API key of the environment — in production it is looked up among the environment's keys, here among the emulator's (`sk_test_default`, or the keys you configured) — and a wrong one is `400 {"error": "invalid_client", "error_description": "Invalid client secret."}`, with no `authentication.sso_failed` event, since nothing was authenticated. The `client_id` is only required to be present, and becomes the access token's `aud`.
- An authorization code lives five minutes, as production's do.

## Directory Sync

Read-only over HTTP, as production is: a directory is connected in the dashboard, so there is no
`POST` route to emulate, and the seed file is the only way to get one
([seeding.md](seeding.md#directory-sync)). A seeded directory's group-to-role mappings are resolved
onto the organization memberships, which then report `directory_managed`, and an organization holds
one directory, as it holds one SSO connection. `DELETE /directories/:id` emits a delivered
`dsync.deleted` — except for an `unlinked` directory with no groups, which production deletes
silently. Removing a user from a group emits `dsync.group.user_removed`.

## Multi-Factor Auth

TOTP codes are accepted without verifying the shared secret. A challenge is verified under the
[one-time-code rules](#one-time-codes-are-single-use-latest-only-and-lock-after-three-misses):
single-use, locked after three wrong codes, and — since a challenge is named by its id — not
retired when another is issued.

### Enrolled means verified

`POST /user_management/users/{id}/auth_factors` creates the factor and the enrollment challenge that completes it, and until that challenge is verified at `POST /auth/challenges/{id}/verify` the factor is not enrolled: `GET /user_management/users/{id}/auth_factors` lists verified factors only, and the `password` grant — and the hosted login page — challenges a second factor only when the user has one. A test that wants the `mfa_challenge` step enrolls, reads the enrollment challenge's code off the store (a TOTP code is delivered nowhere), verifies it, and then signs in; an enrollment abandoned at the QR code changes nothing about how the user signs in, as it does live. Seeded `totp: true` factors come up verified.

## FGA / Authorization

### Roles, permissions, and resources

Role, permission, and resource bodies are validated the way production's DTOs validate them: a
failure is a `422` with `message: "Validation failed"` and one `{ field, code }` per failing field,
`code` being the message of the first constraint that failed, unknown properties first. An
environment role slug matches `^[a-z0-9]+(?:[-_][a-z0-9]+)*$`. An organization role slug must carry
the `org-` prefix (`^org-[a-z0-9]+(?:[-_][a-z0-9]+)*$`) and may be omitted, in which case one is
generated from the name plus the last six characters of the role id (`billing-manager-k4m2xq`, no
prefix), as production generates it. A permission slug matches `^[a-z0-9*]+(?:[-_.:][a-z0-9*]+)*$`.
Slugs and names are at most 48 characters, descriptions 150, and a resource `external_id` is ASCII
and at most 128. Bodies accept only the fields the spec's DTOs declare, so `priority`,
`is_default_role`, a role's `slug` on update, and a resource's `metadata` are refused with
`property <name> should not exist`; the one exception is organization role creation, which ignores
unknown properties as production's unwhitelisted pipe does. A role's priority is seed-only: a role
created through the API joins the end of the priority order, and `GET /authorization/roles` lists
environment roles unpaged in that order, as the organization list does.

Resource types are not modeled: any well-formed `resource_type_slug` is accepted on roles and
permissions, and permission scopes are not checked against the role scope.

There is no `DELETE /authorization/roles/{slug}`; production deletes environment roles from the
dashboard only. `DELETE /authorization/organizations/{id}/roles/{slug}` answers `409`
`role_has_assignments` while a membership holds the role, through its roles or a resource-scoped
assignment (one derived from a native group's grant included); production's
`role_has_group_role_mappings` cannot arise, because the emulator resolves directory group
mappings onto memberships when it seeds them. Attaching an unknown permission slug to a role is
`422` `invalid_permission_slug`; removing a permission an organization role does not hold answers
with the role unchanged.

`PUT /authorization/organizations/{id}/roles/priority` takes `role_priority_order`: every slug that
applies to the organization, environment roles included (an organization role shadows an
environment role with its slug), each exactly once. Duplicates are `400` `duplicate_role_slugs`, an
unknown slug `400` `unknown_role_slugs`, and an incomplete list `400` `bad_request`. The emulator
stores one priority per role, so reordering an environment role through one organization reorders
it for every organization.

`GET /authorization/resources` requires `organization_id` or `resource_type_slug` (`400`
`missing_organization_id_or_resource_type_slug`), and the memberships-for-resource routes require
`permission_slug` (`422`; a slug that names no permission is a `404`).

Every organization owns an implicit `organization` resource whose `external_id` is the
organization's `external_id`, falling back to the organization id. Resources created without parent
fields attach to it, and it cannot be created, updated, or deleted directly.

### Native group authorization

Native AuthKit groups can receive scoped roles through
`/authorization/groups/{groupId}/role_assignments`: create and list assignments, then get or delete
one by ID or remove by role and resource criteria. Omitting the resource targets the
organization's own resource. Direct role assignments also support criteria removal through
`DELETE /authorization/organization_memberships/{id}/role_assignments`. Duplicate group
assignments return `409` with code `duplicate_group_role_assignment`; an unknown role slug is a
`404`, as is group criteria removal that matches nothing; roles and resources from another
organization are rejected. Permission checks, effective-permission lists, and accessible-resource discovery resolve
current group membership and include grants on resource ancestors. Removing a member or group
revokes its derived access immediately. Membership and resource assignment lists expose inherited
grants with `source.type: "group"` and the source group assignment ID; resource filters are honored.
Deleting a role, group, or resource also removes its group grants. The emulator does not invent
role-assignment webhook events. Bulk group assignment replacement is not yet supported.

Resource updates accept the Node SDK's `PATCH` endpoints by ID and by organization, resource type,
and external ID. The earlier `PUT`-by-ID endpoint remains available.

## Audit Logs

Events are ingested with production's `{organization_id, event}` body, validated the way its DTO
validates them, and stored under their idempotency key. No action schemas are registered, so any
action, target type and metadata are accepted. Export generation is not implemented.

## Vault

Object CRUD is implemented; the data-key encryption endpoints are not.

## Feature Flags

Every spec endpoint is implemented at its documented verb; the emulator additionally accepts `POST`
on enable/disable and `PUT` on target creation as aliases, which production rejects. Flags resolve
into the `feature_flags` access-token claim, the per-user and per-organization list endpoints, and
`GET /sdk/feature-flags` — the Node SDK runtime client's polling endpoint, which the spec does not
define. Production has no create-flag endpoint, so flags come from the `featureFlags` seed key
([seeding.md](seeding.md#feature-flags)).

## API Keys

A key created through `POST /organizations/{id}/api_keys`, or seeded under `apiKeys`, authenticates
real requests the way the default key does.

## Pipes / Connected Apps

User- and organization-owned connected-account CRUD and user access-token retrieval are supported; a
refresh mints a local `di_mock_` token rather than contacting the provider. The older
`/pipes/connections` routes remain emulator-specific.

An organization holds one account per provider, with `user_id: null`. `POST` and `PUT` on
`/organizations/{id}/connected_accounts/{slug}` take the acting member in `user_id`.
`established_by_user_id` names the member who imported the account or was seeded as establishing it,
and becomes `null` when that member is deleted. Production invalidates the account when that
member's membership ends (`needs_reauthorization`,
`state_reason: establishing_member_membership_ended`, credentials cleared); the emulator leaves it
as it is. Deleting an organization deletes its accounts and its members' accounts scoped to it, each
emitting `pipes.connected_account.disconnected`.

| Request                                                                           | Outcome        |
| --------------------------------------------------------------------------------- | -------------- |
| Organization `POST` or `PUT` without `user_id`                                    | `422`          |
| Organization `POST` or `PUT` whose `user_id` is not an active member              | `403`          |
| Organization `POST` when the organization already has an account for the provider | `409 conflict` |

The multiple-connections contract (`connection_intent`, `connected_account_id`,
`supports_multiple_connections`) is not implemented, and `account_display_name`,
`account_identifier`, `connection_role` and `config` are not stored.

## Applications

A redirect URI is stored as a bare string, so `default` is accepted on create and update but always
reported as `false`. `uses_pkce` and `is_first_party` are stored and reported; `uses_pkce` makes a
public client, whose codes `/oauth2/token` redeems by PKCE verifier alone and which may present no
client secret. `POST /oauth2/register` (RFC 7591, outside the spec) creates
`was_dynamically_registered` applications, which `registration_types` filters. `POST /client/token`
mints a signed, short-lived token, but the spec documents only the `{ token }` envelope — the claims
inside are an emulator convention, and no Client GraphQL API is served for it to authenticate
against.

## JWT Templates

Claims render into every access token. Filters, conditionals, and loops are not supported. The
template language is in [tokens.md](tokens.md).

## Webhooks

`POST` and `PATCH /webhook_endpoints` validate as production does: an HTTPS `endpoint_url`, a
non-empty `events` list from the subscribable catalog, `status` of `enabled` or `disabled`, and a
generated signing secret (returned on every read). One emulator-only relaxation: a plain `http://`
URL is accepted for a loopback host (`localhost`, `127.0.0.0/8`, `::1`), so a local receiver can be
registered over the API. Seed an endpoint to point it at any other `http://` receiver, pin its
`secret`, or subscribe it to every event with an empty `events` list. Delivery is fire-and-forget
with a 5s timeout and no retries. Endpoints registered in a seed file do not receive events from
that same seed file.

## Events

Emitted as a side effect of every other operation. All are queryable at `GET /events`, including
those with no registered webhook endpoint; the `events` filter is required, as in production.

## AuthKit Configuration

Redirect URIs are accepted but not enforced against authorize requests. MCP resource indicators
(RFC 8707) are stored and, when a request names a registered one, become the `aud` of tokens from
`/oauth2/token`; once any is registered, a dynamically registered client naming an unregistered one
at `/oauth2/authorize` is answered `invalid_target`, and one naming none is bound to the resource
flagged `default`. Resources are matched by normalized URL; wildcard patterns are refused.

## Admin Portal

`POST /portal/generate_link` answers `201` with a link for the organization, validating the
request as production does. The organization must exist (`404`), and must be resolved before the
intent is read — so an unknown organization is a `404` whatever the intent. The intent must be one
of `sso`, `dsync`, `audit_logs`, `log_streams`, `domain_verification`, `certificate_renewal`,
`bring_your_own_key` or `enterprise_managed_authorization`; anything else, a missing intent
included, is a `400` `invalid_portal_link_intent` quoting what was sent. The
`enterprise_managed_authorization` intent is flag-gated per team in production and the emulator
treats every team as flagged in, but it keeps the rule behind the flag: the organization needs an
active `OktaSAML` or `OktaOIDC` connection, or the answer is a `400` `okta_connection_required`.

The portal itself is not served, and `certificate_renewal` is not held to production's check that
the organization has an expiring certificate, because the emulator does not model certificates.

## Widgets

`POST /widgets/token` mints the session token the `@workos-inc/widgets` components authenticate
with, as the SDKs' `widgets.getToken()` calls it, answering `201`. The requested scopes are minted
under the `permissions` claim and the token expires in an hour — the two claims the widget client
reads to decide whether it may render and when to refresh.

The body is validated as production validates it. `scopes` must be drawn from the production list
(`widgets:users-table:manage`, `widgets:user-api-keys:manage-self`,
`widgets:user-api-keys:manage-all`, `widgets:domain-verification:manage`, `widgets:sso:manage`,
`widgets:api-keys:manage`, `widgets:dsync:manage`, `widgets:audit-log-streaming:manage`,
`widgets:pipes:manage`); an unknown one, or a non-string `organization_id` or `user_id`, is the
`400` the spec documents for this route: `{ message: [...], error: 'Bad Request' }`, one
class-validator message per failed field. A session carries a user, an organization, or both:

- `organization_id` with `user_id`: the organization must exist (`404`) and the user must hold an
  active membership in it (`404 UserOrganizationMembership`). `scopes` may be empty.
- `organization_id` alone: a standalone session for the org-scope widgets. `scopes` must name at
  least one, and none of the AuthKit scopes (`widgets:users-table:manage`,
  `widgets:user-api-keys:*`), which only a user can hold; either is a `400` naming the problem.
  The token's `sub` is the session id.
- `user_id` alone: a user-only session for widgets like `UserProfile`, with no organization and
  no permissions. The user must exist (`404`). Any `scopes` need an `organization_id` (`400`).

The emulator does not narrow `permissions` to what the user's role grants, as production does for
a user session; the token carries the requested scopes as is.

The components never call the public REST API; they call a private `/_widgets/*` surface. The
emulator serves the routes the org-scope `<ApiKeys>` widget uses, as a translation layer over the
same store the public API-key routes use — so a key created in the widget authenticates requests,
and a key created through `POST /organizations/{id}/api_keys` (or seeded) shows up in the widget:

| Method   | Path                                      |
| -------- | ----------------------------------------- |
| `GET`    | `/_widgets/ApiKeys/organization-api-keys` |
| `POST`   | `/_widgets/ApiKeys/organization-api-keys` |
| `DELETE` | `/_widgets/ApiKeys/{apiKeyId}`            |
| `POST`   | `/_widgets/ApiKeys/{apiKeyId}/expire`     |
| `GET`    | `/_widgets/ApiKeys/permissions`           |

Point the widgets provider at the emulator and hand it a token minted with the
`widgets:api-keys:manage` scope:

```tsx
<WorkOsWidgets apiHostname="localhost" port={4100} https={false}>
  <ApiKeys authToken={token} />
</WorkOsWidgets>
```

`/_widgets/*` requests authenticate with the widget token, not an API key, and the organization is
the token's `org_id`: keys are only ever listed, created, revoked, or expired within it, and another
organization's key is a `404`. A missing, expired, or otherwise invalid token — or one minted
without the widget's scope — is a `403`, the status the widget client treats as a token problem: it
refetches the token once, then renders its expired-session or incorrect-permissions state.
`GET /_widgets/ApiKeys/permissions` serves the environment's permissions (seeded, or created via
`POST /authorization/permissions`), which is what fills the create dialog's checklist.

Not implemented yet: the `scope="user"` variant (`/_widgets/UserApiKeys/*`) and the other widgets'
`/_widgets/*` routes.

## Radar

Attempt listing only; no risk signals are computed, and the Radar challenge grants are not
implemented (see [Authentication failure shapes](#authentication-failure-shapes)).

## Agent Auth

Blueprint CRUD, all four token grants (`user_delegated`, `autonomous`, `agent_delegated`,
`refresh`), token validation, and instance and session listing, lookup, deletion and revocation are
implemented. Agent access tokens are signed with the emulator key (`typ: at+jwt`,
`sub_profile: ai_agent`) so JWKS validation works; delegated permissions are recomputed from the
member's current role at every mint and refresh. Agent tokens carry the `workos-emulate` placeholder
audience, since nothing at the API-key-authenticated token endpoint names a client.

## Not-Found Responses

A lookup that finds nothing answers the way production's `EntityNotFoundException` does: the
entity type as production names it, the id, slug, token or email the route looked up by, and
`code: "entity_not_found"`:

```json
{ "message": "Organization not found: 'org_01K...'.", "code": "entity_not_found", "entity_id": "org_01K..." }
```

A client that matched on the emulator's former `not_found` code must match `entity_not_found`
instead. A few routes mirror a production 404 that is not an entity lookup: `POST
/authkit/oauth2/complete` answers `external_auth_not_found`, removing a membership that is not in
a group answers `membership_not_found`, and `GET /user_management/jwt_template`, `POST
/sso/logout/authorize` and `DELETE /user_management/authkit_oauth_resources/{id}` carry
production's bare `{ "message" }` body (plus `"error": "Not Found"` where production adds it)
with no `code`. OAuth grant failures keep their RFC 6749 `{ "error", "error_description" }`
shape, and a route that does not exist is still `{ "message": "Not Found", "code": "not_found" }`.
