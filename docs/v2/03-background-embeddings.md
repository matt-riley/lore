# Slice 3: background embeddings and bounded semantic recall

Status: planned. Depends on G2. Exit: G3. Decision: [ADR-004/005/006](architecture-decisions.md).

## Objective

Keep memory indexing independent of prompts while supplying semantic matches for previously unseen queries when the configured provider can respond within budget. Lexical recall and valid manual saves remain available during a provider outage or a large backlog.

The old strict cache-only design is superseded. Recall may embed its query, but never memories, transcripts or pending index work. No durable query jobs or PrepareQuery RPC are implemented.

## Query path and deadline accounting

1. The adapter starts its 200 ms timer before process/connection/repository work and sends the smaller of remaining budget and the 160 ms server maximum. Native CLI startup counts.
2. Start a bounded speculative lexical lookup and exact query-cache lookup. The cache key includes exact UTF-8 query bytes, repository, cross-repository setting and complete model/preprocessing identity.
3. On miss, attempt immediate admission to one of two query-provider slots. If unavailable, use `QUERY_CAPACITY`; do not wait behind a memory batch. Identical active keys can coalesce, with a bounded waiter list counted in foreground admission.
4. Inference allowance is min(100 ms, remaining request budget minus the 30 ms final-work reserve). It includes slot admission, connection/model startup, request, response read, parse and vector validation. If nonpositive, skip inference. Do not retry within Recall.
5. On timeout, disconnect or malformed output, cancel transport work and use lexical fallback. Coalesced work is cancelled when no live waiter remains; each waiter keeps its own deadline. Late results from cancelled work do not update cache.
6. After a valid vector or fallback, read final authoritative state in a bounded snapshot. Recompute lexical candidates if the speculative revision changed, page eligible vectors if budget permits, fuse, check policy and render. The response reports this snapshot's revision/time.
7. Valid completed query vectors enter the memory-only LRU. No raw query or query hash/vector is written to SQLite, logs, metrics, backups or a retry queue.

If final vector scoring exhausts its work allowance, discard incomplete vector ranking and return the complete lexical ranking with `VECTOR_BUDGET`. A deterministic candidate-count cap may produce partial vector coverage and is reported separately. Underlying cancelled work must stop before releasing its worker permit.

The external provider may continue computing after a connection closes; the daemon can bound its own work but cannot promise provider-side cancellation. Use a configured local endpoint by default. Remote inference requires an explicit opt-in covering both memory and submitted-query text.

## Embedding intents and job lifecycle

Retain commits one current embedding intent per memory with desired revision/content hash/model identity. A disabled provider leaves the intent disabled; enabling it changes desired coverage through bounded reconciliation. A full materialized queue never rejects an otherwise valid Retain.

Intent states: `disabled`, `pending`, `queued`, `running`, `retry_wait`, `failed`, `current`, `obsolete`. Materialized jobs use:

```text
queued -> running -> complete
                  -> retry_wait -> queued
                  -> failed
                  -> obsolete
```

Job identity is kind + target ID + target revision/hash + model identity. A new memory revision coalesces the desired intent; old claims become obsolete. Persist the failed identity and attempt count so reconciliation cannot manufacture a fresh retry budget for the same target.

Claim transaction sets a fresh random lease token, owner instance, incremented attempt and expiry. Renew every 10 seconds while an active call runs, up to its bounded deadline. Provider calls are outside SQLite transactions. Completion compares lease token, ownership, expiry, source revision/hash, model identity and current eligibility in one writer transaction before storing a vector and closing the intent/job.

On daemon restart, claims owned by an old process instance are reclaimed after exclusive store ownership is established; no old process may commit. During normal execution an expired claim gets a new token before reuse. Use monotonic timers for live deadlines and persisted UTC times for retries. After sleep, re-evaluate lease expiry/configuration before accepting results; clock jumps never validate an old token.

Successful/obsolete materialized jobs can be compacted after their target status is durable. Retain bounded categorical terminal history; never delete a failed intent merely because it lacks a vector.

## Scheduling and provider failure

Use one memory-embedding request at a time, at most 24 inputs and 256 KiB serialized. The query lane has independent transport/concurrency admission. No model warmup probe is required: reuse connections and warm from normal background work. Optional explicit provider diagnostics can run later; Status never starts a model.

Service pending memories round-robin by repository with a global-scope bucket, oldest intent first within a bucket. Use 256-target keyset reconciliation pages every 30 seconds with a persisted cursor. Count pending intents independently of materialized jobs and show oldest pending age.

Retry transient connection/429/5xx failures with full jitter, 1 second base, 60 second cap and five attempts. Bound Retry-After to 60 seconds. Provider-wide outages open a shared breaker: after three consecutive transient failures pause dispatch for 30 seconds, then admit one background probe; increase repeated pause up to 60 seconds. Queries fall back while the breaker is open rather than becoming probes on every prompt.

Authentication, missing/invalid model and incompatible dimensions pause that provider generation immediately. Invalid individual input fails only that target; a malformed batch response commits no partial vectors. `lore jobs retry --provider <id>` resets selected failed intents after explicit action; a relevant validated credential/configuration change can reset them once in a new generation. Normal reconciliation never resets terminal failures.

Persist explicit retry selection/epoch before acknowledging it. Reconciliation applies each epoch once per selected failed identity, preserving previously current vectors. Distinguish credential/configuration recovery generation from model generation: repairing credentials alone must not demand re-embedding valid vectors.

If the provider serializes query work behind memory batches internally, record fallback and semantic availability. G3 includes that scenario. Correct fallback alone does not pass the healthy-provider quality gate.

## Provider identity and response validation

Configure separate embedding and optional chat providers. Chat models cannot substitute for embeddings. Identity is provider endpoint fingerprint + model ID + operator model generation or verified immutable digest + dimensions + preprocessing version. A mutable tag such as latest requires an explicit generation. Never infer model compatibility from equal dimensions alone.

Requests follow the configured OpenAI-compatible embeddings endpoint with explicit input indices. Disable redirects and implicit proxy use for local providers; remote HTTPS opt-in must not send credentials across hosts. Sanitize displayed endpoint identities; persist an endpoint hash, not secret URL material.

Bound responses to 16 MiB while streaming and decoded dimensions to 3,072. Validate complete response count, unique in-range indices, finite numeric values, expected dimension, nonzero finite norm and no missing targets. Map reordered results by validated index, not array position. Normalize to float32 only after finite/range validation; revalidate after conversion. Store one little-endian vector per current target identity.

Cache and stored vectors invalidate on input, endpoint, generation, dimensions or preprocessing changes. Memory eligibility can change independently of vector mathematical validity; tombstones and current policy always win. A query vector does not invalidate just because another memory was retained.

## Ranking and relevance

Query FTS for at most 200 eligible candidates. Page memory vectors in stable memory-ID order, filtering scope, expiry, suppression, evidence retirement and current identity in SQL before applying the 10,000 eligible-vector cap. Read at most 128 vectors/2 MiB per page and keep a bounded top candidate heap; do not load the corpus.

Use cosine similarity and a model-specific minimumSimilarity. Calibration on the frozen training split selects the highest-recall threshold that satisfies the negative/irrelevance gate, with the stricter threshold winning ties. Freeze it before held-out evaluation. Initial compatibility default is v1's 0.35 until calibration; that number is not a universal model guarantee. RRF alone cannot establish relevance.

Fuse lexical and qualifying vector lists using reciprocal-rank fusion, constant 60, equal weights, stable memory-ID ties. A semantic list below threshold contributes nothing. The policy/context layer handles manual authority and mandatory sections; RRF cannot promote extracted content over an explicit correction.

Diagnostics distinguish query-cache hit rate, inference attempt/success/fallback, semantic availability, vector contribution, stale/missing coverage, capped coverage and no relevant vectors. No individual query hash labels or provider bodies.

## TDD and failure matrix

1. Atomic memory/intent writes with full runnable queue; explicit store quota remains a separate failure.
2. Coalescing, claim token fencing, retry/backoff and fairness under a fake clock/provider.
3. Crash after claim, after response, before vector commit, after vector commit; account for every intent on restart.
4. Expired lease with late success; sleep/resume; model/config changes; memory mutation/Forget during inference; no stale output becomes eligible.
5. Five terminal attempts followed by repeated reconciliation; provider auth failure pauses once; repair/retry resumes without a storm.
6. Malformed JSON, oversized bodies, duplicate/missing/reordered indices, wrong dimensions, zero norm, nonfinite and float32 overflow values.
7. Unique-query cache miss performs at most one bounded query request and zero memory requests. Cache hit performs none. Queue saturation, offline provider and cancellation meet deadlines.
8. Memory-only cache isolation/eviction/TTL, coalesced waiter deadlines and no raw query persistence across restart.
9. Frozen lexical/fusion/relevance fixtures including unrelated prompts and policy exclusions.
10. Four-client load with a 30-second sleeping provider, instantly returning provider, large backlog, largest allowed vectors and sustained writes; measure Retain and Recall.
11. Opt-in isolated local-provider integration and ordered cold-query replay; report provider-side serialization explicitly.

## Acceptance and handoff

G3 requires all safety/recovery fixtures, bounded resource use and the quality/latency criteria in [validation](validation.md). Offline Recall must match the lexical baseline; healthy first-seen semantic recall must meet the agreed v1 comparison without prewarming query vectors.

Report pending intent and failed coverage even when runnable jobs are zero. Retain remains durable throughout provider outage until an explicit authoritative quota/storage failure. Failed G3 blocks the extraction port; changing a provider deployment or threshold requires a new report with the old failure retained.

Deferred: embedded/GPU inference, ANN, full in-memory corpus, semantic cache normalization, prior-turn substitution, keystroke uploads and PrepareQuery. These cannot be introduced as an unreported workaround for a failed gate.
