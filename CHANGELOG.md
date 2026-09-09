# Changelog

All notable changes to Lore will be documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions and uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## Unreleased

### Fixed

- Preserve fragmented Pi worker responses, recover after worker exit, and drain work during graceful shutdown.
- Refresh stale embedding caches, filter weak semantic matches, and bound incremental indexing and inference latency.
- Bound Pi archive scanning and resolve imported file paths against the source session's working directory.
- Serve the dashboard over IPv6 loopback and reject malformed request URLs without terminating the server.

### Changed

- Add Pi transport, adapter, worker, and archive regression coverage; expand lint and the Node/Linux/macOS CI matrix.
- Clarify that schema validation checks committed defaults, not the user's configuration file.

## [0.16.1](https://github.com/matt-riley/lore/compare/lore-v0.16.0...lore-v0.16.1) (2026-09-09)


### Bug Fixes

* address review scope and export safety ([5660a30](https://github.com/matt-riley/lore/commit/5660a3069e21592bb2f1ad91d17341195a9f7538))
* close memory scope and recovery gaps ([610267e](https://github.com/matt-riley/lore/commit/610267e315f9cdbd3bb13abc41a6cafbf1a1ab3c))
* cover mixed directives and empty paths ([861795d](https://github.com/matt-riley/lore/commit/861795d978ebb48fd7bd1648ffa60fbc4bacf175))
* override vulnerable transitive sharp ([a44a783](https://github.com/matt-riley/lore/commit/a44a783cd4a42b1a4ad55f5c50bbd37e65a3a791))
* parse persisted replay provenance ([240e545](https://github.com/matt-riley/lore/commit/240e54537a248e328a2b35c1ad5119c6efd3e107))
* pin sharp security override ([4339801](https://github.com/matt-riley/lore/commit/4339801dc9c9634fb73fc864bbfdbc9a1ec139d8))

## [0.16.0](https://github.com/matt-riley/lore/compare/lore-v0.15.2...lore-v0.16.0) (2026-09-08)


### Features

* add a human lore CLI and install a PATH shim ([e9b1aa5](https://github.com/matt-riley/lore/commit/e9b1aa58727be685dd6bc74da6737dab611daa89))
* expose the full Lore verb set on Pi via RPC and /lore ([aea2578](https://github.com/matt-riley/lore/commit/aea2578049b307fdd4f6869e340acaf827eb88ed))
* give native CLIs and Pi a SessionSource over ingested episodes ([e6c2c14](https://github.com/matt-riley/lore/commit/e6c2c145174601ba1935990939f75754cd9fd353))
* make lore_* the canonical verb set for every host ([e4e3005](https://github.com/matt-riley/lore/commit/e4e3005b776b9071304cf19f02c9abad4c39b8cb))
* run Copilot on createLoreSession with /lore and a nine-tool model list ([dfcc555](https://github.com/matt-riley/lore/commit/dfcc555f41fad8134d1140896d64dab2940bf160))
* tighten extraction, key preferences, expire volatile memory, and fuse ranking ([2616cbc](https://github.com/matt-riley/lore/commit/2616cbc6665b50e9e0ee8d6a4b15822fc6959165))


### Bug Fixes

* address review feedback for Copilot /lore facade ([7318313](https://github.com/matt-riley/lore/commit/7318313b2103b0fb256442080c0242ef4da59896))
* address review feedback for extraction ranking ([51c72f9](https://github.com/matt-riley/lore/commit/51c72f98cf34b264dfee38c2407651d85d09e888))
* address review feedback for feat: canonical lore_* verb set ([c466084](https://github.com/matt-riley/lore/commit/c466084323c291671052f247422bdb8330767b7a))
* address review feedback for one recall assembler ([ec58649](https://github.com/matt-riley/lore/commit/ec586492284e66438ad41ae915e25b2e827566a1))
* align Pi smoke harness and docs with fused recall ranking ([bbd0a55](https://github.com/matt-riley/lore/commit/bbd0a5555a79ef8333b3c6f05da4c3463eadf072))
* align support-matrix category header and extension import test ([b0d59b9](https://github.com/matt-riley/lore/commit/b0d59b945578353f5cb1ed3bc1b961b3797e96fb))
* make knip CI gate actionable ([47f8a9d](https://github.com/matt-riley/lore/commit/47f8a9d0cea27b6bcec396ab13002a3d7771d316))
* stabilize main CI runtime and replay gates ([2836654](https://github.com/matt-riley/lore/commit/2836654b1292d35b3822adae4f9900b36b06007e))

## [0.15.2](https://github.com/matt-riley/lore/compare/lore-v0.15.1...lore-v0.15.2) (2026-09-07)


### Bug Fixes

* **cli:** prevent interactive TTY hang and improve diagnostic logging ([#114](https://github.com/matt-riley/lore/issues/114)) ([5311ef8](https://github.com/matt-riley/lore/commit/5311ef819f4bf2cf7063c2312dbc8fc472b62e86))
* **db:** safely quote SQL identifiers in PRAGMA and ALTER statements ([#113](https://github.com/matt-riley/lore/issues/113)) ([f79b91b](https://github.com/matt-riley/lore/commit/f79b91b52e8fdb21823290fc94b38bfa8a38ed86))
* **extraction:** eliminate false-positive directive capture and semantic drift ([#116](https://github.com/matt-riley/lore/issues/116)) ([07ccd43](https://github.com/matt-riley/lore/commit/07ccd43af2a756710b6972f06bb1775b26f95bae))
* **security:** prevent DNS rebinding and protect static dashboard assets ([#115](https://github.com/matt-riley/lore/issues/115)) ([a33fea4](https://github.com/matt-riley/lore/commit/a33fea496902ba91dbb1cb490239ae81c3108dfd))

## [0.15.1](https://github.com/matt-riley/lore/compare/lore-v0.15.0...lore-v0.15.1) (2026-09-07)


### Performance Improvements

* **website:** tree-shake lazy three runtime ([9615195](https://github.com/matt-riley/lore/commit/9615195e85555155f5f1e2a144f452a39edff55a))

## [0.15.0](https://github.com/matt-riley/lore/compare/lore-v0.14.0...lore-v0.15.0) (2026-09-07)


### Features

* add bounded resumable JSONL reader ([7e9bc7e](https://github.com/matt-riley/lore/commit/7e9bc7e4a2ab4ed1cb0b419b440ad9a6804cb601))
* add fingerprinted memory administration ([c1bb9f0](https://github.com/matt-riley/lore/commit/c1bb9f0a39556e20197e93ebee0d51bdec860bd2))
* **browser:** expose reliability provenance and health ([73b148d](https://github.com/matt-riley/lore/commit/73b148d8d53d1ad2c276eddfcb6229bd1ec54b51))
* **capture:** add resumable native transcript ingestion ([b5fb275](https://github.com/matt-riley/lore/commit/b5fb275863fe62edd9ed9565fcc210146ba986b3))
* **db:** provide a read-only facade for previews ([14847d8](https://github.com/matt-riley/lore/commit/14847d86b68d08b7e25f6957ad637b4e28ea1ec3))
* enforce shared retrieval eligibility and budgets ([bd9d09f](https://github.com/matt-riley/lore/commit/bd9d09fdb7225e6a557322b2bf808216bc0b760c))
* register memory administration tools ([3649382](https://github.com/matt-riley/lore/commit/364938254ccd56e8d11e7e264fc2ba6509b5a703))


### Bug Fixes

* **administration:** align native apply and documented repair contracts ([92c3c4d](https://github.com/matt-riley/lore/commit/92c3c4d57fc8a3bd7b61993c402030f1cfb3ef84))
* **administration:** apply exact source-backed lifecycle plans ([568bac5](https://github.com/matt-riley/lore/commit/568bac5c5469c9926057848381f2da76c0854c68))
* **administration:** close source and destination review gaps ([b603350](https://github.com/matt-riley/lore/commit/b603350a83253d3366668902f054393ce7429503))
* **administration:** keep memory repairs source-scoped ([4f11177](https://github.com/matt-riley/lore/commit/4f11177645023e05c5e9adfb93bf9ac366bda049))
* **administration:** reject missing repository purge targets ([3f2c038](https://github.com/matt-riley/lore/commit/3f2c0385c5c3176bc72c9f926a7487a73a3213d7))
* **administration:** require verified source session identities ([6eef264](https://github.com/matt-riley/lore/commit/6eef264833e240565fd549da734ce8b7c4843f98))
* **admin:** record complete preview selectors ([5b47bd3](https://github.com/matt-riley/lore/commit/5b47bd3d7cf96420c9f1ebcec81a2549d45a03a2))
* bound prompt fallback to scored FTS candidates ([2fcc7fc](https://github.com/matt-riley/lore/commit/2fcc7fc9214faf2005f667a58563dd523115a7cc))
* bound suppression reads and preserve retrieval authority ([b9f83de](https://github.com/matt-riley/lore/commit/b9f83defce6195142278e93b15aad3935b653924))
* **browser:** close reliability dashboard review gaps ([62839fc](https://github.com/matt-riley/lore/commit/62839fc5f2d0bf439ef8fa4eb32d6720b7a62a2f))
* **browser:** inspect structured fallback diagnostics ([859cacb](https://github.com/matt-riley/lore/commit/859cacb31bdba9bdc5e10c10d459fe968fe4c828))
* **browser:** make dashboard commands and status truthful ([1d0ae8f](https://github.com/matt-riley/lore/commit/1d0ae8f9aed4103f86d4d478b110f4f70662f64a))
* **browser:** resolve preview CLI path and repair suppression state ([d24b77b](https://github.com/matt-riley/lore/commit/d24b77b7fafebabc1cdee8fc3130388fee7ce1b4))
* **capture:** bound accepted text work without losing new evidence ([d2b49a3](https://github.com/matt-riley/lore/commit/d2b49a31e72c16876e7cbb8813c1a73af029bdb3))
* **capture:** bound adapter state and preserve source revisions ([b4c3df9](https://github.com/matt-riley/lore/commit/b4c3df92eee4f1056d183afb8fbc524e5cd270d1))
* **capture:** bound ledger queries and include source probe work ([8beeec7](https://github.com/matt-riley/lore/commit/8beeec7f42da481482459d043f1b1dedbd0cd046))
* **capture:** close resume review gaps ([77dcb61](https://github.com/matt-riley/lore/commit/77dcb616a9a4b9b20489597b0bf96da3ec166b58))
* **capture:** detect archive rewrites with preserved timestamps ([2cba041](https://github.com/matt-riley/lore/commit/2cba041168db6a360923ddd7bc5fb9c741146152))
* **capture:** distinguish short appends and cap accepted records ([6ed8e75](https://github.com/matt-riley/lore/commit/6ed8e750d972fe4c077b75291d2075460108bc63))
* **capture:** guard rotated identities and branch restoration ([dcc59f8](https://github.com/matt-riley/lore/commit/dcc59f82a3ba562cf7074177318d110c280f9e08))
* **capture:** harden archive identity and bootstrap ([d3f4181](https://github.com/matt-riley/lore/commit/d3f4181c4176135e731e8137aff664afa58b9e3a))
* **capture:** include archive context in diagnostics ([2f420aa](https://github.com/matt-riley/lore/commit/2f420aad846e1031a22e4470204eb06de14b86c7))
* **capture:** persist retryable capture health ([db80a11](https://github.com/matt-riley/lore/commit/db80a11c896af5c47f270947f94e6c69e2eed994))
* **capture:** reconcile source evidence with bounded adapter state ([6ee348d](https://github.com/matt-riley/lore/commit/6ee348dbc774cb2ea4f1b60e07956ca4276bfcd2))
* **capture:** restore evidence when returning to an earlier branch ([081a384](https://github.com/matt-riley/lore/commit/081a3842cc367a59dcbace030cb44eb7970acbcf))
* **capture:** validate native identities on normal hooks ([412bd25](https://github.com/matt-riley/lore/commit/412bd255b9d388f30bc891eadd4a74e0da90d568))
* classify Pi command saves as manual ([45b247f](https://github.com/matt-riley/lore/commit/45b247f61b0c62e8a42aaa5c3df71315d8b8bfe5))
* **cli:** open administration previews without initializing the store ([07658ff](https://github.com/matt-riley/lore/commit/07658ff978e2f41788f05c953c971daaf8bef6fb))
* **cli:** resume Pi capture and bound Antigravity prompt reads ([6d07fc2](https://github.com/matt-riley/lore/commit/6d07fc2bb7ce5ccac22e0e6c2b96d49bb8556498))
* close administration lifecycle invariants ([2c65ebf](https://github.com/matt-riley/lore/commit/2c65ebfbba9c7814210a05291b2bf1d0389159c0))
* close retrieval eligibility and indexing gaps ([bc00133](https://github.com/matt-riley/lore/commit/bc0013379d3af2abc8cbb56aceb210fab0a47149))
* close retrieval pagination and budget gaps ([f4c6713](https://github.com/matt-riley/lore/commit/f4c671373cb13b4d494372a285c35ef8fabc7815))
* **context:** budget complete entries and trace only rendered evidence ([5f65b83](https://github.com/matt-riley/lore/commit/5f65b83615655ee031baffbe1ec1891a6395b167))
* **copilot:** skip context after initialization failure ([a436cf4](https://github.com/matt-riley/lore/commit/a436cf45f18853e81a6c486bdd41b3d32096141d))
* **db:** rebuild retired evidence index during migration ([87a018a](https://github.com/matt-riley/lore/commit/87a018a271c593d87b09889e929a7984b7fcf306))
* enforce administration selector boundaries ([91061ee](https://github.com/matt-riley/lore/commit/91061ee9311885811ea0ea4187709fab324eb41a))
* fail safe on unknown purge aggregates ([206fd63](https://github.com/matt-riley/lore/commit/206fd63b32408c0d8460e5217eb42638de30e8c9))
* **identity:** preserve source cwd and canonical adapter resolution ([38e6790](https://github.com/matt-riley/lore/commit/38e67909f1d9cb5a2cfef27e2a7cc9ffb2a3b315))
* improve natural prompt recall and embedding traversal ([c3e3320](https://github.com/matt-riley/lore/commit/c3e33202168643dcc6316798462a48b8d3b5f8a9))
* include decisions in recall paths ([60b63be](https://github.com/matt-riley/lore/commit/60b63befd3448e9cc7ff4a95f24e9b0b336735d4))
* **maintenance:** resolve approved repository identities ([7dda4eb](https://github.com/matt-riley/lore/commit/7dda4eb980483d7684b3f27fd9fda88b7146c4aa))
* persist partial semantic embeddings ([58bfc2f](https://github.com/matt-riley/lore/commit/58bfc2f9220921ce3be21724217a781c504d2752))
* **pi:** restore typed fallback for explicit recall ([3fe2e10](https://github.com/matt-riley/lore/commit/3fe2e10b931f5ce098c25271ca472f69c04342c9))
* **pi:** resume archive tails and share the recall budget pipeline ([f3d40bf](https://github.com/matt-riley/lore/commit/f3d40bf47ffb2bf84a0cb38adf1fe8be6415bbd1))
* preserve prompt acronym and morphology matches ([92ad2f5](https://github.com/matt-riley/lore/commit/92ad2f5c9125dafbf290fe080ae1d2b0608c370d))
* **recall:** retain relevant style evidence without ambient injection ([7dc81f1](https://github.com/matt-riley/lore/commit/7dc81f15d6f4d21abf1b297ab227cc8648e1de6e))
* **recovery:** preserve forgotten manual identities during restore ([7d174b4](https://github.com/matt-riley/lore/commit/7d174b450f17440b719329cb928cc60146635894))
* reject foreign administration targets ([68c3942](https://github.com/matt-riley/lore/commit/68c3942baaf0684bf911d62dcc0bc936dd1776d8))
* **reliability:** harden capture and attribution ([51bd056](https://github.com/matt-riley/lore/commit/51bd056f575f5f112fcfcb5fccba006058e4642b))
* report postcommit verification failures ([a0528b3](https://github.com/matt-riley/lore/commit/a0528b30ad05b612421405a3975d45f7bd9a3b0a))
* **retrieval:** constrain rendered trace suffix matching ([fb5d036](https://github.com/matt-riley/lore/commit/fb5d036e3a86bfccb204a4021037a6318e0924ae))
* **retrieval:** harden scopes budgets and identity caching ([954e0bd](https://github.com/matt-riley/lore/commit/954e0bd4dd995a7a5786e57b916f4186e70d574f))
* **retrieval:** read approved legacy repository aliases ([2f40678](https://github.com/matt-riley/lore/commit/2f40678c67d9ff128f1132b338d23b35d100759d))
* support unaliased retrieval policy queries ([0114079](https://github.com/matt-riley/lore/commit/01140791f9a65af4c192c169dae62c2adae9b900))
* **tools:** expose administration apply selection and limits ([1bd48b0](https://github.com/matt-riley/lore/commit/1bd48b0d2a339363b788c57ff57cc401a421bb98))
* use raw sqlite handle for administration scans ([61ab7e9](https://github.com/matt-riley/lore/commit/61ab7e9d57b572997617c93e81cb8930fcf8ba6e))
* validate bounded transcript reader inputs ([b69db25](https://github.com/matt-riley/lore/commit/b69db25f525748050a6dfee0f92a1c76da5b546c))

## [0.14.0](https://github.com/matt-riley/lore/compare/lore-v0.13.1...lore-v0.14.0) (2026-09-07)


### Features

* **db:** add durable lifecycle foundation ([b13bb2e](https://github.com/matt-riley/lore/commit/b13bb2e492699ae0c3d5255feaf1f6609e489a78))
* make session extraction conservative and traceable ([f06fd52](https://github.com/matt-riley/lore/commit/f06fd526eebd3bf466819754ec95f192b61528f0))


### Bug Fixes

* attribute assistant extraction to individual source records ([a5e9141](https://github.com/matt-riley/lore/commit/a5e91416a1d14b268b6d0a6aef06ee89dca5d2c4))
* close extraction review gaps ([d70002d](https://github.com/matt-riley/lore/commit/d70002d7a6824cd931e1551ffe5abe3596d43302))
* **db:** harden lifecycle schema and checkpoint CAS ([c7ec6ee](https://github.com/matt-riley/lore/commit/c7ec6ee1aa7258bb6de971e914e2b08258c25788))
* **db:** isolate suppression across evidence revisions ([a872a56](https://github.com/matt-riley/lore/commit/a872a56faf7e3c5c9d697d021c76f0171c55e81f))
* **db:** make direct backup restore atomic ([a6b6f67](https://github.com/matt-riley/lore/commit/a6b6f6729711cf513ca333d25440ffccd520997b))
* **db:** make extraction lifecycle writes atomic ([783f2fa](https://github.com/matt-riley/lore/commit/783f2fa364d11f604d79e2320592abb5a9c957a4))
* **db:** preserve evidence authority through replay and recovery ([5126914](https://github.com/matt-riley/lore/commit/51269140411ec06fe8e059797d31ec55ce62823a))
* **db:** preserve scoped manual precedence ([268b853](https://github.com/matt-riley/lore/commit/268b8532f94a8b07626fad58ef20cbc2a2a3316a))
* distinguish standing policies and related decision reversals ([115fcb2](https://github.com/matt-riley/lore/commit/115fcb2ab125102d7df8f7d2b81b1eb26e17ee77))
* **extraction:** exclude temporary and informational persona requests ([f045610](https://github.com/matt-riley/lore/commit/f0456101d701b2c4d3e67313b22d6f084918f0e8))
* **extraction:** scope and attribute persona and recurring feedback ([87b820d](https://github.com/matt-riley/lore/commit/87b820dc588e7e998a63cd37e21d9579f4ebed96))
* harden conservative extraction review gaps ([287d6d0](https://github.com/matt-riley/lore/commit/287d6d0d13c2bf38be0f3a8eba254d893b14d1d6))
* preserve host and worktree identity for repository scopes ([a4ad2ce](https://github.com/matt-riley/lore/commit/a4ad2cefd8b5c24c56718ee8182515e34b4ce8c3))
* reconcile all corroborating decision evidence on reversal ([f561d00](https://github.com/matt-riley/lore/commit/f561d003f1d89ec88526c3974f9029e57f2322eb))
* reject incidental extraction outcomes ([0748146](https://github.com/matt-riley/lore/commit/07481463dfc1260acab42742ef21dae4f1f82542))
* retain qualified standing rules and current conversation outcomes ([a3819ac](https://github.com/matt-riley/lore/commit/a3819ac14f1160e90a3400216f52a51e23ee92a8))


### Performance Improvements

* **db:** index bounded evidence and suppression lookups ([906e2bd](https://github.com/matt-riley/lore/commit/906e2bd084c6ab50bae947fd75c2b056320c251e))

## [0.13.1](https://github.com/matt-riley/lore/compare/lore-v0.13.0...lore-v0.13.1) (2026-09-07)


### Bug Fixes

* direct hook installer users to universal setup ([4dd22dc](https://github.com/matt-riley/lore/commit/4dd22dc1c03bdb1ac5041aa89bc84d72da138b1b))
* keep Astro checking on compatible TypeScript 6 ([36a8150](https://github.com/matt-riley/lore/commit/36a8150c504780007d06c13918474eac041e2600))

## [0.13.0](https://github.com/matt-riley/lore/compare/lore-v0.12.0...lore-v0.13.0) (2026-09-06)


### Features

* add safe Lore database recovery commands ([da5799d](https://github.com/matt-riley/lore/commit/da5799d2be41bd3b2914363bb555fbcb895db20e))
* add safe Lore installer removal ([a20cdad](https://github.com/matt-riley/lore/commit/a20cdad1622ab43947648f3ee2a1eb2acb481fd7))
* validate supported node runtime ([641ff65](https://github.com/matt-riley/lore/commit/641ff655b861964bbdd532a6598ee736d858dfbb))


### Bug Fixes

* bound long memory previews in dashboard tables ([e9195bf](https://github.com/matt-riley/lore/commit/e9195bf8890092a2dff84c3e86850de286c30d7d))
* clean stale install records and successful probe artifacts ([a435f91](https://github.com/matt-riley/lore/commit/a435f91181229c0728a8e1516f752f7502709060))
* enforce loopback binding at dashboard server boundary ([642fe49](https://github.com/matt-riley/lore/commit/642fe494736ebca9189f38556bc50363506cf31e))
* handle closed stdin in client verification probes ([88e78b5](https://github.com/matt-riley/lore/commit/88e78b57dfecc50efa9a36aae5e22405b590e7f5))
* harden database schema adoption safety ([97672d9](https://github.com/matt-riley/lore/commit/97672d94c0d3c466003fc01cb33f9f65cd3bb281))
* harden Lore recovery replacement ([4e19644](https://github.com/matt-riley/lore/commit/4e196443d31509b7525cc203186abe1eb1bde5c3))
* include snapshot WAL in recovery validation ([b7cf1fb](https://github.com/matt-riley/lore/commit/b7cf1fb92fdf247af5def8a33f10af472946fd1e))
* label dashboard memory filters for assistive technology ([b02897b](https://github.com/matt-riley/lore/commit/b02897bedd15eaea1c378c95ebc47796bdee34c0))
* migrate legacy domain column before schema indexes ([95897b4](https://github.com/matt-riley/lore/commit/95897b4379c9a8b374f2e5d1bf40a3da07cc23f2))
* preflight pi runtime before database startup ([d86327b](https://github.com/matt-riley/lore/commit/d86327b33a03efa384902d59f5fc48dec89d5522))
* preserve installer edits during rollback ([795fc27](https://github.com/matt-riley/lore/commit/795fc27a02c27394abc20f6173c3162f064bc6cc))
* preserve installer ownership at removal and rollback boundaries ([8f487af](https://github.com/matt-riley/lore/commit/8f487af70778e3a5e97e941d5dc1a82ba25e2e9c))
* preserve orphan database journals during recovery ([325b792](https://github.com/matt-riley/lore/commit/325b7927f583741440e0db1d3eee364b196e351c))
* recall scoped evidence from natural prompts and explicit dates ([426db53](https://github.com/matt-riley/lore/commit/426db53ee756d68c1b3e342ae8a09bea18cdf60d))
* tighten existing dedicated Lore home permissions ([d35803f](https://github.com/matt-riley/lore/commit/d35803f8189c0b9409e967287e18441fcfc0d242))
* validate explicit calendar dates ([aec55d3](https://github.com/matt-riley/lore/commit/aec55d38d60a6d4094ae4788e36f15363a0517c9))
* validate installer ownership manifests before planning writes ([1bc5149](https://github.com/matt-riley/lore/commit/1bc5149f2bce042e424788fef4f9dca575ca7f0a))
* validate recovery against canonical schema ([12733ae](https://github.com/matt-riley/lore/commit/12733ae2a25993839e548978008a9b880003f089))
* validate shared schema versions and recovery snapshots ([e616aeb](https://github.com/matt-riley/lore/commit/e616aeb49f84361ab2cf7ac0aaeb533facdee07f))

## [0.12.0](https://github.com/matt-riley/lore/compare/lore-v0.11.0...lore-v0.12.0) (2026-09-06)


### Features

* add guided setup for all supported coding agents ([9f128b7](https://github.com/matt-riley/lore/commit/9f128b73250fb0048a5174516b888cefd4e446f5))

## [0.11.0](https://github.com/matt-riley/lore/compare/lore-v0.10.2...lore-v0.11.0) (2026-09-06)


### Features

* add native Codex Claude and Antigravity integrations ([4246555](https://github.com/matt-riley/lore/commit/42465555e825067af1611ff4e2c171c8039814c6))


### Bug Fixes

* make semantic memory refreshes transactional ([9a10de5](https://github.com/matt-riley/lore/commit/9a10de5d78b8af387dbe6bec8a572d501d6b9813))

## [0.10.2](https://github.com/matt-riley/lore/compare/lore-v0.10.1...lore-v0.10.2) (2026-09-06)


### Bug Fixes

* configure Astro site for Cloudflare Workers ([e7f5bf2](https://github.com/matt-riley/lore/commit/e7f5bf28a2295f58cffe48b120d05325a0de7222))
* match Cloudflare Worker name ([0cc890d](https://github.com/matt-riley/lore/commit/0cc890d2af9e52f5a546ae7a9bf73c6c980d07e3))

## [0.10.1](https://github.com/matt-riley/lore/compare/lore-v0.10.0...lore-v0.10.1) (2026-09-06)


### Bug Fixes

* **browser:** handle IPv6 loopback and malformed request URLs ([05d10be](https://github.com/matt-riley/lore/commit/05d10be02e956b34e1b2bdffbacb53a737af59cc))
* **pi:** bound archive scanning and preserve import provenance ([a84ef0f](https://github.com/matt-riley/lore/commit/a84ef0fcc1be649157a5ce30632dfd4ca2d249bc))
* **pi:** preserve streamed responses and recover worker lifecycle ([42f6045](https://github.com/matt-riley/lore/commit/42f6045ebfaf8a29fe10a98f1ba72b6212d262b1))
* **recall:** validate embedding caches and bound semantic indexing ([4c3c10d](https://github.com/matt-riley/lore/commit/4c3c10d9bcbf5ce3ee492913270f521a8d3c5de6))

## [0.10.0](https://github.com/matt-riley/lore/compare/lore-v0.9.0...lore-v0.10.0) (2026-09-06)


### Features

* add pi coding agent adapter with recall, extraction, and semantic search ([d3433ee](https://github.com/matt-riley/lore/commit/d3433ee38cbc2c97105d215c21ebc61e438b70f5))
* add semantic (vector) search over stored memories ([b7dedab](https://github.com/matt-riley/lore/commit/b7dedabf78be0180117e3f502beffbec24473634))
* automate Lore memory hygiene ([#70](https://github.com/matt-riley/lore/issues/70)) ([3e2dd9d](https://github.com/matt-riley/lore/commit/3e2dd9df63d4853517677d04b0e9dd4a31ca6a60))
* full lore_onboard profile in pi + replace-semantics for re-onboarding ([23e0e02](https://github.com/matt-riley/lore/commit/23e0e021be238fb44aaff8c59c890c3707a49a99))
* improve Lore hook reliability and observability ([#69](https://github.com/matt-riley/lore/issues/69)) ([2e75493](https://github.com/matt-riley/lore/commit/2e75493c6046652cfbdb3fc8a908eb900b9e4fe2))


### Bug Fixes

* improve local reflection relevance ([#61](https://github.com/matt-riley/lore/issues/61)) ([eaa715c](https://github.com/matt-riley/lore/commit/eaa715c7a11b8a5ff938cd87bf63d694c6101ad6))
* let release-please finish before processing new pushes ([0a77213](https://github.com/matt-riley/lore/commit/0a772138c931c6e577ff09c6ee66fffcfa542f54))
* make Lore tests path-independent ([#81](https://github.com/matt-riley/lore/issues/81)) ([9b6c392](https://github.com/matt-riley/lore/commit/9b6c392c071bfa5b9ff916188e1a65dbc2385e39))
* pass pi notify(title, level) instead of (title, message, level) ([78c7815](https://github.com/matt-riley/lore/commit/78c78159a4054b990c40541dd0f7494d9dc548ca))
* preserve merged hook handlers ([a2a1ad1](https://github.com/matt-riley/lore/commit/a2a1ad19cc6c52fa4cbd751005d0f8c12eda8c54))
* prevent durable trace ID collisions ([#71](https://github.com/matt-riley/lore/issues/71)) ([e65141b](https://github.com/matt-riley/lore/commit/e65141bf2d6ffd76aaf956b78c2ee7ed15664cae))
* recover stale Lore maintenance work ([4614e7a](https://github.com/matt-riley/lore/commit/4614e7a6127bd4a5892e164d1aee0e8c2747b0ca))


### Performance Improvements

* cache pi ambient recall per session and hide it from the TUI ([e5df524](https://github.com/matt-riley/lore/commit/e5df5248dd31daee26824ce591ef26d2b08df926))

## [0.9.0](https://github.com/matt-riley/lore/compare/lore-v0.8.1...lore-v0.9.0) (2026-07-15)


### Features

* add grounded local inference augmentations ([#60](https://github.com/matt-riley/lore/issues/60)) ([97bf141](https://github.com/matt-riley/lore/commit/97bf14133cb6cedc597360f578f106131fc049da))
* **memory:** add opt-in local inference ([#58](https://github.com/matt-riley/lore/issues/58)) ([96d5d92](https://github.com/matt-riley/lore/commit/96d5d9201c5775a52c56c0713d522ebbc1e160ee))

## [0.8.1](https://github.com/matt-riley/lore/compare/lore-v0.8.0...lore-v0.8.1) (2026-07-08)


### Bug Fixes

* **memory:** address OKF import review comments (bounded reads, valid rollback query) ([f558403](https://github.com/matt-riley/lore/commit/f558403bbb9f6031c3dab0d4d75bc2f44a5b0b84))

## [0.8.0](https://github.com/matt-riley/lore/compare/lore-v0.7.1...lore-v0.8.0) (2026-07-07)


### Features

* **memory:** add OKF markdown export format to memory_portable_bundle ([#52](https://github.com/matt-riley/lore/issues/52)) ([bf92978](https://github.com/matt-riley/lore/commit/bf929786254c9e3f1b6bc36eb31fc27fec5aa033))

## [0.7.1](https://github.com/matt-riley/lore/compare/lore-v0.7.0...lore-v0.7.1) (2026-07-03)


### Bug Fixes

* **memory:** durable writes + accurate session counts ([#48](https://github.com/matt-riley/lore/issues/48)) ([5b3a7b9](https://github.com/matt-riley/lore/commit/5b3a7b9c9222ee9c51c41e7fe02584e891aedcd3))

## [0.7.0](https://github.com/matt-riley/lore/compare/lore-v0.6.4...lore-v0.7.0) (2026-07-03)


### Features

* add explicit lookbackHours param to lore_reflect ([#45](https://github.com/matt-riley/lore/issues/45)) ([1b2dc29](https://github.com/matt-riley/lore/commit/1b2dc2924abe540d8132c18854880acd1cbbd0e6))
* surface ambient Working Profile section in session-start capsule ([#47](https://github.com/matt-riley/lore/issues/47)) ([ee2ba7b](https://github.com/matt-riley/lore/commit/ee2ba7b789008b6be4e857eb0f074fc62725429b))

## [0.6.4](https://github.com/matt-riley/lore/compare/lore-v0.6.3...lore-v0.6.4) (2026-07-03)


### Bug Fixes

* stop persisting assistant_identity noise from generic interjections ([#43](https://github.com/matt-riley/lore/issues/43)) ([1794059](https://github.com/matt-riley/lore/commit/17940590142075852912d02003cf88c6abd3d538))

## [0.6.3](https://github.com/matt-riley/lore/compare/lore-v0.6.2...lore-v0.6.3) (2026-06-06)


### Bug Fixes

* enable fallow test root discovery ([#24](https://github.com/matt-riley/lore/issues/24)) ([b7ae248](https://github.com/matt-riley/lore/commit/b7ae24877dcad339133ff5f1ab25f830aaddc7d5))

## [0.6.2](https://github.com/matt-riley/lore/compare/lore-v0.6.1...lore-v0.6.2) (2026-06-05)


### Bug Fixes

* return typed memory_search rows when lexical query misses ([#21](https://github.com/matt-riley/lore/issues/21)) ([d4dffd6](https://github.com/matt-riley/lore/commit/d4dffd6dd7081a883b7d0336303910aca2249092))

## [0.6.1](https://github.com/matt-riley/lore/compare/lore-v0.6.0...lore-v0.6.1) (2026-05-19)


### Bug Fixes

* fallow fix ([1ca9707](https://github.com/matt-riley/lore/commit/1ca97079b2b74b57c59b0250532440cbc3119900))
* more fallow fixes ([76f9f81](https://github.com/matt-riley/lore/commit/76f9f8166539202d210bfe4c17ba31fa5d37bb97))
* some fallow fixes ([ea3f7db](https://github.com/matt-riley/lore/commit/ea3f7db00a6a33a8e5fedf0705334d298ce154f7))
* some fallow issues ([10e7ff3](https://github.com/matt-riley/lore/commit/10e7ff3fae5905012a28d7a10e880216c261fb73))

## [0.6.0](https://github.com/matt-riley/lore/compare/lore-v0.5.2...lore-v0.6.0) (2026-04-22)


### Features

* add skill validation to discovery scanner ([7ed203a](https://github.com/matt-riley/lore/commit/7ed203a7216786c35fe0d0ca05c439658be92a23))


### Bug Fixes

* prefer reverse-prompt for prompt-sharpening ([#17](https://github.com/matt-riley/lore/issues/17)) ([3f634e9](https://github.com/matt-riley/lore/commit/3f634e9377a4b8f8efdee2ebf40606c80fe371c6))
* skill-validator ([3e1c78c](https://github.com/matt-riley/lore/commit/3e1c78c13e8285e63a480cfde4d2eb13978ba51a))

## [0.5.2](https://github.com/matt-riley/lore/compare/lore-v0.5.1...lore-v0.5.2) (2026-04-14)


### Bug Fixes

* harden lore config and repo metadata ([6c169ee](https://github.com/matt-riley/lore/commit/6c169ee8cd356f5c1c4872940be771611de10a7a))

## [0.5.1](https://github.com/matt-riley/lore/compare/lore-v0.5.0...lore-v0.5.1) (2026-04-12)


### Bug Fixes

* stop session-start backfill snapshots ([#13](https://github.com/matt-riley/lore/issues/13)) ([5c34288](https://github.com/matt-riley/lore/commit/5c3428896928646f09669c2224c6949a2b26a79f))

## [0.5.0](https://github.com/matt-riley/lore/compare/lore-v0.4.0...lore-v0.5.0) (2026-04-09)


### Features

* improve temporal recall reliability ([#11](https://github.com/matt-riley/lore/issues/11)) ([3f6d24d](https://github.com/matt-riley/lore/commit/3f6d24dc20a07cc3266726d4cbe1c3729e8c571f))

## [0.4.0](https://github.com/matt-riley/lore/compare/lore-v0.3.1...lore-v0.4.0) (2026-03-30)


### Features

* surface session-start archive import progress ([#9](https://github.com/matt-riley/lore/issues/9)) ([2be4339](https://github.com/matt-riley/lore/commit/2be43394d5d583b8b6c16abc3d3cf7288bbc91b7))

## [0.3.1](https://github.com/matt-riley/lore/compare/lore-v0.3.0...lore-v0.3.1) (2026-03-30)


### Bug Fixes

* preserve onboarding memories during cleanup ([#7](https://github.com/matt-riley/lore/issues/7)) ([0abd6af](https://github.com/matt-riley/lore/commit/0abd6af03e82ea46dd7a39ae4cbb1e439f9046c2))

## [0.3.0](https://github.com/matt-riley/lore/compare/lore-v0.2.1...lore-v0.3.0) (2026-03-29)


### Features

* add lore capability, approval, and progress foundations ([bb179ca](https://github.com/matt-riley/lore/commit/bb179ca18d18b8880c6783f6a22733e3da37407c))
* add memory domains and observations ([d5c6c19](https://github.com/matt-riley/lore/commit/d5c6c19d3c406680fcf331c6741e739f539e7f8a))


### Bug Fixes

* onboarding ([8c637b0](https://github.com/matt-riley/lore/commit/8c637b06f2b26e440f2c3915e2bb21d58595d292))
* stabilize db migration tests ([75e345a](https://github.com/matt-riley/lore/commit/75e345a3d3d0b32d2fb6a70d44993e61edafcdeb))

## [0.2.1](https://github.com/matt-riley/lore/compare/lore-v0.2.0...lore-v0.2.1) (2026-03-28)


### Bug Fixes

* avoid duplicate phase-5 migrations ([d9d9186](https://github.com/matt-riley/lore/commit/d9d918645c8f3e574448f879631ca2ca23aae5cb))
* bridge legacy Lore database markers ([25db667](https://github.com/matt-riley/lore/commit/25db667a051cc3086a4860ed60f7349c5eccd9d1))
* docs and stuff ([e53eb94](https://github.com/matt-riley/lore/commit/e53eb948599210fddb4a982ba23beb69d742d84b))
* handle symlinked dev installs correctly ([31ef7ee](https://github.com/matt-riley/lore/commit/31ef7ee898139cc233ab6df06edab21ed82dda55))
* mcp settings ([d9b656e](https://github.com/matt-riley/lore/commit/d9b656e1284026123a4738ca6d19ce4f065d7cbd))
* remove unneeded documentation ([a80eed3](https://github.com/matt-riley/lore/commit/a80eed31242a17e8daa2c079941d56d84c33ee02))

## [0.2.0](https://github.com/matt-riley/lore/compare/lore-v0.1.0...lore-v0.2.0) (2026-03-28)


### Features

* extract standalone Lore extension ([8b84067](https://github.com/matt-riley/lore/commit/8b84067e5afbe5ee6d9aa051573678720f4ec952))


### Bug Fixes

* fail clearly when session-store.db is missing ([c812e68](https://github.com/matt-riley/lore/commit/c812e68f8bbeafa173ae6b46217d73d5d66631f2))

## [Unreleased]

Release notes in this file are maintained by release-please from conventional commits and merged release PRs.

### Added

- Initial public extraction from the private `~/.copilot/extensions/lore/` workspace.
- `README.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`, `CHANGELOG.md`.
- `.github/` scaffold: CI workflow, issue templates, pull request template.
- `docs/compatibility.md` — runtime requirements and platform support.
- `docs/support-matrix.md` — supported vs experimental surface definitions.
- `docs/releasing.md` — release checklist, versioning rules, rollback/recovery guidance, and required validation gates.
- `lore.example.json` — annotated starter config.
- `scripts/dev-install.mjs` — symlink-based local dev install.
- `scripts/validate-config-schema.mjs` — schema/config drift detection.
- `scripts/run-maintenance.mjs` — maintenance scheduler CLI.
- `scripts/run-browser.mjs` — local read-only dashboard launcher.
- `tests/` — fixture harness, unit tests, and smoke tests using the Node built-in test runner.
- `.github/workflows/release.yml` — release-please automation for version bumps, changelog entries, tags, and GitHub Releases.
- CI now includes a `test` job that runs the full test suite (`npm test`) on every push and pull request, in addition to schema validation.

---

[Unreleased]: https://github.com/matt-riley/lore/commits/main
