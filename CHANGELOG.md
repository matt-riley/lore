# Changelog

All notable changes to Lore will be documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions and uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

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
