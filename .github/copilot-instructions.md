# Copilot instructions for Lore

## Commands

Lore is plain ESM on Node's built-in `node:sqlite`; there is no build step and no install step for normal development.

### Validate config/schema parity

```bash
npm run validate-schema
# or
node scripts/validate-config-schema.mjs
```

### Run the full test suite

```bash
npm test
```

### Run smoke tests only

```bash
npm run test:smoke
```

### Run a single test file

```bash
node --test tests/unit/session-store-reader.test.mjs
node --test tests/unit/query-normalizer.test.mjs
node --test tests/smoke/scripts.test.mjs
```

There is currently no lint script in `package.json`. CI enforces schema validation, tests, SHA-pinned workflow actions, and release automation rules.

## High-level architecture

### Runtime entrypoint

- `extension.mjs` is the only extension entrypoint. It joins the Copilot CLI session, registers the three hooks (`onSessionStart`, `onUserPromptSubmitted`, `onSessionEnd`), and exposes the tool surface via `createMemoryTools(...)`.
- The hook flow is:
  - load config with `lib/config.mjs`
  - initialize the derived store with `lib/db.mjs`
  - open the raw Copilot session store with `lib/session-store-reader.mjs`
  - assemble prompt/session context with `lib/capsule-assembler.mjs`, `lib/memory-operations.mjs`, and related helpers
  - optionally record traces and maintenance state

### Data model

- Lore has two SQLite-backed data sources:
  - `session-store.db` is the raw Copilot CLI store and is read-only from Lore's perspective
  - `coherence.db` is Lore's derived store and is where retained memories, episode digests, day summaries, backlog items, and diagnostics live
- `lib/db.mjs` owns the derived schema, migrations, and query helpers.
- `browser/server.mjs` reads directly from the derived tables (`semantic_memory`, `episode_digest`, `day_summary`, `improvement_backlog`) and serves a localhost-only read-only dashboard.

### Config and rollout model

- `lib/config.mjs` is the runtime source of truth for defaults and env overrides.
- `schemas/coherence.schema.json` is the editor/user-facing schema for `coherence.json`.
- `scripts/validate-config-schema.mjs` compares `USER_CONFIG_DEFAULTS` in `lib/config.mjs` against the schema at leaf-property depth. If you add or rename config keys, update both files together.
- Experimental behavior is gated in `lib/rollout-flags.mjs`, and the public tool surface is assembled in `lib/memory-tools.mjs`.

## Key conventions

### Lore is the product name; `coherence` is still the internal identifier

- Tool names, config keys, DB filenames, and extension install path still use the `coherence_*` / `coherence.*` naming family.
- User-facing docs and repo branding use **Lore**.
- Do not rename internal identifiers casually; the repo is intentionally in a mixed state for compatibility.

### When changing tools or rollout-gated features, update the whole contract

For anything that adds, removes, graduates, or gates a tool/surface, check these together:

- `lib/memory-tools.mjs`
- `lib/rollout-flags.mjs`
- `docs/support-matrix.md`
- `docs/compatibility.md` when the runtime promise changes
- `README.md` / `CONTRIBUTING.md` when the contributor-facing workflow changes

### Tests are split by purpose

- `tests/unit/` is for pure module behavior.
- `tests/smoke/` is for script-level integration and temp-home flows.
- The smoke tests intentionally run scripts in subprocesses because `lib/config.mjs` resolves env-driven paths at module import time. For script/config behavior, prefer smoke-test patterns over importing script modules directly.

### FTS5 is optional locally but expected in the Copilot runtime

- Some tests skip when the local Node build lacks SQLite FTS5 support.
- `tests/helpers/fixture-db.mjs` exposes `FTS5_AVAILABLE`; use that pattern instead of hard-failing local tests that depend on FTS virtual tables.

### Release flow depends on conventional commit semantics

- The repo uses release-please, a release manifest, and conventional PR titles.
- If you change release or workflow behavior, keep `.github/workflows/release.yml`, `release-please-config.json`, `.release-please-manifest.json`, `CHANGELOG.md`, and `docs/releasing.md` consistent.

### Workflow edits should stay pinned and validation-friendly

- GitHub Actions in `.github/workflows/` are SHA-pinned.
- Keep workflow changes compatible with `.github/workflows/validate-workflows.yml`.
- Renovate config for workflow/action upkeep lives in `.github/renovate.json`.

### Browser changes are full-stack even though the UI is small

- The browser dashboard is plain HTML/CSS/JS under `browser/`, but the data contract is shaped in `browser/server.mjs`.
- If you change browser-visible fields, review both the server JSON mapping and the static client assets.
