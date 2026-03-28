# Contributing to Lore

Thanks for your interest — contributions are welcome and appreciated! 🎉 Lore is a small, focused project, and contributions that align with the design philosophy make a real difference.

---

## Before you start

- **Read the [README](README.md)** to understand what Lore is and isn't.
- **Check [docs/support-matrix.md](docs/support-matrix.md)** to see which surfaces are stable vs experimental.
- **Check [docs/compatibility.md](docs/compatibility.md)** for minimum runtime requirements.
- For significant changes, open an issue first to discuss the approach before writing code.

---

## Quick setup

```sh
git clone <repo-url>
cd lore
node scripts/dev-install.mjs --dry-run   # preview install
node scripts/dev-install.mjs             # symlink-install into ~/.copilot/extensions/coherence
```

No build step needed — Lore is plain ESM. Node 22.5.0 or later is required (see [compatibility](docs/compatibility.md)).

Validate that schema and config are in sync after any config-related change:

```sh
npm run validate-schema
```

---

## Running tests

Lore uses the Node built-in test runner. No extra packages needed.

```sh
npm test                 # all tests (unit + smoke)
npm run test:smoke       # smoke / integration tests only
```

Run a single file directly when you're iterating:

```sh
node --test tests/unit/query-normalizer.test.mjs
```

**Unit tests** (`tests/unit/`) are pure and fast — no disk I/O or subprocess spawning.  
**Smoke tests** (`tests/smoke/`) spin up temporary homes and invoke scripts as real subprocesses. They give you confidence that the whole pipeline works end-to-end.

Some tests skip automatically when FTS5 isn't compiled into your local Node build. That's expected — the Copilot CLI runtime always has FTS5, so those tests will run there.

Run the full suite before opening a PR.

---

## What makes a good contribution

**Good bets:**

- Bug fixes with a clear reproduction case.
- Docs improvements — clarity, accuracy, examples.
- Hardening existing surfaces: better error messages, edge-case handling, validation.
- Additions that fit naturally into the experimental ring and come with a clear graduation path.

**Please discuss first:**

- New tools or hooks that expand the public surface.
- Changes to the core memory model, retention logic, or DB schema.
- Anything that would break backward compatibility with existing `coherence.db` or `coherence.json` data.

---

## Code style

- ESM (`import`/`export`) throughout — no CommonJS.
- No transpilation, no bundler. Code runs directly with Node.
- Prefer the Node built-ins over third-party packages. Lore has zero runtime dependencies by design.
- Keep modules small and focused. The existing `lib/` structure is a good guide.
- Comments where non-obvious. No comments restating what code already says clearly.

---

## Submitting a pull request

1. Fork and create a branch from `main`.
2. Use a Conventional Commit PR title such as `feat: add smarter memory replay ranking` or `fix: guard missing session-store.db`.
3. Make your changes.
4. Run `npm test` — all tests should pass.
5. Run `npm run validate-schema` and check that it passes.
6. Fill in the pull request template.
7. Reference any related issue in the PR description.

Lore uses release-please for releases, changelog entries, and version bumps. That means merged changes need conventional titles/messages so the release automation can sort them into the right bucket without guesswork.

---

## Releasing

Maintainers cutting a release should follow [docs/releasing.md](docs/releasing.md). It covers the release-please flow, release PR review, and rollback procedures.

---

## Questions and support

For questions about how Lore works or how to reproduce a bug, see [SUPPORT.md](SUPPORT.md) — it covers the right channel for different kinds of help.

---

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating you agree to abide by its terms.
