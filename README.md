# Lore 🧠✨

**Lore** is a local-first memory and continuity extension for the GitHub Copilot CLI.
It helps Copilot remember useful context across sessions so you do not have to keep re-explaining your project, your recent decisions, or the thing that broke yesterday.

Lore runs entirely on your machine, plugs into Copilot CLI's extension hooks, and stores its derived memory in a local SQLite database. No cloud sync, no hosted service, no runtime dependency pile.

---

## What it does

Every time you work with Copilot, you build up context — decisions made, patterns discovered, blockers hit, things learned. Normally that context evaporates when a session ends. **Lore changes that.**

Lore quietly captures what matters from your sessions and surfaces it again when it's relevant. Ask about your work yesterday and Lore will remember. Ask about a pattern you keep hitting and Lore has examples. Ask about a decision from three weeks ago and Lore might have the answer.

At a glance, Lore can:

- recall prior work, decisions, and recent session context
- retain explicit notes and memories with scope controls
- explain why a given memory result was selected
- run bounded maintenance and backfill flows over the local session store
- expose an optional localhost-only browser dashboard for inspecting stored memories

**Zero runtime dependencies.** Lore is plain ESM built on Node's built-in `node:sqlite` module. No npm bloat. No surprises.

Lore has a stable core and an experimental ring. The support boundary for each surface lives in [`docs/support-matrix.md`](docs/support-matrix.md).

---

## Requirements

Lore keeps things simple, but it does expect a modern runtime:

- **Node.js:** 22.5.0 or later
- **GitHub Copilot CLI:** a version that supports the `extensions/` directory and the `onSessionStart`, `onUserPromptSubmitted`, and `onSessionEnd` hooks
- **Operating system:** macOS is the primary supported platform; Linux is expected to work; Windows is not supported

For the full compatibility contract, including browser and database notes, see [`docs/compatibility.md`](docs/compatibility.md).

---

## Install

The primary install layout is to clone Lore directly into your Copilot extensions directory:

```sh
git clone https://github.com/matt-riley/lore.git ~/.copilot/extensions/lore
```

Then restart the Copilot CLI process so it rescans the extensions directory and loads Lore.

To update later:

```sh
cd ~/.copilot/extensions/lore
git pull
```

If you prefer to work from a separate development checkout, Lore also includes a helper that copies that checkout into the live extensions directory:

```sh
git clone https://github.com/matt-riley/lore.git ~/dev/lore
cd ~/dev/lore
node scripts/dev-install.mjs --dry-run
node scripts/dev-install.mjs
```

---

## Configure

Copy the example config into your Copilot home:

```sh
cp lore.example.json ~/.copilot/lore.json
```

The checked-in example is the "all features on" starting point. It enables Lore itself, turns on the maintenance scheduler, enables session-start archive import, and opts into the current rollout-gated experimental surfaces.

If you want a quieter setup, copy the file first and then dial features back in `~/.copilot/lore.json`.

---

## Optional features

The checked-in example config turns on most experimental features, but deliberately leaves local inference disabled. These are the main opt-in features worth knowing about.

### `localInference`

`localInference` optionally connects Lore to an OpenAI-compatible model server running on the same machine. It is deliberately disabled in both runtime defaults and `lore.example.json`, accepts loopback URLs only, and adds no runtime dependency.

```json
{
  "localInference": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:12434/v1",
    "model": "local-chat-model",
    "timeoutMs": 30000,
    "reflection": {
      "enabledByDefault": false
    },
    "queryExpansion": {
      "enabled": false,
      "maxTerms": 8
    },
    "contextCompression": {
      "enabled": false,
      "minInputTokens": 900,
      "targetTokens": 700,
      "maxSections": 8
    },
    "analysis": {
      "consolidation": {
        "enabled": true,
        "maxItems": 4
      },
      "contradictions": {
        "enabled": true,
        "maxItems": 4
      },
      "trends": {
        "enabled": true,
        "maxItems": 4,
        "minOccurrences": 2
      },
      "qualityEvaluation": {
        "enabled": false,
        "minSupport": 0.8,
        "minSpecificity": 0.6,
        "minUsefulness": 0.6
      }
    },
    "embeddings": {
      "enabled": true,
      "model": "local-embedding-model",
      "maxInputs": 24,
      "topK": 6,
      "minSimilarity": 0.2,
      "groundingMinSimilarity": 0.35
    }
  },
  "deferredExtraction": {
    "useLocalInference": true
  }
}
```

The provider and each consuming surface have separate opt-ins:

- Deferred extraction requires both `localInference.enabled: true` and `deferredExtraction.useLocalInference: true`.
- `lore_reflect` uses `localInference.reflection.enabledByDefault` when the call omits `useLocalInference`; an explicit `true` or `false` on the call always overrides the configured default.
- Query expansion is independently default-off. It changes retrieval terms only, retries the deterministic query when expansion finds no evidence, and cannot change routing, temporal scope, or repository eligibility.
- Model-backed reflection can return advisory consolidation proposals, possible contradictions or supersessions, and recurring trends. Every finding cites bounded evidence and never mutates trusted memory.
- Quality evaluation is independently default-off. When enabled, it rejects generated candidates below the configured support, specificity, or usefulness thresholds and falls back to deterministic reflection if no acceptable insight remains.
- Context compression is independently default-off. It preserves required identity, directive, and commitment sections, keeps source indexes, and falls back to the uncompressed deterministic capsule on any failure.
- Embedding-based evidence ranking is optional. `maxInputs` bounds the candidate pool, `topK` bounds evidence sent to the chat model, and `minSimilarity` removes weakly related evidence.
- When embeddings are enabled, Lore embeds generated claims in a second bounded pass and discards claims below `groundingMinSimilarity`. If no grounded insight remains, Lore returns the deterministic reflection.

Prompt-context hooks make no model calls by default. Enabling query expansion or context compression permits bounded loopback-only inference during context assembly and can add latency. Invalid output, missing citations, ungrounded claims, timeouts, or an unavailable model server are reported while Lore preserves its deterministic retrieval, capsule, extraction, or reflection result. Embeddings are held in memory only and are never persisted.

### `traceRecorder`

`traceRecorder` records bounded samples of Lore's prompt-need classification and retrieval decisions so you can debug why context was injected, skipped, or filtered.

To enable it, turn on the rollout flag and then optionally tune the recorder limits:

```json
{
  "rollout": {
    "traceRecorder": true
  },
  "traceRecorder": {
    "maxRecords": 80,
    "persistDurableSample": true,
    "durableSampleRate": 0.5
  }
}
```

Use `memory_status` for recorder health and recent samples. `includeRecentTraces: true` appends recent in-memory entries, and `includeRecentTrajectoryArtifacts: true` shows persisted durable samples. For a single prompt, `memory_explain` is the quickest way to inspect the current retrieval decision.

### `maintenanceScheduler`

`maintenanceScheduler` is the opt-in maintenance loop for automated memory hygiene, deferred extraction processing, validation and replay corpus runs, backlog review, and index upkeep. On session start, Lore evaluates the maintenance plan and runs the bounded `memoryHygiene` and `deferredExtraction` tasks when they are enabled and due. The work is deferred so the session-start hook remains responsive. The same scheduler also powers manual or scripted sweeps through `maintenance_schedule_run` and `node scripts/run-maintenance.mjs`.

> **Session hooks do not guarantee wall-clock cadence.** For reliable periodic upkeep independent of session frequency, wire `scripts/run-maintenance.mjs` into cron or launchd. See [`docs/maintenance-scheduling.md`](docs/maintenance-scheduling.md) for the full guide including cron and launchd examples, failure detection, and the isolated-database rule.

```json
{
  "maintenanceScheduler": {
    "enabled": true,
    "autoRunOnSessionStart": true,
    "maxTasksPerRun": 4,
    "memoryHygiene": {
      "mode": "shadow",
      "maxItems": 50,
      "includeGlobal": true
    },
    "tasks": {
      "memoryHygiene": true,
      "deferredExtraction": true,
      "validationCorpus": true,
      "replayCorpus": true,
      "backlogReview": true,
      "indexUpkeep": true
    }
  }
}
```

Memory hygiene is non-blocking and defaults to `off`. Use `shadow` first: Lore records candidates and unresolved evidence without changing memories. After reviewing a forced run, switch to `apply` to supersede only memories with deterministic completion evidence. Repo-scoped commit-promotion items may use local Git ancestry; global items always require an exact normalized target plus explicit later completion evidence. Later episode open items prevent automatic resolution.

Every applied run uses an `auto-hygiene:<run-id>` marker and writes trajectory artifacts. To reverse one run, call `maintenance_schedule_run` with `action: "rollback_hygiene"` and the exact marker; Lore restores only rows carrying that marker and records a rollback audit artifact. The latest completed hygiene summary is added to the next Lore prompt or session context. It never denies write tools.

#### `sessionStartBackfill`

If you want Lore to import older session history gradually as you keep working, enable `maintenanceScheduler.sessionStartBackfill`:

```json
{
  "maintenanceScheduler": {
    "enabled": true,
    "sessionStartBackfill": {
      "enabled": true,
      "includeOtherRepositories": true,
      "batchSize": 25,
      "maxCandidates": 250
    }
  }
}
```

This uses the controlled backfill engine during session start, stays read-only against `session-store.db`, and reports progress in the CLI as it works through queued history.

---

## Validate

Before trusting a config change, validate that the runtime defaults and schema still agree:

```sh
npm run validate-schema
# or
node scripts/validate-config-schema.mjs
```

To run the full test suite:

```sh
npm test
```

To run only the smoke tests:

```sh
npm run test:smoke
```

---

## First-run behavior

On first use, Lore bootstraps a lightweight profile so it can act more like a consistent teammate than a blank slate every session.

That includes:

- seeding a default personality profile
- asking for the user's preferred name at a natural moment
- leaving Lore's own final name to real onboarding rather than hardcoding one too early

If you want to complete or refresh that setup explicitly, use `lore_onboard`.

Lore can also optionally run a session-start archive import from the raw Copilot session store. When enabled, it reuses the controlled backfill engine, reports progress in the CLI, and stays read-only against `session-store.db`.

---

## Tool and surface overview

Lore has two main rings:

- **Supported core** for stable hooks and core memory tools
- **Experimental surfaces** for newer capabilities that are useful but still evolving

The canonical breakdown lives in [`docs/support-matrix.md`](docs/support-matrix.md), but the short version is:

- stable session hooks: `onSessionStart`, `onUserPromptSubmitted`, `onSessionEnd`
- stable core verbs such as `lore_recall`, `lore_retain`, `lore_onboard`, `memory_search`, `memory_save`, and `memory_forget`
- stable diagnostics such as `memory_status`, `memory_explain`, and `memory_validate`
- experimental reflection, backfill, portability, maintenance, browser, and self-diagnostic surfaces gated by rollout flags

For runtime and platform promises, see [`docs/compatibility.md`](docs/compatibility.md).

### Portable exports and the OKF viewer

`memory_portable_bundle` accepts a `format` argument: `json` (default, machine-readable) or `okf`. The `okf` format writes an [Open Knowledge Format v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle -- one markdown file with YAML frontmatter per approved improvement artifact, plus a root `index.md` -- so approved Lore improvements can be reviewed, archived, or shared outside the CLI with any OKF-aware tool.

To browse an OKF bundle visually, render it into a self-contained HTML viewer:

```sh
npm run visualize-okf -- --bundle path/to/bundle --out viz.html
```

This produces a force-directed graph of the bundle's concepts (colored by type, with search, a type filter, and a detail panel showing backlinks), loading Cytoscape.js and marked from CDN at view time -- no npm runtime dependency is added. It mirrors the `visualize` subcommand of the OKF reference agent.

To import an OKF bundle back into Lore's own memory (making its concepts retrievable via `memory_search`), call `memory_portable_bundle` with `action: "import"` and `format: "okf"`:

```
memory_portable_bundle({ action: "import", bundlePath: "path/to/bundle", format: "okf" })
```

Each concept is retained as a `type: "okf_concept"` semantic memory row, tagged `okf_import`, at a lower default confidence (`0.7`) than self-authored memory (`memory_save`'s default is `0.9`) since it's externally sourced content. Import is always a manual, explicit tool call -- it is never wired into a hook or schedule. Re-importing the same bundle reinforces existing rows (matched by a stable `repository::conceptId` key) instead of duplicating them, but a later import does not overwrite already-stored content -- the first import wins. To revert an unwanted import: `memory_search(query: "okf_import", type: "okf_concept")` to find the rows, then `memory_forget(id: ..., supersededBy: "reverted okf import")` per row. `format: "json"` import is not yet implemented.

---

## Privacy and security

Lore is local-only by design.

It stores derived memory in `~/.copilot/lore.db`, reads Copilot CLI's raw `session-store.db` as input, and keeps configuration in `~/.copilot/lore.json`. Lore does **not** sync memory to the cloud or expose a network API. If you explicitly enable `localInference`, selected session or reflection evidence is sent only to the configured loopback model endpoint.

If you enable the optional browser dashboard, keep in mind:

- it is **read-only**
- it is meant for **loopback hosts only** (`127.0.0.1`, `localhost`, or `::1`)
- it has **no authentication**
- it can display sensitive local memory content, including code, notes, file paths, and decisions

Useful, yes. Internet-facing, absolutely not.

For the full security model, see [SECURITY.md](SECURITY.md).

---

## Scripts and repository layout

Lore is plain ESM on Node's built-in `node:sqlite`. There is no build step and no runtime install dance.

Useful commands:

| Command | What it does |
| --- | --- |
| `npm test` | Run the full unit + smoke test suite |
| `npm run test:smoke` | Run smoke tests only |
| `npm run validate-schema` | Validate config/schema parity |
| `npm run dev-install` | Copy a dev checkout into `~/.copilot/extensions/lore` |
| `npm run maintenance` | Run the maintenance script |
| `npm run browser` | Start the local browser dashboard |
| `npm run visualize-okf -- --bundle <dir>` | Render an interactive `viz.html` for an OKF-format `memory_portable_bundle` export |

High-level layout:

```text
extension.mjs          # Copilot CLI entrypoint
lib/                   # Core runtime and memory logic
browser/               # Local read-only dashboard
scripts/               # Dev and maintenance scripts
schemas/               # Config schema
docs/                  # Compatibility, support matrix, and release docs
tests/                 # Unit and smoke tests
```

---

## Docs and contributing

If you want the deeper contract, these are the main references:

- [docs/support-matrix.md](docs/support-matrix.md) — supported vs experimental surfaces
- [docs/compatibility.md](docs/compatibility.md) — runtime, OS, browser, and DB expectations
- [CONTRIBUTING.md](CONTRIBUTING.md) — local workflow and PR guidance
- [docs/releasing.md](docs/releasing.md) — release process and rollback guidance
- [CHANGELOG.md](CHANGELOG.md) — release history
- [SUPPORT.md](SUPPORT.md) — where to go for help
- [SECURITY.md](SECURITY.md) — security reporting and local risk model

Lore is still in the `0.x` stage, so the supported core is intentionally small and the experimental ring is where faster iteration happens. If you contribute, keep the support matrix, compatibility notes, and tool metadata in sync when behavior changes.
