# Testing with the emulator

Driving the emulator from a test suite: starting it from Node, pointing other languages' SDKs at
it, receiving webhooks, forcing failures with error hooks, and serving a real login page for
browser tests.

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

The emulator's request budget defaults to 1,000 per API key in each 60-second window. Larger
integration suites that share an API key can set `requestsPerMinute` to a positive safe integer,
for example `createEmulator({ port: 0, requestsPerMinute: 10_000 })`. The full configured budget is
accepted, so a budget of 1 allows one request before HTTP 429 responses with `Retry-After`. The
last accepted request has `X-RateLimit-Remaining: 0`; the budget resets 60 seconds after the first
request in the window. Anonymous requests share a separate budget.

From the CLI, `--requests-per-minute 10000` sets the same budget, and
`WORKOS_EMULATE_REQUESTS_PER_MINUTE=10000` is the environment equivalent, for a compose file or the
Docker image. The flag wins over the environment.

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

## Testing Your Login Flow End-to-End

The emulator implements the full [workos.com/docs](https://workos.com/docs) login story: every resource creation and authentication outcome fires a signed webhook, with event names and payload shapes generated from the WorkOS OpenAPI spec. You can run your app's entire login flow — hosted authorize, callback, token exchange, webhook handling — against the emulator without touching the real API.

### 1. Register a webhook endpoint

Seed it (an empty `events` list subscribes to everything):

```yaml
webhookEndpoints:
  - endpoint_url: http://localhost:5005/webhooks
    secret: whsec_test # optional; generated if omitted
    events: []
    status: enabled # optional; `enabled` or `disabled`
```

Pin `secret` when your consumer verifies signatures, so the secret is in its environment before
anything talks to the emulator; a generated one is only discoverable through `GET /webhook_endpoints`.

Or register at runtime:

```bash
curl -X POST http://localhost:4100/webhook_endpoints \
  -H "Authorization: Bearer sk_test_default" \
  -H "Content-Type: application/json" \
  -d '{"endpoint_url":"http://localhost:5005/webhooks","events":["user.created","session.created"]}'
```

The API holds a request to what production holds it to: `endpoint_url` must be an HTTPS URL
(422 `invalid_url`), `events` must name at least one event from the subscribable catalog (422
`invalid_request_parameters`, with an `unknown_event_type` item per bad name), a URL another
endpoint already uses is a 409 `duplicate_endpoint`, and the signing secret is generated — a
`secret` in the body is ignored, as is `enabled`. `PATCH /webhook_endpoints/:id` takes
`endpoint_url`, `events` and `status` (`enabled` or `disabled`) under the same rules. One
deliberate, emulator-only relaxation: a plain `http://` URL is accepted when its host is a
loopback address (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), since a receiver on this
machine is the whole point and rarely has a certificate. Any other `http://` receiver, a pinned
`secret`, and the catch-all empty `events` list are seed-only: the seed is where the emulator
holds state the real API would never let you create.

### 2. Walk the login flow

Point your SDK's base URL at the emulator and follow the AuthKit quickstart exactly as documented:

1. **Create a user** — `POST /user_management/users` → a `user.created` webhook arrives.
2. **Redirect to AuthKit** — send the browser to `GET /user_management/authorize?redirect_uri=...&state=...`. By default the emulator immediately redirects back to your callback with a `code`; with `--interactive` it serves a real login page first.
3. **Exchange the code** — your callback calls `POST /user_management/authenticate` with `grant_type=authorization_code`. You get back the user, `access_token`, and `refresh_token` — and `session.created` plus `authentication.oauth_succeeded` webhooks arrive (`authentication.password_succeeded` instead, when the [interactive password page](#requiring-a-password) checked the login, or the event of the gate that page cleared last).
4. **Other methods work the same way** — password, Magic Auth, email verification, MFA, and SSO logins all emit their spec-named `authentication.*_succeeded` events; failed attempts emit `authentication.*_failed` with an `error: { code, message }` object.

Codes that WorkOS would deliver by email are delivered to you in the webhook payload instead: `magic_auth.created` carries the Magic Auth `code`, `password_reset.created` carries the reset `password_reset_token` (and the `password_reset_url` built around it), and `email_verification.created` carries the verification `code`. Your test can drive the whole flow from webhooks alone — see `src/e2e.spec.ts` for a complete worked example.

### 3. Verify signatures

Webhooks are signed exactly like production WorkOS: `WorkOS-Signature: t=<timestamp>, v1=<hmac>` where the HMAC-SHA256 is computed over `"{timestamp}.{body}"` with the endpoint's secret. The official SDKs' `webhooks.constructEvent` verifies them unchanged.

### Emitted events

Authentication events carry the spec payload `{ type, status, user_id, email, ip_address, user_agent }` (plus `error` on failures and `sso` details on SSO events).

| Trigger                                | Events                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Login success (per method)             | `authentication.{oauth,password,magic_auth,email_verification,mfa,sso}_succeeded`                                                                                  |
| Login failure (bad/expired credential) | `authentication.{oauth,password,magic_auth,email_verification,mfa,sso}_failed`                                                                                     |
| Sessions                               | `session.created`, `session.revoked`                                                                                                                               |
| Users                                  | `user.created`, `user.updated`, `user.deleted`                                                                                                                     |
| Login-flow resources                   | `magic_auth.created`, `email_verification.created`, `password_reset.created`, `password_reset.succeeded`                                                           |
| Organizations & domains                | `organization.*`, `organization_domain.{created,updated,deleted}` (`verified` only through the store, see [Organization domains](seeding.md#organization-domains)) |
| Memberships & invitations              | `organization_membership.*`, `invitation.{created,accepted,revoked,resent}`                                                                                        |
| Connections                            | `connection.activated`, `connection.deactivated`, `connection.deleted`                                                                                             |
| Directory Sync                         | `dsync.activated`, `dsync.deleted`, `dsync.user.*`, `dsync.group.*`                                                                                                |
| Roles & permissions                    | `role.*`, `organization_role.*`, `permission.*`                                                                                                                    |
| API keys & feature flags               | `api_key.{created,updated,revoked}`, `flag.{created,updated,deleted}`                                                                                              |

The full catalog (including names the emulator never emits, like `authentication.passkey_*` and `vault.*`) lives in `src/workos/generated/events.ts`, generated from the [`@workos/openapi-spec`](https://www.npmjs.com/package/@workos/openapi-spec) package.

All events are also queryable at `GET /events`. The `events` filter is required, as in production — there is no "all events" listing — in any form an SDK sends it (`?events=user.created,user.updated`, repeated `?events=`, or `?events[]=`); a name outside the catalog is a 400 `invalid_events_request`, and so is `range_start` combined with `after`.

### Caveats

- Delivery is fire-and-forget with a 5-second timeout and no retries — poll your receiver in tests rather than asserting immediately.
- Resources defined in a seed file record events (visible at `GET /events`) but are not delivered to webhook endpoints from the same seed file — endpoints are registered last, mirroring real WorkOS, where pre-existing data never replays. Register endpoints via the API if you want deliveries for setup data.
- Seeding a directory user into a group emits `dsync.group.user_added`. Removing that membership emits `dsync.group.user_removed`. There is still no HTTP route to mutate a directory; production connects one in the dashboard.

## Error Hooks

Error hooks let you force the emulator to return non-200 responses so you can test how your app handles WorkOS API failures (422, 500, etc.).

`@workos/emulate/core` exports the two error classes the emulator itself throws, for hooks that need to
raise a failure rather than describe one: `WorkOSApiError(status, message, code)` renders the plain
`{code, message}` envelope, and `OauthApiError(status, error, description)` the RFC 6749
`{error, error_description}` one used by `/sso/token`, `/oauth2/token` and the OAuth-shaped
`authenticate` grants (see [Authentication failure shapes](behavior.md#authentication-failure-shapes)).

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

1. Your app redirects to `/sso/authorize?client_id=...&connection=...&redirect_uri=...` (or `/user_management/authorize?...`)
2. The emulator serves a login page instead of auto-redirecting
3. The browser (or agent) fills in the email field and submits the form
4. With the [password option](#requiring-a-password) on, a user who has a password is asked for it next
5. Under the same option, the gates the `password` grant enforces follow: an unverified mailbox is asked for its emailed code, then an enrolled second factor for its one-time code
6. If the user belongs to more than one organization, the emulator asks which one, as hosted AuthKit does
7. The emulator creates an auth code and redirects back to your app's callback URL

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

### Requiring a password

The login page asks for an email and nothing else, so a suite signs in as anyone with one form fill. Pass `--interactive-password` (CLI) or `interactiveAuth: { password: true }` (programmatic) to add the step hosted AuthKit puts next: a user who has a password is asked for it after the email and before any organization question.

```bash
workos-emulate --interactive-password --seed workos-emulate.config.yaml
```

```ts
const emulator = await createEmulator({
  interactiveAuth: { password: true },
  seed: { users: [{ email: 'alice@example.com', password: 'correct-horse', email_verified: true }] },
});
```

- The page shows the email read-only above an `input[name="password"]`, with a "Use a different account" link back to the email page. A user without a password skips it, so a sign-up or a passwordless seed behaves exactly as before.
- A wrong password re-renders the page with an inline error (HTTP 401) and emits `authentication.password_failed` with `invalid_credentials`, the same event the `password` grant emits. Nothing reaches your callback until the password is right.
- Once it is, the code the callback receives remembers how it was earned: the exchange emits `authentication.password_succeeded` rather than `authentication.oauth_succeeded`, and the response carries `"authentication_method": "Password"`.
- The gates the `password` grant enforces apply here too, in the order hosted AuthKit shows them. A user whose `email_verified` is `false` gets a "Verify your email" page for the code that arrives on the `email_verification.created` webhook, and a user with an enrolled factor (`totp: true` in a seed) gets a one-time-code page for a fresh authentication challenge, whose code a test reads from the store as it does to finish the `mfa-totp` grant. Both pages take an `input[name="code"]`. A wrong code re-renders with an inline error (HTTP 401) and emits `authentication.email_verification_failed` or `authentication.mfa_failed`, as the matching grant would; three wrong codes lock the code as they would at the grant (`one_time_code_too_many_attempts` on the event), and the page issues a fresh one, as it does for a code that has expired. The verification page compares the user's latest code, as the grant does, so a code sent since the page sent its own (`email_verification/send`, another login) retires the page's; the code it accepts is redeemed, not dropped.
- When a gate was cleared, the exchange reports what that grant reports: `authentication.email_verification_succeeded` or `authentication.mfa_succeeded` in place of `authentication.password_succeeded`, with the session and `authentication_method` still recording `Password`. Fixtures that should go from the password straight to the callback want `email_verified: true`, as they do for the `password` grant.
- Every page after the password carries a short-lived token rather than the password. Posting an `organization_id`, or a code, without that token lands back on the password page, and posting past an open gate lands back on the gate.
- Plain `--interactive` is unchanged.

```ts
test('password login', async ({ page }) => {
  await page.goto('http://localhost:3000/login');
  await page.fill('input[name="email"]', 'alice@example.com');
  await page.click('button[type="submit"]');

  await page.fill('input[name="password"]', 'correct-horse');
  await page.click('button[type="submit"]');

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
