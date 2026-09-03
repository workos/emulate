# WorkOS Emulate

Local WorkOS API emulator for tests and development.

**[Which features are supported?](SUPPORTED.md)** — a per-feature matrix of endpoint coverage and
how data gets in, regenerated from the spec and the routes on every build.

## Installation

### Homebrew (macOS and Linux)

```bash
brew install workos/tap/workos-emulate
```

### Direct binary download

Self-contained executables for supported macOS, Linux, and Windows targets are attached to each
[GitHub release](https://github.com/workos/emulate/releases) — no Node, npm, or Bun required. Intel
and x64 builds use Bun's baseline target for compatibility with older CPUs.

```bash
# macOS (Apple Silicon)
curl -fsSL -o workos-emulate https://github.com/workos/emulate/releases/latest/download/workos-emulate-darwin-arm64
chmod +x workos-emulate

# macOS (Intel)
curl -fsSL -o workos-emulate https://github.com/workos/emulate/releases/latest/download/workos-emulate-darwin-x64
chmod +x workos-emulate

# Linux with glibc (x64)
curl -fsSL -o workos-emulate https://github.com/workos/emulate/releases/latest/download/workos-emulate-linux-x64
chmod +x workos-emulate

# Linux with glibc (arm64)
curl -fsSL -o workos-emulate https://github.com/workos/emulate/releases/latest/download/workos-emulate-linux-arm64
chmod +x workos-emulate

# Alpine Linux / musl (x64)
curl -fsSL -o workos-emulate https://github.com/workos/emulate/releases/latest/download/workos-emulate-linux-x64-musl
chmod +x workos-emulate

# Alpine Linux / musl (arm64)
curl -fsSL -o workos-emulate https://github.com/workos/emulate/releases/latest/download/workos-emulate-linux-arm64-musl
chmod +x workos-emulate
```

On Windows, download `workos-emulate-windows-x64.exe` or `workos-emulate-windows-arm64.exe` from
the [latest release](https://github.com/workos/emulate/releases/latest) and run it directly (there
is no Homebrew path for Windows).

Each release also ships a `checksums.txt` with the SHA-256 of every binary.

### npm

For JavaScript projects (or one-off runs via npx):

```bash
npm install --save-dev @workos/emulate

# or run without installing
npx @workos/emulate
```

### Docker

A container image is published to the GitHub Container Registry with each release.
Stable releases are tagged `:latest` and `:<version>`; prereleases are tagged `:beta`
and `:<version>`.

```bash
docker run --rm -p 4100:4100 ghcr.io/workos/emulate
```

With `docker-compose.yml`:

```yaml
services:
  workos-emulate:
    image: ghcr.io/workos/emulate:latest
    ports:
      - '4100:4100'
    # Mount a seed config file (optional)
    volumes:
      - ./workos-emulate.config.yaml:/app/workos-emulate.config.yaml:ro
```

The image binds to `0.0.0.0` so the emulator is reachable from the host or other
containers. The seed config is auto-detected from the working directory (`/app`);
mount it at `/app/workos-emulate.config.yaml` (or `.yml` / `.json`).

## CLI

```bash
workos-emulate
workos-emulate --port 9100 --json
workos-emulate --seed workos-emulate.config.yaml
workos-emulate --interactive          # serve login pages for E2E browser testing
workos-emulate --signing-key ci-key.pem --issuer https://api.workos.com  # stable JWKS and iss
workos-emulate --redirect-hosts app.example.test  # allow a non-localhost redirect_uri
workos-emulate --version
```

The emulator defaults to `http://localhost:4100` and the API key `sk_test_default`.
Use `GET /health` for readiness checks.

In an interactive terminal, the CLI checks for new stable releases without delaying startup. npm
installations follow the npm registry; Homebrew and direct-download installations follow GitHub
Releases after their checksums are available. Set `NO_UPDATE_NOTIFIER=1` or
`WORKOS_EMULATE_DISABLE_UPDATE_CHECK=1` to disable the check. JSON output, CI, and non-interactive
invocations never perform it.

## Using from Any Language

The emulator is a plain HTTP server, so any language can use it — just point your WorkOS SDK's base URL at the emulator instead of `https://api.workos.com`.

Start the emulator in the background (or in a separate terminal):

```bash
workos-emulate --port 4100 --seed workos-emulate.config.yaml
```

### Python

```python
import workos

workos.api_key = "sk_test_default"
workos.base_url = "http://localhost:4100"  # ← emulator

# Use the SDK as normal — requests hit the emulator
user = workos.client.user_management.create_user(email="alice@example.com")

# Add an error hook at runtime to test failure handling
import requests

requests.post("http://localhost:4100/_emulate/hooks", json={
    "method": "POST",
    "path": "/user_management/users",
    "status": 422,
    "body": {"message": "Validation failed", "code": "unprocessable_entity"},
})

# Now this call returns a 422 — test your error handling
try:
    workos.client.user_management.create_user(email="bob@example.com")
except Exception as e:
    print(f"Handled error: {e}")
```

### PHP

```php
use WorkOS\WorkOS;

$workos = new WorkOS('sk_test_default');
$workos->setApiBaseUrl('http://localhost:4100'); // ← emulator

// Use the SDK as normal
$user = $workos->userManagement->createUser(['email' => 'alice@example.com']);

// Add an error hook at runtime
$ch = curl_init('http://localhost:4100/_emulate/hooks');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS => json_encode([
        'method' => 'POST',
        'path' => '/user_management/users',
        'status' => 500,
    ]),
    CURLOPT_RETURNTRANSFER => true,
]);
curl_exec($ch);
curl_close($ch);

// Now user creation returns a 500 — test your error handling
try {
    $workos->userManagement->createUser(['email' => 'bob@example.com']);
} catch (\Exception $e) {
    echo "Handled error: " . $e->getMessage();
}
```

The same pattern works for any language with a WorkOS SDK (Ruby, Go, Java, etc.) — override the base URL and use the `/_emulate/hooks` HTTP API to manage error hooks from your test setup.

## Programmatic API (Node.js)

```ts
import { createEmulator } from '@workos/emulate';

const emulator = await createEmulator({
  port: 0,
  seed: {
    users: [{ email: 'test@example.com', password: 'secret' }],
  },
});

const res = await fetch(`${emulator.url}/user_management/users`, {
  headers: { Authorization: `Bearer ${emulator.apiKey}` },
});

emulator.reset();
await emulator.close();
```

### ⚠️ Important: EventBus Reset Limitation

The `reset()` method clears all data and re-seeds from the original config, but **route-level authentication events will not work after reset**. This is because Hono's router cannot be modified after it's built, so the EventBus cannot be re-registered with the collection hooks.

This limitation is acceptable for test scenarios where `reset()` is primarily used to clean up state between tests, but it means:

- After calling `reset()`, authentication events (`authentication.*_succeeded`, `authentication.*_failed`) will not be emitted
- Resource lifecycle events (user.created, organization.created, etc.) will still work
- If you need authentication events after reset, you must create a new emulator instance

```ts
const emulator = await createEmulator({ port: 0 });

// First run: authentication events work
await fetch(`${emulator.url}/user_management/authenticate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'password', email: 'test@example.com', password: 'secret' }),
});
// authentication.password_succeeded webhook is delivered

emulator.reset();

// Second run: authentication events DO NOT work
await fetch(`${emulator.url}/user_management/authenticate`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ grant_type: 'password', email: 'test@example.com', password: 'secret' }),
});
// NO authentication.password_succeeded webhook is delivered

// Solution: create a new emulator instance if you need authentication events
await emulator.close();
const newEmulator = await createEmulator({ port: 0 });
```

## Seed Data

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

roles:
  - slug: admin
    name: Admin
    permissions: [posts:read, posts:write]

permissions:
  - slug: posts:read
    name: Read Posts
  - slug: posts:write
    name: Write Posts
```

### Pinning organization and user ids

Both `organizations` and `users` accept an optional `id`. Pin it to match what your real
WorkOS environment emits, so a backend whose database already references a real org or user id
lines up with the emulator — and stays stable across restarts, which otherwise mint a fresh id
each time the seed re-runs. Omit it and an id is generated as before.

```yaml
organizations:
  - id: org_01ABC... # optional; generated if omitted
    name: Acme Corp

users:
  - id: user_01XYZ... # optional; generated if omitted
    email: alice@acme.com
    password: test123
```

A pinned id must be a non-empty string, and ids must be unique within `organizations` and
within `users` (a duplicate would silently overwrite the earlier record in the store). The
pinned id is what the API, login tokens, and webhooks report for that resource.

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

### Linked OAuth identities

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

### Seeded MFA factors

Set `totp: true` on a user to enroll a TOTP authentication factor at boot, exactly as
`POST /user_management/users/{id}/auth_factors` would:

```yaml
users:
  - email: alice@acme.com
    password: test123
    email_verified: true
    totp: true # enrolls a TOTP factor; password sign-ins answer with mfa_challenge
```

The factor is reported by `GET /user_management/users/{id}/auth_factors`, and a password
sign-in for the user returns the spec's `mfa_challenge` step (a `pending_authentication_token`
plus an `authentication_challenge`) instead of a session, completed with the
`urn:workos:oauth:grant-type:mfa-totp` grant — so MFA administration and step-up login flows
need no post-boot enrollment calls that in-memory state would lose on restart.

### Pipes connected accounts

`GET|POST|PUT|DELETE /user_management/users/{id}/connected_accounts/{slug}` serve a user's
[connected accounts](https://workos.com/docs/reference/pipes/connected-account). Seed them
with `connectedAccounts`, referencing a user by email (the same join key memberships use)
and, for an org-scoped connection, an organization by name:

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
    organization: Acme Corp # resolvable only with ?organization_id=<its id>
    state: needs_reauthorization # defaults to connected
```

Accounts are keyed by (user, provider, organization scope), exactly as the API addresses
them. `POST` imports an account from OAuth tokens — an omitted `state` is derived from the
token combination (an expired access token with no refresh token is `needs_reauthorization`) —
and answers `409` for a duplicate. `DELETE` disconnects by removing the account and its stored
tokens, so a later import is a fresh `201`. State changes emit the spec's
`pipes.connected_account.connected` / `reauthorization_needed` / `disconnected` events,
including for seeded accounts.

### Machine-to-Machine (M2M) Applications

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
```

Each seeded application is provisioned with a client secret. Pin `client_secret` to bake a known
value into a service's environment; otherwise one is generated. The application is then available
via `GET /connect/applications`.

#### Token exchange (`client_credentials`)

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

### API Keys

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

## Testing Your Login Flow End-to-End

The emulator implements the full [workos.com/docs](https://workos.com/docs) login story: every resource creation and authentication outcome fires a signed webhook, with event names and payload shapes generated from the WorkOS OpenAPI spec. You can run your app's entire login flow — hosted authorize, callback, token exchange, webhook handling — against the emulator without touching the real API.

### 1. Register a webhook endpoint

Seed it (an empty `events` list subscribes to everything):

```yaml
webhookEndpoints:
  - endpoint_url: http://localhost:5005/webhooks
    secret: whsec_test # optional; generated if omitted
    events: []
```

Pin `secret` when your consumer verifies signatures: the API masks an endpoint's secret after
creation, so a generated one can't be recovered for the consumer's environment.

Or register at runtime:

```bash
curl -X POST http://localhost:4100/webhook_endpoints \
  -H "Authorization: Bearer sk_test_default" \
  -H "Content-Type: application/json" \
  -d '{"endpoint_url":"http://localhost:5005/webhooks","secret":"whsec_test","events":[]}'
```

### 2. Walk the login flow

Point your SDK's base URL at the emulator and follow the AuthKit quickstart exactly as documented:

1. **Create a user** — `POST /user_management/users` → a `user.created` webhook arrives.
2. **Redirect to AuthKit** — send the browser to `GET /user_management/authorize?redirect_uri=...&state=...`. By default the emulator immediately redirects back to your callback with a `code`; with `--interactive` it serves a real login page first.
3. **Exchange the code** — your callback calls `POST /user_management/authenticate` with `grant_type=authorization_code`. You get back the user, `access_token`, and `refresh_token` — and `session.created` plus `authentication.oauth_succeeded` webhooks arrive.
4. **Other methods work the same way** — password, Magic Auth, email verification, MFA, and SSO logins all emit their spec-named `authentication.*_succeeded` events; failed attempts emit `authentication.*_failed` with an `error: { code, message }` object.

Codes that WorkOS would deliver by email are delivered to you in the webhook payload instead: `magic_auth.created` carries the Magic Auth `code`, `password_reset.created` carries the reset `password_reset_token` (and the `password_reset_url` built around it), and `email_verification.created` carries the verification `code`. Your test can drive the whole flow from webhooks alone — see `src/e2e.spec.ts` for a complete worked example.

### 3. Verify signatures

Webhooks are signed exactly like production WorkOS: `WorkOS-Signature: t=<timestamp>, v1=<hmac>` where the HMAC-SHA256 is computed over `"{timestamp}.{body}"` with the endpoint's secret. The official SDKs' `webhooks.constructEvent` verifies them unchanged.

### Organization-scoped sessions

Every fresh login resolves an organization the way production does, so tokens carry the claims your authorization code reads:

- **One active membership** — selected implicitly. The response returns `organization_id` and the access token carries `org_id`, `role`, `roles`, and `permissions`.
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

Only `active` memberships count — an unaccepted invitation or a deactivated member is never selected. Passing `invitation_token` to the `authorization_code`, `password`, or Magic Auth grants accepts the invitation as part of the login, joining the user to the invited organization and scoping the session to it, so there is no selection step; a token that is unknown, expired, or already used is rejected with `invitation_invalid`, and one addressed to somebody else with `invitation_cannot_be_used_for_email`. Once a session exists, only an explicit `organization_id` on a refresh (`switchToOrganization`) moves it between organizations.

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

The resulting session records the method that was gated (`password`), not the verification step. Driving the grant with `user_id` instead of a pending token still works, and that session reports `unknown` — there is no primary method to recover. Fixtures that sign in with a password want `email_verified: true`, in a seed file or on `POST /user_management/users`.

### SSO logins produce a session

A code from `GET /sso/authorize` redeems at `POST /user_management/authenticate` with `grant_type=authorization_code`, so an app that sends people straight to their IdP with `sso.getAuthorizationUrl` and finishes at AuthKit's callback gets a real session — one whose `auth_method` is `sso`, so authorization code that hides password management for federated users can be exercised. `POST /sso/token` still redeems the same code for a bare profile and access token, which is the standalone SSO product and creates no session; a code is spent by whichever endpoint gets it first.

The session is scoped to the connection's organization. A profile with no user-management account yet gets one, verified — the IdP asserted the address — the way AuthKit provisions on a first SSO login.

As with `/user_management/authorize`, `/sso/authorize` is public and signs in whoever `login_hint` names: there is no IdP here to prove an identity with, and inventing a profile for any address is what lets a test drive an SSO login at all. Both endpoints will therefore hand out a session for any account you ask them for. That is the emulator being a test double, not an authorization server — do not point anything at it that you would not also let sign in as your users.

### Refresh tokens always rotate

The emulator issues a new refresh token on every refresh and invalidates the one you presented, so replaying it returns `{"error": "invalid_grant", "error_description": "Invalid refresh token."}`. WorkOS documents that refresh tokens _may_ be rotated after use, so production is free to hand back the same token and leave it valid. The emulator always takes the stricter path: a client that forgets to store the newly returned `refresh_token` fails locally instead of in production.

### Authentication failure shapes

`POST /user_management/authenticate` does not use one error shape for every failure. Which shape you get depends on the failure, not only on the grant: any malformed request is OAuth-shaped, and among credential failures three grants are OAuth-shaped and the rest plain.

| Failure                                                          | Body                                                                  | Node SDK raises           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------- |
| Malformed request — missing or unrecognized parameter, any grant | `{"error": "invalid_request", "error_description": "…"}`              | `OauthException`          |
| `authorization_code` — unknown, expired, bad verifier, user gone | `{"error": "invalid_grant", "error_description": "…"}`                | `OauthException`          |
| `refresh_token` — unknown, expired, rotated, or user deleted     | `{"error": "invalid_grant", "error_description": "…"}`                | `OauthException`          |
| Device code — pending, expired, unknown, or user deleted         | `{"error": "authorization_pending\|expired_token\|invalid_grant", …}` | `OauthException`          |
| `password` — wrong password                                      | `{"code": "invalid_credentials", "message": "…"}` (400)               | `GenericServerException`  |
| Magic Auth — wrong or expired code                               | `{"code": "invalid_one_time_code\|one_time_code_expired", …}`         | `GenericServerException`  |
| Step-up (MFA, org selection, email verification)                 | `{"code": "…", "message": "…"}` (403)                                 | `AuthenticationException` |

`password` is an RFC 6749 grant, but production fails its credentials with the plain shape, so the emulator does too — while a `password` request that omits a parameter still answers `invalid_request` OAuth-style. Both halves come from the spec, whose authenticate 400 lists `invalid_request` and `invalid_grant` only as `{error, error_description}` and `invalid_credentials` and the one-time-code errors only as `{code, message}`. An unrecognized `grant_type` is reported as `invalid_request` rather than `unsupported_grant_type`, which the spec gives to `/sso/token` alone.

`/sso/token` is OAuth-shaped throughout, matching its spec definition.

### Magic Auth doubles as sign-up

`POST /user_management/magic_auth` creates the user when the email has none, so a sign-up flow needs no separate `POST /user_management/users` first. Production does the same at code-creation time rather than at authenticate: the 201 already carries a `user_id`, the user is immediately listable with `email_verified: false`, and the email it sends uses the "Sign up" template.

Redeeming a Magic Auth code sets `email_verified` to `true`, matching the live authenticate response for the same flow. This applies to **any** user who was not already verified, not only ones the endpoint just created, so a fixture seeded `email_verified: false` comes back verified after its first Magic Auth login.

An email is resolved case-insensitively (`User@x.test` and `user@x.test` are the same account, stored under whichever case created it), and one that could only be a typo is rejected rather than turned into an account nothing can reach. `POST /user_management/users` applies both — so it answers 409 for an address that differs from an existing one only in case, rather than creating a second account no lookup can tell apart from the first.

Every lookup by email is case-insensitive, not just Magic Auth's, so an account created by a Magic Auth sign-up is reachable by whatever casing the caller has: the password grant, `login_hint` on the authorize endpoints, `POST /user_management/password_reset`, the `email` filter on `GET /user_management/users` and `GET /user_management/invitations`, accepting an invitation, the `user_id` on SSO authentication events, the profile `/sso/authorize` resolves from a `login_hint`, and the email a seeded organization membership joins its user by. Seeded `users` are held to the same uniqueness the API enforces — two entries differing only in case are a config error, since a seed was otherwise the one way left to produce the pair of accounts no lookup can tell apart.

A field named `email` must be a string wherever it is accepted. A number or object is a `400` (`422` on `POST /user_management/users` and `POST /user_management/invitations`, which keep those routes' validation shape) naming the type, distinct from the `email is required` reported for one that is genuinely absent — which includes an explicit `null`, since that is how a JSON body spells absence. Addresses are trimmed before they are stored or compared, so a padded copy of an address finds the account written under it.

The typo guard applies wherever an address is written rather than looked up: both routes that create users, `POST /user_management/invitations` (acceptance resolves the recipient by email, so a typo is an invitation that is spent without enrolling anyone), and seeded `users`, `invitations`, and organization `memberships`. Read paths are left alone — an address that resolves to nothing is still a `404` you can act on, not a validation error.

### Emitted events

Authentication events carry the spec payload `{ type, status, user_id, email, ip_address, user_agent }` (plus `error` on failures and `sso` details on SSO events).

| Trigger                                | Events                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Login success (per method)             | `authentication.{oauth,password,magic_auth,email_verification,mfa,sso}_succeeded`                        |
| Login failure (bad/expired credential) | `authentication.{oauth,password,magic_auth,email_verification,mfa,sso}_failed`                           |
| Sessions                               | `session.created`, `session.revoked`                                                                     |
| Users                                  | `user.created`, `user.updated`, `user.deleted`                                                           |
| Login-flow resources                   | `magic_auth.created`, `email_verification.created`, `password_reset.created`, `password_reset.succeeded` |
| Organizations & domains                | `organization.*`, `organization_domain.*` (incl. `organization_domain.verified`)                         |
| Memberships & invitations              | `organization_membership.*`, `invitation.{created,accepted,revoked,resent}`                              |
| Connections                            | `connection.activated`, `connection.deactivated`, `connection.deleted`                                   |
| Directory Sync                         | `dsync.activated`, `dsync.deleted`, `dsync.user.*`, `dsync.group.*`                                      |
| Roles & permissions                    | `role.*`, `organization_role.*`, `permission.*`                                                          |
| API keys & feature flags               | `api_key.{created,updated,revoked}`, `flag.{created,updated,deleted}`                                    |

The full catalog (including names the emulator never emits, like `authentication.passkey_*` and `vault.*`) lives in `src/workos/generated/events.ts`, generated from the [`@workos/openapi-spec`](https://www.npmjs.com/package/@workos/openapi-spec) package.

All events are also queryable at `GET /events` (filter with `?events[]=user.created`).

### Caveats

- Delivery is fire-and-forget with a 5-second timeout and no retries — poll your receiver in tests rather than asserting immediately.
- Resources defined in a seed file record events (visible at `GET /events`) but are not delivered to webhook endpoints from the same seed file — endpoints are registered last, mirroring real WorkOS, where pre-existing data never replays. Register endpoints via the API if you want deliveries for setup data.
- `dsync.group.user_added` / `dsync.group.user_removed` are catalogued but never emitted: the emulator has no directory group membership mutation surface.

## JWT Templates (custom claims)

A JWT template adds your own claims to every access token the emulator mints, so authorization
code that reads a custom claim runs against the emulator unchanged. Seed it to have the claims
present from the first sign-in, with no setup call:

```yaml
jwtTemplate:
  content: >-
    {"urn:myapp:name": "{{ user.first_name }} {{ user.last_name }}",
     "urn:myapp:tenant": "{{ organization.metadata.tenant_id }}",
     "urn:myapp:role": "{{ organization_membership.role }}"}
```

Or set it at runtime, matching the WorkOS API — `content` is a template string that renders to a
JSON object:

```bash
curl -X PUT http://localhost:4100/user_management/jwt_template \
  -H "Authorization: Bearer sk_test_default" \
  -H "Content-Type: application/json" \
  -d '{"content": "{\"urn:myapp:tenant\": \"{{ organization.metadata.tenant_id }}\"}"}'
```

Either way the rendered claims land in the token:

```json
{
  "sub": "user_01...",
  "org_id": "org_01...",
  "role": "admin",
  "urn:myapp:name": "Alice Smith",
  "urn:myapp:tenant": "tenant_123"
}
```

### Template syntax

WorkOS uses a small interpolation syntax, not full Liquid. The emulator implements that subset:

| Form                                    | Meaning                                                |
| --------------------------------------- | ------------------------------------------------------ |
| `{{ user.email }}`                      | Interpolate a value by dotted path                     |
| `{{ user.nickname \|\| user.email }}`   | Fallback chain; the first non-null value wins          |
| `{{ user.nickname \|\| 'anonymous' }}`  | Single-quoted literal as the last resort               |
| `"{{ user.first_name }} {{ user.id }}"` | Concatenation inside a JSON string; null becomes `""`  |
| `{"meta": {{ user.metadata }}}`         | A whole object or array, interpolated outside a string |
| `organization.domains.0.domain`         | Array index as a path segment                          |

Filters, conditionals, and loops are not part of the syntax and are not supported.

Available variables are `user.*`, `organization.*`, and `organization_membership.*`. `organization`
and `organization_membership` are only populated for an org-scoped session; in a session with no
organization they resolve to null, so use a fallback if a claim must always be present.

Templates apply to AuthKit session tokens — every grant on `POST /user_management/authenticate`,
including `refresh_token`, so claims survive a refresh. They do not apply to M2M
(`client_credentials`) tokens, widget tokens, or the profile-based `POST /sso/token`, none of which
resolve a user and membership to render against.

### What is rejected

Templates are validated when set — over the API, and at startup for a seeded one, so a bad template
fails the boot rather than the first sign-in. `--validate-config` checks it too.

- **Reserved claims.** A template may not set `iss`, `sub`, `exp`, `iat`, `nbf`, or `jti`. Note that
  `aud`, `sid`, `org_id`, `role`, `roles`, and `permissions` are _not_ reserved: a template may
  deliberately override those, and the rendered value wins over what the emulator resolved.
- **Unknown variables.** An unrecognized root (`{{ usr.email }}`) is a typo and is rejected. A path
  _below_ a known root that the emulator does not model resolves to null instead — including
  `organization.allow_profiles_outside_organization` and
  `organization_membership.custom_attributes`, which the emulator has no data for and will not
  invent.
- **Anything that is not a JSON object** with at least one key.

WorkOS caps rendered claims at 3072 bytes, because the session cookie carrying them has to fit in a
browser. That depends on the data, so it is enforced when the token is signed: a template that
renders too large fails the authenticate call with a 422 naming the size, rather than quietly
handing back a token missing its claims. Nothing is persisted when that happens — no session, no
refresh token, no bumped `last_sign_in_at` — with one exception: a login that passed
`invitation_token` has already consumed the invitation by then, and the membership it created
stands. Retrying with the same token returns `invitation_invalid`, so fix the template and re-seed
rather than replaying the login.

> Earlier versions accepted a `custom_claims` object on this endpoint and stored it without ever
> putting it in a token. That field is gone; `content` is what works. Sending `custom_claims` now
> returns a 422 pointing at `content`.

## Stable Signing Key and Issuer

By default the emulator generates an RSA keypair at startup and builds `iss` from its own URL. That
is fine for a single run, but it means a restart invalidates every token already issued and changes
the published JWKS — and the issuer moves with the port.

Pin either or both to make tokens outlive a restart:

```bash
# Generate a key once and keep it with your test fixtures
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out ci-key.pem

workos-emulate \
  --signing-key ci-key.pem \
  --kid ci_key \
  --issuer https://api.workos.com
```

Each flag has an environment equivalent — `WORKOS_EMULATE_SIGNING_KEY`, `WORKOS_EMULATE_KID`,
`WORKOS_EMULATE_ISSUER` — so a compose file can set them once. Flags win over the environment.

Programmatically:

```ts
const emulator = await createEmulator({
  signingKey: { privateKey: readFileSync('ci-key.pem', 'utf-8'), kid: 'ci_key' },
  issuer: 'https://api.workos.com',
});
```

What this buys you:

- **JWKS stable across restarts.** `/sso/jwks/:client_id` publishes the same key every boot, so a
  token minted before a restart still verifies after it. Without a pinned key, a verifier that
  cached the JWKS must refetch.
- **A constant `iss`.** A verifier comparing `iss` against a hardcoded string needs no test-only
  branch. It must still fetch JWKS from the emulator — pinning the issuer does not make WorkOS's
  real keys apply.
- **One key across several emulators**, or tokens pre-signed offline with the same key the emulator
  verifies.

`--issuer` is the base the client id hangs off, not the whole claim. An AuthKit access token from
`/user_management/authenticate` carries `iss` of `{issuer}/user_management/{client_id}`, which is
what production mints — so `--issuer https://api.workos.com` with a client of `client_123` gives
`https://api.workos.com/user_management/client_123`. The M2M, SSO and widget tokens carry the bare
value, as does an AuthKit token from a grant that named no `client_id` — there is no client to hang
off, and inventing a placeholder would advertise an issuer whose discovery document is not there.

The key must be a PEM-encoded RSA private key, since tokens are signed RS256; anything else fails at
startup with a message saying why. Omit `--kid` and the `kid` is derived from the key itself, so it
is stable for a pinned key without being pinned separately.

> A pinned signing key is a test fixture, not a secret to reuse anywhere real. Never point the
> emulator at a key your production environment trusts.

## OIDC Discovery

`GET /user_management/:client_id/.well-known/openid-configuration` serves the same document
production does, unauthenticated, so a client that discovers its endpoints rather than hard-coding
them needs no emulator-specific branch:

```bash
curl http://localhost:4100/user_management/client_123/.well-known/openid-configuration
```

```json
{
  "issuer": "http://localhost:4100/user_management/client_123",
  "authorization_endpoint": "http://localhost:4100/user_management/authorize",
  "token_endpoint": "http://localhost:4100/user_management/authenticate",
  "response_types_supported": ["code"],
  "jwks_uri": "http://localhost:4100/sso/jwks/client_123"
}
```

Those five fields are the whole document production returns. `subject_types_supported` and
`id_token_signing_alg_values_supported` are absent from both, though OIDC Discovery marks them
required — a client that needs them fails against WorkOS too, and an emulator that papered over
that would be hiding the failure rather than reproducing it.

The endpoints follow the host the document was fetched over, so reaching the emulator as
`host.docker.internal` or a compose service name gets a document pointing back at that name rather
than at localhost. `issuer` is the one field that does not: it has to equal the `iss` the emulator
mints, whatever name the document was fetched under. If a strict client enforces OIDC Discovery
§4.3 — `issuer` must equal the URL the document was fetched from — and you reach the emulator under
a name other than its own base URL, set `--issuer` to that name.

An id that is not shaped like a client id gets production's 404 rather than a document advertising
it as a key endpoint:

```json
{ "message": "Application not found: 'nope'.", "code": "entity_not_found", "entity_id": "nope" }
```

A _registered_ client cannot be told apart from an unregistered one — nothing under
`/user_management` or `/sso` consults the application registry, so `authorize` and `/sso/jwks` serve
any well-formed id too.

## Redirect URI Hosts

The authorize endpoints refuse to redirect anywhere but `localhost`, `127.0.0.1` and `[::1]`, so a
reachable emulator cannot be turned into an open redirect. If your test environment fakes
production-like hostnames, list them:

```bash
workos-emulate --redirect-hosts app.example.test,auth.example.test

# Repeatable, and each occurrence may be a comma-separated list
workos-emulate --redirect-hosts app.example.test --redirect-hosts auth.example.test

# Any subdomain of example.test (the apex itself is not matched)
workos-emulate --redirect-hosts '*.example.test'

# Any host at all — the check is off
workos-emulate --redirect-hosts '*'
```

`WORKOS_EMULATE_REDIRECT_HOSTS=app.example.test,*.internal.test` is the environment equivalent, for
a compose file. The flag wins over the environment.

Programmatically:

```ts
const emulator = await createEmulator({
  allowedRedirectHosts: ['app.example.test', '*.internal.test'],
});
```

Notes:

- Configured hosts **add to** the localhost set rather than replacing it, so existing callbacks keep
  working.
- An entry is a hostname (`app.example.test`), a subdomain wildcard (`*.example.test`), or `*`. A
  whole origin (`https://app.example.test:8443`) is accepted and reduced to its hostname — ports and
  schemes are never part of the host check.
- The check applies to `redirect_uri` on `/user_management/authorize`, `/sso/authorize` and
  `/data-integrations/:slug/authorize`, and to `return_to` on `/user_management/sessions/logout`.
- An internationalized hostname may be written either way: `møller.test` and its punycode
  (`xn--mller-vua.test`) normalize to the same entry, since that is the form a request carries.
- An IP address may be written any legal way. `[FD00::0001]` and `[fd00:0:0:0:0:0:0:1]` are the same
  entry as `[fd00::1]`; `10.1`, `192.168.001.1` and `2130706433` are the same entries as `10.0.0.1`,
  `192.168.1.1` and `127.0.0.1`. A trailing dot is optional too (`app.example.test.` matches
  `app.example.test`). Both sides are reduced to the one form a request carries.
- An underscore is fine (`my_host.example.test`, the shape a Docker Compose service name takes).
  It is not DNS-conformant, but a request really does arrive carrying it.
- A host that could never match (`https://`, anything with whitespace) fails at startup rather than
  silently rejecting every request. So does an entry that would only reduce to `*` by having
  something stripped off it (`*:3000`, `https://*`) — `*` means every host, and it may only be
  spelled that way rather than arrived at by accident.
- A `redirect_uri` carrying an unencoded control character is a 400, since URL parsing strips those
  rather than failing on them: `http://local<TAB>host/` would otherwise validate as localhost and
  reach the `Location` header raw.
- `javascript:`, `data:`, `vbscript:`, `blob:` and `file:` redirect URIs are always refused, `*`
  included — `javascript://localhost/…` parses with an allowed hostname it never navigates to. So
  is any URI with no authority at all (`view-source:javascript:…`, `jar:`, `about:blank`), which
  the host check has nothing to say about and `*` would otherwise wave through. Custom app schemes
  (`myapp://callback`, for native clients) keep their host and are allowed if that host is.

## Error Hooks

Error hooks let you force the emulator to return non-200 responses so you can test how your app handles WorkOS API failures (422, 500, etc.).

`@workos/emulate/core` exports the two error classes the emulator itself throws, for hooks that need to
raise a failure rather than describe one: `WorkOSApiError(status, message, code)` renders the plain
`{code, message}` envelope, and `OauthApiError(status, error, description)` the RFC 6749
`{error, error_description}` one used by `/sso/token`, `/oauth2/token` and the OAuth-shaped
`authenticate` grants (see [Authentication failure shapes](#authentication-failure-shapes)).

### Seed config

Add `errorHooks` to your config file:

```yaml
errorHooks:
  - method: POST
    path: /user_management/users
    status: 422
    body:
      message: 'Validation failed'
      code: 'unprocessable_entity'
      errors:
        - field: email
          code: invalid
          message: 'must be a valid email'

  - method: GET
    path: /user_management/users
    status: 500

  # Fail the first 3 requests, then let them through
  - method: '*'
    path: /organizations
    status: 503
    count: 3
```

| Field    | Required | Description                                                                                                       |
| -------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `method` | yes      | HTTP method to match (`GET`, `POST`, etc.) or `*` for any                                                         |
| `path`   | yes      | URL path to match — exact (`/user_management/users`), prefix with wildcard (`/user_management/*`), or `*` for all |
| `status` | yes      | HTTP status code to return                                                                                        |
| `body`   | no       | Custom JSON response body (`message`, `code`, `errors`). A sensible default is used when omitted.                 |
| `count`  | no       | Number of times the hook fires before it auto-removes. Omit for unlimited.                                        |

### Runtime HTTP API

Manage hooks at runtime without restarting the emulator. These endpoints require no authentication.

```bash
# List all hooks
curl http://localhost:4100/_emulate/hooks

# Add a hook
curl -X POST http://localhost:4100/_emulate/hooks \
  -H "Content-Type: application/json" \
  -d '{"method":"GET","path":"/user_management/users","status":500}'

# Remove a hook by ID
curl -X DELETE http://localhost:4100/_emulate/hooks/hook_abc123
```

### Programmatic API

```ts
const emulator = await createEmulator({ port: 0 });

// Make user creation return a 422
const hook = emulator.addErrorHook({
  method: 'POST',
  path: '/user_management/users',
  status: 422,
  body: { message: 'Email is invalid', code: 'unprocessable_entity' },
});

// Your app code under test handles the error...

// Clean up
emulator.removeErrorHook(hook.id);

// Or list what's active
emulator.listErrorHooks();

// reset() clears all hooks and re-seeds from the original config
emulator.reset();
```

### Advanced Error Hook Examples

Error hooks can be used for sophisticated testing scenarios:

#### Testing Retry Logic

```ts
const emulator = await createEmulator({ port: 0 });

// Make the first 3 requests fail, then succeed
emulator.addErrorHook({
  method: 'POST',
  path: '/user_management/users',
  status: 503,
  count: 3, // Auto-remove after 3 uses
});

// Your app's retry logic will handle the failures
for (let i = 0; i < 4; i++) {
  const res = await fetch(`${emulator.url}/user_management/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emulator.apiKey}` },
    body: JSON.stringify({ email: 'test@example.com' }),
  });
  console.log(`Attempt ${i + 1}:`, res.status);
  // Attempt 1-3: 503, Attempt 4: 201
}
```

#### Conditional Error Responses

```ts
// Simulate validation errors for specific inputs
emulator.addErrorHook({
  method: 'POST',
  path: '/user_management/users',
  status: 422,
  body: {
    message: 'Validation failed',
    code: 'unprocessable_entity',
    errors: [
      { field: 'email', code: 'invalid', message: 'must be a valid email' },
      { field: 'password', code: 'too_short', message: 'must be at least 8 characters' },
    ],
  },
});
```

#### Testing Rate Limiting

```ts
// Simulate rate limiting after 10 requests
let requestCount = 0;
emulator.addErrorHook({
  method: '*',
  path: '/user_management/*',
  status: 429,
  body: {
    message: 'Rate limit exceeded',
    code: 'rate_limit_exceeded',
  },
  count: 1, // Will be managed manually
});

// In your test, manage the hook manually
const checkRateLimit = async () => {
  requestCount++;
  if (requestCount > 10) {
    // Add the rate limit hook
    emulator.addErrorHook({
      method: '*',
      path: '/user_management/*',
      status: 429,
    });
  }
};
```

### Advanced Custom Seeding

Custom seeding can be used to create complex test scenarios:

#### Complete Organization Setup

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
      # generated at startup, so memberships are joined by email.
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
  - name: Acme SSO
    connection_type: GenericSAML
    organization: Acme Corp
    state: active
    domains: [acme.com]
    profiles:
      - email: admin@acme.com
        first_name: Admin
        last_name: User
        groups: [admins, it_staff]
      - email: employee@acme.com
        first_name: Regular
        last_name: Employee
        groups: [employees]

webhookEndpoints:
  - endpoint_url: http://localhost:5000/webhooks
    events: []
    enabled: true
```

## Interactive Auth (E2E Browser Testing)

By default, the SSO and AuthKit authorize endpoints auto-redirect with an auth code — great for API-level tests, but agent browsers and E2E test frameworks need an actual login page to interact with.

Pass `--interactive` (CLI) or `interactiveAuth: true` (programmatic) to enable login pages:

```bash
workos-emulate --interactive --seed workos-emulate.config.yaml
```

```ts
const emulator = await createEmulator({
  interactiveAuth: true,
  seed: {
    users: [{ email: 'test@example.com', password: 'secret' }],
    connections: [{ name: 'Test SSO', organization: 'Acme', domains: ['example.com'] }],
    organizations: [{ name: 'Acme' }],
  },
});
```

### What changes

| Endpoint                         | Default (auto)                                   | Interactive                                                                                             |
| -------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `GET /sso/authorize`             | Immediately redirects to callback with auth code | Serves an HTML login page with an email field                                                           |
| `GET /user_management/authorize` | Immediately redirects to callback with auth code | Serves an HTML login page with an email field, plus a collapsed list of the accounts the emulator holds |

When interactive mode is on:

1. Your app redirects to `/sso/authorize?connection=...&redirect_uri=...` (or `/user_management/authorize?...`)
2. The emulator serves a login page instead of auto-redirecting
3. The browser (or agent) fills in the email field and submits the form
4. If the user belongs to more than one organization, the emulator asks which one, as hosted AuthKit does
5. The emulator creates an auth code and redirects back to your app's callback URL

The `login_hint` parameter pre-fills the email field, so agent browsers can skip typing if desired.

### Picking an account

The login page also lists every account the emulator holds, collapsed behind **Pick an account (N)** and ordered by email, so a test does not have to hard-code an address to sign in as one. Each row submits directly. A user created through the API mid-session appears in the list too. Typing an address that was never seeded still works, which is what sign-up flows rely on.

### Choosing an organization

A user with more than one active membership gets a second page, one row per organization, before any code is minted. This mirrors hosted AuthKit, and it matters because the alternative is the API-level `organization_selection_required` response, which a browser client receives mid-callback and cannot act on.

Skip the page by passing `organization_id` to `/user_management/authorize`; it must be one the user is an active member of, or the request is refused. If the membership behind a code is revoked before the code is redeemed, redemption fails with `invalid_grant` rather than silently signing the user into a different tenant.

```ts
test('multi-organization login', async ({ page }) => {
  await page.goto('http://localhost:3000/login');
  await page.fill('input[name="email"]', 'alice@example.com');
  await page.click('button[type="submit"]');

  // Only shown when the user belongs to several organizations
  await page.click('text=Acme');

  await expect(page).toHaveURL(/dashboard/);
});
```

### E2E example with Playwright

```ts
test('SSO login flow', async ({ page }) => {
  await page.goto('http://localhost:3000/login');
  await page.click('text=Sign in with SSO');

  // Emulator serves the login page
  await page.fill('input[name="email"]', 'alice@example.com');
  await page.click('button[type="submit"]');

  // Redirected back to your app with a valid session
  await expect(page).toHaveURL(/dashboard/);
});
```

This replaces the need for WorkOS's Test Identity Provider — no dashboard login required, works in incognito, works with headless browsers.

## Security Considerations

The WorkOS Emulator is designed for testing and development environments. When using it in production-like scenarios, consider the following security implications:

### Authentication & Authorization

- **No real authentication**: The emulator uses a simple API key system (`sk_test_default`) that provides no real security. Anyone with access to the emulator can make API calls.
- **No rate limiting**: By default, the emulator has no rate limiting. In production scenarios, implement rate limiting to prevent abuse.
- **Public error hook endpoints**: The `/_emulate/hooks` endpoints require no authentication and can be used by anyone who can reach the server.

### Data Security

- **In-memory storage**: All data is stored in memory and lost when the server stops. Do not use for persistent data.
- **No encryption**: Data is not encrypted at rest or in transit. Use HTTPS in production environments.
- **No audit logging**: While the emulator has audit log endpoints, it doesn't provide real security auditing.

### Webhook Security

- **Simple signature verification**: Webhook signatures use HMAC-SHA256, but ensure your webhook endpoints validate signatures properly.
- **No webhook authentication**: The emulator doesn't authenticate webhook endpoints — ensure your endpoints are secure.

### Network Security

- **Bind to localhost**: By default, the emulator binds to `localhost`, so its unauthenticated endpoints are only reachable from the local machine. To intentionally expose it to other hosts, pass `--host 0.0.0.0` (CLI) or `hostname: '0.0.0.0'` (`createEmulator`), and protect it with a firewall or VPN.
- **Open redirect protection**: The authorize endpoints only redirect to localhost by default. `--redirect-hosts` (or `allowedRedirectHosts`) widens that for test environments with production-like hostnames; `--redirect-hosts '*'` disables the host check entirely, so only use it on an emulator nothing untrusted can reach. Script-bearing schemes (`javascript:`, `data:`) and URIs with no authority for the host check to speak about (`view-source:javascript:…`, `about:`) are refused regardless. See [Redirect URI Hosts](#redirect-uri-hosts).
- **No CORS restrictions**: The emulator doesn't enforce CORS. Configure CORS in your application if needed.
- **No TLS/SSL**: The emulator doesn't provide HTTPS. Use a reverse proxy (nginx, Caddy) for TLS termination in production.

### Recommendations

- **Use only in development/testing**: The emulator is not designed for production use.
- **Run behind a reverse proxy**: Use nginx, Caddy, or similar for TLS termination and additional security.
- **Implement authentication**: Add proper authentication if exposing the emulator to external networks.
- **Use environment variables**: Store sensitive configuration (API keys, secrets) in environment variables.
- **Regular updates**: Keep the emulator updated to get security fixes and improvements.
- **Network isolation**: Run the emulator in an isolated network environment when possible.

## Development

The repository uses Bun 1.3.14, pinned by the `packageManager` field in `package.json`.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

`bun run test:coverage` writes text output and `coverage/lcov.info`. `bun run build:binary` produces
a standalone executable for the current platform, while `scripts/build-binaries.sh <version>` builds
every release target.
