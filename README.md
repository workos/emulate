# WorkOS Emulate

Local WorkOS API emulator for tests and development.

## CLI

```bash
workos-emulate
workos-emulate --port 9100 --json
workos-emulate --seed workos-emulate.config.yaml
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
      message: "Validation failed"
      code: "unprocessable_entity"
      errors:
        - field: email
          code: invalid
          message: "must be a valid email"

  - method: GET
    path: /user_management/users
    status: 500

  # Fail the first 3 requests, then let them through
  - method: "*"
    path: /organizations
    status: 503
    count: 3
```

| Field    | Required | Description |
|----------|----------|-------------|
| `method` | yes      | HTTP method to match (`GET`, `POST`, etc.) or `*` for any |
| `path`   | yes      | URL path to match — exact (`/user_management/users`), prefix with wildcard (`/user_management/*`), or `*` for all |
| `status` | yes      | HTTP status code to return |
| `body`   | no       | Custom JSON response body (`message`, `code`, `errors`). A sensible default is used when omitted. |
| `count`  | no       | Number of times the hook fires before it auto-removes. Omit for unlimited. |

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
