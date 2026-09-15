# Capability parity ledger

Status: inventory frozen at `4771816`, 2026-09-15. Every v2 row is currently planned, not implemented or certified.
Sources: [capability manifest](../../lib/capabilities/capability-manifest.mjs), [support matrix](../support-matrix.md), [configuration defaults](../../lib/core/config.mjs).

## Completion rule

All 26 canonical operations and their aliases below are in the replacement scope, including experimental operations. Existing experimental status does not excuse omission, and implementing a row does not promote its support level. A future inventory change must amend this ledger before the next gate.

For every row preserve the baseline parameter schema (fields, required/optional meaning, enum values and alias behavior) through CLI/host compatibility translation. The new wire can use typed requests, but a rejected/changed v1 argument needs an explicit documented difference. Run a schema/golden comparison; do not hand-copy only the commonly used arguments.

Each row needs schema, handler, flag, policy, failure and relevant real-surface evidence. Mark implemented/tested/certified separately in the implementation ledger with commit/report links. No row is complete merely because its command name exists.

Stage references: [2](02-daemon-core.md), [3](03-background-embeddings.md), [4](04-ingestion.md), [5A](05-extraction.md), [5B](05-migration-recovery.md), [6A](06-client-adapters.md), [6B](06-administration-dashboard.md), [7](07-rollout.md).

## Canonical operations and aliases

| ID | Canonical operation | Accepted aliases | Current status | Stage | Required behavior / fixture family |
| --- | --- | --- | --- | --- | --- |
| CAP-01 | lore_status | memory_status | supported | 2, 6B | Cheap readiness/coverage; bounded optional recent trace/trajectory detail without default payload logging |
| CAP-02 | memory_intent_journal | none | experimental | 6B | list/record, scope/session/kind/context, durable idempotent record, bounded list |
| CAP-03 | memory_portable_bundle | none | experimental | 6B | Signed JSON export; OKF export/import, confidence, scoped stable concept IDs, first-content-wins; no JSON import |
| CAP-04 | lore_maintenance | maintenance_schedule_run | experimental | 6B | status/run/rollback, dryRun/force/tasks, exact marker/actor/reason and snapshot-safe mutation |
| CAP-05 | memory_improvement_backlog | none | experimental | 6B | List/update/supersede, sourceKind/sourceCaseId, status and bounded limits |
| CAP-06 | memory_evolution_ledger | none | experimental | 6B | Existing actions, capture_signal fields/evidence/trace, dryRun/repair, explicit approval state |
| CAP-07 | memory_capability_inventory | none | experimental | 6B | summary/recommend/route and case/detail options; advertise actual registry/flags, not plans |
| CAP-08 | lore_recall | none | supported | 2, 3, 5A | Lexical + bounded semantic, all context sections, scope, detailLevel/includeTrace and complete provenance |
| CAP-09 | lore_onboard | none | supported | 5A | User/assistant identity, voice/warmth/humor/frequency/collaboration/name defaults; atomic manual authority |
| CAP-10 | lore_retain | lore_save, memory_save | supported | 2, 5A | Semantic/domain/workstream kinds and every current field; manual authority, scope, idempotency, expiry and embedding intent |
| CAP-11 | lore_reflect | none | experimental | 6B | Scope/lookback/focus/detail, persisted observations/freshness/domain, optional local synthesis and evidence validation |
| CAP-12 | lore_search | memory_search | supported | 6B | Keyword/type/limit; explicit broad administrative selection; no ambient private-repo leak |
| CAP-13 | lore_explain | memory_explain | supported | 5A, 6B | Prompt/session_start assembly reasons, same policy/budget as Recall |
| CAP-14 | lore_validate | memory_validate | supported | 6B | Integrity/schema/selected validation cases, verbose bounded output, explicit run |
| CAP-15 | memory_replay | none | experimental | 6B | caseIds/verbose, held-out ranking/evidence, no corpus contamination |
| CAP-16 | memory_scope_override | none | experimental | 6B | semantic/episode IDs, set/clear, dryRun, repository, actor/reason/source, authority audit |
| CAP-17 | memory_scope_audit | none | experimental | 6B | target type/ID/limit, immutable scoped history and complete explanation |
| CAP-18 | lore_forget | memory_forget | supported | 2, 5A, 6B | ID retirement, optional legacy supersededBy attribution, tombstones, aggregate invalidation and no resurrection |
| CAP-19 | lore_correct | memory_correct | supported | 6B | Default preview, planFingerprint, replacement/expiry semantics, snapshot and dependency validation |
| CAP-20 | lore_repair | memory_repair | experimental | 6B | Complete-source evidence, mappings, typed selectedCandidateIds, 32 MiB source limit, unresolved reporting |
| CAP-21 | lore_purge | memory_purge | experimental | 6B | Explicit IDs/repo/global; includeDependentAggregates and full selection, snapshot and retained suppression |
| CAP-22 | memory_deferred_process | none | experimental | 4, 5A, 6B | limit/includeOtherRepositories, deterministic extraction with optional background enrichment |
| CAP-23 | lore_backfill | memory_backfill | experimental | 4, 6B | legacy/controlled, preview/start/resume/status/restore, selected raw source, runId/retryFailed/refreshExisting |
| CAP-24 | lore_doctor | memory_doctor_report | experimental | 6B | dryRun, trajectoryLimit, observe-only plannedActions, source cases and health reasons |
| CAP-25 | memory_review_gate | none | experimental | 6B | Proposal text/dryRun, observe-only checks and bounded trajectory artifact |
| CAP-26 | memory_skill_validate | none | supported | 6B | summary/detailed validation of configured skills; no execution |

## Model, command and lifecycle surfaces

Copilot/Pi register exactly nine model tools: lore_recall, lore_retain, lore_onboard, lore_search, lore_forget, lore_status, lore_explain, lore_validate and lore_correct. Extras and all accepted aliases remain available through `/lore <verb>`, `lore <verb>` and `lore tool <name>`. Aliases normalize once; an alias cannot create a new receipt namespace.

Preserve input `--json`, JSON-on-stdin, positional text and current error exit behavior. New structured output uses `--output json`. Preserve protocol hook stdout and host-specific neutral failure. CLI capture-resume becomes a source hint/status operation, not an independent archive worker.

| Surface ID | Client | Events / responsibilities | Gate |
| --- | --- | --- | --- |
| HOST-01 | Copilot | onSessionStart, onUserPromptSubmitted, onSessionEnd; gated onErrorOccurred, onPostToolUse, onPreToolUse | 6A host tests + 7 soak |
| HOST-02 | Pi | session_start, before_agent_start, context, session_compact, session_tree, tool_call, tool_result, agent_end, session_shutdown; /lore | 6A Node/Bun host tests + 7 soak |
| HOST-03 | Codex | SessionStart, UserPromptSubmit, Stop, SessionEnd, PreCompact, PostToolUse | 6A subprocess/host + 7 soak |
| HOST-04 | Claude Code | SessionStart, UserPromptSubmit, Stop, SessionEnd, PreCompact, PostToolUse, PostToolUseFailure | 6A subprocess/host + 7 soak |
| HOST-05 | Antigravity | PreInvocation, PostInvocation, Stop, PostToolUse; explicit shared config/workspace mounts | 6A subprocess/host + 7 soak |

Copilot onPreMcpToolCall remains deferred/unregistered. No MCP integration is added. Host version numbers must be rechecked during certification, not copied from old observations as current guarantees.

## Rollout flags and defaults

Defaults below match the checked-out USER_CONFIG_DEFAULTS; parent dependencies match `lib/rollout/rollout-flags.mjs`. Top-level enabled remains false until explicit setup. Preserve disabled behavior and expose effective state in the inventory.

| Flag | Default | v2 destination and dependency |
| --- | --- | --- |
| ambientPersonaMode | false | 5A optional persona |
| autoWriteImprovementGoals | false | 6B explicit automatic-goal opt-in |
| memoryOperations | true | 2/5A core and parent gate |
| workstreamOverlays | true | 5A; memoryOperations |
| temporalQueryNormalization | true | 5A; memoryOperations |
| memoryDomains | true | 5A; memoryOperations |
| refreshableObservations | true | 5A/6B; memoryDomains |
| retentionSanitization | true | 2/5A; memoryOperations |
| directives | true | 5A; memoryOperations |
| traceRecorder | false | 6B diagnostic traces; v2 payload-retention difference below |
| evolutionLedger | true | 6B parent gate |
| proposalGeneration | true | 6B; evolutionLedger |
| generatedArtifactIntegrity | true | 6B; evolutionLedger |
| overlayAutoHydration | true | 5A; workstreamOverlays |
| loreDoctor | true | 6B; evolutionLedger |
| reviewGate | true | 6B; evolutionLedger |
| approvalSubstrate | true | 6B; evolutionLedger |
| hybridRetrieval | true | 3; memoryOperations, configured embeddings also required |
| ambientWorkingProfile | true | 5A working profile |
| errorTelemetry | false | 6A/6B categorical events only |
| postToolUse | false | 6A/6B categorical tool observation |
| subagentScopeTracking | false | 6A host-provided scope attribution |
| preToolUseGuardrail | false | 6A allowlisted advisory, never blocking |

Additional config behavior: providers/localInference and embeddings default off; reflection synthesis, query expansion and context compression default off; deferred deterministic extraction defaults on; maintenance scheduler and sessionStartBackfill default off; hygiene mode off. Preserve selected task flags/cadences and source roots through explicit config mapping. Do not enable a model merely because hybridRetrieval defaults true.

Maintenance task inventory: memoryHygiene, deferredExtraction, validationCorpus, replayCorpus, backlogReview, traceCompaction, indexUpkeep, doctorSnapshot. Due work moves to the daemon while configured enabled. Zero cadence becomes a bounded 60-second opportunity; positive existing cadences are preserved.

## Context, data and dashboard surfaces

| ID | Surface | Destination / acceptance |
| --- | --- | --- |
| CTX-01 | Standing directives, response style/addressing, user/assistant identity | 5A required sections independent of topical similarity; explicit versus inferred scope fixtures |
| CTX-02 | Preferences, commitments, working profile, procedural guidance | 5A authority, freshness and byte-budget fixtures |
| CTX-03 | Episodes, day summaries, temporal lookup, prior work | 4/5A evidence completeness, date/timezone and retired-source tests |
| CTX-04 | Domains, workstreams, overlays, observations and cross-repo hints | 5A/6B manual fields, rollout gates, scoped provenance |
| DATA-01 | All v1 tables, config, source roots and backup/recovery state | 5B per-table/field disposition and checksums |
| UI-01 | Overview /api/overview and /api/health | 6B read-only gateway, readiness/count/coverage parity |
| UI-02 | Memories /api/memories and /api/memories/filters | 6B scope/category filters, pagination, escaping |
| UI-03 | Maintenance /api/maintenance | 6B schedule/run history and failures |
| UI-04 | Episodes /api/episodes | 6B session groups and provenance |
| UI-05 | Drill-down /api/drilldown | 6B lineage, supersession, canonical grouping and safe rendering |

## Scripts, setup and developer tooling

| Current paths/surface | Destination | Verification |
| --- | --- | --- |
| scripts/setup.mjs, scripts/install-hooks.mjs, scripts/dev-install.mjs | 7 Rust setup/managed install; development source mode remains explicit | Selection/cancel/preservation/rerun/rollback in isolated homes |
| scripts/run-maintenance.mjs | 6B `lore maintenance` and service scheduler | Task selection, errors, dry-run, current configured store only |
| scripts/run-browser.mjs | 6B `lore browser` | Loopback, lifecycle, HTTP/rendered parity |
| scripts/recover.mjs | 5B Rust backup/restore/status | Snapshot/ledger union, interrupted restore, clients-stopped boundary |
| scripts/migrate-home.mjs | 5B/7 explicit path-move preview/apply compatibility | Preserve custom/legacy paths, no implicit relocation |
| scripts/validate-config-schema.mjs | Development schema checks plus Rust config validation command | Defaults/unknowns/version parity |
| scripts/visualize-okf-bundle.mjs | 6B Rust explicit OKF visualization export | Content/escaping/approval/read-only input fixtures |
| scripts/check-runtime.mjs | 7 artifact/host preflight; no Node requirement for native clients | Host/runtime failure gives correct neutral hook result |
| scripts/verify-cli-hooks.mjs, scripts/verify-extension-clients.mjs, scripts/verification-process.mjs | 6A/7 host verification harness | Real-host/version matrix; no simulated pass claim |
| scripts/diagnostics-quality.mjs, scripts/reliability-quality.mjs, scripts/reliability-benchmark.mjs | Development v1/v2 corpus and baseline runners | Independent shared fixtures and threshold reports |
| scripts/check-release-evidence.mjs | 7 complete G1-G6 evidence/soak validation | Missing evidence fails; current support never inferred from docs |
| Root schema/lint/test/knip and website check/test/build/check:links | Retain during coexistence; add Cargo checks | Public README/site/support/capability consistency at release |
| scripts/shared-args.mjs and private fixture helpers | Implementation details, no public compatibility promise | Port public CLI semantics through golden tests |

## Deliberate differences and exclusions

- Rust replaces Node core/CLI/worker processes; host-required JS/TS remains. No public command silently starts a v1 worker.
- New queries use bounded inference; no memory embedding, raw source fallback, chat expansion or compression occurs on the prompt path. Explicit background augmentation remains available with reported coverage and an explicit config migration notice.
- Ambient cross-repository Recall admits transferable material only; the historical all-repository search option is preserved as explicit administrative search.
- Raw prompt/query traces are no longer persisted, even when traceRecorder is enabled. Retain bounded content-free decisions/IDs/reasons and optional in-memory diagnostic detail. Historical sensitive trace import is an explicit selection.
- Always-on service scheduling replaces dependence on session starts for background progress, but optional maintenance/source flags still apply.
- JSON import, deferred MCP hooks, remote daemon access, Windows, embedded inference and ANN remain excluded; none is promised by current v1 support.

The final capability gate includes these documented differences and their tests. No further omission or weakened support is implied by this ledger.
