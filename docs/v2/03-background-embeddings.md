# Slice 3: background embeddings and indexing

Status: planned. Depends on: [Slice 2](02-daemon-core.md).

## Objective

Embedding/indexing runs independently of agent prompts. Recall remains responsive while models are cold, unavailable, slow, or processing a backlog. Successful vector work survives restart; stale results cannot make retired memories visible.

## Critical design tradeoff: query embeddings

Precomputing memory vectors does not eliminate the need to embed a new query. This proof chooses strict cache-only vector recall:

- Recall uses lexical retrieval immediately.
- An exact-query cache hit may add vector results.
- A cache miss remains lexical-only; Recall does not synchronously compute or enqueue a vector.
- Add an optional `PrepareQuery` RPC for clients/tests to request background query-vector preparation. It returns an acknowledgement, never waits for inference.
- A client may call PrepareQuery when a completed prompt is submitted, then Recall immediately. It must not wait for preparation, send partial keystrokes, or claim that the first query gets semantic results.

This deliberately trades first-query semantic recall for strict prompt latency. Evaluate retrieval quality alongside latency. If unacceptable, stop and review alternatives (bounded online query embedding or local lightweight query encoder) rather than quietly adding inference back into Recall.

## Durable job model

Extend the slice-2 transaction intent into a persistent queue. Initial job kinds: `memory_embedding`, `query_embedding`.

Job fields: ID, kind, target ID/query hash, target revision, model identity, state, attempts, available time, lease owner/expiry, error category, created/updated times. Uniqueness covers target, revision, and model identity.

States:

```text
queued -> running -> complete
                 -> retry_wait -> queued
                 -> failed
                 -> obsolete
```

- Memory creation and embedding intent commit atomically.
- Claim jobs transactionally with expiring leases.
- A crashed worker's lease expires and work becomes eligible again.
- Provider calls happen outside SQLite transactions and locks.
- At commit, compare target revision/content hash and model identity again. Discard obsolete output.
- Completed memory jobs may be compacted after the vector commit; failed/retry state remains inspectable.
- A periodic bounded reconciliation scan repairs missing/stale vector coverage without requiring another prompt or relying on queue emptiness.

## Scheduling and bounds

Initial provider concurrency: one request. Memory batch maximum: 24 inputs, further bounded to 256 KiB serialized input. Query preparation gets priority, but after four query jobs service at least one memory batch to prevent starvation.

Provider deadline: 30 seconds, configurable. Retry transient network/429/5xx errors with exponential backoff and jitter (base 1 second, cap 60 seconds, maximum five attempts). Respect bounded Retry-After. Invalid model/dimensions/authentication errors become failed with an actionable category; do not hot-loop.

Maximum outstanding memory jobs: 10,000. If the queue is full, reject Retain atomically with `RESOURCE_EXHAUSTED`; do not acknowledge a write while silently losing required intent. Query preparation is optional: cap at 1,000 outstanding jobs and reject excess without affecting Recall.

Long-running provider calls must never occupy the foreground SQLite executor. Vector validation, hashing, and scoring use bounded blocking/CPU execution rather than blocking the async reactor.

## Provider and cache identity

Use the existing OpenAI-compatible embeddings endpoint contract. Keep chat and embedding models separate: Gemma4 is not a replacement for embeddinggemma.

Cache identity includes endpoint/provider, model ID, explicit model revision/generation, dimensions, content hash, and preprocessing version. For mutable model tags, require an operator-controlled generation or discover a trustworthy digest; changing it invalidates cache entries. Never reuse same-dimension vectors from an unknown model generation.

Validate response count/order, numeric finite values, nonzero norm, expected dimensions, and response size. Reject malformed/partial responses safely; do not pair vectors with the wrong target. Bound provider responses (initial 16 MiB) while reading, not after allocating an unlimited body. Send only necessary text to the configured provider; remote endpoints require explicit opt-in and documented privacy implications.

## Query cache privacy

Query text is sensitive. Persist it only while its preparation job needs it, with a maximum one-hour TTL; erase it after completion or expiry. Cache only the hash, vector, model identity, and timestamps afterward.

Use exact UTF-8 query bytes plus repository/scope context and model identity as the key. No fuzzy reuse or broad normalization that could conflate requests. Initial cache cap: 1,000 vectors with a 24-hour TTL and LRU eviction. No query text in diagnostics. These deletions are not secure erasure from WAL/backups; document that limit.

## Retrieval integration

- Lexical policy from slice 2 remains authoritative.
- Query cache lookup performs no provider calls and no mutation.
- Score only eligible, current memory vectors. Missing/stale vectors are absent, not an error.
- Use reciprocal-rank fusion with stable ties; calibrate result quality on frozen fixtures.
- Every merged result must pass current scope, suppression, expiry, and supersession checks.
- Report cache hit/miss, indexed/stale counts, whether vector candidate coverage was capped, and lexical-only fallback.
- Initial vector scoring cap: 10,000 eligible vectors; report partial coverage beyond that. ANN indexes are deferred until measurement justifies them.

Do not describe vectors as an authoritative memory store. Deleting/rebuilding them must not delete memories or resurrect suppressed content.

## TDD implementation sequence

1. Fail tests for atomic memory/job writes and duplicate job coalescing.
2. Implement durable claim/lease/retry transitions using a fake clock and fake provider.
3. Add restart/failpoint tests for claim, provider response, and vector commit boundaries.
4. Validate malformed, oversized, reordered, wrong-dimension, timeout, and offline responses.
5. Race model-generation changes and memory revision/suppression changes against in-flight jobs. Verify obsolete outputs cannot become usable.
6. Add PrepareQuery bounds/TTL and exact-key isolation tests.
7. Assert Recall makes zero provider calls on both cache hit and cache miss, and never inserts a preparation job.
8. Run lexical/vector fusion and policy tests against frozen synthetic fixtures.
9. Run load tests with a large backlog and a provider deliberately sleeping for 30 seconds; foreground latency must still meet the roadmap targets.
10. Opt-in local-provider integration test against an isolated synthetic store; never use personal memories for CI.

## Acceptance gate

- Zero provider calls or embedding jobs initiated by Recall.
- Retain stays durable while the provider is offline; capacity exhaustion is explicit and atomic.
- All committed jobs are accounted for as completed, queued/retrying, failed, or obsolete after forced termination.
- Queue size, raw query retention, response allocation, and concurrent provider work remain bounded.
- Cache invalidation covers content, model generation, endpoint, dimensions, preprocessing, expiry, and suppression.
- Status distinguishes no work from missing coverage, failed work, and active processing.
- Four-client recall benchmark passes under backlog without hiding failures or dropping safety filters.
- Report first-query lexical-only quality versus warm-query fusion, and obtain a go/no-go before porting ingestion/extraction.

## Deferred

Inference serving inside the daemon, GPU integration, ANN indexes, semantic query reuse, speculative keystroke preparation, chat-based extraction, and production adapter rollout. The daemon schedules model work; rewriting it in Rust does not make the external model faster.
