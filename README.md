# Lore 🧠✨

**Lore** is a local-first memory and continuity extension for the GitHub Copilot CLI.
It remembers things across sessions so _you_ don't have to.

---

## What it does

Every time you work with Copilot, you build up context — decisions made, patterns discovered, blockers hit, things learned. Normally that context evaporates when a session ends. **Lore changes that.**

Lore quietly captures what matters from your sessions and surfaces it again when it's relevant. Ask about your work yesterday and Lore will remember. Ask about a pattern you keep hitting and Lore has examples. Ask about a decision from three weeks ago and Lore might have the answer.

It's your project's lore — and now Copilot gets to read it.

**Zero runtime dependencies.** Lore is plain ESM built on Node's built-in `node:sqlite` module. No npm bloat. No surprises.

---

## Requirements

- **Node 22.5.0 or later** — Lore uses the built-in `node:sqlite` module.
- **GitHub Copilot CLI** with extension directory support (`~/.copilot/extensions/`).
- macOS or Linux. Windows is not supported (WSL2 may work but is untested).

---

## Quick start

### 1. Install

Clone Lore directly into your Copilot extensions directory:

```sh
git clone https://github.com/matt-riley/lore.git ~/.copilot/extensions/lore
```

Then restart the **Copilot CLI process** so it rescans the extensions directory and loads Lore.

To update later:

```sh
cd ~/.copilot/extensions/lore
git pull
```

If you prefer to develop or keep a checkout somewhere else, Lore still ships a helper that copies that checkout into `~/.copilot/extensions/lore`:

```sh
git clone https://github.com/matt-riley/lore.git ~/dev/lore
cd ~/dev/lore
node scripts/dev-install.mjs
```

Not sure yet? Preview what would happen first:

```sh
node scripts/dev-install.mjs --dry-run
```

### 2. Configure

Copy the example config to your Copilot home:

```sh
cp lore.example.json ~/.copilot/lore.json
```

The checked-in `lore.example.json` is the **all-features-on** starting point: Lore itself is enabled, the maintenance scheduler is on, session-start archive import is enabled with visible progress, and the current experimental rollout flags — including `directives`, `memoryDomains`, and `refreshableObservations` — are enabled. If you want a quieter setup, copy it first and then turn individual surfaces back down in `~/.copilot/lore.json`.

### 3. Validate

Check that your config is in sync with the schema:

```sh
node scripts/validate-config-schema.mjs
# or: npm run validate-schema
```

### 4. First-run onboarding

Once Lore is enabled, it now bootstraps a small profile on the first session:

- Lore seeds a default teammate-like personality profile.
- Lore leaves assistant naming for real onboarding instead of hardcoding one at startup.
- Lore asks what name it should use for you when there is a natural moment.
- If Lore still needs its own name, the nudge is intentionally playful: `If you were human, what would you like your name to be?`
- Once Lore picks a name, it should tell the user directly so the user can actually use it.

If the assistant needs to lock in or update that profile immediately, use `lore_onboard`.

- If `userName` is supplied, Lore can complete onboarding in one shot.
- If `assistantName` is omitted, Lore chooses one during onboarding and persists it then.
- If Lore already knows your preferred name, `lore_onboard` can finish the remaining pieces without asking for it again.

### 5. Session-start archive import

Lore can optionally do a full archive import on session start with progress updates in the CLI.

- Configure it under `maintenanceScheduler.sessionStartBackfill`.
- Use `maintenanceScheduler.sessionStartBackfill.maxCandidates` to bound how many session candidates Lore plans per startup sweep.
- Use `maintenanceScheduler.sessionStartBackfill.maxInspected` to cap how many raw session-store rows Lore inspects before deferring the rest to later startup sweeps.
- Lore announces when the import starts, reports incremental progress, and logs completion or failure.
- The import reuses the existing controlled backfill engine, but it does **not** create restore snapshots.
- Manual controlled `memory_backfill` runs still create snapshots that can be restored by run ID.
- The default is conservative: disabled in code defaults, enabled in the all-features-on example config.

---

## Capabilities at a glance

Lore operates across two rings — proven core features and actively-evolving experimental surfaces.

### Supported core 🟢 (Stable)

These surfaces are covered by the compatibility promise in [`docs/compatibility.md`](docs/compatibility.md) and won't break your workflow.

- **Session hooks** — `onSessionStart`, `onUserPromptSubmitted`, `onSessionEnd` fire automatically
- **Core memory verbs** — `lore_recall`, `lore_retain`, `lore_onboard`, `memory_search`, `memory_save`, `memory_forget`
- **Temporal recall** — Ask Lore "what did we do last Thursday?" and it resolves it through date normalization, episode lookup, and session-history verification. Answers include confidence notes so you know whether Lore answered from day summaries, prior episodes, or verified history
- **Structured memory shaping** — optional memory domains on `lore_retain` and refreshable observations from `lore_reflect` (rollout-flagged)
- **Status and diagnostics** — `memory_status`, `memory_explain`, `memory_validate`

### Experimental ring 🟡 (Evolving)

Functional and used daily, but interfaces are still evolving. The canonical source is [`lib/capability-manifest.mjs`](lib/capability-manifest.mjs); [`docs/support-matrix.md`](docs/support-matrix.md) mirrors it.

---

## Repository layout

```
extension.mjs          ← extension entrypoint (Copilot CLI loads this)
lib/                   ← core implementation modules
browser/               ← local read-only dashboard (experimental)
scripts/               ← dev tooling and maintenance scripts
  dev-install.mjs      ← helper to copy a non-installed checkout into the extension dir
  validate-config-schema.mjs
  run-maintenance.mjs
  run-browser.mjs
schemas/
  lore.schema.json ← config schema (source of truth)
docs/
  support-matrix.md
  compatibility.md
```

Lore uses the `lore` identifier family consistently across module names, tool names, config keys, and the derived database name.

---

## Privacy and security

Lore stores your session context **locally** in `~/.copilot/lore.db`. Nothing is sent to any remote service. The optional browser UI binds to `localhost` only and is read-only.

For the full picture — what's stored, browser surface risks, file permission recommendations, and how to report vulnerabilities — see [SECURITY.md](SECURITY.md).

---

## Scripts

All scripts can be run directly with Node or via the `npm run` shortcuts:

| npm script                | Direct                                      | What it does                                                              |
| ------------------------- | ------------------------------------------- | ------------------------------------------------------------------------- |
| `npm run dev-install`     | `node scripts/dev-install.mjs`              | Copies a non-installed checkout into `~/.copilot/extensions/lore`         |
| `npm run validate-schema` | `node scripts/validate-config-schema.mjs`   | Validates `lore.json` config against `schemas/lore.schema.json` |
| `npm run maintenance`     | `node scripts/run-maintenance.mjs --status` | Show maintenance scheduler status                                         |
| `npm run browser`         | `node scripts/run-browser.mjs`              | Start the local read-only browser dashboard                               |

---

## Testing

Lore's test suite uses the Node built-in test runner — no extra packages needed.

```sh
npm test                # all tests (unit + smoke)
npm run test:smoke      # smoke tests only (script integration)
```

Or run individual test files directly:

```sh
node --test tests/unit/query-normalizer.test.mjs
node --test tests/smoke/harness.test.mjs
```

> **FTS5 note**: some tests check full-text search and will be skipped if your local Node build doesn't include FTS5 in its SQLite. The Copilot CLI runtime does have it — so tests that pass locally will also pass in the extension context.

---

## Docs

- [Support matrix](docs/support-matrix.md) — supported vs experimental surfaces
- [Compatibility](docs/compatibility.md) — minimum versions, platform support, and privacy posture
- [Changelog](CHANGELOG.md) — what's changed across releases

---

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, style, and PR guidance.
Lore uses conventional PR titles and release-please for automated changelog + version management.
For questions or bug reports, see [SUPPORT.md](SUPPORT.md).
Security issues go via [GitHub Security Advisories](../../security/advisories/new) — not public issues.
