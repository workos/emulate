# Seed data

The seed file declares what the emulator holds before the first request: users, organizations and
their memberships, roles and permissions, SSO connections, directories, feature flags, M2M
applications, API keys, webhook endpoints and more. Each section below covers one key of the file
and the behavior the emulator attaches to it. Which routes exist for each feature is in
[SUPPORTED.md](../SUPPORTED.md); how the routes behave is in [behavior.md](behavior.md).

Create `workos-emulate.config.yaml` in the current directory or pass `--seed <path>`.

```yaml
users:
  - email: alice@acme.com
    first_name: Alice
    password: test123
    email_verified: true

organizations:
  - name: Acme Corp
    domains:
      - domain: acme.com
        state: verified
    # Minted into the `entitlements` claim of access tokens scoped to this organization.
    entitlements: [audit-logs, sso]
    memberships:
      - email: alice@acme.com
        # One `role`, or several with `roles` — the multiple-roles shape, ordered by role priority.
        roles: [admin, document-editor]

roles:
  - slug: admin
    name: Admin
    permissions: [posts:read, posts:write]
  - slug: document-editor
    name: Document Editor
    permissions: [documents:read]
    resource_type_slug: document # optional; defaults to organization

permissions:
  - slug: posts:read
    name: Read Posts
  - slug: posts:write
    name: Write Posts
  - slug: documents:read
    name: Read Documents
    resource_type_slug: document # optional; defaults to organization
```

## Pinning organization, user, and membership ids

`organizations`, `users` and an organization's `memberships` accept an optional `id`. Pin it to
match what your real WorkOS environment emits, so a backend whose database already references a
real org, user or membership id lines up with the emulator — and stays stable across restarts,
which otherwise mint a fresh id each time the seed re-runs. Omit it and an id is generated as
before. Pin a membership id when your backend stores it and later changes the role or removes the
member by it; a restart would otherwise leave the stored id pointing at nothing.

```yaml
organizations:
  - id: org_01ABC... # optional; generated if omitted
    name: Acme Corp
    memberships:
      - id: om_01DEF... # optional; generated if omitted
        email: alice@acme.com

users:
  - id: user_01XYZ... # optional; generated if omitted
    email: alice@acme.com
    password: test123
```

A pinned id must be a non-empty string, and ids must be unique within `organizations`, within
`users`, and across the memberships of all organizations (a duplicate would silently overwrite
the earlier record in the store). The pinned id is what the API, login tokens, and webhooks
report for that resource.

For OAuth-based logins (`authorization_code`, `refresh_token`, `device_code`), the authenticate
response omits `authentication_method` by default: the hosted authorize flow carries no provider
information, and the spec's `authentication_method` enum has no generic `OAuth` value — only
provider-specific ones like `GoogleOAuth`. Set `oauth_provider` on a seeded user to have the
response report a concrete, spec-valid provider. (Password, Magic Auth, and SSO logins already
report their own method and need no configuration.)

```yaml
users:
  - email: alice@acme.com
    oauth_provider: GoogleOAuth # reported as authentication_method for this user's OAuth logins
    oauth_idp_id: 108872335 # the user's id at the provider; generated if omitted
```

## Linked OAuth identities

`oauth_provider` also links an OAuth identity, so the user is reported by
`GET /user_management/users/{id}/identities` — a bare array of `{idp_id, type, provider}`, which is
what the SDKs' `getUserIdentities` deserializes:

```json
[{ "idp_id": "108872335", "type": "OAuth", "provider": "GoogleOAuth" }]
```

Completing a login through an OAuth `connection` (`GoogleOAuth`, `MicrosoftOAuth`, `GitHubOAuth`,
`AppleOAuth`) links one too, carrying the profile's `idp_id`. SAML connections do not: the spec's
identity `provider` enum is OAuth-only. A second login through the same provider is the same link,
not another one.

A JWT template reads the same fact as `user.identities` — a provider→`idp_id` map, `null` for every
provider the user has not linked, so `{{ user.identities.GoogleOAuth }}` renders the id and an
unlinked provider renders a claim the emulator drops.

## Seeded MFA factors

Set `totp: true` on a user to enroll a TOTP authentication factor at boot, exactly as
`POST /user_management/users/{id}/auth_factors` would:

```yaml
users:
  - email: alice@acme.com
    password: test123
    email_verified: true
    totp: true # enrolls a TOTP factor; password sign-ins answer with mfa_challenge
```

The seeded factor comes up verified — what a factor becomes once its enrollment challenge
clears, and the only kind production lists or challenges (see [Enrolled means
verified](behavior.md#enrolled-means-verified)) — so it is reported by
`GET /user_management/users/{id}/auth_factors`, and a password sign-in for the user returns
the spec's `mfa_challenge` step (a `pending_authentication_token` plus an
`authentication_challenge`) instead of a session, completed with the
`urn:workos:oauth:grant-type:mfa-totp` grant — so MFA administration and step-up login flows
need no post-boot enrollment calls that in-memory state would lose on restart.

## Session settings

The dashboard's Sessions tab (Applications → your application → Sessions) sets how long an
AuthKit access token lives. It has no API, so the seed is the way in:

```yaml
sessionSettings:
  access_token_ttl_seconds: 60 # production's default is 300
```

| Key                        | Condition     | Effect                                                                                            |
| -------------------------- | ------------- | ------------------------------------------------------------------------------------------------- |
| `access_token_ttl_seconds` | omitted       | `/user_management/authenticate` mints access tokens with `exp - iat` of 300, production's default |
| `access_token_ttl_seconds` | 1 to 2³¹ − 1  | every grant, first sign-in and `refresh_token` alike, mints with that lifetime                    |
| `access_token_ttl_seconds` | anything else | startup fails naming `sessionSettings.access_token_ttl_seconds`; `--validate-config` reports it   |

It is part of the seed, so `reset()` restores it with the rest of the data and each emulator
instance has its own. Only the access token's `exp` moves: refresh tokens, their rotation and
replay grace, and the lifetimes of SSO, M2M, widget and Agent Auth tokens are untouched. Expiry
follows real time, so a test that wants a genuinely expired token seeds a short lifetime and either
waits or moves its clock past `exp` (`setSystemTime` in `bun:test`, fake timers elsewhere); the
refresh token still exchanges for a fresh access token on the same session.

## Organization domains

A domain reaches an organization three ways, and each stores it lowercased:

```yaml
organizations:
  - name: Acme Corp
    domains:
      - domain: acme.com
        state: verified # or pending, the default
```

```bash
# domain_data on create or update: `state` is required, `pending` or `verified`
curl -X POST http://localhost:4100/organizations \
  -H "Authorization: Bearer sk_test_ci_key" -H "Content-Type: application/json" \
  -d '{"name":"Acme Corp","domain_data":[{"domain":"acme.com","state":"verified"}]}'

# The standalone route always creates the domain pending and starts DNS verification on it
curl -X POST http://localhost:4100/organization_domains \
  -H "Authorization: Bearer sk_test_ci_key" -H "Content-Type: application/json" \
  -d '{"organization_id":"org_01K...","domain":"acme.dev"}'
```

Production's validation applies to `domain_data` and to `POST /organization_domains`. A malformed
domain, or an entry whose `state` is missing or not one of the two, is the validation pipe's
`422 {"message":"Validation failed","errors":[{"field":"domain_data.0.domain","code":"domain must be valid domain name"}]}`
(with `state should not be empty` or `state must be one of the following values: pending, verified`
for the state). A `domain_data` list that names a domain twice in any casing is
`422 {"error":"Unprocessable Entity","message":"\`domain_data\` must contain unique domains"}`, and
a public consumer domain — `gmail.com`, `icloud.com`, `outlook.*`and the rest of production's
list, vendored in`src/workos/consumer-domains.ts`— is`422`with`The domain icloud.com is a public consumer domain and cannot be attached to an organization.`;
both are refused before the organization is written, so no `organization.created`or`organization.updated`precedes them. Adding a domain the organization already holds through`POST /organization_domains`is`409 domain_already_exists`. Two organizations may share a
domain: production forbids that only behind its `enforce-unique-organization-domains-in-environment`flag, which the emulator does not model.`external_id`is unique across organizations — reusing
another organization's is`400 external_id_already_used` on create and update.

**`POST /organization_domains/{id}/verify` starts verification; it does not verify.** As in
production it answers `201` with the domain `pending` under `verification_strategy: dns` and a
fresh 25-character `verification_token` (calling it again rotates the token), fires
`organization_domain.updated`, and is `400 domain_already_verified` on a verified domain.
Production then has a cron resolve the TXT record; the emulator resolves no DNS, so the domain
stays pending and no route ever fires `organization_domain.verified`. To get a verified domain,
seed `state: verified` or send `domain_data[].state: verified` on the organization — production
accepts both. On update, a domain resent with a different state is deleted and recreated under a
new id (`organization_domain.deleted`, then `organization_domain.created`), exactly as
production's `recreateExistingDomainsWithDifferentState` does; one resent unchanged keeps its
row, token and all. Verified domains created either way record `verification_strategy: manual`;
pending ones carry no verification fields until `verify` runs. Domains are ASCII: production
never enables its validator's Unicode mode, so `bücher.de` is refused and `xn--bcher-kva.de`
accepted. From Node, flipping a domain in the store —
`getWorkOSStore(store).organizationDomains.update(id, { state: 'verified' })` — fires
`organization_domain.verified`, the one way to exercise that webhook.

Events follow production's write order. `PUT /organizations/{id}` writes the organization first
and emits `organization.updated` from that write — only when a field actually changed, and with
the domains as they stood at that moment — then writes the domains, which report themselves as
`organization_domain.created` and `organization_domain.deleted`. A domain-only update therefore
emits no `organization.updated`, and one that also renames the organization carries the
pre-change domains in that event while the response carries the new ones.

## Organization IT contacts

`/organizations/{id}/it_contacts` is implemented in full — list, create, delete, invite and
revoke:

```bash
curl -X POST http://localhost:4100/organizations/org_01K.../it_contacts \
  -H "Authorization: Bearer sk_test_ci_key" -H "Content-Type: application/json" \
  -d '{"email":"it@acme.com"}'

curl -X POST http://localhost:4100/organizations/org_01K.../it_contacts/it_contact_01K.../invite \
  -H "Authorization: Bearer sk_test_ci_key" -H "Content-Type: application/json" \
  -d '{"intents":["sso","directory_sync"]}'
```

Three production rules are enforced. The address is lowercased before it is stored, and an
email may be an IT contact of a given organization only once — `409 it_contact_already_exists`
otherwise, in any casing — though the same address may serve several organizations. An
organization holds at most 20 contacts; the 21st is `422 too_many_it_contacts`. And an
organization may hold **one active invitation at a time**: inviting _any_ contact while one is
active is `409 it_contact_invitation_already_active`, including the contact who holds it, so
revoke before you resend. Deleting a contact revokes its invitation, and `revoke` clears the
organization's active invitation whichever contact you address it through — no endpoint
reports which contact holds it. The list serves the whole set under null cursors and reads no
query parameters, as production does.

Nothing is emailed. `invite` records the setup link production would have sent, and `revoke`
clears it; neither the link nor the invitation state appears in any response, because the
spec's `it_contact` object documents no such fields and both routes answer `204`.

The spec also documents `403` and `503` on all five routes. Neither is implemented: the
emulator's store is not environment-scoped, so the forbidden case cannot arise, and `503` is a
production infrastructure state. Both can still be injected per-route through the
[error hooks](testing.md#error-hooks) if you need to exercise them.

## Pipes connected accounts

`GET|POST|PUT|DELETE /user_management/users/{id}/connected_accounts/{slug}` serve a user's
[connected accounts](https://workos.com/docs/reference/pipes/connected-account), and
`/organizations/{id}/connected_accounts/{slug}` an organization's. Seed them with
`connectedAccounts`, referencing a user by email (the same join key memberships use) and, for an
org-scoped connection, an organization by name:

```yaml
users:
  - email: alice@acme.com
organizations:
  - name: Acme Corp
connectedAccounts:
  - email: alice@acme.com
    provider: github # the slug requests address
    scopes: [repo, user:email]
  - email: alice@acme.com
    provider: slack
    organization: Acme Corp # scoped to that organization's id
    state: needs_reauthorization # defaults to connected
  - owner: organization # the organization's own account; defaults to user
    organization: Acme Corp # required for an organization-owned account
    provider: google-calendar
    email: alice@acme.com # optional: the member who established it
```

An organization owns one account per provider, apart from any its members hold. It has
`user_id: null`, and `established_by_user_id` is the user `email` names, or `null` without one.

Accounts are keyed by (user, provider, organization scope). `POST` imports an account from
OAuth tokens under exactly that key — an omitted `state` is derived from the token combination
(an expired access token with no refresh token is `needs_reauthorization`) — and answers `409`
for a duplicate. On every other verb `organization_id` is a filter, as in the API: omitted, a
user's lone account for the provider resolves whatever its scope, and several (one provider
installed in two organizations) answer `409` until one is named. `DELETE` disconnects by
removing the account and its stored tokens, so a later import is a fresh `201`. State changes
emit the spec's `pipes.connected_account.connected` / `reauthorization_needed` /
`disconnected` events, including for seeded accounts.

`POST /data-integrations/{slug}/token` (the SDK's `pipes.getAccessToken`) resolves the account
the same way and returns its access token with its scopes and expiry. Missing accounts return
`not_installed`; accounts in `needs_reauthorization` return that. A `connected` account always
yields a token: an imported one is returned verbatim while it is unexpired, and otherwise the
emulator — which never contacts the real provider — mints a `di_mock_…` token in its place: an
expiring one when a refresh token was imported (the emulated refresh), a non-expiring one for
a seeded account, which is never given credentials. An expired token with no refresh token
flips the account to `needs_reauthorization`, emitting its event, as a failed refresh would.
The emulator cannot see a provider revoke a grant, so to exercise a reauthorization flow, set
`state: needs_reauthorization` on the account — on import, with `PUT`, or in the seed — and
reconnect it with a `PUT` carrying the new token.

## Machine-to-Machine (M2M) Applications

Seed M2M Connect Applications so a service has a known `client_id` / client secret pair on
startup — ideal for `docker compose up` style local development where credentials must exist
before any dashboard interaction.

```yaml
organizations:
  - name: Acme Corp

connectApplications:
  - name: Backend Service
    type: m2m # default; use `oauth` for an OAuth app
    organization: Acme Corp # required for m2m; owning org, by name
    scopes: [posts:read, posts:write]
    client_id: client_local_backend # optional; generated if omitted
    client_secret: secret_local_backend # optional; generated if omitted
    audience: https://api.acme.example # optional; the token `aud` claim, defaults to client_id

  - name: Partner App
    type: oauth
    is_first_party: false # optional, oauth only; a third-party app needs `organization`
    organization: Acme Corp
    uses_pkce: true # optional, oauth only; marks a public client: /oauth2/token redeems its codes by PKCE verifier alone
```

Each seeded application is provisioned with a client secret. Pin `client_secret` to bake a known
value into a service's environment; otherwise one is generated. The application is then available
through the full Connect Applications surface:

| Method   | Path                                       | Notes                                                 |
| -------- | ------------------------------------------ | ----------------------------------------------------- |
| `GET`    | `/connect/applications`                    | Filters on `organization_id` and `registration_types` |
| `POST`   | `/connect/applications`                    |                                                       |
| `GET`    | `/connect/applications/:id`                | `:id` is the application ID **or** the client ID      |
| `PUT`    | `/connect/applications/:id`                | `name`, `description`, `scopes`, `redirect_uris`      |
| `DELETE` | `/connect/applications/:id`                | Cascades secrets and in-flight Connect logins         |
| `GET`    | `/connect/applications/:id/client_secrets` | A bare array; never includes the plaintext            |
| `POST`   | `/connect/applications/:id/client_secrets` | The one response carrying the plaintext, as `secret`  |
| `DELETE` | `/connect/client_secrets/:id`              |                                                       |

`registration_types` defaults to `authenticated`, as production does, so an unfiltered list hides the
applications `POST /oauth2/register` created; ask for them with `?registration_types=dynamic`.
A secret's `last_used_at` is stamped when a token exchange actually succeeds, not merely when the
secret is presented.

### Token exchange (`client_credentials`)

A service swaps its seeded `client_id` + `client_secret` for a scoped access token at
`POST /oauth2/token`, exactly as in production:

```bash
curl -s http://localhost:4100/oauth2/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d grant_type=client_credentials \
  -d client_id=client_local_backend \
  -d client_secret=secret_local_backend
# (client credentials may also be sent via HTTP Basic auth)
```

```json
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "scope": "posts:read posts:write"
}
```

The `access_token` is an RS256 JWT signed with the same key the emulator publishes at
`GET /sso/jwks/:client_id` (and `GET /oauth2/jwks`), so a consumer validating with JWKS — e.g.
`jose` — verifies it with no emulator-specific shims. Its claims:

| Claim    | Value                                                  |
| -------- | ------------------------------------------------------ |
| `iss`    | the emulator base URL (e.g. `http://localhost:4100`)   |
| `aud`    | the app's `audience` if set, otherwise the `client_id` |
| `sub`    | the requesting `client_id`                             |
| `jti`    | a unique token identifier (ULID)                       |
| `scope`  | granted scopes, space-delimited                        |
| `org_id` | the application's owning organization                  |

The claim set mirrors a production M2M token, because the SDKs parse it: scopes are a
space-delimited `scope` **string** (not an array, and not `scp`), and `jti` is always present —
the WorkOS SDKs reject an M2M token that lacks it, however well-signed.

> **Set `audience` on the seeded application.** In production `aud` is your environment's client
> ID, which is _not_ the M2M application's `client_id` — and the SDKs default the expected
> audience to the environment client ID. The emulator has no environment-level client ID to fall
> back on, so it uses the requesting `client_id`. Pin `audience` to the value your real WorkOS
> environment emits and a consumer that validates `aud` accepts emulator tokens unchanged.

A request may narrow to a subset of the application's scopes via `-d scope="posts:read"`;
requesting a scope the application does not have returns `400 invalid_scope`, so scope-based
authorization can be exercised locally. Unknown credentials return `401 invalid_client`, and an
`oauth`-type application returns `400 unauthorized_client`.

## Standalone Connect

Bridge your application's own login to Connect with an OAuth application and an emulator-only
`connectApplications[].login_url` (the stand-in for the login page configured in the WorkOS dashboard):

```yaml
connectApplications:
  - name: Standalone App
    type: oauth
    client_id: client_local_standalone
    client_secret: secret_local_standalone
    login_url: http://localhost:3000/login
    redirect_uris: [http://localhost:3000/callback]
    scopes: [profile, email]
```

1. Send the browser to
   `http://localhost:4100/oauth2/authorize?client_id=client_local_standalone&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fcallback&state=my-state`.
   The emulator redirects to `login_url` with a fresh `external_auth_id` valid for ten minutes.
2. Authenticate the user in your application, then call from your backend:

   ```bash
   curl -s http://localhost:4100/authkit/oauth2/complete \
     -H "Authorization: Bearer sk_test_default" \
     -H "Content-Type: application/json" \
     -d '{"external_auth_id":"ext_auth_FROM_LOGIN_URL","user":{"id":"user_12345","email":"marcelina.davis@example.com"}}'
   ```

   This creates or updates the AuthKit user by `external_id = user.id`, marks their email verified,
   emits `user.created` or `user.updated`, and returns `{"redirect_uri":"..."}`. Optional `name`,
   `first_name`, `last_name`, and `metadata` update when supplied; omitted fields are preserved.

3. Redirect the browser to that returned URL (`GET /oauth2/authorize/complete`). It is single-use
   and redirects to the original client callback with `code` and the original `state`.
4. Exchange the code at `POST /oauth2/token` with `grant_type=authorization_code`, `code`, the exact
   original `redirect_uri`, `client_id`, and `client_secret` (form-encoded or JSON; Basic credentials
   also work). Codes expire after ten minutes and are consumed on exchange. The response contains
   an access token, `token_type`, `expires_in`, and `scope`. Its JWT `sub` is the AuthKit user ID;
   `aud` is the application's `audience`, falling back to its `client_id`.

Reusing a completed ID returns `400 external_auth_session_already_completed`; unknown or expired IDs
return `404 external_auth_not_found`. Missing required fields return `422`, malformed email returns `400 invalid_email`,
and an email owned by another user returns `400 email_not_available` (including on updates). A failed
validation does not consume the session. Browser redemption of an incomplete or already redeemed ID
returns `404`.

`login_url` can also be set on `POST /connect/applications`, but is not included in API application
responses. Both browser destinations must pass the emulator's redirect-host policy (localhost by
default; configure `--redirect-hosts` for other hosts). When `redirect_uris` is non-empty, the callback
must also match an entry exactly.

**Deliberate limitations:** no PKCE, refresh tokens, ID tokens, or consent UI. `user_consent_options`
is ignored; the `email_change_not_allowed` policy is not modeled. The authorize request's `scope`
is not tracked: tokens default to the application's configured scopes, optionally narrowed by `scope`
at token exchange. The emulator's completion URL uses `/oauth2/authorize/complete?external_auth_id=...`,
not production's AuthKit-domain `/oauth/authorize/complete?state=...`; always follow the returned URL
rather than constructing it. This is a local testing flow, not a replacement authentication service.

## AuthKit OAuth server (MCP clients)

An MCP client (Claude Code and the like) signs in to a WorkOS environment through its **AuthKit
domain**, which acts as an OAuth 2.1 authorization server. The emulator reproduces that flow on its
single origin, so an MCP resource server can be tested against it locally:

1. **Discovery.** `GET /.well-known/oauth-authorization-server` and
   `GET /.well-known/openid-configuration`, unauthenticated, with the field sets a production
   AuthKit domain serves. Endpoint URLs follow the host the document was fetched over; `issuer` is
   the configured bare issuer (`--issuer`, default the emulator's own URL). There is no RFC 8414
   path-inserted form, because the issuer has no path. Only what the emulator implements is
   advertised: production's `device_authorization_endpoint`, `introspection_endpoint`,
   `userinfo_endpoint` and `client_id_metadata_document_supported` are **omitted, not stubbed**, so
   a client never follows discovery into a 404.
2. **Registration.** `POST /oauth2/register` (RFC 7591), unauthenticated. It creates a real Connect
   `oauth` application: third-party, `was_dynamically_registered`, listed under
   `registration_types=dynamic`. `client_name` is required, as production requires it.
   `application_type` is `web` or `native` (default `web`) and is echoed back.
   `token_endpoint_auth_method: none` makes a public client (PKCE only, no secret); anything else a
   confidential one with a generated `client_secret`; omitted, it is `none` for
   `application_type: native` and `client_secret_basic` otherwise, as in production. The
   `grant_types` (default `["authorization_code"]`) and `token_endpoint_auth_method` a client
   registers are stored and echoed, as production stores them, but neither is enforced at
   `/oauth2/token`: production reads neither there, so a refresh token is issued by the scope rule
   in step 4 and a confidential client may send its secret in the body or as Basic either way.
   `scope` follows production's registration: a scope the client cannot be granted is **dropped,
   not refused**, and the effective scope is echoed back (only when one was requested, and as an
   empty string when nothing survived). The grantable scopes are the standard four,
   `openid profile email offline_access`; production also grants an environment's
   dynamic-registration permissions, which the emulator does not model, so a custom scope is
   always dropped. A registered application has no scopes of its own (`scopes: []`), as production
   serves that field from assigned permissions. The response carries the resolved
   `application_type`, `grant_types`, `response_types` and `token_endpoint_auth_method`. `logo_uri`,
   `client_uri`, `policy_uri` and `tos_uri` must be http(s) URLs. `redirect_uris` go through the
   [redirect-host policy](tokens.md#redirect-uri-hosts).
3. **Authorize.** `GET /oauth2/authorize` on an application with no `login_url` validates the
   request, then redirects to the hosted AuthKit sign-in, the page `/user_management/authorize`
   serves. With `--interactive` that is the login page; without it the sign-in completes at once,
   with the first user or the one named by `login_hint`, as non-interactive `/user_management/authorize`
   does. **There is no consent step**: the first user (or `login_hint`) is signed in and authorized
   without a prompt. Accepted: `code_challenge` with `code_challenge_method=S256` (the only method),
   `state`, `scope`, RFC 8707 `resource`, plus `login_hint` and `organization_id`. Failures never
   come back as an API error body, as in production. Until the client and its callback are
   validated they redirect to `/oauth2/error?error=…`: `invalid_query_params` when `client_id` or
   `redirect_uri` is missing, `application_not_found` for an unknown client (observed against a
   production AuthKit domain, 2026-09-30), `invalid_redirect_uri` for a callback the client did not
   register or the host policy refuses. After that they come back on the callback as
   `error`/`error_description`/`state`: `unsupported_response_type`, `invalid_request` for a
   missing `response_type` or an unknown `code_challenge_method`, `unauthorized_client` for an
   application without the authorization-code grant, `invalid_scope`, `invalid_target`, with a
   description only where production gives one. The error page is `200 text/html` and reflects the
   `error_description` it is given, escaped. PKCE is taken as production takes it: a
   `code_challenge` must name its method (`invalid_request`, "code_challenge_method is required
   when code_challenge is provided."), a method without a challenge is ignored, nothing is checked
   about the challenge's shape, and **a public client is not refused here for omitting PKCE**; that
   is the token endpoint's question. `scope`: the standard four are open to every OAuth
   application, a custom scope must be one of the application's own, and an **omitted `scope`
   grants nothing** (a token with no `scope` claim), not everything. Applications with a
   `login_url` keep the [Standalone Connect](#standalone-connect) behavior.
4. **Token.** `POST /oauth2/token`. Client authentication follows production's token-endpoint
   guards: the body's `client_id` wins outright when present (the Authorization header is then not
   read), else the Basic header is decoded and split on the first `:`. A client is only public or
   confidential, whatever method it registered. Failures are `401 invalid_client` with
   `WWW-Authenticate: Basic realm="AuthKit"`: "Missing authorization header." with neither
   (observed against a production AuthKit domain, 2026-09-30), "Missing client_id." for an empty
   Basic id, "Application not found." for an unknown `client_id` or a wrong secret (production looks
   the pair up together), "Missing client_secret." for a confidential client without one, and
   "Unsupported client_secret." for a public client with one; a public client asking for
   `client_credentials` is `400 unauthorized_client`. These run before the body is validated, so an
   unknown client is refused the same way under every grant type; then an unknown grant is
   `unsupported_grant_type` and a body missing a required field `invalid_request` "Invalid token
   request body.". With `authorization_code`, a public client authenticates by its `code_verifier`
   alone, a confidential one by its secret plus the verifier when the code carries a challenge, and
   a public client whose code carries no challenge is refused. Every failure of the code itself
   (unknown, expired, wrong `redirect_uri`, another client's, a wrong or missing verifier) is the
   bare `{"error":"invalid_grant"}` production returns, and **none of them spends the code**: the
   verifier is checked before the exchange, so a wrong one leaves the code for a retry, and the
   verifier's shape is not checked. The response is production's: `access_token`, `token_type`
   (`bearer`, lowercase), `expires_in`, an `id_token` whatever the scope (production mints one
   unconditionally), and `refresh_token` by production's rule: when the grant carries
   `offline_access`, or when a dynamically registered client did not ask for `openid`; otherwise
   none. There is no `scope` on a code exchange, and a `scope` parameter on it is ignored.
   `grant_type=refresh_token` answers with `access_token`, `expires_in`, `id_token`,
   `refresh_token`, `scope` (absent when none) and `token_type`; a public client's token is rotated
   (the old one is spent) and a confidential client keeps the one it presented, as OAuth 2.1 §6.1
   lets production. A `scope` on refresh narrows that token alone, to the requested scopes the
   grant covers; the grant is unchanged, and only a request that leaves nothing is `invalid_scope`.
   A refresh token minted by `/user_management/authenticate` is `400 unauthorized_client` pointing
   at that endpoint; every other refresh failure is the bare `invalid_grant`. An
   `authorization_code` request from an M2M application, or a `client_credentials` request from an
   OAuth application, is `401 invalid_client` without the Basic challenge. Token responses carry
   `Cache-Control: no-store` and `Pragma: no-cache`. `client_credentials` keeps its behavior and
   claims, with `token_type` `bearer`, a sorted `scope` omitted when none was issued, and the
   client errors above rather than the earlier `400 invalid_request` / `401 Invalid client ID or
   secret.`.
5. **Claims.** The access token carries what production's consent token service mints: `iss` (the
   bare issuer, signed by the key at `/oauth2/jwks`), `aud` (step 6), `sub` (the user id), `sid`,
   `jti`, `client_id`, `org_id` when the session has an organization, `auth_time` (when the
   sign-in happened), `exp`, `iat`, and a sorted space-delimited `scope` that is absent rather than
   empty. Production can add the environment's JWT template claims on top; the emulator does not,
   and the token carries no `email`.
6. **Resource indicators.** Declare the resource servers your environment registers, by seed or
   through the API (`POST/GET /user_management/authkit_oauth_resources`, `DELETE …/:id`). The rules
   are production's. At `/oauth2/authorize`, a dynamically registered client's `resource` is
   validated once any resource is registered: a malformed value or one matching no registered
   resource is `invalid_target` on the callback; with none registered the parameter is ignored. A
   dynamically registered client bound to nothing (it named no `resource`, or none is registered)
   is bound to the resource flagged `default`, when there is one. Other clients' `resource` is
   ignored at authorize, as production ignores it without a feature flag. At `/oauth2/token`, a
   bound grant may restate or omit its resource and nothing else (a bound resource since deleted is
   `invalid_target`); a grant bound to none may name a registered resource and have that token
   minted for it, an unregistered one is `invalid_target`, and with no resources registered the
   parameter is ignored. Resources are matched by normalized URL, as production matches them, and
   the token carries the URI as registered. A bound resource is the token's `aud` and is carried
   across every refresh. With none, production's `aud` is the environment's own client id, which
   the emulator has no equivalent of: it falls back to the application's `audience`, then its
   `client_id`. That fallback is the one deviation on this claim.

```yaml
resourceIndicators:
  - uri: https://mcp.example.test/mcp
users:
  - email: alice@acme.test
```

```bash
BASE=http://localhost:4100
curl -s $BASE/.well-known/oauth-authorization-server

# Register a public client
CLIENT_ID=$(curl -s $BASE/oauth2/register -H 'Content-Type: application/json' \
  -d '{"client_name":"demo","redirect_uris":["http://localhost:33418/callback"],"token_endpoint_auth_method":"none"}' \
  | jq -r .client_id)

# PKCE pair
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/' | cut -c1-64)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')

# Authorize: two redirects (hosted sign-in, then your callback carrying ?code=…)
curl -si "$BASE/oauth2/authorize?response_type=code&client_id=$CLIENT_ID&redirect_uri=http%3A%2F%2Flocalhost%3A33418%2Fcallback&code_challenge=$CHALLENGE&code_challenge_method=S256&state=s1&scope=openid%20offline_access&resource=https%3A%2F%2Fmcp.example.test%2Fmcp&login_hint=alice%40acme.test" | grep -i '^location'
# curl -si "<that location>" | grep -i '^location'   ->  http://localhost:33418/callback?code=auth_code_…&state=s1

curl -s $BASE/oauth2/token -d grant_type=authorization_code -d client_id=$CLIENT_ID \
  -d code=auth_code_… -d redirect_uri=http://localhost:33418/callback -d code_verifier=$VERIFIER
curl -s $BASE/oauth2/token -d grant_type=refresh_token -d client_id=$CLIENT_ID -d refresh_token=ref_…
```

**`id_token`.** Every code exchange and every refresh carries an RS256 `id_token`, whatever the
scope, because production mints one unconditionally. It is signed with the key at `/oauth2/jwks`
and carries production's claims: `iss` (the bare issuer), `sub`, `aud` (the `client_id`), `exp`,
`iat`, and `nonce` when the authorize request sent one (a refresh carries none). With the `profile`
scope: `name`, composed from the user's first and last names (so an empty string when there are
none), and `given_name` and `family_name` where each exists. With the `email` scope: `email` and
`email_verified`. Production can add the environment's JWT template claims; the emulator does not.

**Grant lifetime.** Each refresh re-checks the grant: it is refused with `invalid_grant` when the
session has expired or been revoked, or when the organization the token was scoped to is no longer
one the user is an active member of (the code exchange makes the same membership check). A refresh
token never outlives its session. Deleting an application also removes its refresh tokens and any
sign-in request it had parked. Those rules are emulator choices, not observed production behavior.
Scopes follow production: a custom scope removed from the application with
`PUT /connect/applications/:id` stops being issued at exchange and at refresh, the standard four
are not application scopes and are unaffected, and a grant left with no scope issues a token with
no `scope` claim rather than being refused.

**Assumptions and gaps.** Not implemented: Client ID Metadata Documents, the device grant on this
surface, token introspection, `userinfo`, environment-level permissions for dynamically registered
clients, and the environment's own client id as a fallback `aud`. A registration must include
`authorization_code` in `grant_types` (an emulator rule: `response_types` is always `code`), and
`response_types` is `["code"]` or omitted. The registered resource is matched by normalized URL,
without wildcards. A seeded application with an empty `redirect_uris` accepts any allowed redirect
host, as Standalone Connect does; a dynamically registered one is matched exactly.

## Client API tokens

`POST /client/token` mints the short-lived token the Client GraphQL API expects, scoped to an
organization and a user:

```bash
curl -X POST http://localhost:4100/client/token \
  -H "Authorization: Bearer sk_test_ci_key" -H "Content-Type: application/json" \
  -d '{"organization_id":"org_01K...","user_id":"user_01K..."}'
```

Unknown ids return `404`. The token is signed with the emulator key, so it verifies against
`/sso/jwks`, and carries `sub`, `org_id`, and `aud: client` with a five-minute expiry. The spec
documents only the `{ token }` response, so those claims are an emulator convention — and the
emulator does not serve the Client GraphQL API itself, so nothing consumes the token.

## API Keys

Seed organization- or user-owned API keys. Each seeded key is created as an `api_key` resource
**and** registered in the auth allow-list, so the value authenticates requests to the emulator.

```yaml
organizations:
  - name: Acme Corp

apiKeys:
  - name: CI Key
    organization: Acme Corp # owner org, by name (or use `user_id`)
    value: sk_test_ci_key # optional; must start with `sk_` and be unique; generated if omitted
    permissions: [posts:read, posts:write]
    # expires_at: 2030-01-01T00:00:00.000Z   # optional; never expires if omitted
```

```bash
# The seeded value authenticates requests:
curl http://localhost:4100/connect/applications -H "Authorization: Bearer sk_test_ci_key"
```

Validate a key the way the SDKs do — `POST /api_keys/validations` with the key in `value`:

```bash
curl -X POST http://localhost:4100/api_keys/validations \
  -H "Authorization: Bearer sk_test_ci_key" -H "Content-Type: application/json" \
  -d '{"value":"sk_test_ci_key"}'
```

```json
{
  "api_key": {
    "object": "api_key",
    "id": "api_key_01K...",
    "name": "CI Key",
    "owner": { "type": "organization", "id": "org_01K..." },
    "obfuscated_value": "sk_..._key",
    "permissions": ["posts:read", "posts:write"],
    "last_used_at": null,
    "expires_at": null,
    "created_at": "2026-01-15T12:00:00.000Z",
    "updated_at": "2026-01-15T12:00:00.000Z"
  }
}
```

A valid key returns the whole `api_key` object — `permissions` included, so permission-based
authorization can be exercised locally. An invalid, expired, or unknown key is `200` with
`{"api_key": null}`, not an error — matching production and what the SDKs read. The raw value is
never echoed back; only `obfuscated_value`.

The `organization` (or the org supplied via `user_id`) must reference a seeded organization;
an unresolved name fails fast at startup. A key seeded with an already-past `expires_at` is still
created as a resource but does **not** authenticate, and deleting a key via `DELETE /api_keys/:id`
stops it authenticating immediately — matching production.

`apiKeys` also accepts the legacy auth allow-list map form (`{ sk_xxx: { environment } }`), which
only registers values for authentication without creating resources. A map-form value authenticates
requests but has no `api_key` resource behind it, so validating one returns `{"api_key": null}` —
use the array form for keys your code validates.

## Directory Sync

Production connects a directory through the dashboard or Admin Portal — there is no
create-directory endpoint — so the `directories` seed key is how one comes into existence at
all. A directory joins its organization by name, the same way `connections` do, and its users
join the directory's own groups by name.

```yaml
organizations:
  - name: Acme Corp

directories:
  - name: Acme Okta
    organization: Acme Corp
    type: okta scim v2.0
    domain: acme.com
    groups:
      # Object form maps the group to an organization role, the way a directory's role
      # assignments do in the dashboard. A bare string declares a group with no mapping.
      - name: Admins
        role: admin
      - name: Engineering
        role: member
      - Contractors
    users:
      - email: dev@acme.com
        first_name: Dev
        last_name: Eloper
        groups:
          - Engineering
```

A user in several mapped groups takes the first in declaration order, the emulator's
stand-in for the dashboard's role-assignment priority; a user's own `role` overrides the
mapping. The resolved role is set on the directory user and, where `users` and
`memberships` already put that person in the organization, on their organization
membership — which is what an app reads, and where production puts it too.

A membership matching a seeded directory user reports `directory_managed: true`, whether or
not a role mapped.

An organization holds one directory, as it does in production (a second one is
`directory_already_exists_for_organization` there); a seed that declares two for one
organization fails the boot, naming the organization and both directories.

`DELETE /directories/:id` clears `directory_managed` on every membership the directory
claimed. A membership no directory ever claimed is left alone, so an application-owned
membership survives the directory being deleted.

Seeding a directory creates no AuthKit user and no organization membership: seed `users`
and `memberships` for those.

`state` defaults to `linked` and `type` to `generic scim v2.0`. Seeding emits `dsync.activated`
for a `linked` directory, plus `dsync.group.created` and `dsync.user.created`, all queryable at
`GET /events`. They are not delivered to a seeded webhook endpoint, which registers after them —
as with every other seeded resource. `DELETE /directories/:id` emits `dsync.deleted`, which is
delivered.

## Feature Flags

Production has no create-flag endpoint — flags are made in the dashboard — so the `featureFlags`
seed key is how a flag comes into existence at all. Targets join to `users` by email and to
`organizations` by name, the same way memberships do; an entry naming neither fails at startup.

```yaml
users:
  - email: alice@acme.com
    password: test123
    email_verified: true
  - email: bob@acme.com
    password: test123
    email_verified: true

organizations:
  - name: Acme Corp
    memberships:
      - email: alice@acme.com
      - email: bob@acme.com
  - name: Other Inc

featureFlags:
  # On for everyone: nothing matches a target, so default_value decides.
  - slug: new-billing
    name: New Billing
    default_value: true

  # Off by default, on for exactly the listed targets.
  - slug: beta-dashboard
    name: Beta Dashboard
    description: The rebuilt analytics dashboard
    tags: [ui, beta]
    owner:
      email: jane@acme.com
      first_name: Jane
      last_name: Doe
    targets:
      users: [alice@acme.com]
      organizations: [Acme Corp]

  # Targeted at an organization Alice is not a member of.
  - slug: partner-portal
    targets:
      organizations: [Other Inc]

  # Built but not switched on in this environment: off for everyone, targets included.
  - slug: unreleased
    id: flag_01PINNEDUNRELEASED
    enabled: false
    default_value: true
    targets:
      users: [alice@acme.com]
```

Signing Alice in against that config gives `feature_flags: ["new-billing", "beta-dashboard"]`;
Bob gets `["new-billing", "beta-dashboard"]` too via Acme Corp, but would lose `beta-dashboard`
if the organization target were removed. `partner-portal` is off for both, and `unreleased` is
off for everyone until something enables it.

A flag is on for a resource when it is `enabled` **and** either a target names that resource or
`default_value` is true. Targeting is additive, as it is in production: `POST
/feature-flags/{slug}/targets/{resourceId}` carries no body, so a target can turn a flag on but
never off. Flags also accept an optional `id` to pin (`flag_01ABC…`). Slugs must be URL-safe, since
every route addresses a flag by slug in the path.

Three surfaces read the result, and all three resolve through the same rule:

- **The `feature_flags` access-token claim** — the slugs on for the signed-in user, re-resolved at
  every mint (refresh grants included), so a toggle lands in the next token. Scoped to the
  session's organization: a flag targeted at some _other_ org the user belongs to is not in the
  claim. Omitted rather than minted as `[]` when nothing is on.
- **The list endpoints an SDK polls** — `GET /user_management/users/{id}/feature-flags` and
  `GET /organizations/{id}/feature-flags`. Both return a paginated list of whole `feature_flag`
  objects, and both list only the flags that are on. The user endpoint includes flags from every
  organization the user is an _active_ member of, as production documents — a `pending` or
  `inactive` membership grants nothing, matching the status check `authenticate` applies before
  scoping a session to an organization.

```ts
const { data } = await workos.featureFlags.listUserFeatureFlags({ userId: user.id });
const enabled = new Set(data.map((flag) => flag.slug));
// ...or the organization-scoped equivalent
await workos.featureFlags.listOrganizationFeatureFlags({ organizationId: org.id });
```

- **The SDK runtime client** — `workos.featureFlags.createRuntimeClient()` does not use either
  list endpoint. It polls `GET /sdk/feature-flags`, which is **not in the WorkOS OpenAPI spec**;
  the emulator implements it anyway, because without it the runtime client never leaves its
  bootstrap state. The response is a bare slug-keyed map of every flag and its targets, and the
  client evaluates locally, so `isEnabled` answers without a round trip:

```ts
const flags = workos.featureFlags.createRuntimeClient({ pollingIntervalMs: 5_000 });
await flags.waitUntilReady();
flags.isEnabled('beta-dashboard', { userId: user.id, organizationId: org.id });
flags.on('change', ({ key, current }) => console.log(key, current));
```

All three apply the same rule — a disabled flag is off for everyone; otherwise a matching enabled
target wins; otherwise `default_value` — so for one resource they agree. They are scoped
differently on purpose, and that is the one case where they legitimately differ: the token claim
covers the user plus the session's organization, while the user list endpoint covers the user plus
_every_ organization they are an active member of. A user in two organizations can therefore have a flag in the
list endpoint that is absent from a token scoped to the other organization. Production scopes them
the same way.

Toggling at runtime works too. The verbs match the spec: `PUT /feature-flags/{slug}/enable` and
`/disable`, `POST /feature-flags/{slug}/targets/{resourceId}` and its `DELETE`. The emulator also
accepts `POST` on enable/disable and `PUT` on target creation, for callers written against its
earlier shape — those aliases are **emulator-only**, and production rejects them, so do not rely
on them in code you intend to run against real WorkOS. Changes emit `flag.updated`; adding or
removing a target emits `flag.rule_updated`, carrying the flag's `access_type`, its configured
targets, and the previous rule state.

`flag.rule_updated` names the API key that made the request as its `actor` when that key has a
record behind it (an array-form `apiKeys` entry, or a key created over the API); a map-form key
authenticates but has no record, so the actor falls back to the emulator's placeholder key. The
collection-level `flag.created` / `flag.updated` / `flag.deleted` events run without request
context and always report the placeholder. Flags are not environment-scoped, so every flag event
reports `environment_test`. Deleting a user or organization removes its flag targets.

## Agent Auth

Agent blueprints, the tokens minted from them, and the resulting instances and sessions are all
implemented (`/agents/blueprints`, `/agents/instances`, `/agents/sessions`). Blueprints can be
created over the API or seeded; instances and sessions only ever come into being by minting.
`permissions` and `invocable_by.role_slugs` name seeded `permissions` and `roles` by slug, and
`invocable_by.organizations` names `organizations` by name, the same join feature-flag targets use.
A seeded blueprint is validated the way `POST /agents/blueprints` validates a body: `description`
is a non-empty string or omitted, and `session_settings` is either omitted (production's 3600 /
300 / 3600 second defaults) or given with all three values.

```yaml
permissions:
  - slug: crm:read
    name: Read CRM
  - slug: email:send
    name: Send email

roles:
  - slug: manager
    name: Manager
    permissions: [crm:read, email:send]
  - slug: member
    name: Member
    permissions: [crm:read]

organizations:
  - name: Acme Corp
    memberships:
      - email: alice@acme.com
        role: manager

agentBlueprints:
  - name: Prospecting Agent
    description: Finds and qualifies sales prospects.
    permissions: [crm:read, email:send]
    invocable_by:
      role_slugs: [manager]
      organizations: [Acme Corp]
    session_settings:
      max_age_seconds: 3600
      access_token_ttl_seconds: 300
      refresh_token_ttl_seconds: 3600
```

`POST /agents/blueprints/{id}/tokens` accepts the four grant types production does:

- **`user_delegated`** takes a user access token minted by the emulator (any `authenticate` or
  `/oauth2/token` grant). The token only identifies the user and organization: the session behind
  its `sid` must still be live, the user must be an active member of the organization, the
  organization and the member's role must be allowed by `invocable_by`, and the login must be
  younger than `max_age_seconds`. The granted permissions are the blueprint's `permissions`
  intersected with what the member's role currently grants — recomputed at every mint and refresh,
  so a role change lands in the next token.
- **`autonomous`** takes an `organization_id` and grants the whole blueprint ceiling.
- **`agent_delegated`** exchanges an agent access token for a new session on the same instance.
  Chains are self-only (a token from another blueprint is `invalid_agent_access_token`), at most 32
  deep, and anchored at the root: no hop may outlive the root session's `created_at +
  max_age_seconds`.
- **`refresh`** rotates the refresh token. Each is single-use, and a refresh never extends the
  session past its chain root's max-age window.

Access tokens are RS256 JWTs signed with the emulator key and `typ: at+jwt`, so the same JWKS a
backend already uses for user tokens validates them. Claims follow production: `sub` is the agent
instance id, `sub_profile: ai_agent`, `sid` is the session id, plus `org_id`, `permissions`,
`intent: { text }` when supplied, `act: { sub: <user id>, sub_profile: user }` for delegated
sessions, and `auth_time` from the delegating login. `aud` is the `workos-emulate` placeholder,
since nothing at the API-key-authenticated token endpoint names a client.
`POST .../tokens/validate` checks the signature, the session (revoked, expired, or torn down), and
for delegated chains that the backing user session is still live.

Revoking a session (`POST /agents/sessions/{id}/revoke`, or revoking or logging out of the user
session it was delegated from) cascades to every session chained from it. Deleting an instance
revokes its live sessions first, and deleting a blueprint tears down its instances. The resources
agents hang off cascade the same way: deleting an organization tears down every instance in it,
deleting a membership or its user tears down the instances delegated from it, deactivating a
membership revokes their sessions (the instance survives for a reactivation), and deleting a
permission removes it from every blueprint ceiling that named it. Session `status` is derived at
read time from `revoked_at` and `expires_at`; revoking touches only live sessions, so an
already-expired one stays `expired` with a null `revoked_at` while its live descendants are
still revoked. The seven `agent.*` events fire through the same webhook and `/events` plumbing
as everything else.

Errors use production's stable codes: `invalid_request` (400) for a malformed body;
`permission_not_found`, `role_not_found`, `organization_not_found` (422) and `name_already_in_use`
(409) on blueprint create and update; and at mint time `invalid_user_access_token`,
`invalid_agent_access_token`, `invalid_refresh_token`, `session_revoked`, `session_expired`,
`user_session_ended`, `max_age_exceeded`, `chain_depth_exceeded` (400) and
`user_not_member_of_organization`, `organization_not_invocable`, `role_not_invocable` (403).

Agent Registration (`/agents/registrations`, claim attempts, credential validation) is not
implemented.

## Audit Logs

`POST /audit_logs/events` takes production's ingestion body — `organization_id` beside an `event`
whose `action` is the bare action name — and answers `200 {"success": true}`, which is all
production answers. The event is stored, but no endpoint reads it back: production has none
either, exports being its read path.

```json
{
  "organization_id": "org_01HXYZ",
  "event": {
    "action": "user.signed_in",
    "occurred_at": "2026-02-02T16:35:39.317Z",
    "actor": { "id": "user_123", "type": "user", "name": "Jon Smith" },
    "targets": [{ "id": "team_456", "type": "team" }],
    "context": { "location": "1.1.1.1", "user_agent": "Chrome/104.0.0.0" },
    "metadata": { "plan": "enterprise" }
  }
}
```

An `Idempotency-Key` header dedupes a retried request the way production does: the key is paired
with a hash of the event, so a replay with the same key and body stores nothing new, while the
same key on a different body is a different event. The Node SDK sends a fresh key on every
`createEvent` call, so only its own retries collide.

Rejections carry production's bodies. A body that does not fit the DTO is a 422
`{"message": "Validation failed", "errors": [...]}` with one entry per failing field, named by its
dotted path and class-validator's message — `{"field": "event.targets.0.id", "code": "id must be a
string"}` — and no top-level `code`. An `organization_id` the emulator does not have is a 404
`{"message": "Organization not found: 'org_x'.", "code": "entity_not_found", "entity_id": "org_x"}`.
An `occurred_at` before `2018-10-01T00:00:00.000Z` or more than 24 hours ahead is a 400
`invalid_audit_log`: production's partitioned storage holds nothing outside that window and
refuses the event rather than acknowledge one it would lose.

What is not modeled: production checks every event against the schema registered for its action
in the dashboard — the action must exist at that `version`, the target types must match, metadata
keys and values are constrained — and 400s with `invalid_audit_log` when it does not. The emulator
keeps no registry (`POST /audit_logs/actions/{name}/schemas` records a schema, but nothing consults
it), so any action, target type and metadata are accepted. The audit log trail is always enabled.
Exports resolve to a placeholder URL rather than a CSV of the stored events.

## Complete example

A seed that exercises most keys at once, with the join rules spelled out in comments:

```yaml
users:
  - email: admin@acme.com
    first_name: Admin
    last_name: User
    password: admin123
    email_verified: true

  - email: employee@acme.com
    first_name: Regular
    last_name: Employee
    password: employee123
    email_verified: true

organizations:
  - name: Acme Corp
    external_id: acme_corp_123
    domains:
      - domain: acme.com
        state: verified
    memberships:
      # Reference users by the email declared in `users` above — user ids are
      # generated at startup, so memberships are joined by email. One person gets
      # one membership per organization that is not `inactive`, the same rule
      # POST /user_management/organization_memberships keeps: a create for a user who
      # already holds an active one answers with that membership.
      - email: admin@acme.com
        role: admin
        status: active
      - email: employee@acme.com
        role: member
        status: active
    groups:
      # Groups belong to this org; members reference a membership by the same
      # email join key `memberships` use above.
      - name: Engineering
        description: The engineering team
        members: [employee@acme.com]

roles:
  - slug: admin
    name: Administrator
    description: Full access to all resources
    permissions: [users:read, users:write, organizations:read, organizations:write]

  - slug: member
    name: Member
    description: Standard access
    permissions: [users:read, organizations:read]

permissions:
  - slug: users:read
    name: Read Users
  - slug: users:write
    name: Write Users
  - slug: organizations:read
    name: Read Organizations
  - slug: organizations:write
    name: Write Organizations

connections:
  # One SSO connection per organization, as production allows; a second one fails the boot.
  # OAuth connections (GoogleOAuth, MicrosoftOAuth, ...) are exempt, as they are in production.
  - name: Acme SSO
    connection_type: GenericSAML
    organization: Acme Corp
    # Defaults to active: a seed stands for a connection verified before the suite began.
    # `POST /connections` starts one `validating` instead, as production does.
    state: active
    # Seed-only: the create endpoint has no `domains` field, and ignores one.
    domains: [acme.com]
    profiles:
      - email: admin@acme.com
        first_name: Admin
        last_name: User
        # The profile's full name is its own attribute, as in production, where it is set only
        # when the connection maps one. Omit it and the profile reports `name: null` — it is
        # never composed from first_name and last_name.
        name: Admin User
        groups: [admins, it_staff]
      - email: employee@acme.com
        first_name: Regular
        last_name: Employee
        groups: [employees]

sessionSettings:
  access_token_ttl_seconds: 60 # short enough for a test to watch a token expire

webhookEndpoints:
  - endpoint_url: http://localhost:5000/webhooks
    events: []
    status: enabled
```
