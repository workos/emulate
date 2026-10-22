<!-- The table between the gen:supported markers is written by `bun run gen:supported`; edit everything else by hand. -->

# Supported Features

Endpoint coverage says whether a route exists, not whether a feature is usable. Directory Sync
implements every read endpoint the spec defines for it, yet production has no endpoint that creates
a directory, so the seed file is the only way to use it here. The **Set up** column is the one that
answers "can I actually emulate this?".

| Column     | Meaning                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| **Read**   | `GET` endpoints implemented / defined in the spec                           |
| **Write**  | `POST`/`PUT`/`PATCH`/`DELETE` endpoints implemented / defined in the spec   |
| **Set up** | How data gets in: ✅ seed file, ⚠️ API calls only, ❌ no way to create data |

✅ full · ⚠️ partial · ❌ none · — not applicable

Each feature links to its section of [Production parity](docs/behavior.md), which says what the
emulator accepts and refuses and where it knowingly differs from production. How data gets in is
in [Seed data](docs/seeding.md).

<!-- gen:supported:begin -->

The emulator implements **203 of 266** endpoints in the WorkOS OpenAPI spec (`@workos/openapi-spec@0.133.0`) (**76.3%**).

| Feature                                                               | Read     | Write    | Set up                         |
| --------------------------------------------------------------------- | -------- | -------- | ------------------------------ |
| [Organizations](docs/behavior.md#organizations)                       | ✅ 6/6   | ✅ 10/10 | ✅ seed `organizations`        |
| [User Management](docs/behavior.md#user-management)                   | ⚠️ 8/11  | ⚠️ 7/13  | ✅ seed `users`                |
| [Authentication](docs/behavior.md#authentication)                     | ⚠️ 3/4   | ⚠️ 4/5   | ⚠️ API only                    |
| [Organization Memberships](docs/behavior.md#organization-memberships) | ✅ 3/3   | ✅ 5/5   | ✅ seed `memberships`          |
| [Groups](docs/behavior.md#groups)                                     | ✅ 3/3   | ✅ 5/5   | ✅ seed `groups`               |
| [Invitations](docs/behavior.md#invitations)                           | ✅ 3/3   | ✅ 4/4   | ✅ seed `invitations`          |
| [SSO](docs/behavior.md#sso)                                           | ⚠️ 5/8   | ⚠️ 4/11  | ✅ seed `connections`          |
| [Directory Sync](docs/behavior.md#directory-sync)                     | ✅ 6/6   | ⚠️ 1/2   | ✅ seed `directories`          |
| [Multi-Factor Auth](docs/behavior.md#multi-factor-auth)               | ✅ 2/2   | ✅ 5/5   | ⚠️ API only                    |
| [FGA / Authorization](docs/behavior.md#fga--authorization)            | ✅ 19/19 | ⚠️ 24/26 | ✅ seed `roles`, `permissions` |
| [Audit Logs](docs/behavior.md#audit-logs)                             | ⚠️ 3/4   | ⚠️ 3/4   | ⚠️ API only                    |
| [Vault](docs/behavior.md#vault)                                       | ✅ 5/5   | ⚠️ 3/6   | ⚠️ API only                    |
| [Feature Flags](docs/behavior.md#feature-flags)                       | ✅ 4/4   | ✅ 4/4   | ✅ seed `featureFlags`         |
| [API Keys](docs/behavior.md#api-keys)                                 | ✅ 2/2   | ✅ 5/5   | ✅ seed `apiKeys`              |
| [Pipes / Connected Apps](docs/behavior.md#pipes--connected-apps)      | ⚠️ 2/8   | ⚠️ 4/19  | ✅ seed `connectedAccounts`    |
| [Applications](docs/behavior.md#applications)                         | ✅ 5/5   | ✅ 8/8   | ✅ seed `connectApplications`  |
| [JWT Templates](docs/behavior.md#jwt-templates)                       | ✅ 1/1   | ✅ 1/1   | ✅ seed `jwtTemplate`          |
| [Webhooks](docs/behavior.md#webhooks)                                 | ✅ 1/1   | ✅ 3/3   | ✅ seed `webhookEndpoints`     |
| [Events](docs/behavior.md#events)                                     | ✅ 1/1   | —        | ✅ automatic                   |
| [AuthKit Configuration](docs/behavior.md#authkit-configuration)       | ⚠️ 1/3   | ⚠️ 4/5   | ✅ seed `resourceIndicators`   |
| [Admin Portal](docs/behavior.md#admin-portal)                         | —        | ⚠️ 1/2   | ⚠️ API only                    |
| [Widgets](docs/behavior.md#widgets)                                   | —        | ✅ 1/1   | ⚠️ API only                    |
| [Radar](docs/behavior.md#radar)                                       | —        | ⚠️ 1/4   | ⚠️ API only                    |
| [Agent Auth](docs/behavior.md#agent-auth)                             | ✅ 6/6   | ✅ 7/7   | ✅ seed `agentBlueprints`      |
| Agent Registration                                                    | ❌ 0/1   | ❌ 0/3   | ❌ none                        |
| Platform Teams                                                        | ❌ 0/1   | ❌ 0/1   | ❌ none                        |

<!-- gen:supported:end -->

## How this file is generated

Everything between the two `gen:supported` markers is derived, so the table cannot drift from the
code:

- **Read** / **Write** come from cross-referencing the spec's paths against the routes
  registered in `src/workos/routes/`.
- **Set up** comes from the `EmulatorSeedConfig` keys in `src/index.ts`. A feature declaring
  a seed key that the interface does not define fails the build.
- **Feature** groups the spec's API-shaped tags into products, in
  `scripts/gen-supported-lib.ts`. A spec tag with no feature also fails the build, so a new
  WorkOS product cannot silently disappear from this table.
- Every implemented feature needs a `## <Feature>` section in `docs/behavior.md`, which its row
  links to. One without a section fails the build too.

The prose around the table is hand-written: edit it here, and edit a feature's notes in
`docs/behavior.md`.
