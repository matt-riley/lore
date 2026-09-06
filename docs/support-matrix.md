# Lore support matrix

← [README](../README.md) · [Compatibility](compatibility.md) · [CONTRIBUTING](../CONTRIBUTING.md)

This document defines which surfaces are **supported**, **experimental**, or **unsupported** for external users.

---

## Lifecycle definitions

| Status | Meaning |
|---|---|
| 🟢 **Supported** | Stable interface. Breaking changes require a deprecation notice and migration path. Bugs are prioritised. |
| 🟡 **Experimental** | Available and functional. Interface may change before graduation. No stability promise. |
| 🔴 **Unsupported / internal** | Not intended for direct external use. May change or disappear without notice. |

**Graduation path**: an experimental surface graduates to supported when it has been stable across ≥ 3 months of daily use, has clear documented semantics, and has at least one automated smoke test.

**Deprecation path**: a supported surface moves to deprecated with a notice in the changelog and a migration guide. Removal happens no sooner than the next minor release after deprecation.

---

## Client adapters

| Client | Status | Interface |
|---|---|---|
| Codex CLI | 🟡 Experimental | Native `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`, `PreCompact`, and `PostToolUse` command hooks. |
| Claude Code | 🟡 Experimental | Native `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`, `PreCompact`, `PostToolUse`, and `PostToolUseFailure` command hooks. |
| Google Antigravity CLI | 🟡 Experimental | Native `PreInvocation`, `PostInvocation`, `Stop`, and `PostToolUse` hooks; shared configuration and explicit workspace mounting are required on 1.1.19. |

These clients use `lore-cli.mjs`, not MCP. Native hooks provide automatic recall
and transcript capture. The direct shell commands are `lore_recall`,
`lore_retain`, `lore_onboard`, `memory_search`, `memory_save`, `memory_forget`,
and `memory_status`. The canonical lists are `LORE_CLIENT_HOOKS` and
`LORE_CLI_TOOL_NAMES` in `lib/capability-manifest.mjs`.
See [installation, verification, and boundaries](cli-integrations.md).

## Session hooks

The hook names below describe the existing Copilot SDK adapter. Other CLI
events map to shared behavior through the adapters above.

| Hook | Status | Notes |
|---|---|---|
| `onSessionStart` | 🟢 Supported | Initialises DB, loads config, runs cheap pre-warm. Bounded latency target: < 300 ms. |
| `onUserPromptSubmitted` | 🟢 Supported | Injects memory capsule into prompt context when relevant. Bounded latency target: < 200 ms. Temporal prompts use date normalisation plus `day_summary` / episode lookup first, then bounded raw session-store verification only when primary temporal evidence is missing. |
| `onSessionEnd` | 🟢 Supported | Persists session extraction to the derived store. Non-blocking best-effort. |
| `onErrorOccurred` | 🟡 Experimental | Passive error telemetry. Requires `rollout.errorTelemetry: true` (default-off). Persists only categorical metadata to `error_telemetry` table. Never persists error messages, stack traces, or raw payloads. No `errorHandling` override in Phase 2. |
| `onPostToolUse` | 🟡 Experimental | Passive post-tool-use observations. Requires `rollout.postToolUse: true` (default-off). Derives categorical tool kind and success/failure only. Never persists raw args or results. Enqueues observations via deferred background path. When `subagentScopeTracking` is also enabled, annotates observations with the active sub-agent name. |
| `onPreToolUse` | 🟡 Experimental | Narrow default-off guardrail (Phase 3). Requires `rollout.preToolUseGuardrail: true`. Only observes tools in the explicit allowlist (`lore_retain`, `lore_reflect`, `memory_save`). Never blocks; never persists raw args. Returns advisory `additionalContext` with active sub-agent scope when both flags are on. Fails open on timeout (50 ms), error, or malformed payload. |
| `onPreMcpToolCall` | ⏸ Deferred | SDK capability verified (≥ 1.0.75). Intentionally not registered in Phase 3 — no concrete Lore MCP metadata use case verified. See `docs/copilot-sdk-hooks.md`. |

---

## Memory tools

### Core memory verbs

| Tool | Status | Notes |
|---|---|---|
| `lore_recall` | 🟢 Supported | Primary recall verb. Returns matched memories with provenance. Optional local query expansion changes retrieval terms only and retries deterministic retrieval when expansion finds no evidence. When `localInference.embeddings` is configured, appends embedding-ranked `Semantic Matches` (cosine similarity) cached in `memory_embedding`; fails open to lexical-only on endpoint errors. |
| `lore_retain` | 🟢 Supported | Primary retain verb. Persists a memory with scope, category, and optional domain association. |
| `lore_onboard` | 🟢 Supported | Captures the user name plus Lore's assistant/style profile in one step. |
| `memory_search` | 🟢 Supported | Keyword search over the derived semantic-memory store. Meaning-based (vector) search is available via `lore_recall` when embeddings are configured. |
| `memory_save` | 🟢 Supported | Explicit save for freeform notes and decisions. |
| `memory_forget` | 🟢 Supported | Soft-deletes a memory by ID. |

### Status and diagnostics

| Tool | Status | Notes |
|---|---|---|
| `memory_status` | 🟢 Supported | Overview of DB health, row counts, latency metrics, and maintenance state. |
| `memory_explain` | 🟢 Supported | Explains what context would be injected for a given prompt and why. |
| `memory_validate` | 🟢 Supported | Validates DB integrity and schema parity. |

### Skill management and diagnostics

| Tool | Status | Notes |
|---|---|---|
| `memory_skill_validate` | 🟢 Supported | Validates SKILL.md files and frontmatter. Useful for skill authors and maintainers. |

### Synthesis and reflection

| Tool | Status | Notes |
|---|---|---|
| `lore_reflect` | 🟡 Experimental | Synthesised reflection over recent memory clusters. Optional persisted observations are supported via `refreshableObservations`. Local model synthesis is default-off but supports persistent config plus per-call overrides, advisory consolidation/contradiction/trend findings, optional quality evaluation, and embedding-grounded claims. |

### Scope control

| Tool | Status | Notes |
|---|---|---|
| `memory_scope_override` | 🟡 Experimental | Override the active memory scope for a session. Interface may evolve. |
| `memory_scope_audit` | 🟡 Experimental | Audit scope decisions across recent retrieval events. |

### Backfill and deferred processing

| Tool | Status | Notes |
|---|---|---|
| `memory_backfill` | 🟡 Experimental | Backfills memories from the raw session store. The public tool is bounded to 20 items per run; manual controlled runs still create restorable snapshots, while session-start archive import uses the same engine without creating snapshots. |
| `memory_deferred_process` | 🟡 Experimental | Triggers processing of extractions deferred during session-start. Optional local model enrichment is default-off, requires provider plus deferred-extraction opt-in, and preserves deterministic extraction on failure. |

### Replay and portability

| Tool | Status | Notes |
|---|---|---|
| `memory_replay` | 🟡 Experimental | Runs the replay corpus against current retrieval behavior and reports ranking hits/misses. |
| `memory_portable_bundle` | 🟡 Experimental | Exports a portable bundle of approved improvement artifacts. format=json (default) writes a single signed JSON file; format=okf writes an OKF v0.1 markdown+frontmatter bundle directory for human/agent-readable, git-diffable exchange. action=import (format=okf only) reads an OKF bundle directory from disk and retains each concept as a `type=okf_concept` semantic memory row, retrievable via `memory_search(query="okf_import", type="okf_concept")` — imported content defaults to a lower confidence (0.7) than self-authored memory and is always manually invoked, never automatic. Re-importing the same bundle reinforces existing rows (by a stable `repository::conceptId` canonical key) instead of duplicating them, but stored content is not overwritten by a later import — the first import's content wins. json format import is not yet implemented. |

### Improvement and evolution

| Tool | Status | Notes |
|---|---|---|
| `memory_improvement_backlog` | 🟡 Experimental | Lists accumulated improvement artifacts and their status. Requires `evolutionLedger` rollout flag. |
| `memory_evolution_ledger` | 🟡 Experimental | Reads and writes the evolution ledger of memory-quality improvement goals. Requires `evolutionLedger` rollout flag. |
| `memory_intent_journal` | 🟡 Experimental | Reads the intent and trajectory journal for recent sessions. |

### Maintenance

| Tool | Status | Notes |
|---|---|---|
| `maintenance_schedule_run` | 🟡 Experimental | Triggers a maintenance sweep (dry-run or live), reports automated memory hygiene, or rolls back one exact `auto-hygiene:*` marker with an audit artifact. |

### Self-diagnostics and proposals

| Tool | Status | Notes |
|---|---|---|
| `memory_doctor_report` | 🟡 Experimental | Generates a structured health report. Requires `loreDoctor` and `evolutionLedger` rollout flags. |
| `memory_review_gate` | 🟡 Experimental | Runs an observe-only proposal-doc gate and records review-gate trajectory artifacts. Requires `reviewGate` and `evolutionLedger` rollout flags. |
| `memory_capability_inventory` | 🟡 Experimental | Enumerates all registered capabilities with rollout state. |

---

## Browser UI

| Surface | Status | Notes |
|---|---|---|
| `browser/` — local dashboard | 🟡 Experimental | Loopback-only, read-only Node HTTP server + static HTML. Bind address accepts `127.0.0.1`, `localhost`, or `::1` only. Not hardened for network exposure. |
| Overview tab | 🟡 Experimental | Activity state, memory summary, maintenance status. |
| Memories tab | 🟡 Experimental | Browsable memory list with scope and category filters. |
| Maintenance tab | 🟡 Experimental | Maintenance task history and schedule state. |
| Episodes tab | 🟡 Experimental | Session-grouped episode view. |
| Drill-down tab | 🟡 Experimental | Provenance, supersession lineage, and canonical grouping for a selected memory. |

> **Privacy note**: The browser dashboard has no authentication and displays the full contents of your memory store — including code, file paths, decisions, and session notes from your local workspace. It is opt-in and only runs when you explicitly start it. Do not proxy or forward the port externally. See [SECURITY.md](../SECURITY.md#browser-dashboard) for the full risk model.

---

## Scripts

| Script | Status | Notes |
|---|---|---|
| `scripts/validate-config-schema.mjs` | 🟢 Supported | Validates `lore.json` against the schema. Safe to run at any time. |
| `scripts/run-maintenance.mjs` | 🟡 Experimental | The supported out-of-session entry point for maintenance tasks (`memoryHygiene`, `validationCorpus`, `replayCorpus`, `backlogReview`, `traceCompaction`, `indexUpkeep`, `doctorSnapshot`). Designed for cron, launchd, or any external scheduler. Exits 0 on success, 1 on unknown task names or DB error. Operates only on the configured Lore database — never on test fixtures or other users' databases. See [`docs/maintenance-scheduling.md`](maintenance-scheduling.md) for the full guide. Use `maintenance_schedule_run` tool for in-session triggering. |
| `scripts/run-browser.mjs` | 🟡 Experimental | Starts the local browser dashboard. Loopback hosts only (`127.0.0.1`, `localhost`, or `::1`). |

---

## Rollout flags

Experimental surfaces are controlled by rollout flags in the `rollout` section of `lore.json`. For quick-start config snippets for `traceRecorder` and `maintenanceScheduler`, see the [README optional features section](../README.md#optional-features). The table below maps each flag to its governed surfaces.

| Flag | Status | Default | Governed surfaces |
|---|---|---|---|
| `memoryOperations` | 🟢 Supported | `true` | `lore_recall`, `lore_retain`, `lore_reflect`, workstream overlays, temporal normalisation, temporal provenance/confidence notes, retention sanitisation |
| `memoryDomains` | 🟢 Supported | `true` (requires `memoryOperations`) | Domain-aware semantic retention and domain metadata persisted alongside memories |
| `refreshableObservations` | 🟢 Supported | `true` (requires `memoryDomains`) | Persisted observations produced from `lore_reflect` |
| `workstreamOverlays` | 🟢 Supported | `true` (requires `memoryOperations`) | Workstream overlay injection at prompt time |
| `temporalQueryNormalization` | 🟢 Supported | `true` (requires `memoryOperations`) | Temporal phrase normalisation in queries |
| `retentionSanitization` | 🟢 Supported | `true` (requires `memoryOperations`) | Anti-feedback-loop guards on transcript-based retention |
| `hybridRetrieval` | 🟢 Supported | `true` (requires `memoryOperations`) | Hybrid keyword + entity/recency retrieval path for episode scoring (distinct from embedding-based memory search) |
| `directives` | 🟢 Supported | `true` (requires `memoryOperations`) | Directive injection into memory capsules |
| `overlayAutoHydration` | 🟢 Supported | `true` (requires `workstreamOverlays`) | Auto-hydrates workstream overlay on session start |
| `traceRecorder` | 🟡 Experimental | `false` | Trace recorder for prompt-need classification and retrieval audits |
| `evolutionLedger` | 🟡 Experimental | `true` | `memory_improvement_backlog`, `memory_evolution_ledger`, proposal generation, integrity checks, doctor, review gate, approval substrate |
| `proposalGeneration` | 🟢 Supported | `true` (requires `evolutionLedger`) | AI-assisted improvement proposal generation |
| `generatedArtifactIntegrity` | 🟡 Experimental | `true` (requires `evolutionLedger`) | Integrity checks on generated manifests and caches |
| `loreDoctor` | 🟢 Supported | `true` (requires `evolutionLedger`) | `memory_doctor_report` |
| `reviewGate` | 🟢 Supported | `true` (requires `evolutionLedger`) | `memory_review_gate` |
| `approvalSubstrate` | 🟢 Supported | `true` (requires `evolutionLedger`) | Approval-workflow substrate for ledger-backed proposal review state |
| `errorTelemetry` | 🟡 Experimental | `false` | Passive `onErrorOccurred` hook. Persists only categorical metadata (category, recoverability, fingerprint) to `error_telemetry`. Never persists raw messages or stack traces. No `errorHandling` overrides. |
| `postToolUse` | 🟡 Experimental | `false` | Passive `onPostToolUse` hook. Derives categorical tool kind and success/failure. Enqueues observations via deferred background path. Never persists raw args or results. |
| `subagentScopeTracking` | 🟡 Experimental | `false` | Phase 3. Tracks active custom agent identity via `subagent.*` session events. In-memory only; never persisted. Resets on deselection, completion, failure, and session end. Attaches additive scope metadata to `onPostToolUse` and `onPreToolUse` outputs when active. |
| `preToolUseGuardrail` | 🟡 Experimental | `false` | Phase 3. Wires `onPreToolUse` for tools in the explicit Lore allowlist (`lore_retain`, `lore_reflect`, `memory_save`). Observe-only; never blocks; fails open on timeout (50 ms), error, or malformed payload. No raw args persisted. |

Temporal recall notes:

- Pure temporal prompts (for example `what did we do last Thursday?`) prefer `day_summary` rows, then date-filtered episode recall.
- When that primary temporal evidence is missing, Lore can run a bounded verification pass against the raw session store for the resolved date instead of widening into broad keyword history search.
- Temporal prompt context now carries explicit provenance/confidence labels:
  - `high` → day summary
  - `medium` → episode fallback
  - `low` → verified raw session history
- Local embeddings rerank bounded evidence, validate generated reflection or compressed-context claims, and — when `embeddings.enabled` — power meaning-based memory search for `lore_recall` (query and memory embeddings ranked by cosine similarity). Embedding vectors are cached in the local `memory_embedding` table; they augment, not replace, the general lexical retrieval/indexing pipeline. EmbeddingGemma and Nomic receive model-specific retrieval prefixes, and model-backed lookback reflection can use the latest bounded checkpoint overview when a session title is too generic.
- Optional query expansion performs a separate bounded retrieval attempt and preserves deterministic routing, temporal scope, repository eligibility, and fallback behavior.

---

## Structured status values

The new structured Wave 1 entities use explicit status fields:

- `memory_domain.status` → `active`, `archived`
- `refreshable_observation.status` → `current`, `stale`, `error`

These are persisted rows, so new values should be treated as contract changes and documented here when they expand.

---

## When the maintenance / "healing" loop runs

Lore's maintenance loop is intentionally bounded. It is about **runtime/data health and improvement artifacts**, not static source-code repair.

### Hook cadence

**Session hooks do not guarantee wall-clock cadence.** `onSessionStart` fires only when a Copilot CLI session starts. If sessions are infrequent, maintenance that depends on session start may not run for hours or days. Use `scripts/run-maintenance.mjs` with an external scheduler (cron, launchd) for wall-clock-driven upkeep.

### Maintenance modes

| Mode | Trigger | Tasks |
|---|---|---|
| Automatic | `onSessionStart` hook | Bounded deferred `memoryHygiene` and `deferredExtraction` |
| Manual / in-session | `maintenance_schedule_run` tool; `--dry-run`; `--status` | Any enabled task |
| External / scheduled | `scripts/run-maintenance.mjs` | Any enabled task |

### Isolated database rule

Scheduled maintenance operates only on the configured Lore database (default `~/.config/lore/lore.db`). It must never be pointed at test fixtures, shared databases, or other users' databases. Failed migrations and jobs use forward recovery — if a task fails, the database is left intact and the failure is recorded for the next run to retry.

### Auto-run conditions

It auto-runs on session start only when all of these are true:

- `maintenanceScheduler.enabled: true`
- `maintenanceScheduler.autoRunOnSessionStart: true`
- Lore has an initialized runtime with both the derived DB and the raw session store open
- The task is enabled and due under `maintenanceScheduler.tasks.*` plus its cadence settings

Additional task gates:

- On session start, Lore only auto-selects `memoryHygiene` and `deferredExtraction`; the broader maintenance set is for manual or scripted sweeps.
- `memoryHygiene` requires `maintenanceScheduler.memoryHygiene.mode` to be `shadow` or `apply`. `shadow` records candidates without superseding rows. `apply` uses deterministic completion evidence, writes an `auto-hygiene:<run-id>` marker, and never blocks write tools.
- Optional archive import is separate from the maintenance task list and is configured under `maintenanceScheduler.sessionStartBackfill.*`. When enabled, Lore announces start/progress/completion in the CLI while reusing the existing controlled backfill run state, `maxCandidates` bounds how many pending sessions it queues per startup sweep, `maxInspected` bounds how much raw history it scans before deferring the rest to later starts, and startup runs do not create restore snapshots.
- `deferredExtraction` also requires `deferredExtraction.enabled: true`, and on session start it additionally requires `deferredExtraction.autoProcessOnSessionStart: true`.
- `doctorSnapshot` requires `rollout.loreDoctor: true`.
- Proposal/integrity/review surfaces stay bounded by the `evolutionLedger`, `proposalGeneration`, `generatedArtifactIntegrity`, `reviewGate`, and `approvalSubstrate` rollout flags.

You can always inspect or force the loop manually with `maintenance_schedule_run` or `node scripts/run-maintenance.mjs`. See [`docs/maintenance-scheduling.md`](maintenance-scheduling.md) for the full external scheduling guide.

What it **does not** currently do: statically inspect Lore's own source tree for logic mistakes like duplicated migration calls. Those still need tests, review, or future invariant checks.
