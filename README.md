# WorkOS Emulate

Local WorkOS API emulator for tests and development.

## CLI

```bash
workos-emulate
workos-emulate --port 9100 --json
workos-emulate --seed workos-emulate.config.yaml
workos-emulate --interactive          # serve login pages for E2E browser testing
```

The emulator defaults to `http://localhost:4100` and the API key `sk_test_default`.
Use `GET /health` for readiness checks.

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

## Testing Your Login Flow End-to-End

The emulator implements the full [workos.com/docs](https://workos.com/docs) login story: every resource creation and authentication outcome fires a signed webhook, with event names and payload shapes generated from the WorkOS OpenAPI spec. You can run your app's entire login flow — hosted authorize, callback, token exchange, webhook handling — against the emulator without touching the real API.

### 1. Register a webhook endpoint

Seed it (an empty `events` list subscribes to everything):

```yaml
webhookEndpoints:
  - endpoint_url: http://localhost:5005/webhooks
    events: []
```

Or register at runtime and choose your own signing secret:

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

Codes that WorkOS would deliver by email are delivered to you in the webhook payload instead: `magic_auth.created` carries the Magic Auth `code`, `password_reset.created` carries the reset `token`, and `email_verification.created` carries the verification `code`. Your test can drive the whole flow from webhooks alone — see `src/e2e.spec.ts` for a complete worked example.

### 3. Verify signatures

Webhooks are signed exactly like production WorkOS: `WorkOS-Signature: t=<timestamp>,v1=<hmac>` where the HMAC-SHA256 is computed over `"{timestamp}.{body}"` with the endpoint's secret. The official SDKs' `webhooks.constructEvent` verifies them unchanged.

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

## Error Hooks

Error hooks let you force the emulator to return non-200 responses so you can test how your app handles WorkOS API failures (422, 500, etc.).

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
      - user_id: user_admin_id # Replace with actual user ID after creation
        role: admin
        status: active
      - user_id: user_employee_id # Replace with actual user ID
        role: member
        status: active

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

| Endpoint                         | Default (auto)                                   | Interactive                                   |
| -------------------------------- | ------------------------------------------------ | --------------------------------------------- |
| `GET /sso/authorize`             | Immediately redirects to callback with auth code | Serves an HTML login page with an email field |
| `GET /user_management/authorize` | Immediately redirects to callback with auth code | Serves an HTML login page with an email field |

When interactive mode is on:

1. Your app redirects to `/sso/authorize?connection=...&redirect_uri=...` (or `/user_management/authorize?...`)
2. The emulator serves a login page instead of auto-redirecting
3. The browser (or agent) fills in the email field and submits the form
4. The emulator creates an auth code and redirects back to your app's callback URL

The `login_hint` parameter pre-fills the email field, so agent browsers can skip typing if desired.

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

- **Bind to localhost**: By default, the emulator binds to `localhost`. If you need to expose it, use a firewall or VPN.
- **No CORS restrictions**: The emulator doesn't enforce CORS. Configure CORS in your application if needed.
- **No TLS/SSL**: The emulator doesn't provide HTTPS. Use a reverse proxy (nginx, Caddy) for TLS termination in production.

### Recommendations

- **Use only in development/testing**: The emulator is not designed for production use.
- **Run behind a reverse proxy**: Use nginx, Caddy, or similar for TLS termination and additional security.
- **Implement authentication**: Add proper authentication if exposing the emulator to external networks.
- **Use environment variables**: Store sensitive configuration (API keys, secrets) in environment variables.
- **Regular updates**: Keep the emulator updated to get security fixes and improvements.
- **Network isolation**: Run the emulator in an isolated network environment when possible.
