# Slice 2: Rust daemon core

Status: planned. Depends on: [Slice 1](01-contracts.md).

## Objective

Run one foreground `lored` process that durably serves Status, Retain, and lexical Recall to multiple clients. Prove the boundary without ingestion, extraction, model calls, or production installers.

## Initial process interface

```text
lored --data-dir <isolated-v2-directory> --socket <absolute-socket-path>
```

Production service management is deferred. Tests launch the foreground process and own its temporary directory. Provide a small test client/CLI for invoking the three RPCs; this is not yet a replacement for every `lore` command.

Startup order: validate arguments and paths -> acquire exclusive store lock -> open/version-check database -> apply supported v2 migrations transactionally -> bind socket -> report ready. A future schema fails closed. No automatic v1 detection/import.

Shutdown: reject new requests -> drain accepted writes within a configurable deadline (default 5 seconds) -> close database and socket -> release lock. If forcibly terminated, unacknowledged clients retry idempotently. Never delete a lock or socket belonging to a replacement process.

## Minimal module boundaries

Suggested modules: `main`, `rpc`, `store`, `policy`, `retrieval`. Add a background module in slice 3. Prefer plain functions and concrete types over a generic plugin framework or repository abstraction.

Use one bounded SQLite write executor and a small read pool (initial maximum four). Do not run blocking SQLite operations on Tokio reactor threads. Limit foreground in-flight requests to 32 and return `RESOURCE_EXHAUSTED` rather than buffering indefinitely. Propagate cancellation before starting queued work; a transaction already committed remains committed even if its client disconnects.

## Retain transaction

1. Validate complete request and canonical scope combinations.
2. Look up idempotency key and compare normalized request hash.
3. Insert manual semantic memory with stable ID and authority metadata.
4. Update FTS index in the same transaction.
5. Increment authoritative memory revision.
6. Persist idempotent response and an embedding intent row, initially disabled until slice 3.
7. Commit before returning success.

Use parameterized SQL exclusively. Map disk-full, corruption, lock contention, and incompatible-schema errors to explicit status categories. Never report success after a failed commit. Different keys do not imply semantic equivalence: do not add fuzzy deduplication in this slice.

## Lexical Recall

Port the minimum shared query normalization and eligibility behavior needed by the contract. Read existing `lib/db/db-retrieval-policy.mjs` and recall fixtures before implementing; do not copy SQL without its caller assumptions.

- Build safe FTS expressions from normalized terms; user input is not executable FTS syntax.
- Enforce scope, expiry, supersession, and suppression in candidate selection.
- Empty/scaffolding-only queries get an explicit deterministic behavior tested in fixtures, not an accidental broad scan. Initial behavior: no topical hits.
- Rank deterministically with a stable ID tie-breaker.
- Apply eligibility again before output when merging candidates.
- Render within byte budget without splitting UTF-8 sequences or inventing provenance.
- Return only supported sections. Full persona/episode/day-summary parity is deferred to slice 5.

Candidate work must be bounded and report truncation. Do not apply a limit to unfiltered rows and then silently claim complete eligible coverage.

Suppression and expired/superseded records can be seeded by test fixtures even though administrative mutation RPCs are not implemented yet. Their omission from the public proof API is not permission to ignore them during reads.

## Observability

Status exposes counts, readiness, memory revision, and capabilities. Structured stderr logs include operation, request ID, duration, status, and categorical failure. No memory/query text, vectors, source paths, or model response bodies by default.

Track request latency and queue wait separately. Use bounded in-memory histograms/counters rather than a mandatory metrics server. No terminal progress spam from routine successful background work.

## Test-first sequence

### A. Storage and policy

Failing unit tests for scope combinations, expiry boundary timestamps, suppression, Unicode budgets, malformed queries, and deterministic ranking. Implement minimal policy and store functions.

### B. Durability and retries

Integration tests against real SQLite:

- Acknowledged Retain survives restart and is visible through an independent connection.
- Same key and payload returns same ID/revision; different payload is rejected.
- Concurrent identical requests create one record.
- Failpoints before commit and after commit/before response prove retry safety.
- Failed writes roll back FTS, revision, idempotency result, and job intent together.
- Disk failure and incompatible schema never create a success response.

### C. Process lifecycle and security

Subprocess tests for two daemon instances, stale socket recovery, unsafe directory ownership/mode, symlink refusal, cancellation, bounded overload, SIGTERM, and SIGKILL/restart. Use dedicated temporary homes only.

### D. Client interoperability

Two independent Node clients connect to one daemon. Client A retains; client B recalls after acknowledgement. Disconnect one client without killing daemon or affecting the other. Use deadline and invalid-protobuf cases from slice 1.

### E. Performance baseline

Load 10,000 deterministic synthetic memories, run four clients, and report cold/warm Recall latency, idle/peak RSS, CPU, DB size, queue waits, and error rates. Run a comparable v1 lexical workload with local inference disabled; document feature differences. Use release Rust builds and preserve machine-readable results.

## Acceptance gate

- All supported policy fixtures pass with no foreign/private or suppressed memory leaks.
- Restart and failpoint tests prove durability, not just process exit success.
- No inference dependency or network request exists on Recall's call path.
- Overload remains bounded and cancellation does not leak work indefinitely.
- API/version/scope behavior is identical across test clients.
- Performance meets the provisional targets in [the roadmap](README.md), or the milestone is explicitly blocked with measurements.

## Deferred

Production adapters, launchd/systemd units, automatic daemon spawning, full extraction semantics, actual embedding execution, v1 migrations, vector search, dashboards, remote access, and Windows support.
