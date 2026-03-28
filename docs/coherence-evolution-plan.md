# Combined implementation plan

> **Public name**: This extension is called **Lore** in all outward-facing docs and communications.  
> See [`README.md`](../README.md) for the product introduction, [`docs/support-matrix.md`](support-matrix.md) for the capability taxonomy, and [`docs/compatibility.md`](compatibility.md) for version and platform requirements.  
> Internal identifiers (module names, tool prefixes, config keys) still say "coherence" and will migrate incrementally — this plan document retains the original naming for historical continuity.

## Problem

Turn the combined OpenSpace, Instar, and Hindsight research into a concrete implementation program for `/Users/matthew.riley/.copilot` that improves the day-to-day Copilot CLI experience without replacing `extensions/coherence/`.

## Decision summary

- Keep `extensions/coherence/` as the memory substrate.
- Change the execution order from the first report: do **memory ergonomics first**, then routing/orchestration, then self-improvement infrastructure.
- Use Hindsight for the memory contract (`retain / recall / reflect`), Instar for continuity and maintenance patterns, and OpenSpace for routing, trace capture, and evolution ledgers.

## Proposed architecture

```text
Current foundation
------------------
coherence hooks
  -> session-start capsule
  -> prompt-time retrieval
  -> session-end extraction
  -> validation / replay / improvement backlog

Target shape
------------
memory operations layer
  -> coherence_retain
  -> coherence_recall
  -> workstream overlays
  -> temporal normalization

working-memory + runtime layer
  -> working-memory v2 rendering
  -> coherence_reflect
  -> trace recorder
  -> capability router
  -> maintenance scheduler

safe improvement layer
  -> evolution ledger
  -> review-gated proposal generation
  -> integrity checks for generated manifests/caches
  -> richer status/dashboard surfaces
```

## Current observability and browser slices

- The visibility substrate now persists positive-path activity in `coherence_activity_state` and bounded sampled retrieval history in `retrieval_trace_sample`, which powers richer `memory_status` output and browser overview state.
- The local browser under `extensions/coherence/browser/` is now a localhost-only, read-only Node server plus static HTML/CSS/vanilla JS with `Overview`, `Memories`, `Maintenance`, `Episodes`, and a secondary `Drill-down` tab.
- The drill-down view is intentionally scoped: it centers on a selected memory, workstream, or session and renders provenance, supersession lineage, canonical grouping, linked improvement artifacts, and episode/day grouping without replacing the overview-first landing flow.
- Maintenance operationalization stays on the existing `run-maintenance.mjs`/scheduler path: session start remains bounded to cheap work, while broader upkeep is expected to run through explicit or scheduled script invocations.

## Phased plan

### Phase 1 — Memory operations layer

Goal: make `coherence` easier to call, reason about, and extend before adding higher-level routing.

Deliverables:

1. Introduce explicit memory verbs:
   - `coherence_retain`
   - `coherence_recall`
2. Add a workstream overlay abstraction for active task continuity:
   - mission / objective
   - extraction steering (`retain` priorities / capture rules)
   - synthesis steering (`reflect` priorities / answer-shaping rules)
   - active constraints
   - blockers
   - next actions
   - retained high-salience decisions
3. Add temporal query normalization ahead of episodic/session retrieval.
4. Add anti-feedback-loop protection for transcript-based retention and future recall/retain paths.
5. Expose richer internal retrieval envelopes so downstream tools can request:
   - matched rows
   - supporting source facts/snippets
   - ranking / trace metadata
6. Harden hook choreography for the ephemeral runtime:
   - cheap session-start prewarm only
   - bounded prompt-time recall work
   - async retain/extraction where safe
   - small locked cross-process state where persistence is required

Likely files in scope:

- `extensions/coherence/extension.mjs`
- `extensions/coherence/lib/memory-tools.mjs`
- `extensions/coherence/lib/capsule-assembler.mjs`
- new `extensions/coherence/lib/memory-operations.mjs`
- new `extensions/coherence/lib/workstream-overlays.mjs`
- new `extensions/coherence/lib/query-normalizer.mjs`
- session-store / extraction helpers where transcript sanitization belongs

Validation:

- `memory_explain` cases for temporal prompts and continuity prompts
- `memory_validate`
- `memory_replay`
- targeted manual prompts:
  - “What did we do last Thursday?”
  - “What are the blockers on this workstream?”
  - “What pattern do you see in our recent debugging sessions?”

Rollout notes:

- keep the old prompt-time injection flow working while new verbs are added
- keep workstream overlays additive to repo/global/transferable scope, not a replacement
- keep new writes additive and flag-gated so rollback is “disable and bypass”, not destructive cleanup

### Phase 2 — Working-memory and observability upgrades

Goal: make retrieval easier to inspect and higher quality at prompt time.

Deliverables:

1. Refactor capsule rendering into a clearer Working Memory v2:
   - explicit source sections
   - source budgets
   - source accounting in traces/explanations
   - richer top-result rendering with compressed lower-priority items
2. Add an optional trace recorder for:
   - prompt-need classification
   - eligible scopes
   - matched vs dropped rows
   - injected context
   - tool/router decisions
3. Extend diagnostics/status output to surface:
   - source hit rates
   - latency trendlines
   - repeated misses / repeated wins
   - workstream overlay state
4. Build full `coherence_reflect` on top of the richer retrieval envelopes and workstream overlays from Phase 1.

Likely files in scope:

- `extensions/coherence/lib/capsule-assembler.mjs`
- `extensions/coherence/lib/diagnostics.mjs`
- `extensions/coherence/lib/memory-tools.mjs`
- new `extensions/coherence/lib/trace-recorder.mjs`
- supporting schema/db modules for persisted traces or sampled trace metadata

Validation:

- compare `memory_explain` output before/after for the same prompts
- ensure session-start and prompt-submit latency stay within existing targets
- replay cases should show trace-backed explanations for misses

Rollout notes:

- start with sampled traces or bounded local retention to avoid latency blowups
- prefer using existing replay/validation surfaces over creating parallel evaluation systems
- treat `coherence_reflect` as Phase-2-complete only once it consumes richer evidence objects rather than a thin wrapper over old prompt injection

### Phase 3 — Capability router

Goal: automatically choose the right local mechanism before the user has to remember it.

Current first slice:

- `extensions/coherence/lib/capability-inventory.mjs` builds a local-first manifest over repo-authored skills, agents, and extension/coherence tool surfaces.
- `memory_capability_inventory` now also runs a recommendation-only router core for a prompt, choosing among retrieval, skill, agent, background-task, and direct/no-op paths with a concrete local target plus traceable reasons, while still avoiding auto-invocation.
- The manifest now carries a concrete router corpus scaffold plus built-in evaluation cases, and `memory_capability_inventory` can run that corpus locally to verify route-family coverage, target selection, confidence, and explanation quality.

Deliverables:

1. Build a local-first capability router that can choose among:
   - plain retrieval
   - a skill
   - a custom agent
   - a background task
   - a no-op / direct answer path
2. Index local capabilities from:
   - `skills/`
   - `agents/`
   - extension tools / repo docs
3. Feed router decisions and outcomes into the trace/evaluation system.

Likely files in scope:

- new router manifest/index modules under `extensions/coherence/lib/` or sibling extension code
- `README.md` or local docs only if needed for capability discovery metadata
- trace/evaluation storage used by the router

Validation:

- hand-authored prompt corpus covering at least:
  - skill routing
  - agent routing
  - plain retrieval
  - background-task routing
  - direct/no-op answer paths
- require traceable router explanations for each corpus case
- require a documented success bar before default-on routing

Rollout notes:

- keep routing strictly local by default
- start with recommendation/explanation mode before fully automatic routing if needed
- keep router manifests/indexes additive and ignorable on rollback

### Phase 4 — Maintenance scheduler

Goal: make quality upkeep routine instead of opportunistic.

Current first slice:

- `extensions/coherence/lib/maintenance-scheduler.mjs` now owns a bounded local maintenance planner/executor that reuses deferred extraction, validation, replay, backlog review, and optional trace/index upkeep.
- `maintenance_schedule_run` exposes dry-run/status/live execution through the existing Coherence tool surface, while `memory_status` now shows scheduler state and recent maintenance runs.
- The scheduler remains default-off behind `maintenanceScheduler.enabled`, with a standalone `extensions/coherence/scripts/run-maintenance.mjs` entrypoint for explicit local runs.

Deliverables:

1. Add a lightweight scheduler for:
   - deferred extraction
   - validation corpus runs
   - replay corpus runs
   - stale backlog review
   - optional trace/index compaction
2. Add health/status reporting for maintenance activity.

Likely files in scope:

- `extensions/coherence/lib/backfill.mjs`
- scheduler entrypoints or scripts under `extensions/coherence/`
- `extensions/coherence/lib/memory-tools.mjs`

Validation:

- dry-run scheduler execution
- successful bounded runs against existing validation/replay suites
- verify maintenance jobs respect explicit caps and fail loudly

Rollout notes:

- keep the scheduler local-only and resource-capped
- do not introduce an always-on heavy daemon as the first cut
- make the scheduler disable-only by config so rollback is operationally trivial

### Phase 5 — Safe improvement loop

Goal: let the system learn from repeated wins/misses without silently mutating trusted config.

Current first slice:

- `memory_evolution_ledger` now exposes a review-gated ledger/report surface over the existing improvement backlog, including manual router/maintenance/trace signal capture.
- `extensions/coherence/lib/proposal-generator.mjs` can turn active ledger artifacts into review-only proposal docs under `extensions/coherence/docs/proposals/`, with provenance, supporting evidence, explicit review state, and no automatic edits to trusted source files.
- Generated proposal artifacts now carry explicit integrity verification and an explicit repair path; the maintenance scheduler's `backlogReview` task can generate proposals and run proposal-artifact integrity checks when the corresponding rollout flag is enabled.

Deliverables:

1. Add an evolution ledger that unifies:
   - replay misses
   - validation failures
   - extracted lessons
   - router/trace performance signals
2. Generate reviewable proposals for:
   - skills
   - instruction updates
   - extension heuristic changes
3. Add integrity checks for generated manifests/caches.

Likely files in scope:

- `extensions/coherence/lib/db.mjs`
- `extensions/coherence/lib/schema.mjs`
- `extensions/coherence/lib/memory-tools.mjs`
- proposal-generation / integrity helper modules

Validation:

- proposal artifacts include provenance and supporting evidence
- integrity failures trigger rebuild/rescan paths instead of silent fallback

Rollout notes:

- all evolution remains review-gated
- generated artifacts only; never sign or mutate user-authored source of truth files silently
- keep proposal/ledger artifacts additive so rollback is “disable and ignore”, not schema surgery

### Wave 3 minimal landed slice — intent journaling

- Added a bounded `intent_journal` table and indexes in the coherence DB schema for durable local intent capture.
- Added `memory_intent_journal` with `action=list|record` and constrained kinds (`journal`, `routing`, `rollout`, `reviewer`, `fallback`, `serendipity`).
- Extended `memory_status`/DB stats with intent-journal counters so this slice is observable without adding a parallel dashboard.
- Scope is intentionally minimal and additive: no autonomous routing changes, no automatic cross-worktree import path, and no trusted-source mutation.

## Dependencies

- Phase 1 is the new foundation and should land first.
- Working Memory v2 depends on Phase 1 retrieval envelopes and workstream overlays.
- The capability router depends on Phase 1 memory verbs and Phase 2 trace data.
- The scheduler depends on existing validation/replay tooling and benefits from Phase 2 diagnostics.
- The safe improvement loop depends on router traces, scheduler outputs, and backlog artifacts from earlier phases.

## Recommended first implementation slice

If we want the smallest high-leverage slice, do this first:

1. Add `coherence_recall` as a structured internal boundary.
2. Add workstream overlays.
3. Add temporal normalization.

That sequence gives the biggest product improvement with the least architectural churn and sets up richer reflect/router/scheduler work cleanly.

## Phase exit criteria

### Baseline capture exit criteria

- Save a pre-change snapshot of:
  - `memory_status`
  - `memory_validate`
  - `memory_replay`
  - current hook latency readings
- Record current must-pass validation/replay cases and configured latency targets before implementation starts.
- Store baseline artifacts in the session workspace under `session-state/<sessionId>/files/baselines/` so later phases can compare against a reproducible local snapshot.

### Phase 1 exit criteria

- `coherence_retain` and `coherence_recall` exist as explicit internal boundaries.
- Temporal recall and workstream continuity succeed on the curated manual prompt set.
- `memory_validate` shows no new failures versus baseline.
- `memory_replay` shows no regressions on must-pass invariants versus baseline.
- Hook latency remains within current configured targets, or any exception is explicitly documented and accepted before continuing.
- Any new overlay/query-normalizer state is additive and fully bypassable by config.

### Phase 2 exit criteria

- Working Memory v2 reports source sections and source budgeting/accounting in explain output.
- Trace output can show matched vs dropped evidence for the curated prompt set.
- `coherence_reflect` uses richer retrieval envelopes rather than a thin wrapper over old prompt injection.
- `coherence_reflect` succeeds on at least one reflect-specific manual prompt from the curated set (for example, “What pattern do you see in our recent debugging sessions?”).
- `memory_validate` and must-pass replay cases remain non-regressed.
- Trace storage can be disabled without breaking baseline retrieval behavior.

### Phase 3 exit criteria

- The router corpus covers skill, agent, retrieval, and direct/no-op cases.
- Router decisions are explainable from traces.
- The success bar for default-on routing is documented and met on the corpus.
- Recommendation-only mode remains available as a safer fallback.

### Phase 4 exit criteria

- Scheduler dry-run and bounded live runs complete without unhandled errors.
- Deferred extraction, replay, and validation jobs respect configured caps.
- Scheduler can be disabled cleanly without affecting baseline interactive behavior.

### Phase 5 exit criteria

- Proposal artifacts include provenance, supporting evidence, and explicit review state.
- Integrity verification failures trigger rebuild/rescan behavior instead of silent fallback.
- All improvement paths remain review-gated and additive to trusted source files.

## Compatibility and rollback gates

- Prefer additive schema changes only: new tables, new columns, new cache artifacts, no destructive migration in the initial rollout.
- Gate each major new subsystem behind an explicit config flag so rollback is “disable and bypass”, not “delete data”.
- Keep legacy prompt-time retrieval behavior available until the new boundary has passed validation/replay and manual corpus checks.
- For generated manifests, traces, overlays, and ledgers, define the revert path as:
  1. disable writes
  2. ignore unread artifacts
  3. fall back to legacy retrieval/diagnostics
- Do not let new persisted artifacts become required inputs for baseline chat behavior until they have survived a replay/validation cycle.

## Out of scope / defer

- Replacing SQLite/local-first coherence with a full Hindsight-style backend
- Defaulting to a remote or daemonized external memory service
- Autonomous self-editing of trusted instructions/skills/extensions
- Cloud skill sharing as a default behavior

## Verification commands and artifacts

- Verification commands:
  - `memory_status`
  - `memory_evolution_ledger`
  - `coherence_reflect`
  - `memory_explain`
  - `memory_validate`
  - `memory_replay`
- Existing research artifacts:
  - `research/i-want-you-to-research-both-https-github-com-hkuds.md`
  - `research/i-have-another-project-i-want-you-to-include-in-th.md`
- Plan artifact:
  - `plan.md` (this file)
  - `extensions/coherence/docs/coherence-evolution-plan.md` (published repo copy)

## Notes

- Current implementation progress:
  - Phase 1 is complete: explicit `coherence_retain` / `coherence_recall`, workstream overlays, temporal normalization, transcript sanitization, and rollout fallback flags are all landed.
  - Validation and replay are green again after suppressing ambient style/addressing for pure temporal recall.
  - Phase 2 is in progress: `memory_explain` and session-start traces now expose section/source accounting, diagnostics/status surfaces now summarize lookup hit rates, repeated wins/misses, current workstream overlay state, and richer latency trendlines, `coherence_reflect` now synthesizes summary/pattern/blocker/decision/next-action views directly from structured evidence envelopes plus active workstream overlays, and an optional bounded trace recorder now captures prompt-need, scope, lookup, and router-ready decision traces without requiring a separate diagnostics stack.
  - Phase 5 first slice is now landed: the safe improvement loop uses the additive improvement backlog as its evolution ledger, `memory_evolution_ledger` can capture manual router/maintenance/trace signals, proposal generation stays review-gated behind `rollout.proposalGeneration`, generated proposal docs live under `extensions/coherence/docs/proposals/`, and explicit integrity verification/repair prevents silent drift in generated artifacts.
  - Session-start proposal awareness is now landed: when draft proposal artifacts exist, the session-start capsule adds a bounded `Pending Proposal Review` section with the most recent draft proposal paths so pending review work becomes visible without a separate command.
- The main strategy change from the first report is ordering: **memory contract first, router second**.
- Keep all new layers additive to `coherence`; avoid big-bang replacement.
- Preserve the current security model, local-first operation, and review-gated trust boundaries.
- The published repository copy of this plan lives at `extensions/coherence/docs/coherence-evolution-plan.md`.


## Phase 3 operational guidance (implemented)

- Source of truth remains unchanged: `runMaintenanceSweep`, `maintenance_schedule_run`, `memory_status`, and persisted `maintenance_task_state` / `maintenance_run`.
- Supported external scheduler path is `node extensions/coherence/scripts/run-maintenance.mjs` with:
  - `--status` for parity checks
  - `--tasks <csv>` for bounded subsets
  - `--dry-run` / `--force` for rollout and troubleshooting
  - `--recommended-schedule` for operator cadence guidance
- Session-start maintenance is bounded to cheap deferred extraction only; heavier maintenance stays on explicit/scripted runs.
- Recommended periodic tasks:
  - validation corpus
  - replay corpus
  - backlog review
  - trace compaction
  - index upkeep
- Doctor snapshots are now an optional scheduled maintenance task (`doctorSnapshot`) that reuses `memory_doctor_report`/doctor observation surfaces and writes additive doctor-report trajectory artifacts when enabled.
