# Model review disposition

Status: reconciled with the user's architecture decisions, 2026-09-15.
Source overview: [Summary](../model-opinions/Summary.md). Original opinions remain unchanged.

## Reading this record

Adopted means the recommendation is required by these plans. Adapted means its concern is addressed through the selected architecture. Deferred means it is not part of v2's initial implementation and is not a hidden fallback. None means implemented or validated.

Sources are plain `File.md:start-end` references relative to `docs/model-opinions/`, so this record and its evidence can be grepped. User choices take precedence over review votes: Rust core/CLI, HTTP/JSON, continuous per-user service, bounded query inference and full replacement scope.

## Shared architectural and product concerns

| ID | Concern / suggestion | Disposition and implementation destination | Sources |
| --- | --- | --- | --- |
| REV-01 | One daemon/writer and shared background scheduler | Adopted: roadmap and ADR-001/003; actual multi-client proof | Astra.md:17-28; Claude-Opus.md:8-18; Fable.md:7-20; Gemini.md:22-27; GLM.md:7-19; Grok.md:10-20; Kimi.md:7-19 |
| REV-02 | Separate storage, explicit migration, honest same-user trust | Adopted: configuration/storage, contracts and migration/recovery | Astra.md:19-26; Claude-Opus.md:46-59; Fable.md:24-35; Gemini.md:22-27; GLM.md:21-46; Grok.md:74-84; Kimi.md:17-23 |
| REV-03 | Repository/suppression/expiry/manual policy must survive every path | Adopted: shared fixtures, actual Forget and aggregate invalidation; no blanket SQL port | Astra.md:84-100; Claude-Opus.md:46-59; GLM.md:21-46; Kimi.md:17-23 |
| REV-04 | Node proof before Rust / hybrid language shell | Adapted: user selected Rust now; retain frozen protocol, v1 baselines and cross-language policy fixtures; no second production core | Claude-Opus.md:20-28; Fable.md:38-47; GLM.md:114-136; Grok.md:68-72; Astra.md:11-15 |
| REV-05 | Rust and embedded inference benefits | Adapted: Rust core accepted for daemon/CLI preference and packaging, not unmeasured inference claims; embedded model distribution deferred | Gemini.md:8-18; Gemini.md:47-50 |
| REV-06 | Exact-cache-only makes unseen-query semantic recall unreliable | Adopted: bounded query inference, cache as optimization, first-seen quality gate | Astra.md:30-50; Claude-Opus.md:30-37; Fable.md:58-68; Gemini.md:33-50; GLM.md:78-112; Grok.md:22-43 |
| REV-07 | Cache-only as a disciplined proof extreme | Adapted: retain cache-only benchmark/fallback instrumentation; production default is the user-selected 100 ms bounded query path | Kimi.md:13-17; Kimi.md:33-39 |
| REV-08 | HTTP/JSON should be first-class versus gRPC | Adopted: standard HTTP over Unix socket, JSON Schema, Node/Bun interoperability; gRPC/custom framing deferred | Fable.md:49-56; Gemini.md:54-64; Grok.md:50-51; Claude-Opus.md:38-45; GLM.md:150-161; Astra.md:52-64 |
| REV-09 | Embedding backlog should not reject authoritative saves | Adopted: coalescing durable per-memory intent and independently bounded runnable jobs; coverage degradation in Status | Astra.md:102-110; Claude-Opus.md:46-49; GLM.md:48-76; Grok.md:45-48; Kimi.md:47-51 |
| REV-10 | Small boundary proof before a wholesale port | Adapted: G1 tiny Rust server/clients then four-operation G2; no parallel Node implementation, service installers remain later | Fable.md:70-79; Fable.md:100-109; Claude-Opus.md:38-45; Grok.md:53-54; Astra.md:164-177 |
| REV-11 | Measure quality and realistic unique prompts, not just p95 | Adopted: validation fixes held-out recall@6/MRR/irrelevance and required-context gates with v1 modes | Astra.md:38-50; Claude-Opus.md:10-18; GLM.md:90-112; Grok.md:86-90; Kimi.md:27-39 |

## Retrieval, resource and privacy details

| ID | Concern / suggestion | Disposition and implementation destination | Sources |
| --- | --- | --- | --- |
| REV-12 | Different proposed query budgets | Resolved by user: 100 ms inference within 200 ms complete hook; smaller remaining deadlines win | Grok.md:34-43; Claude-Opus.md:30-37; Gemini.md:47-50; Fable.md:62-68 |
| REV-13 | Local encoder alternative if provider misses budget | Deferred as a separate deployment/design decision after failed G3; do not silently change model space or bundle an encoder | Gemini.md:47-50; GLM.md:90-112; Grok.md:34-43 |
| REV-14 | Keep provider warm | Adapted: connection reuse and ordinary background work; no prompt-time model startup wait or mandatory heartbeat inference | Fable.md:62-68 |
| REV-15 | Pre-rewrite PrepareQuery timing experiment | Adapted: ordered recurrence/cache metrics in replay; no v1 runtime edit or durable preparation API is needed after choosing bounded inference | GLM.md:106-112; Astra.md:38-50; Kimi.md:33-39 |
| REV-16 | Previous-turn vectors and query canonicalization | Deferred: exact-key cache only; avoid using a different question's meaning or conflating case-sensitive identifiers | Claude-Opus.md:34-36; Gemini.md:47-50 |
| REV-17 | In-memory contiguous vectors versus SQLite paging | Paging adopted first; full contiguous index deferred pending measured need and the same memory/policy gates | Gemini.md:67-75; Grok.md:65-66 |
| REV-18 | Dimensions, decoded allocations, candidate bounds and cancellation | Adopted: shared resource table, bounded pages/heaps, SQL filtering, SQLite interrupt and permits retained until work stops | Astra.md:126-140 |
| REV-19 | Test Retain during rapid vector commits, sweep read pools | Adopted: fast/slow provider workloads, 1/2/4 readers, write-tail latency and WAL pressure | Kimi.md:53-67 |
| REV-20 | Query-text privacy / memory-only encryption key | Adapted: remove persistent query jobs entirely; queries/cache are memory-only, making at-rest query-job encryption unnecessary | Kimi.md:41-45; Astra.md:153-162 |
| REV-21 | Explicit model generation and sanitized identities | Adopted: endpoint/model/generation/dimensions/preprocessing identity, no mutable-tag assumption or credential diagnostics | Grok.md:59-63; GLM.md:21-46; Astra.md:153-162 |
| REV-22 | RRF needs relevance/abstention, not just ranking | Adopted: calibrated model threshold, held-out negatives and zero unsupported required guidance | Astra.md:30-50 |
| REV-23 | Oldest retryable-job eviction | Adapted: coalesce intents and compact obsolete materialized jobs; do not erase durable failure/attempt state to free queue slots | Kimi.md:47-51 |

## Contract, lifecycle and migration details

| ID | Concern / suggestion | Disposition and implementation destination | Sources |
| --- | --- | --- | --- |
| REV-24 | 20 x 64 KiB exceeds response cap | Adopted: encoded response budget, complete structured rows, represented IDs and explicit UTF-8-safe excerpts/omissions | Astra.md:66-82 |
| REV-25 | Retry hashing/defaults, quota recovery and original receipt | Adopted: stable normalized payload, reserved lookup before quota, original acknowledgement and replay after Forget | Astra.md:66-100; Grok.md:56-57 |
| REV-26 | Stable adapter IDs across reload/upgrade | Adopted: fixed client namespaces and private persistent uncertain-write journals | Grok.md:56-57 |
| REV-27 | Add real Forget to the proof | Adopted: stage-2 public operation and cross-client mutation fixtures | Fable.md:85-87 |
| REV-28 | Backup restore, re-extraction and fresh manual save differ | Adopted: ID versus scoped fingerprint tombstones, preserved receipts/retirement, stage-5B restore union | Astra.md:84-100 |
| REV-29 | Lease fencing, terminal recovery and provider-wide failure | Adopted: claim tokens, config generations, breaker, explicit retry and reconciliation retaining terminal state | Astra.md:112-124 |
| REV-30 | Consistent snapshot/revision and endpoint-to-store identity | Adopted: final snapshot contract, separate memory/index generations, store plus endpoint locks | Astra.md:141-151 |
| REV-31 | Fairness, bounded DB work, checkpoint/WAL growth | Adopted: admission reservations, query-plan evidence, read lifetimes, checkpoint pressure and resource gate | Astra.md:126-140 |
| REV-32 | Stable status/error reasons, read-your-writes, FTS5/FULL | Adopted: contracts/status taxonomy and bundled SQLite; process-crash versus power-loss evidence distinguished | GLM.md:163-180; Fable.md:89-98; Astra.md:153-162 |
| REV-33 | Short macOS socket paths | Adopted: deterministic short endpoint, explicit override, byte-length rejection and ownership tests | Grok.md:59-63 |
| REV-34 | Lazy spawn/readiness timeout / idle exit | Adapted: service selected for continuous work; missing-service and startup/death tests retained, no hook auto-spawn | Gemini.md:78-90; Fable.md:81-83; Grok.md:53-54 |
| REV-35 | Bun/host-loading/cold subprocess overhead | Adopted: G1 boundary spike plus G5 actual host certification and complete prompt deadline | Claude-Opus.md:38-45; Astra.md:52-64 |
| REV-36 | Modular transcript/extraction workers | Adapted: versioned Rust parser/extractor modules with stable normalized evidence; executable plugins/JS workers deferred | Gemini.md:94-101 |
| REV-37 | Timestamp conversion, repository legacy mapping, retired evidence | Adopted: version-specific source readers, complete migration accounting and quarantine; no unknown-schema import | Fable.md:89-98 |
| REV-38 | Backups need restrictive permissions | Adopted: private staging/snapshots, quotas, verified restore and non-secure-erasure caveat | Kimi.md:69-75 |
| REV-39 | Dual-maintenance cost and v1 movement | Adopted: v1 correctness/security/required compatibility budget, shared fixtures and inventory reconciliation; release/soak gate before retirement | Grok.md:68-72; Fable.md:89-98 |
| REV-40 | Global-default leaks and mandatory context parity | Adopted: explicit/inferred scope negatives and all required persona/directive/context sections before migration | Claude-Opus.md:46-59; Astra.md:153-162 |

## Resulting scope

The architecture preserves the reviews' safety and measurement concerns while following the user's implementation choices. Full ingestion, extraction, migration, adapters, administration, dashboard and rollout are specified now; G3 still controls commitment to the large port.

No review's benchmark number, assumed prompt recurrence percentage or host compatibility assertion becomes a measured fact through citation. Reproduce it with the [validation plan](validation.md) or leave it identified as an unverified hypothesis. The current public support matrix changes only when implementation evidence supports it.
