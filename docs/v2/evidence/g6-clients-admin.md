# G6 evidence — stage 6A clients and stage 6B administration/dashboard

Gate: G5 (stages 5B-6B) per [06-client-adapters](../06-client-adapters.md) and
[06-administration-dashboard](../06-administration-dashboard.md). This record
covers the stage-6 half; G5 still requires real host evidence and full
capability parity, as recorded under gaps.
Platform: macOS arm64 (Apple M5); hermetic CI for the Rust suites and the
Node adapter proofs.

## 6A — thin clients and compatible commands

| Piece | Detail |
| --- | --- |
| Capability catalog | `daemon/clients/capability-catalog.json`, exported from the v1 manifest by `daemon/tests/export-capability-catalog.mjs`; 27 canonical rows with aliases, surfaces, mutability, support state and route. Golden-tested against the manifest. |
| Registry dispatch | `lore tool <canonical-or-alias>` resolves through one Rust registry; aliases (`lore_save`, `memory_save`, `memory_forget`, `memory_status`, …) share the canonical receipt namespace. Planned operations fail explicitly (`unimplemented operation: …`) before any spawn. |
| Output contract | `--json` still selects JSON *input*; `--output text|json` selects output. `lore recall <text>` is a human verb over the same dispatch. |
| Native hooks | `lore hook <client> <event>` for codex/claude/antigravity: bounded stdin (1 MiB), prompt extraction from tolerant host shapes, Recall within a 190 ms budget, and neutral failure — a missing daemon never fails the host. Antigravity `Stop` keeps `{"decision":"stop"}`. |
| Journal | `uncertain-writes.json` in the owned data dir, 0600, atomic temp+fsync+rename, capacity 100 before dispatch, payload dropped on resolve; `lore retries list|resolve`. |
| Thin adapter | `daemon/clients/js/lore-adapter.mjs`: capability negotiation, cached store identity, Recall/Retain/Forget with `AbortSignal` cancellation that destroys the in-flight request. No SQLite import. |

All 27 canonical operations are implemented: `lore_status`, `lore_retain`,
`lore_forget`, `lore_recall`, `lore_search`, `lore_explain`, `lore_validate`,
`lore_doctor`, `lore_audit_extractions`, `memory_capability_inventory`,
`lore_correct`, `lore_purge`, `memory_scope_override`, `memory_scope_audit`,
`lore_onboard`, `lore_maintenance`, `lore_reflect`,
`memory_deferred_process`, `lore_backfill`, `memory_improvement_backlog`,
`memory_evolution_ledger`, `memory_intent_journal`, `memory_review_gate`,
`memory_portable_bundle`, `memory_skill_validate`, `lore_repair` and
`memory_replay`. No catalog row is `planned`; the registry test asserts this
for every row, and unknown names are refused before dispatch.

### Read-only administration (first matrix slice)

`/v2/admin/{search,explain,validate,doctor,audit/extractions}` are bounded
synchronous reads with capability IDs `search.browse`, `explain.context`,
`validate.read`, `doctor.read` and `audit.read`:

- **Search** is lexical browsing with explicit scope selection, suppression,
  expiry and supersession applied, plus keyset pagination and an explicit
  all-repositories administrative selection. A missing query fails before any
  work (`ADMIN_ARGUMENT_INVALID`).
- **Explain** runs the same Recall assembly and reports sections, represented
  IDs and bounded diagnostics without persisting the query.
- **Validate** reports quick/deep integrity, foreign-key violations, schema
  parity and FTS health.
- **Doctor** is observe-only: health, coverage, skipped records, pending
  extraction and categorical hints.
- **Audit extractions** reports per-source capture state, normalized record
  counts, extraction intent state/rule version and gaps separately from
  completion.
- **Capability inventory** merges the checked-in catalog with live daemon
  capabilities; it works without a daemon and reports `storeId: null`.

### Write operations and the run model

Schema 6 adds `operation_runs`, `operation_run_items` and
`scope_override_audit`. Every apply records a run (state, input hash, plan
fingerprint, actor, counts) and pages its items through `/v2/admin/run-status`.

- **Correct** previews the replacement, fingerprints operation + store +
  target revision + proposed fields, then applies in one transaction:
  manual replacement created, original retired with lineage, FTS rebuilt,
  vectors and evidence links invalidated, embedding intent queued. Apply
  requires the exact fingerprint and a pre-apply snapshot
  (`lore-v2.snapshot-<ms>.db`); a changed dependency is `PREVIEW_STALE`.
- **Purge** requires explicit selection (IDs, repository or the global flag),
  shows the dependency closure, and applies by re-forgetting under durable
  scoped suppression while retaining evidence as provenance. Raw sources and
  backups are untouched.
- **Scope override** previews/applys set or clear with actor and reason
  recorded in the audit ledger; vector eligibility is invalidated immediately
  and repository-scoped overrides require a repository.
- **Scope audit** pages the override ledger, newest first.

### Onboarding, maintenance, reflection and catch-up

- **Onboard** writes the assistant identity and style profile, and the user's
  preferred name, into stable global slots keyed by kind + `topic_key`.
  Repeating identical input is a no-op that keeps both memory ids; changed
  fields update in place, retire nothing and re-queue embedding work.
- **Maintenance** runs registered bounded tasks — `expire_memories`,
  `retry_stale_extraction`, `reap_embedding_jobs` — with `dryRun` defaulting
  to a rolled-back transaction. Applying expiry forgets the row and records
  durable `expired` suppression under the task's own run record.
- **Reflect** builds a deterministic digest of recent in-scope memories.
  `persist` stores the digest as an inferred `reflection` memory whose tags
  list the represented ids; the query text is never persisted.
- **Deferred processing** drains pending extraction intents through the same
  lease/apply path as the scheduler, capped per call.
- **Backfill** runs one bounded discovery sweep through the configured roots
  and reports discovered/captured/pending counts; with no roots it is a
  zero-count no-op.

### Governance, portability, repair and replay (schema 7)

- **Improvement backlog** (`/v2/admin/backlog`) and the **review gate**
  (`/v2/admin/review-gate`) keep proposed/accepted/rejected/done items with
  keyset paging, attributed state changes and a gate verdict that stays
  `open` while anything is still proposed.
- **Evolution ledger** (`/v2/admin/ledger`) records corrections, purges,
  scope changes, imports, repairs and replays; corrections, purges and scope
  overrides append entries in their own transactions, and manual entries are
  appended explicitly.
- **Intent journal** (`/v2/admin/journal`) tracks open/doing/blocked/done/
  cancelled intents with notes.
- **Portable bundles** (`/v2/admin/bundle`) export approved backlog
  artifacts as a checksummed JSON file or an OKF v0.1 directory (index,
  one concept per artifact, manifest), and import OKF directories only.
  Imports are bounded (200 files, 256 KiB each), stage under
  `<dataDir>/bundles`, reject traversal and symlinks, are idempotent by
  checksum, create `okf_concept` memories at confidence 0.7, and follow
  first-import-content-wins by `repository::conceptId`. JSON import stays
  unsupported. Exports publish atomically with restrictive permissions.
- **Skill validation** (`/v2/admin/skill-validate`) reads configured roots
  (or explicit paths), checks `SKILL.md` front matter, name/directory
  agreement and body presence, and never executes skill text.
- **Repair** (`/v2/admin/repair`) previews FTS gaps, missing/stale embedding
  intents and stale vectors, then applies with a fingerprint check, a
  pre-apply snapshot, a run record and a ledger entry.
- **Replay** (`/v2/admin/replay`) runs the frozen 160-case extraction corpus
  in-process, treats propositions retired by later corrections as inactive,
  and reports pass/fail with bounded failure detail; it never writes
  memories and uses no provider.

## 6B — administration and dashboard

| Piece | Detail |
| --- | --- |
| View routes | `/v2/views/{overview,health,memories,memories/filters,maintenance,episodes,drilldown}` — read-only, store-scoped, keyset pagination with a 200-row cap, capability `views.read`. |
| Gateway | `lore browser [--port N] [--open]` binds 127.0.0.1 only, prints the URL, serves the checked-in assets, and translates `/api/<view>` into view calls as `{data: …}`. No SQL, no mutation proxy, dies with the foreground process. |
| Security | Loopback bind + loopback peer check, Host allowlist (127.0.0.1/localhost/::1), Origin rejection, CSP `default-src 'self'`, `X-Content-Type-Options`, `no-store`, `X-Frame-Options: DENY`, read-only methods, and `..` rejection in both static and view paths. |

## Verification

- Rust: 26 suites pass, including `views_flow` (store-ready → filters →
  drilldown → suppression state), `cli_surface` (catalog, planned refusal,
  hook context, neutral failure, non-prompt short-circuit),
  `browser_gateway` (assets, translation, Host/Origin rejection, 405, 404 for
  traversal and unknown views), plus registry/journal/hooks unit tests.
- JS: `capability-catalog.test.mjs`, `adapter.test.mjs`,
  `two-client.test.mjs`, `lexical-quality.test.mjs` — 9 passing; the catalog
  and adapter proofs run in the daemon CI job.
- clippy `-D warnings` and `cargo fmt --check` clean.

## Known gaps (honest boundary)

- **No real host evidence.** Pi and Copilot native extensions are not ported;
  hooks are exercised against a fake daemon and the adapter against a real
  daemon, but no host application has been driven. G5's per-host integration
  evidence therefore remains open, and support claims stay experimental.
- **Remaining honest gaps**: OKF import is limited to `<dataDir>/bundles`
  staging; JSON import is refused by design; replay covers the extraction
  corpus only (not retrieval); the backlog/ledger/journal APIs have no
  dashboard panel yet; dashboard field parity and real-host adapter evidence
  are the next milestones. Human/slash
  surfaces for those verbs fail explicitly rather than pretending support.
  The durable run model exists and records every apply; long-running
  multi-batch operations are not ported yet.
- Hook source hints and capture observations are not wired: capture relies on
  the daemon's scheduled discovery, which is proven to catch up without
  hints. Hooks do prompt Recall and lifecycle-neutral responses only.
- The hook repository identity uses host-provided fields; the bounded Git
  fallback is not implemented, so unresolved scope degrades to global-only
  Recall.
- The dashboard serves the existing assets and maps v1 API paths to v2 view
  data, but panel-by-panel field parity with the v1 browser server is partial:
  overview/memories/filters/maintenance/episodes/drilldown render from v2
  shapes; there is no visual redesign and no screenshot capture in this pass.
- Views expose no episode digests or day summaries because extraction does
  not produce them yet; the episodes view says so explicitly.
