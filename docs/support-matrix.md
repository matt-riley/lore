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

## Session hooks

| Hook | Status | Notes |
|---|---|---|
| `onSessionStart` | 🟢 Supported | Initialises DB, loads config, runs cheap pre-warm. Bounded latency target: < 300 ms. |
| `onUserPromptSubmitted` | 🟢 Supported | Injects memory capsule into prompt context when relevant. Bounded latency target: < 200 ms. Temporal prompts use date normalisation plus `day_summary` / episode lookup first, then bounded raw session-store verification only when primary temporal evidence is missing. |
| `onSessionEnd` | 🟢 Supported | Persists session extraction to the derived store. Non-blocking best-effort. |

---

## Memory tools

### Core memory verbs

| Tool | Status | Notes |
|---|---|---|
| `lore_recall` | 🟢 Supported | Primary recall verb. Returns matched memories with provenance. |
| `lore_retain` | 🟢 Supported | Primary retain verb. Persists a memory with scope and category. Domain association is experimental behind `memoryDomains`. |
| `lore_onboard` | 🟢 Supported | Captures the user name plus Lore's assistant/style profile in one step. |
| `memory_search` | 🟢 Supported | Keyword + semantic search across the derived store. |
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
| `lore_reflect` | 🟡 Experimental | Synthesised reflection over recent memory clusters. Optional persisted observations require `refreshableObservations`. |

### Scope control

| Tool | Status | Notes |
|---|---|---|
| `memory_scope_override` | 🟡 Experimental | Override the active memory scope for a session. Interface may evolve. |
| `memory_scope_audit` | 🟡 Experimental | Audit scope decisions across recent retrieval events. |

### Backfill and deferred processing

| Tool | Status | Notes |
|---|---|---|
| `memory_backfill` | 🟡 Experimental | Backfills memories from the raw session store. The public tool is bounded to 20 items per run; manual controlled runs still create restorable snapshots, while session-start archive import uses the same engine without creating snapshots. |
| `memory_deferred_process` | 🟡 Experimental | Triggers processing of extractions deferred during session-start. |

### Replay and portability

| Tool | Status | Notes |
|---|---|---|
| `memory_replay` | 🟡 Experimental | Runs the replay corpus against current retrieval behavior and reports ranking hits/misses. |
| `memory_portable_bundle` | 🟡 Experimental | Exports a portable bundle of memories and improvement artifacts. Import not yet implemented. |

### Improvement and evolution

| Tool | Status | Notes |
|---|---|---|
| `memory_improvement_backlog` | 🟡 Experimental | Lists accumulated improvement artifacts and their status. Requires `evolutionLedger` rollout flag. |
| `memory_evolution_ledger` | 🟡 Experimental | Reads and writes the evolution ledger of memory-quality improvement goals. Requires `evolutionLedger` rollout flag. |
| `memory_intent_journal` | 🟡 Experimental | Reads the intent and trajectory journal for recent sessions. |

### Maintenance

| Tool | Status | Notes |
|---|---|---|
| `maintenance_schedule_run` | 🟡 Experimental | Triggers a maintenance sweep (dry-run or live). Designed for scripted/scheduled use. |

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
| `scripts/run-maintenance.mjs` | 🟡 Experimental | Runs maintenance sweeps outside of session context. Use `maintenance_schedule_run` tool for in-session triggering. |
| `scripts/run-browser.mjs` | 🟡 Experimental | Starts the local browser dashboard. Loopback hosts only (`127.0.0.1`, `localhost`, or `::1`). |

---

## Rollout flags

Experimental surfaces are controlled by rollout flags in the `rollout` section of `lore.json`. The table below maps each flag to its governed surfaces.

| Flag | Default | Governed surfaces |
|---|---|---|
| `memoryOperations` | `true` | `lore_recall`, `lore_retain`, `lore_reflect`, workstream overlays, temporal normalisation, temporal provenance/confidence notes, retention sanitisation |
| `memoryDomains` | `false` (requires `memoryOperations`) | Domain-aware semantic retention and domain metadata persisted alongside memories |
| `refreshableObservations` | `false` (requires `memoryDomains`) | Persisted observations produced from `lore_reflect` |
| `workstreamOverlays` | `true` (requires `memoryOperations`) | Workstream overlay injection at prompt time |
| `temporalQueryNormalization` | `true` (requires `memoryOperations`) | Temporal phrase normalisation in queries |
| `retentionSanitization` | `true` (requires `memoryOperations`) | Anti-feedback-loop guards on transcript-based retention |
| `hybridRetrieval` | `true` (requires `memoryOperations`) | Hybrid keyword + semantic retrieval path |
| `directives` | `true` (requires `memoryOperations`) | Directive injection into memory capsules |
| `overlayAutoHydration` | `true` (requires `workstreamOverlays`) | Auto-hydrates workstream overlay on session start |
| `traceRecorder` | `false` | Trace recorder for prompt-need classification and retrieval audits |
| `evolutionLedger` | `true` | `memory_improvement_backlog`, `memory_evolution_ledger`, proposal generation, integrity checks, doctor, review gate |
| `proposalGeneration` | `false` (requires `evolutionLedger`) | AI-assisted improvement proposal generation |
| `generatedArtifactIntegrity` | `true` (requires `evolutionLedger`) | Integrity checks on generated manifests and caches |
| `loreDoctor` | `false` (requires `evolutionLedger`) | `memory_doctor_report` |
| `reviewGate` | `false` (requires `evolutionLedger`) | `memory_review_gate` |

Temporal recall notes:

- Pure temporal prompts (for example `what did we do last Thursday?`) prefer `day_summary` rows, then date-filtered episode recall.
- When that primary temporal evidence is missing, Lore can run a bounded verification pass against the raw session store for the resolved date instead of widening into broad keyword history search.
- Temporal prompt context now carries explicit provenance/confidence labels:
  - `high` → day summary
  - `medium` → episode fallback
  - `low` → verified raw session history
- This slice does **not** add vector retrieval or an embedding pipeline; `hybridRetrieval` remains the existing lexical/re-ranking path.

---

## Structured status values

The new structured Wave 1 entities use explicit status fields:

- `memory_domain.status` → `active`, `archived`
- `refreshable_observation.status` → `current`, `stale`, `error`

These are persisted rows, so new values should be treated as contract changes and documented here when they expand.

---

## When the maintenance / "healing" loop runs

Lore's maintenance loop is intentionally bounded. It is about **runtime/data health and improvement artifacts**, not static source-code repair.

It auto-runs on session start only when all of these are true:

- `maintenanceScheduler.enabled: true`
- `maintenanceScheduler.autoRunOnSessionStart: true`
- Lore has an initialized runtime with both the derived DB and the raw session store open
- The task is enabled and due under `maintenanceScheduler.tasks.*` plus its cadence settings

Additional task gates:

- On session start, Lore only auto-selects the `deferredExtraction` maintenance task; the broader maintenance set is for manual or scripted sweeps.
- Optional archive import is separate from the maintenance task list and is configured under `maintenanceScheduler.sessionStartBackfill.*`. When enabled, Lore announces start/progress/completion in the CLI while reusing the existing controlled backfill run state, `maxCandidates` bounds how many pending sessions it queues per startup sweep, `maxInspected` bounds how much raw history it scans before deferring the rest to later starts, and startup runs do not create restore snapshots.
- `deferredExtraction` also requires `deferredExtraction.enabled: true`, and on session start it additionally requires `deferredExtraction.autoProcessOnSessionStart: true`.
- `doctorSnapshot` requires `rollout.loreDoctor: true`.
- Proposal/integrity/review surfaces stay bounded by the `evolutionLedger`, `proposalGeneration`, `generatedArtifactIntegrity`, and `reviewGate` rollout flags.

You can always inspect or force the loop manually with `maintenance_schedule_run` or `node scripts/run-maintenance.mjs`.

What it **does not** currently do: statically inspect Lore's own source tree for logic mistakes like duplicated migration calls. Those still need tests, review, or future invariant checks.
