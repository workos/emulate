# Changelog

## [0.9.0](https://github.com/workos/emulate/compare/v0.8.0...v0.9.0) (2026-08-25)


### Features

* **auth:** interactive organization selection, and an account picker on the sign-in page ([#78](https://github.com/workos/emulate/issues/78)) ([5e7ca56](https://github.com/workos/emulate/commit/5e7ca561b92990b1455fa913c8d2041411244386))

## [0.8.0](https://github.com/workos/emulate/compare/v0.7.1...v0.8.0) (2026-08-21)


### Features

* **seed:** enroll TOTP auth factors from user config ([#77](https://github.com/workos/emulate/issues/77)) ([df078b0](https://github.com/workos/emulate/commit/df078b0685f87ef42c2a7f53b505e1e9b2ca25ec))


### Bug Fixes

* **auth:** gate the password grant on email verification ([#69](https://github.com/workos/emulate/issues/69)) ([799ef19](https://github.com/workos/emulate/commit/799ef19ad18db6bae86f5f9ba267075bb8fdd88e))
* **seed:** honor a pinned webhook signing secret ([#76](https://github.com/workos/emulate/issues/76)) ([5c38781](https://github.com/workos/emulate/commit/5c38781207f5df0474585e2bb59874567dee4452))
* **sso:** redeem an SSO code for a user-management session ([#70](https://github.com/workos/emulate/issues/70)) ([b0ae0e8](https://github.com/workos/emulate/commit/b0ae0e88cfbd13e066cd215270aa7477a0156ca9))
* **users:** populate and shape linked OAuth identities ([#71](https://github.com/workos/emulate/issues/71)) ([71f1322](https://github.com/workos/emulate/commit/71f13225d41e9a89bf12337fd309200b67385f73))
* **users:** populate connected accounts and serve the spec's verbs ([#73](https://github.com/workos/emulate/issues/73)) ([20b4989](https://github.com/workos/emulate/commit/20b4989e97237a09316b5bc55b50978d9f1ba057))

## [0.7.1](https://github.com/workos/emulate/compare/v0.7.0...v0.7.1) (2026-08-13)


### Bug Fixes

* **auth:** complete device authorization grant support ([#64](https://github.com/workos/emulate/issues/64)) ([524ed5d](https://github.com/workos/emulate/commit/524ed5d0d81127915f36f1d12b90115cbffabfc8))

## [0.7.0](https://github.com/workos/emulate/compare/v0.6.0...v0.7.0) (2026-08-07)


### Features

* **groups:** add AuthKit Groups support ([#60](https://github.com/workos/emulate/issues/60)) ([06c1a7f](https://github.com/workos/emulate/commit/06c1a7face47cb6f7d0977c7ae9e9689c2ec97d7))
* **redirects:** make allowed redirect hosts configurable ([#54](https://github.com/workos/emulate/issues/54)) ([363ef25](https://github.com/workos/emulate/commit/363ef253f605d7150d55f234b2d0d4c37b3221e9))


### Bug Fixes

* **auth:** make last_sign_in_at stamp silent on sign-in ([#59](https://github.com/workos/emulate/issues/59)) ([4623a63](https://github.com/workos/emulate/commit/4623a638297538e4d49971182be45023fd875433))
* **auth:** match production's authenticate failure shape per grant ([#53](https://github.com/workos/emulate/issues/53)) ([9028c0a](https://github.com/workos/emulate/commit/9028c0a45bfba0b041cdec4966a825fec1180253))
* **auth:** support Magic Auth sign-up for emails without a user ([#52](https://github.com/workos/emulate/issues/52)) ([c6d7707](https://github.com/workos/emulate/commit/c6d7707f14718caee695b37ea76c78d1791f4a79))
* Directory User Group Filter ([#56](https://github.com/workos/emulate/issues/56)) ([0f2fd2d](https://github.com/workos/emulate/commit/0f2fd2dddcfbbad1c6d11e5c7ab6e8fbee4dae20))

## [0.6.0](https://github.com/workos/emulate/compare/v0.5.0...v0.6.0) (2026-08-05)


### Features

* **docker:** publish container image to GHCR on release ([#45](https://github.com/workos/emulate/issues/45)) ([0c6a89a](https://github.com/workos/emulate/commit/0c6a89a991a5b9b405c20c1886db112d3a9fb417))
* **docs:** generate a feature support matrix ([#47](https://github.com/workos/emulate/issues/47)) ([6a63784](https://github.com/workos/emulate/commit/6a6378449d91c1afe466ad93770cfe3fa3e8c894))


### Bug Fixes

* **auth:** add jti claim to AuthKit access tokens ([#44](https://github.com/workos/emulate/issues/44)) ([c0dab82](https://github.com/workos/emulate/commit/c0dab82f0937c7d26ed7f913beda0d03bf97a743))
* **auth:** add the five missing documented claims to AuthKit tokens ([#46](https://github.com/workos/emulate/issues/46)) ([4dc9066](https://github.com/workos/emulate/commit/4dc906628e77d5380e5d31c69b46d4783ed54679))
* **ci:** grant packages:write for GHCR release job ([c0980f7](https://github.com/workos/emulate/commit/c0980f72430ed29dbbf633cb23e41307db32a774))
* **jwt-template:** mirror production context for org domains, user, org, and membership ([#42](https://github.com/workos/emulate/issues/42)) ([0fc88c1](https://github.com/workos/emulate/commit/0fc88c13bbf604b65b79dd658051757b2d852be2))
* **users:** include name field on user objects ([#43](https://github.com/workos/emulate/issues/43)) ([76483fb](https://github.com/workos/emulate/commit/76483fbdccaa2f2ba21cef565422d98dc1a7baaa))
* **webhooks:** match the WorkOS signature header ([#41](https://github.com/workos/emulate/issues/41)) ([580ef50](https://github.com/workos/emulate/commit/580ef5068d443f99ecd7d73268666736f152255d))

## [0.5.0](https://github.com/workos/emulate/compare/v0.4.1...v0.5.0) (2026-08-04)


### Features

* **jwt:** apply JWT templates and pin the signing key ([#32](https://github.com/workos/emulate/issues/32)) ([f2da8b5](https://github.com/workos/emulate/commit/f2da8b596a3f6dd6d5ae761c81ec51fbc32c042d))

## [0.4.1](https://github.com/workos/emulate/compare/v0.4.0...v0.4.1) (2026-07-27)


### Bug Fixes

* align M2M tokens, API key validation, and JWKS with the spec ([#29](https://github.com/workos/emulate/issues/29)) ([b7746ab](https://github.com/workos/emulate/commit/b7746aba4d087d5cc840af30d623089fd515f007))
* **auth:** scope AuthKit sessions to an organization ([#31](https://github.com/workos/emulate/issues/31)) ([c3fe11a](https://github.com/workos/emulate/commit/c3fe11aafed7e0bcb3c8a5bff2bfc59901454fd1))

## [0.4.0](https://github.com/workos/emulate/compare/v0.3.0...v0.4.0) (2026-07-27)


### Features

* convert toolchain to Bun and ship standalone binaries ([#27](https://github.com/workos/emulate/issues/27)) ([122a3aa](https://github.com/workos/emulate/commit/122a3aa4c4e02072c205ae29d237a3857d09c2a7))


### Bug Fixes

* bind emulator server to localhost by default ([#21](https://github.com/workos/emulate/issues/21)) ([5a0fd1b](https://github.com/workos/emulate/commit/5a0fd1bffdd698384059249e76800b5b3982ea27))

## [0.3.0](https://github.com/workos/emulate/compare/v0.2.2...v0.3.0) (2026-07-21)


### Features

* **seed:** pin organization and user ids ([#19](https://github.com/workos/emulate/issues/19)) ([7736e10](https://github.com/workos/emulate/commit/7736e1062fa188ec055345726bc72de0d83930e6))

## [0.2.2](https://github.com/workos/emulate/compare/v0.2.1...v0.2.2) (2026-07-21)


### Bug Fixes

* **memberships:** Emit directory_managed, roles, and user on organization_membership ([#15](https://github.com/workos/emulate/issues/15)) ([8dbc218](https://github.com/workos/emulate/commit/8dbc218a056e8a4174082aaea768ec54e0ce6df4))
* **seed:** join org memberships to users by email + validate references ([#16](https://github.com/workos/emulate/issues/16)) ([2d89866](https://github.com/workos/emulate/commit/2d89866aa613f09829375a77e84d03447fceb97d))

## [0.2.1](https://github.com/workos/emulate/compare/v0.2.0...v0.2.1) (2026-07-14)


### Bug Fixes

* **auth:** Echo original session method on refresh_token ([#14](https://github.com/workos/emulate/issues/14)) ([97fb951](https://github.com/workos/emulate/commit/97fb95195d7829973df8b5b29ed9efd1365a6cae))
* **auth:** Emit spec-valid authentication_method ([#12](https://github.com/workos/emulate/issues/12)) ([3066f71](https://github.com/workos/emulate/commit/3066f71f80fef087b176350b5b25bcbadcda1182))

## [0.2.0](https://github.com/workos/emulate/compare/v0.1.0...v0.2.0) (2026-07-12)


### Features

* add response-shape conformance codegen and test ([#9](https://github.com/workos/emulate/issues/9)) ([358773b](https://github.com/workos/emulate/commit/358773b8626b35f0191653e3a4341ebd652b37fe))
* provide an end-to-end login flow story with spec-accurate webhooks ([#2](https://github.com/workos/emulate/issues/2)) ([fa39dfe](https://github.com/workos/emulate/commit/fa39dfe3b798b2916cffb339d44001b8926d7a13))
* seed M2M apps and API keys ([#10](https://github.com/workos/emulate/issues/10)) ([f761419](https://github.com/workos/emulate/commit/f76141957c88ab64f138d44d87c1b204a262c921))

## [0.1.0](https://github.com/workos/emulate/compare/v0.0.1...v0.1.0) (2026-06-01)


### Features

* add error responding to emulation ([4fb1639](https://github.com/workos/emulate/commit/4fb16390c56d62e97c35af97401cf863ad0a468a))
* add interactive auth ([424f9ef](https://github.com/workos/emulate/commit/424f9ef3e16971920341ae17c639e2b9c6d91bb4))
