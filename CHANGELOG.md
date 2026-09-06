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
