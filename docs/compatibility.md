# Lore compatibility

← [README](../README.md) · [Support matrix](support-matrix.md) · [CONTRIBUTING](../CONTRIBUTING.md)

This document defines the minimum supported runtime environments, version expectations, and compatibility promises for Lore. It covers fresh installs, upgrades from existing local data, and the browser surface.

> **Provisional areas are called out explicitly.** Where exact version floors haven't been validated against a live matrix, the reasoning behind the stated minimum is given so you can make an informed call.

---

## Node.js

| Requirement | Value |
|---|---|
| **Minimum** | Node 22.5.0 |
| **Recommended** | Node 22 LTS or Node 23+ |
| **Tested** | Node 23.x (author's daily driver) |

**Why 22.5.0?** Lore uses [`node:sqlite`](https://nodejs.org/api/sqlite.html) (`DatabaseSync`) from Node's built-in module set. This API landed experimentally in Node 22.5.0. If you're on an older version, Lore will fail to initialise with a clear error at startup.

Node 22 is the current LTS line. If you're on Node 20 or earlier, upgrade before installing.

---

## Operating system

| Platform | Status | Notes |
|---|---|---|
| macOS (Apple Silicon / Intel) | 🟢 Supported | Primary development and testing platform. |
| Linux (x86-64, ARM64) | 🟡 Expected to work | No dedicated test matrix yet. Path and filesystem assumptions should hold. File an issue if you hit platform-specific problems. |
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
| Existing DB from any prior Lore version | ✅ Supported. The migration system applies additive schema changes. No data is destroyed during migration. |
| DB created by a significantly older version (schema version unknown) | ⚠️ Run `memory_validate` first. If validation reports schema drift, use `memory_doctor_report` or the `maintenance_schedule_run` tool (dry-run mode) to assess before proceeding. |

### `lore.json` (config)

| Scenario | Compatibility |
|---|---|
| Fresh install (no prior config) | ✅ All keys have defaults. A minimal config with only `"enabled": true` is sufficient to start. |
| Existing config from prior versions | ✅ New keys are additive. Unknown keys are rejected by schema validation, so `memory_validate` will surface any stale keys from old configs. |
| Config validated against schema | ✅ `scripts/validate-config-schema.mjs` validates `lore.json` against `schemas/lore.schema.json`. Run it after any manual config edits. |

### `session-store.db` (raw Copilot CLI store — read-only for Lore)

Lore reads this file to backfill memories and extract session context. It never writes to it. Minimum supported schema: the session store as written by Copilot CLI with the `sessions` and `turns` tables present.

---

## Browser UI

| Requirement | Value |
|---|---|
| **Bind address** | `127.0.0.1` only — localhost, never `0.0.0.0` |
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
| `~/.copilot/lore.db` | Session memories — code snippets, decisions, notes, file paths, and summaries captured from your sessions. This is the primary data store. |
| `~/.copilot/lore.json` | Your configuration and preferences. |
| `~/.copilot/session-store.db` | Raw Copilot CLI session data. **Lore reads this for backfill; it never writes to it.** |

### What Lore does NOT do

- Make outbound network calls.
- Send memory content to any third-party service.
- Sync data to the cloud.
- Share data between machines or users.

### Protecting your data

`lore.db` contains a record of your work — code you've written, decisions you've made, notes you've kept. Consider restricting file access to your user account:

```sh
chmod 600 ~/.copilot/lore.db
chmod 600 ~/.copilot/lore.json
```

The `memory_portable_bundle` export tool (experimental) can generate a portable snapshot. Treat any exported bundle as sensitive — it contains raw memory data.

---

## Compatibility promises

### What Lore promises for supported surfaces

1. **No silent data loss** — schema migrations are additive. If a migration cannot be applied safely, Lore fails loudly rather than silently dropping data.
2. **No surprise removals** — supported tools and hooks get a deprecation notice and migration path before removal.
3. **Backwards-compatible config** — new config keys are additive. Existing valid configs stay valid across minor releases.
4. **Clear error messages** — if the environment doesn't meet minimum requirements (Node version, missing DB, schema mismatch), Lore tells you what's wrong and what to do about it.

### What Lore does not promise

1. **Experimental surfaces may change** — tool names, argument shapes, and output formats for experimental surfaces can change between releases without notice.
2. **No cross-machine portability yet** — `lore.db` is not portable by default. The `memory_portable_bundle` export tool exists (experimental) but import is not yet implemented.
3. **No multi-user or multi-machine sync** — Lore is local-first. There is no cloud sync, no shared team memory, and no remote API surface.
4. **No performance guarantees under heavy load** — the bounded operation targets (< 300 ms session-start, < 200 ms prompt-time) are aspirational guidelines calibrated for a typical developer machine. Very large DBs or slow disks may exceed these.

---

## Versioning

Lore follows [Semantic Versioning](https://semver.org/). Until the standalone repository ships its first tagged release, the version is considered `0.x` and no SemVer stability guarantees apply to experimental surfaces.

> The first `1.0.0` release is the target for graduating the supported core surfaces to a formal stability promise.
