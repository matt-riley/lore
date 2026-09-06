# Lore compatibility

← [README](../README.md) · [Support matrix](support-matrix.md) · [CONTRIBUTING](../CONTRIBUTING.md)

This document defines the minimum supported runtime environments, version expectations, and compatibility promises for Lore. It covers fresh installs, upgrades from existing local data, and the browser surface.

> **Provisional areas are called out explicitly.** Where exact version floors haven't been validated against a live matrix, the reasoning behind the stated minimum is given so you can make an informed call.

---

## Node.js

| Requirement | Value |
|---|---|
| **Minimum** | Node 22.5.0 |
| **Recommended** | Node 24 |
| **CI matrix** | Latest Node 22, 24, and 26 releases on Linux and macOS |

**Why 22.5.0?** Lore uses [`node:sqlite`](https://nodejs.org/api/sqlite.html) (`DatabaseSync`) from Node's built-in module set. This API landed experimentally in Node 22.5.0. If you're on an older version, Lore will fail to initialise with a clear error at startup.

The CI matrix tests the latest release of each listed major; it does not certify every earlier minor release. If you're on Node 20 or earlier, upgrade before installing.

---

## Operating system

| Platform | Status | Notes |
|---|---|---|
| macOS (Apple Silicon / Intel) | 🟢 Supported | Primary development and testing platform. |
| Linux (x86-64, ARM64) | 🟡 Expected to work | CI exercises the GitHub-hosted Ubuntu runner; it does not cover every architecture. File an issue if you hit platform-specific problems. |
| Windows | 🔴 Not supported | Path handling, shell quoting, and process assumptions are macOS/Linux-oriented. WSL2 on Windows may work but is untested and unsupported. |

---

## GitHub Copilot CLI

| Requirement | Value |
|---|---|
| **Minimum** | Any Copilot CLI release that supports the `extensions/` directory and the three hook names (`onSessionStart`, `onUserPromptSubmitted`, `onSessionEnd`) |
| **SDK model** | The `@github/copilot-sdk` package is **not** bundled — it is resolved by the CLI runtime. Lore does not declare it as a dependency. |

> **Provisional**: the exact minimum CLI version with stable extension-hook support hasn't been pinned against a published release number. If you're on a recent Copilot CLI (mid-2025 or later) you should be fine. If extension hooks don't fire, verify your CLI supports the extension directory model.

---

## Database and config

### `lore.db` (derived store)

| Scenario | Compatibility |
|---|---|
| Fresh install (no prior DB) | ✅ Fully supported. Lore creates the DB and runs all schema migrations on first `onSessionStart`. |
| Existing DB from any prior Lore version | ✅ Supported. The migration system applies additive schema changes such as `domain_key`, `memory_domain`, and `refreshable_observation`. No data is destroyed during migration. |
| DB created by a significantly older version (schema version unknown) | ⚠️ Run `memory_validate` first. If validation reports schema drift, use `memory_doctor_report` or the `maintenance_schedule_run` tool (dry-run mode) to assess before proceeding. |

### `lore.json` (config)

Fresh installs use `~/.config/lore/lore.json` (or `$XDG_CONFIG_HOME/lore/lore.json`; `XDG_CONFIG_HOME` must be absolute) and `~/.config/lore/lore.db`, with backups in `~/.config/lore/backups`. `LORE_HOME` overrides the Lore directory; `LORE_CONFIG` overrides the config file path without relocating the database; `LORE_COPILOT_HOME` applies to Copilot inputs. For compatibility, an unconfigured install with no new home continues to use legacy files under `~/.copilot`, including `backups/lore`. Once the new home exists, it is selected. Existing users must migrate before creating it. Use `npm run migrate-home -- --from <old> --to <new>` for an explicit, non-overwriting migration; stop Lore sessions first. The command leaves the source untouched and preserves custom paths. If you choose a custom destination, set `LORE_HOME` to it in each harness. Update or unset any `LORE_CONFIG` override that still points to the old config.

| Scenario | Compatibility |
|---|---|
| Fresh install (no prior config) | ✅ All keys have defaults. A minimal config with only `"enabled": true` is sufficient to start. |
| Existing config from prior versions | New keys are additive, including rollout flags like `memoryDomains` and `refreshableObservations`. Runtime loading merges user values with defaults; it does not perform full JSON Schema validation or reject every unknown key. |
| Schema/default parity | `npm run validate-schema` checks committed defaults against `schemas/lore.schema.json`. It does not read or validate your personal `lore.json`. Use an editor with JSON Schema support and the checked-in schema to validate manual config edits. |

`maintenanceScheduler.memoryHygiene` is additive and defaults to `mode: "off"`. `shadow` mode is report-only. `apply` mode can supersede `open_loop` and `assistant_goal` rows only when deterministic later evidence satisfies the documented scope rules. Each mutation is soft, marked with `auto-hygiene:<run-id>`, and reversible through `maintenance_schedule_run` using `action: "rollback_hygiene"`.

### `session-store.db` (raw Copilot CLI store — read-only for Lore)

Lore reads this file to backfill memories and extract session context. It never writes to it. Minimum supported schema: the session store as written by Copilot CLI with the `sessions` and `turns` tables present.

When `maintenanceScheduler.sessionStartBackfill` is enabled, Lore may also perform a session-start archive import from this same raw store. That import is still read-only against `session-store.db`, and progress is surfaced to the user via CLI log messages plus the existing backfill status surfaces.

### External maintenance — isolated database rule

`scripts/run-maintenance.mjs` and the `maintenance_schedule_run` tool operate only on the configured Lore database. The `--derived-store-path` and `--raw-store-path` flags exist for legitimate path overrides (e.g., non-standard install locations), not for pointing an external scheduler at test fixtures or other users' databases.

Failed migrations and tasks use **forward recovery**: if a migration or maintenance job fails, the database is left intact, the failure is recorded, and the next run retries the forward path. Destructive downgrade of the schema is never applied silently. If you need to recover from a migration failure, see [Scenario 3 in the releasing guide](releasing.md#scenario-3----db-schema-migration-causes-data-issues).

### Optional local inference server

| Requirement | Value |
|---|---|
| **Protocol** | OpenAI-compatible HTTP endpoints for `/v1/chat/completions`; `/v1/embeddings` is optional |
| **Host** | Loopback only: `127.0.0.1`, `localhost`, or `::1` |
| **Authentication** | Not supported in the URL; Lore rejects embedded credentials |
| **Failure behavior** | Deterministic retrieval, capsule, extraction, and reflection results are preserved for provider, embedding, malformed-output, citation, and grounding failures |

Local inference is disabled by default. Deferred extraction, query expansion, context compression, and quality evaluation require separate config opt-ins. Reflection can be enabled persistently with `localInference.reflection.enabledByDefault`, while an explicit per-call `useLocalInference` value overrides that default. Optional embeddings filter bounded evidence and validate generated claims before rendering. EmbeddingGemma and Nomic retrieval inputs automatically use model-specific query and document prefixes; unknown embedding models keep the protocol's raw text behavior. Model-backed lookback reflection can also enrich recent-session titles with the latest bounded checkpoint overview before reranking. Consolidation, contradiction, possible-supersession, and recurring-trend findings remain advisory. Prompt-context hooks make no model calls unless query expansion or context compression is explicitly enabled; those features can add local inference latency and preserve the deterministic capsule on failure.

---

## Browser UI

| Requirement | Value |
|---|---|
| **Bind address** | Loopback hosts only: `127.0.0.1`, `localhost`, or `::1` — never `0.0.0.0` or any non-loopback interface |
| **Protocol** | HTTP (no TLS). LAN / network exposure is explicitly not supported. |
| **Browser** | Any modern browser with vanilla ES6 support. No build step; the frontend is plain HTML + CSS + vanilla JS. |
| **Port** | Configurable; defaults vary — check `scripts/run-browser.mjs` for the current default. |

The browser UI is an **experimental** surface (see [support matrix](support-matrix.md)). It is read-only and never accepts writes from the browser client.

> **Security note**: The dashboard has no authentication and displays the full contents of your memory store — including code, file paths, decisions, and session notes. Do not proxy or expose the port externally. See [SECURITY.md](../SECURITY.md#browser-dashboard) for the full risk model and recommended mitigations.

---

## Privacy posture

Lore is local-only. This section is the canonical summary of what it stores, what it doesn't do, and how to protect your data.

### What Lore stores

| File | Contents |
|---|---|
| `~/.config/lore/lore.db` | Session memories — code snippets, decisions, notes, file paths, and summaries captured from your sessions. This is the primary data store. |
| `~/.config/lore/lore.json` | Your configuration and preferences. |
| `~/.copilot/session-store.db` | Raw Copilot CLI session data. **Lore reads this for backfill; it never writes to it.** |

### What Lore does NOT do by default

- Make non-loopback outbound network calls.
- Send memory content to any third-party service.
- Sync data to the cloud.
- Share data between machines or users.

When `localInference.enabled` is explicitly set, Lore sends bounded session or reflection evidence to the configured loopback model server. Lore rejects non-loopback provider URLs.

### Protecting your data

`lore.db` contains a record of your work — code you've written, decisions you've made, notes you've kept. Consider restricting file access to your user account:

```sh
chmod 600 ~/.config/lore/lore.db
chmod 600 ~/.config/lore/lore.json
```

The `memory_portable_bundle` export tool (experimental) can generate a portable snapshot as a signed JSON file or an Open Knowledge Format (OKF v0.1) markdown bundle. It exports your approved improvement artifacts (not the full raw memory corpus), but treat any exported bundle as sensitive — those artifacts can still contain excerpts of your code, decisions, and notes.

---

## Compatibility promises

### What Lore promises for supported surfaces

1. **No silent data loss** — schema migrations are additive. If a migration cannot be applied safely, Lore fails loudly rather than silently dropping data.
2. **No surprise removals** — supported tools and hooks get a deprecation notice and migration path before removal.
3. **Backwards-compatible config** — new config keys are additive. Existing valid configs stay valid across minor releases.
4. **Clear error messages** — if the environment doesn't meet minimum requirements (Node version, missing DB, schema mismatch), Lore tells you what's wrong and what to do about it.

### What Lore does not promise

1. **Experimental surfaces may change** — tool names, argument shapes, and output formats for experimental surfaces can change between releases without notice.
2. **No cross-machine portability yet** — `lore.db` is not portable by default. The `memory_portable_bundle` tool supports export (experimental, json or OKF markdown format) and, for the OKF format only, import — reading an OKF bundle directory back into semantic memory as `type=okf_concept` rows (manually invoked only; never automatic). json format import is not yet implemented.
3. **No multi-user or multi-machine sync** — Lore is local-first. There is no cloud sync, no shared team memory, and no remote API surface.
4. **No performance guarantees under heavy load** — the bounded operation targets (< 300 ms session-start, < 200 ms prompt-time) are aspirational guidelines calibrated for a typical developer machine. Very large DBs or slow disks may exceed these.

---

## Versioning

Lore follows [Semantic Versioning](https://semver.org/). Until the standalone repository ships its first tagged release, the version is considered `0.x` and no SemVer stability guarantees apply to experimental surfaces.

> The first `1.0.0` release is the target for graduating the supported core surfaces to a formal stability promise.
