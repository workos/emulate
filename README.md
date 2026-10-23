# WorkOS Emulate

A local, in-memory stand-in for the WorkOS API. Point a WorkOS SDK at it and run sign-in, SSO,
Directory Sync, RBAC, webhooks and machine-to-machine flows in tests and local development, with no
WorkOS account, no network and no dashboard.

- **Answers like production.** Routes accept and refuse what the real API does, down to the error
  codes, and every event name and payload shape is generated from the
  [WorkOS OpenAPI spec](https://www.npmjs.com/package/@workos/openapi-spec).
- **Seeded from a file.** Users, organizations, connections, roles, M2M credentials can be generated as working fixtures.
- **Built for tests.** Force failures with error hooks, receive signed webhooks locally, and drive
  browser suites against a real login page.

For the list of supported features, see [SUPPORTED.md](SUPPORTED.md).

## Installation

| Method                  | Command                                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| Homebrew (macOS, Linux) | `brew install workos/tap/workos-emulate`                                                         |
| npm                     | `npm install --save-dev @workos/emulate`, or `npx @workos/emulate` for a one-off run             |
| Docker                  | `docker run --rm -p 4100:4100 ghcr.io/workos/emulate`                                            |
| Binary                  | Download from the [latest release](https://github.com/workos/emulate/releases/latest), see below |

### Docker

Stable releases are tagged `:latest` and `:<version>`; prereleases are tagged `:beta` and
`:<version>`.

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

The image binds to `0.0.0.0` so the emulator is reachable from the host or other containers. The
seed config is auto-detected from the working directory (`/app`); mount it at
`/app/workos-emulate.config.yaml` (or `.yml` / `.json`).

### Binaries

Self-contained executables are attached to each [GitHub release](https://github.com/workos/emulate/releases);
no Node, npm, or Bun required. Intel and x64 builds use Bun's baseline target for compatibility
with older CPUs, and each release ships a `checksums.txt` with the SHA-256 of every binary.

| Target               | File                               |
| -------------------- | ---------------------------------- |
| macOS, Apple Silicon | `workos-emulate-darwin-arm64`      |
| macOS, Intel         | `workos-emulate-darwin-x64`        |
| Linux x64, glibc     | `workos-emulate-linux-x64`         |
| Linux arm64, glibc   | `workos-emulate-linux-arm64`       |
| Alpine / musl x64    | `workos-emulate-linux-x64-musl`    |
| Alpine / musl arm64  | `workos-emulate-linux-arm64-musl`  |
| Windows x64          | `workos-emulate-windows-x64.exe`   |
| Windows arm64        | `workos-emulate-windows-arm64.exe` |

```bash
curl -fsSL -o workos-emulate https://github.com/workos/emulate/releases/latest/download/workos-emulate-darwin-arm64
chmod +x workos-emulate
```

On Windows, download the `.exe` and run it directly.

## Quickstart

When you launch emulate, it starts a server that listens on http://localhost:4100, and uses the API key `sk_test_default`.

Point your SDK at it and carry on as normal:

```ts
import { WorkOS } from '@workos-inc/node';

const workos = new WorkOS({ apiKey: 'sk_test_default', apiHostname: 'localhost', port: 4100, https: false });
const user = await workos.userManagement.createUser({ email: 'alice@example.com' });
```

Or, for JS/TS projects, start an emulator inside a test, on a free port, with its own fixtures:

```ts
import { createEmulator } from '@workos/emulate';

const emulator = await createEmulator({
  port: 0,
  seed: { users: [{ email: 'test@example.com', password: 'secret' }] },
});

const res = await fetch(`${emulator.url}/user_management/users`, {
  headers: { Authorization: `Bearer ${emulator.apiKey}` },
});

emulator.reset();
await emulator.close();
```

For more help using emulate with the WorkOS SDKs, see
[Using from any language](docs/testing.md#using-from-any-language).

## CLI

```bash
workos-emulate
workos-emulate --port 9100 --json
workos-emulate --seed workos-emulate.config.yaml
workos-emulate --interactive          # serve login pages for E2E browser testing
workos-emulate --interactive-password # ...and ask a user who has a password for it
workos-emulate --signing-key ci-key.pem --issuer https://api.workos.com  # stable JWKS and iss
workos-emulate --redirect-hosts app.example.test  # allow a non-localhost redirect_uri
workos-emulate --requests-per-minute 10000  # widen the per-key request budget (default 1000)
workos-emulate --version
```

The emulator defaults to `http://localhost:4100` and the API key `sk_test_default`.
Use `GET /health` for readiness checks.

In an interactive terminal, the CLI checks for new stable releases without delaying startup. npm
installations follow the npm registry; Homebrew and direct-download installations follow GitHub
Releases after their checksums are available. Set `NO_UPDATE_NOTIFIER=1` or
`WORKOS_EMULATE_DISABLE_UPDATE_CHECK=1` to disable the check. JSON output, CI, and non-interactive
invocations never perform it.

## Documentation

| Guide                                        | What it covers                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Testing with the emulator](docs/testing.md) | The Node API, other languages, webhooks and events, error hooks, interactive login pages for E2E  |
| [Seed data](docs/seeding.md)                 | The config file: users, organizations, connections, M2M apps, directories, flags, agents and more |
| [Production parity](docs/behavior.md)        | What each route accepts and refuses, and where the emulator knowingly differs from production     |
| [Tokens, keys and redirects](docs/tokens.md) | JWT templates, a stable signing key and issuer, OIDC discovery, allowed redirect hosts            |
| [Supported features](SUPPORTED.md)           | The generated endpoint coverage matrix                                                            |

## Security

The emulator is a test double, not an authorization server. Keep it where nothing untrusted can
reach it.

- **Anyone can call it.** `sk_test_default` and every seeded key authenticate, and the
  `/_emulate/hooks` endpoints take no credentials at all.
- **Anyone can sign in as anyone.** The authorize endpoints hand out a session for whichever account
  is asked for, since there is no IdP to prove an identity against.
- **Localhost by default.** The CLI binds to `localhost` and the authorize endpoints only redirect
  there. `--host 0.0.0.0` and [`--redirect-hosts`](docs/tokens.md#redirect-uri-hosts) widen that,
  and the Docker image binds to `0.0.0.0` already.
- **Nothing is persisted or encrypted.** State lives in memory, there is no TLS, and webhook
  deliveries are signed but never retried.
- **A pinned signing key is a fixture.** Never point the emulator at a key your production
  environment trusts.

## Development

The repository uses the Bun version pinned by the `packageManager` field in `package.json`.

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

`bun run test:coverage` writes text output and `coverage/lcov.info`. `bun run build:binary` produces
a standalone executable for the current platform, while `scripts/build-binaries.sh <version>` builds
every release target.
