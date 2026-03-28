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
| `onUserPromptSubmitted` | 🟢 Supported | Injects memory capsule into prompt context when relevant. Bounded latency target: < 200 ms. |
| `onSessionEnd` | 🟢 Supported | Persists session extraction to the derived store. Non-blocking best-effort. |

---

## Memory tools

### Core memory verbs

| Tool | Status | Notes |
|---|---|---|
| `coherence_recall` | 🟢 Supported | Primary recall verb. Returns matched memories with provenance. |
| `coherence_retain` | 🟢 Supported | Primary retain verb. Persists a memory with scope and category. |
| `memory_search` | 🟢 Supported | Keyword + semantic search across the derived store. |
| `memory_save` | 🟢 Supported | Explicit save for freeform notes and decisions. |
| `memory_forget` | 🟢 Supported | Soft-deletes a memory by ID. |

### Status and diagnostics

| Tool | Status | Notes |
|---|---|---|
| `memory_status` | 🟢 Supported | Overview of DB health, row counts, latency metrics, and maintenance state. |
| `memory_explain` | 🟢 Supported | Explains what context would be injected for a given prompt and why. |
| `memory_validate` | 🟢 Supported | Validates DB integrity and schema parity. |

### Synthesis and reflection

| Tool | Status | Notes |
|---|---|---|
| `coherence_reflect` | 🟡 Experimental | Synthesised reflection over recent memory clusters. Requires `memoryOperations` rollout flag. |

### Scope control

| Tool | Status | Notes |
|---|---|---|
| `memory_scope_override` | 🟡 Experimental | Override the active memory scope for a session. Interface may evolve. |
| `memory_scope_audit` | 🟡 Experimental | Audit scope decisions across recent retrieval events. |

### Backfill and deferred processing

| Tool | Status | Notes |
|---|---|---|
| `memory_backfill` | 🟡 Experimental | Backfills memories from the raw session store. Bounded to 20 items per run; larger volumes need direct module access. |
| `memory_deferred_process` | 🟡 Experimental | Triggers processing of extractions deferred during session-start. |

### Replay and portability

| Tool | Status | Notes |
|---|---|---|
| `memory_replay` | 🟡 Experimental | Replays a past retrieval event against current state for comparison. |
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
| `memory_doctor_report` | 🟡 Experimental | Generates a structured health report. Requires `coherenceDoctor` rollout flag. |
| `memory_review_gate` | 🟡 Experimental | Lists pending review-gated proposals and allows approval/rejection. Requires `reviewGate` rollout flag. |
| `memory_capability_inventory` | 🟡 Experimental | Enumerates all registered capabilities with rollout state. |

---

## Browser UI

| Surface | Status | Notes |
|---|---|---|
| `browser/` — local dashboard | 🟡 Experimental | Localhost-only, read-only Node HTTP server + static HTML. Bind address is `127.0.0.1` only. Not hardened for network exposure. |
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
| `scripts/validate-config-schema.mjs` | 🟢 Supported | Validates `coherence.json` against the schema. Safe to run at any time. |
| `scripts/run-maintenance.mjs` | 🟡 Experimental | Runs maintenance sweeps outside of session context. Use `maintenance_schedule_run` tool for in-session triggering. |
| `scripts/run-browser.mjs` | 🟡 Experimental | Starts the local browser dashboard. Localhost only. |

---

## Rollout flags

Experimental surfaces are controlled by rollout flags in the `rollout` section of `coherence.json`. The table below maps each flag to its governed surfaces.

| Flag | Default | Governed surfaces |
|---|---|---|
| `memoryOperations` | `true` | `coherence_recall`, `coherence_retain`, `coherence_reflect`, workstream overlays, temporal normalisation, retention sanitisation |
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
| `coherenceDoctor` | `false` (requires `evolutionLedger`) | `memory_doctor_report` |
| `reviewGate` | `false` (requires `evolutionLedger`) | `memory_review_gate` |
