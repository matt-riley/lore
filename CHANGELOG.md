# Changelog

All notable changes to Lore will be documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) conventions and uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

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

[Unreleased]: https://github.com/mattriley/lore/commits/main
