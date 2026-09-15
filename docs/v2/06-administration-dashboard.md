# Slice 6B: administration, optional capabilities and dashboard

Status: planned. Depends on G4, stage 5B backup/recovery and stage 6A dispatch contracts. Exit contributes to G5.
Inventory: [capability parity](capability-parity.md).

## One dispatch and run model

Implement every inventoried operation through a fixed Rust registry with canonical name, aliases, input/output schema, required flags, support state and mutability. The existing manifest is the baseline; do not keep a second independent JS policy implementation.

Short reads finish within their RPC budget. Expensive diagnostics, repair, backfill, replay, maintenance, exports and reflection use durable operation runs: `queued -> running -> complete | complete_with_gaps | failed | cancelled`, with retry_wait for transient work. Admission validates the entire request, commits its idempotent run receipt, then returns runId. Polling returns bounded pages of per-item results and progress.

Run identity includes store, operation, immutable normalized input and selected revision/preview where required. Each batch commits an item cursor with its effects. Cancellation stops future batches; completed effects are listed and do not roll back magically. Retry resumes only eligible failed/pending items and preserves attempt state. No raw paths or payloads in routine logs.

Persist only input hashes and the bounded execution plan needed for a run. Resolve query selectors into scoped IDs/revisions at admission. Original query/focus prose remains in memory if still needed; a restart that loses required transient input marks the run failed with `INPUT_UNAVAILABLE`, requiring an explicit new submission. Never claim such a run resumed successfully, or persist raw query text to make it resumable. Explicit memory/journal content selected for retention remains authoritative data under its own operation contract.

Every operation's tests must cover enabled/disabled flags, wrong scope, invalid bounds, idempotency, cancellation and read-only preview behavior. The parity matrix identifies operation-specific fixtures rather than treating successful dispatch as feature completion.

## Correct, repair, purge and scope override

Correction defaults to preview and preserves expiry unless explicitly changed. Preview computes a deterministic fingerprint over operation, store ID, target revisions, policy/suppression state, selected fields and source/evidence hashes. It does not create snapshots, jobs, directories or write traces. Apply requires that fingerprint and a fresh validated pre-apply snapshot; any changed dependency is PREVIEW_STALE.

Apply a correction by creating a manual replacement, retiring the original, preserving lineage and invalidating dependent aggregates atomically. The optional repository chooses the replacement destination, not permission to widen unrelated records. Existing explicit field semantics remain; no automatic confidence/authority downgrade.

Repair operates only on complete verified source evidence and approved repository mappings. Preserve current limits: 32 MiB per repair source, preview default 50/max 200 candidates, selectedCandidateIds max 200. Incomplete, oversized, missing and ambiguous evidence remains unresolved. A no-longer-actionable candidate invalidates apply rather than being silently skipped as a success.

Purge requires explicit memory IDs, repository or global selection. Shared aggregates require includeDependentAggregates and all typed selected candidates. Remove selected derived rows while preserving scoped suppression, raw source bytes and backups. Preview shows the full dependency closure; unknown/incomplete dependency accounting blocks apply. Result distinguishes removed content, invalidated/rebuilt aggregates and retained provenance.

Scope override applies to semantic/episode row IDs, as in the current schema; it is not merely a session flag. Set/clear records actor/reason and validated destination scope. Dry-run has no side effects. Clear recomputes automatic scope from current verified evidence; unresolved identity does not become global. Changing scope invalidates applicable context/vector eligibility immediately.

All apply operations use the writer and snapshot protocol. Snapshot failure prevents the mutation. If an operation requires several bounded transactions, expose a durable run and recovery state; never label a partially applied multi-batch purge atomic.

## Search, explain, status and validation

Search is lexical browsing with explicit scope selection and pagination. Preserve the v1 human/tool includeOtherRepositories option by translating it to explicit all-repository administrative selection; this is never the default for automatic Recall. Apply suppression/expiry/retirement to active results. An explicit historical inspection view labels retired content and never feeds it back as current prompt context.

Explain uses the same context assembly and policy as Recall, with bounded diagnostic reasons and represented IDs. It can report cache/provider state without persisting the query. Session-start explanation covers required capsule sections. Validate and Replay run frozen cases/integrity checks as explicit jobs; Status only reports summaries and freshness.

Doctor and review-gate preserve their observe-only behavior. A planned action report or imported proposal cannot execute a tool, modify code or approve itself. Preserve dryRun behavior, sourceCaseId links, signed/integrity artifacts and error categories.

## Background operations and optional capabilities

- Backfill preserves legacy and controlled preview/start/resume/status/restore interfaces, default/max 20 sessions per legacy invocation and bounded controlled batches. Existing v1 raw-store selection remains distinct from Pi archive ingestion. The daemon's all-client source reconciliation is a separate source operation.
- Deferred processing schedules extraction jobs with current rule/source identity. Manual processing across repositories requires explicit selection. It never waits inside prompt hooks.
- Maintenance ports memoryHygiene, deferredExtraction, validationCorpus, replayCorpus, backlogReview, traceCompaction, indexUpkeep and doctorSnapshot with flag dependencies, dry-run/status and exact auto-hygiene-marker rollback. Hygiene remains off by default; shadow mode reports candidates without retiring data.
- Use persisted due times and one active claim per task/scope. Port positive existing cadences; zero cadence maps to a bounded 60-second background opportunity while enabled, not a busy loop. Sleep/restart coalesces missed intervals to one due run rather than replaying every tick.
- Reflection is a bounded explicit/background operation. Preserve optional persisted observations, domain scope, freshness, provenance, and optional chat synthesis with evidence checks. Disabled providers produce deterministic fallback, not fabricated synthesis.
- Intent journal, improvement backlog, evolution ledger and trajectory artifacts preserve manual decisions, source cases, supersession and approval state. Automatic goal writing stays behind its existing default-off flag.
- Skill validation reads only configured skill roots, validates syntax/frontmatter and reports results. It does not execute skill text.

Portability preserves signed JSON export of approved improvement artifacts and OKF v0.1 directory export/import. JSON import remains unsupported. OKF import stays manually invoked, bounded by approved paths and parser limits, lower-confidence by default (0.7), idempotent by repository/concept identity, and first-import-content-wins unless a separate explicit correction occurs. Validate signatures/integrity where required, resolve path traversal/symlink hazards and preserve provenance. Use safe atomic export publication and restrictive permissions.

Explicit optional augmentation uses `lore analyze --kind query-expansion|context-compression` with a JSON object on stdin, mapped to POST /v2/analysis. Input is kind, query (at most 16 KiB), repository and, for compression, an already policy-filtered bounded set of record IDs/revisions. The daemon refetches/revalidates those records; it does not trust client-provided provenance. Output is bounded expanded terms or compressed sections with source IDs and diagnostics. Revalidate policy after model work before returning.

Analysis occupies the single optional chat lane, defaults to a 5-second deadline (explicit maximum 30 seconds), and keeps request/result only in memory. It has no durable run/job, cannot mutate memories, and returns timeout/unavailable on disconnect/restart. Automatic hooks never call it or wait for its results. This preserves explicit access to augmentation while honoring the prompt latency and query-retention contracts.

The OKF visualizer remains an explicit CLI export of a standalone inspectable artifact; it consumes approved bundles, never starts model inference, and shares escaping/content tests with the current implementation.

## Dashboard architecture and boundaries

`lore browser` starts a separate foreground Rust loopback HTTP gateway serving the current browser HTML/CSS/JS. Default bind is 127.0.0.1 and a free local port, reported to the operator; explicit localhost/::1 remain allowed. No 0.0.0.0, remote binding, automatic service launch, or arbitrary operation proxy. Closing the gateway does not stop lored.

The gateway reads daemon view routes: overview, memories, memory filters, maintenance, episodes, drilldown and health. Add corresponding `/v2/views/<name>` read-only routes and capability IDs. View pagination is keyset-based, default 50/max 200 rows and 1 MiB encoded cap; cursors bind filters/store/revision and expire after five minutes, with explicit stale-cursor restart. Never create a long SQLite snapshot between browser pages.

Preserve the existing public browser /api route shapes where feasible through gateway translation, with golden response fixtures for the current app. The gateway has no SQLite imports and never serves migration, filesystem read, generic tool, provider or mutation routes.

Reuse the current loopback Host allowlist, static-path traversal prevention, MIME handling, escaping and Content Security Policy. Reject cross-origin API requests, disable CORS, set no-store for memory-bearing responses, and render all memory/source data as untrusted text. Add explicit CSP/header/browser tests instead of assuming loopback is sufficient. No authentication claim: same-user local processes remain inside the stated trust boundary.

Maintain existing Overview, Memories, Maintenance, Episodes and Drill-down behavior, filters, pagination, provenance and lineage. Add only necessary v2 status fields: daemon readiness, source gaps, index coverage/freshness and categorical failures. Do not visually redesign the dashboard as part of the port.

## TDD and acceptance

Use current administration, portable-bundle, maintenance, observation, diagnostics, browser-security and rendering fixtures as a reference. Add stale-preview races, snapshot failure, partial-run recovery, deletion dependency closure, wrong-repository search and cancellation.

Verify all 26 operation rows and aliases have schemas, handler tests and flag tests. Assert disabled features are absent/unavailable as advertised, and every alias shares the canonical receipt namespace.

Dashboard tests cover a stopped daemon, expired cursor, empty/loading/error states, large escaped content, injection/path traversal, Host/Origin controls and no mutating route. Render on desktop and mobile; exercise filters, pagination, drilldown and keyboard navigation. Capture screenshots with synthetic data only.

G5 requires full matrix coverage, read-only preview and dashboard checks, recovery-backed administration and no hidden JS store/model worker. Update public guidance and support claims only with implemented evidence.
