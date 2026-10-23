# Changelog

## [0.17.0](https://github.com/workos/emulate/compare/v0.16.0...v0.17.0) (2026-10-23)


### Features

* support per-instance AuthKit token lifetimes ([#168](https://github.com/workos/emulate/issues/168)) ([0a45553](https://github.com/workos/emulate/commit/0a45553f9cb57b210f80afd76cf7df71d9f89886))


### Bug Fixes

* **audit-logs:** accept the production event body shape ([#158](https://github.com/workos/emulate/issues/158)) ([12d5f2b](https://github.com/workos/emulate/commit/12d5f2bc8b12a1598732f3ee30bc89b0af1913be))
* **auth:** enforce step-bound pending tokens and refresh org membership ([#164](https://github.com/workos/emulate/issues/164)) ([a7926a5](https://github.com/workos/emulate/commit/a7926a59acb8921e1623a4850c3e4596981bbf87))
* **auth:** one-time-code errors, lockouts and verified-only totp factors ([#159](https://github.com/workos/emulate/issues/159)) ([7bca006](https://github.com/workos/emulate/commit/7bca0061c47cf543fdf33fd3c61f4ddbce85caa4))
* **authorization:** list the environment roles that apply to an organization ([#153](https://github.com/workos/emulate/issues/153)) ([cb173ed](https://github.com/workos/emulate/commit/cb173ed8fcaa8d59c63c93a1059865d6b229b987))
* **authorization:** production slug, deletion and resource list rules ([#160](https://github.com/workos/emulate/issues/160)) ([f6c05da](https://github.com/workos/emulate/commit/f6c05daa7c47e8dfa82ea68d1eb19c8d37c20733))
* **errors:** answer 404s with production's entity_not_found body ([#157](https://github.com/workos/emulate/issues/157)) ([ed8b984](https://github.com/workos/emulate/commit/ed8b984fab182b91a667bdd9f283ab3bc8a5bdb7))
* **organizations:** verify starts dns, domain rules, unique external_id ([#161](https://github.com/workos/emulate/issues/161)) ([4ac1425](https://github.com/workos/emulate/commit/4ac1425bf1585756774da4869a70b51efd812e3b))
* **portal:** validate portal link intents and widget token scopes ([#165](https://github.com/workos/emulate/issues/165)) ([49c6b86](https://github.com/workos/emulate/commit/49c6b86b74937bda10eee2269863d6b8f59ee05f))
* **sso:** one connection per org, create rules, authorize states ([#163](https://github.com/workos/emulate/issues/163)) ([102d2bd](https://github.com/workos/emulate/commit/102d2bd957830439ae51d492c7713f9b7a156980))
* **user-management:** reject what production rejects ([#162](https://github.com/workos/emulate/issues/162)) ([ef8fc50](https://github.com/workos/emulate/commit/ef8fc50f0288afd2bdfe7f3a52475edf14d7473a))
* **webhooks:** PATCH endpoint updates, validate URLs and events, require events on list ([#156](https://github.com/workos/emulate/issues/156)) ([cdde3fa](https://github.com/workos/emulate/commit/cdde3fa2a792510d37a2f6cfd34eccc15cc131e5))

## [0.16.0](https://github.com/workos/emulate/compare/v0.15.0...v0.16.0) (2026-10-20)


### Features

* **user-management:** hold several roles per membership and list an organization's roles ([#146](https://github.com/workos/emulate/issues/146)) ([40cbc50](https://github.com/workos/emulate/commit/40cbc50345dc4f3d10be0dba28bfe1bffd337512))


### Bug Fixes

* **authorization:** emit source.group on role assignments ([#144](https://github.com/workos/emulate/issues/144)) ([8089acf](https://github.com/workos/emulate/commit/8089acfb29cb919eb9736e1f93b320da68829708))
* **invitations:** create the invitee's user and pending membership on invite ([#149](https://github.com/workos/emulate/issues/149)) ([a2c750c](https://github.com/workos/emulate/commit/a2c750c2fb4b2a4354b45d53cbb8cfeca8cd3dbf))
* **memberships:** reactivate an inactive membership on create, refuse a pending one ([#152](https://github.com/workos/emulate/issues/152)) ([826a452](https://github.com/workos/emulate/commit/826a4523b61a82d60e733faf68afcec8b5ca52d9))
* **memberships:** refuse pending deactivate and reactivate, make repeats no-ops ([#150](https://github.com/workos/emulate/issues/150)) ([0498fac](https://github.com/workos/emulate/commit/0498fac374501afb8f9662f61be991a43b5d54fd))

## [0.15.0](https://github.com/workos/emulate/compare/v0.14.0...v0.15.0) (2026-10-15)


### ⚠ BREAKING CHANGES

* **oauth:** serve the AuthKit OAuth server MCP clients sign in through ([#142](https://github.com/workos/emulate/issues/142))

### Features

* Add native group authorization ([#136](https://github.com/workos/emulate/issues/136)) ([dcf3719](https://github.com/workos/emulate/commit/dcf371966efb51335afc413c86510a40280aa5b5))
* Make request budgets configurable ([#133](https://github.com/workos/emulate/issues/133)) ([2fa7f44](https://github.com/workos/emulate/commit/2fa7f44125ffa5b0eaaf116cc38e7fb96cfd5775))
* **oauth:** serve the AuthKit OAuth server MCP clients sign in through ([#142](https://github.com/workos/emulate/issues/142)) ([dcfb3d4](https://github.com/workos/emulate/commit/dcfb3d4e301648b8088fa37003636f6c113f87ba))
* **organizations:** implement IT contacts ([#126](https://github.com/workos/emulate/issues/126)) ([c1edc4c](https://github.com/workos/emulate/commit/c1edc4cf1a06f0c460fef5d6d13f0806f5de1dbb))


### Bug Fixes

* **auth:** replay a refresh token within the 30s grace period ([#137](https://github.com/workos/emulate/issues/137)) ([6bf2edf](https://github.com/workos/emulate/commit/6bf2edfcf802e8064fe4ae85d032d9f7c3558eda))
* **dsync:** match spec payloads for dsync.activated and dsync.deleted ([#132](https://github.com/workos/emulate/issues/132)) ([933e75f](https://github.com/workos/emulate/commit/933e75f9ba2d57176b35cdfb572007be78d1a028))
* **memberships:** honor the plain statuses param and default to active ([#135](https://github.com/workos/emulate/issues/135)) ([34fdbad](https://github.com/workos/emulate/commit/34fdbaded104d37536dd20d22e2981af3d98b3b0))
* **sso:** return token_type, expires_in and profile.name from /sso/token ([#130](https://github.com/workos/emulate/issues/130)) ([83d0480](https://github.com/workos/emulate/commit/83d04803e247f61f59eee35f3976d292c4dac533))

## [0.14.0](https://github.com/workos/emulate/compare/v0.13.1...v0.14.0) (2026-09-22)


### ⚠ BREAKING CHANGES

* **ids:** mint the id prefixes the spec documents ([#122](https://github.com/workos/emulate/issues/122))
* complete the Connect Applications contract ([#121](https://github.com/workos/emulate/issues/121))

### Features

* complete the Connect Applications contract ([#121](https://github.com/workos/emulate/issues/121)) ([b59f904](https://github.com/workos/emulate/commit/b59f904f5b33596539ea40929ca096aca8e6bdff))
* **seed:** create directories, groups and users from config ([#116](https://github.com/workos/emulate/issues/116)) ([7f32b7a](https://github.com/workos/emulate/commit/7f32b7aa8afcec327a3cca4bc58f0c11e5524765))


### Bug Fixes

* accept the event and SSO queries workos-go v10 sends ([#119](https://github.com/workos/emulate/issues/119)) ([99db049](https://github.com/workos/emulate/commit/99db0495b18ca192b93c69873f6e17808b8a9e98))
* **ids:** mint the id prefixes the spec documents ([#122](https://github.com/workos/emulate/issues/122)) ([ad7aa1c](https://github.com/workos/emulate/commit/ad7aa1cee9a7ce2fcc8e0b138cbed9db0869a600))
* return imported connected-account tokens through Pipes ([#117](https://github.com/workos/emulate/issues/117)) ([de4ccdc](https://github.com/workos/emulate/commit/de4ccdcde0339abf416834794aec47cd6e30aa36))

## [0.13.1](https://github.com/workos/emulate/compare/v0.13.0...v0.13.1) (2026-09-15)


### Bug Fixes

* **connect:** complete Standalone Connect logins ([#111](https://github.com/workos/emulate/issues/111)) ([6095131](https://github.com/workos/emulate/commit/60951313a8845edbd3c2009d97e9bdf27cb94528))
* **mfa:** remove three MFA routes the API does not have ([#115](https://github.com/workos/emulate/issues/115)) ([a780aa0](https://github.com/workos/emulate/commit/a780aa0a16c5c881fbe6050311806e0ecdc349af))
* **mfa:** return the spec's auth-factor enrollment envelope ([#114](https://github.com/workos/emulate/issues/114)) ([9b438ee](https://github.com/workos/emulate/commit/9b438eebe5b01a1a6954e099e7bdea72aac8e0d3))
* **users:** match duplicate email creation contract ([#108](https://github.com/workos/emulate/issues/108)) ([c2a609c](https://github.com/workos/emulate/commit/c2a609c94d168634142197672550d12143384433))

## [0.13.0](https://github.com/workos/emulate/compare/v0.12.0...v0.13.0) (2026-09-09)


### Features

* **agents:** add Agent Auth blueprints, tokens, instances and sessions ([#104](https://github.com/workos/emulate/issues/104)) ([9a2f973](https://github.com/workos/emulate/commit/9a2f97322c57b097f1b60fefcae2b0c1bab8cd74))


### Bug Fixes

* **authorization:** create implicit organization roots ([#106](https://github.com/workos/emulate/issues/106)) ([b16cd04](https://github.com/workos/emulate/commit/b16cd0455dc01ee197c06cfa440fc7fc84e76693))

## [0.12.0](https://github.com/workos/emulate/compare/v0.11.0...v0.12.0) (2026-09-03)


### Features

* **auth:** add opt-in password step to interactive login ([#99](https://github.com/workos/emulate/issues/99)) ([993f7f1](https://github.com/workos/emulate/commit/993f7f15d3fd00429dce76b6e833aa8a26fde2db))
* **authorization:** align roles and permissions with the spec (PATCH, 409 conflicts, resource_type_slug) ([#97](https://github.com/workos/emulate/issues/97)) ([1d1c84c](https://github.com/workos/emulate/commit/1d1c84c21c0e812850d5070f1c55c9bfdb450e6d))
* **feature-flags:** align with production contract, add seeding and SDK polling ([#96](https://github.com/workos/emulate/issues/96)) ([ae19616](https://github.com/workos/emulate/commit/ae19616c1919dcfb5311fb2c8db85493079c7151))
* **widgets:** implement /_widgets/ApiKeys for the ApiKeys widget ([#101](https://github.com/workos/emulate/issues/101)) ([5cd33ae](https://github.com/workos/emulate/commit/5cd33ae26a42a07cb3ccaca8e06e5d4fd8ace31f))


### Bug Fixes

* **connect:** resolve applications by client ID ([#92](https://github.com/workos/emulate/issues/92)) ([b4afb88](https://github.com/workos/emulate/commit/b4afb889a8efffd4cf6d85de00d0ff077e073e13))
* emit spec-shaped password_reset_token and password_reset_url ([#100](https://github.com/workos/emulate/issues/100)) ([5e362ee](https://github.com/workos/emulate/commit/5e362eecfa5ecfc22b67dab9617e2156e2f102ca))

## [0.11.0](https://github.com/workos/emulate/compare/v0.10.0...v0.11.0) (2026-08-28)


### Features

* **api-keys:** support runtime key creation ([#87](https://github.com/workos/emulate/issues/87)) ([931971b](https://github.com/workos/emulate/commit/931971b664b41a26e6016f96de673f11a57e7fa3))
* **vault:** emulate object storage routes ([#88](https://github.com/workos/emulate/issues/88)) ([300475b](https://github.com/workos/emulate/commit/300475b4596a98184aa5f2386624eb4c17ba4f84))


### Bug Fixes

* **fga:** align authorization checks and resources with production contract ([#89](https://github.com/workos/emulate/issues/89)) ([ae7abed](https://github.com/workos/emulate/commit/ae7abed78c4c47b44985d25741c3b0a0e3ed6798))
* **invitations:** emit required nullable keys ([#90](https://github.com/workos/emulate/issues/90)) ([cda19b2](https://github.com/workos/emulate/commit/cda19b2e86c270500de075e0a3d358ba12b8cb8b))

## [0.10.0](https://github.com/workos/emulate/compare/v0.9.0...v0.10.0) (2026-08-27)


### Features

* **fga:** implement effective-permissions listing endpoints ([#84](https://github.com/workos/emulate/issues/84)) ([4c444e2](https://github.com/workos/emulate/commit/4c444e2698f551a749fd502e04f3fabde1e97f90))
* **sso:** serve OIDC discovery per AuthKit client ([#80](https://github.com/workos/emulate/issues/80)) ([45b7736](https://github.com/workos/emulate/commit/45b7736606ecd9b978fa6bde73ed10aeb9541dc3))


### Bug Fixes

* **fga:** accept role_slug when creating role assignments ([#83](https://github.com/workos/emulate/issues/83)) ([d454991](https://github.com/workos/emulate/commit/d454991537544badc805437aac81ae78a8599c69))

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
