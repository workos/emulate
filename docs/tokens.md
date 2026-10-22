# Tokens, keys and redirects

How the emulator mints and signs tokens, and where it will send a browser: custom claims through
JWT templates, a signing key and issuer that survive restarts, OIDC discovery for clients that look
up their endpoints, and the hosts the authorize endpoints redirect to.

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
`https://api.workos.com/user_management/client_123`. The M2M, SSO, widget and OAuth-server
(`/oauth2/token`) tokens carry the bare value, as does an AuthKit token from a grant that named no `client_id` — there is no client to hang
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
