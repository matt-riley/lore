# Slice 2: Rust daemon core

Status: planned. Depends on G1. Exit: G2. Contracts: [protocol](01-contracts.md), [storage/limits](configuration-storage.md).

## Objective and process interface

Serve Status, Retain, Forget and lexical Recall from one foreground `lored` to independent clients. Prove actual write/deletion paths, read-your-writes, restart safety and bounded foreground work before adding inference.

```text
lored --config <isolated-config> --data-dir <isolated-directory> --socket <absolute-socket>
lore --config <isolated-config> status --json
lore --config <isolated-config> tool lore_retain
```

The final command reads one JSON object from stdin. The initial CLI implements only these proof operations plus help/version; unavailable commands say so. Test processes own their temporary homes. Service installation, real host settings and v1 migration do not belong here.

Startup: parse and validate configuration -> resolve canonical paths -> acquire store lock -> acquire endpoint lock -> validate owned endpoint -> open/create/version-check store -> apply supported v2 migrations -> validate FTS5 -> bind socket -> publish readiness. Future schemas, corrupted stores, unsafe paths and live socket conflicts stop startup without changing the target.

Shutdown: stop admission -> cancel queued reads/background work -> drain accepted writes for up to five seconds -> interrupt remaining reads -> close connections/store -> remove only the socket inode created by this instance -> release locks. Never unlink a replacement endpoint. A force-kill can leave uncertain writes; receipts settle them after restart.

## Modules and execution

Keep modules `protocol`, `rpc`, `store`, `policy`, `retrieval`, `config` and `diagnostics` concrete. One shared core library serves the CLI and daemon without exposing SQL to adapters. Add `jobs` in stage 3, `ingestion` in stage 4 and `extraction` in stage 5A. No generic plugin/repository framework.

Use one dedicated SQLite writer and four bounded read workers. Every connection enables required pragmas and policy functions; a read handle is never used concurrently. CPU scoring and serialization use explicit bounded work, not unlimited spawn_blocking. Read cancellation reaches SQLite progress/interrupt hooks; cancelled workers retain admission permits until stopped. Reset interrupt state before reusing a connection.

Use the reserved request classes and per-client shares in the limits document. Reject excess rather than buffering beyond those limits. Writer selection prefers queued foreground mutations over background commits, but after eight foreground transactions allows one ready background transaction. Reserved admission prevents background completion from crowding out prompt requests.

## Authoritative transactions

Retain transaction:

1. Validate schema, bounds, canonical scope and semantic payload before queueing.
2. Check an existing idempotency receipt on a reserved read path; confirm again under the writer transaction to settle races.
3. Check new-write quota only when no matching receipt exists.
4. Insert memory UUID and authority, update FTS, increment memory revision, and record current embedding intent (disabled in this slice).
5. Store the exact acknowledgement under the unique receipt key.
6. Commit durably, then respond. A lost response cannot lose the receipt.

Forget transaction uses the same receipt sequence, writes ID and scoped fingerprint suppression, marks the target ineligible, removes it from active FTS and advances memory revision atomically. Suppression records are not garbage-collected with derived data. A previously manual row is still hidden by its ID tombstone; manual authority only exempts a new deliberate manual save from proposition-level automatic suppression.

Retain and Forget must roll back together with FTS, intent, revision and receipt on any failure. SQLite commit failure is never a successful RPC. Disk full, schema mismatch and corruption use explicit categories; avoid blind transaction retries after an uncertain commit.

## Lexical retrieval and consistency

Use existing query normalization and repository-policy fixtures as behavioral evidence. Convert input into safe FTS terms; do not execute raw user FTS syntax. Empty/scaffolding-only queries have no topical results. Later mandatory sections are assembled independently.

Apply global/repository/transferable policy, tombstones, supersession and expiry before candidate limits. Rank deterministically using lexical relevance and stable ID ties. A rejected candidate does not consume the eligible-result limit. Recheck eligibility in the final result snapshot; return its memory revision and evaluation time.

The slice-2 implementation can perform lexical selection and rendering from one bounded read snapshot. In stage 3 any early speculative lexical read is only a candidate hint: after inference finishes or times out, start a final snapshot, check revision and rerun lexical selection if it changed, then score vectors and render from that snapshot. Do not hold a transaction during inference. If work cannot fit the remaining budget, return an explicit bounded result or deadline error; never mix old content with a newer revision.

Queries use indexes for scope, active rows and suppression. Include EXPLAIN QUERY PLAN evidence for sparse eligible repositories, not just a dense single-repository corpus. The database deadline/VM interrupt bounds work when an index cannot avoid a large search. Report candidate truncation and lower-layer deadlines; do not pretend a capped scan was complete.

## Observability and health

Use bounded in-memory histograms for operation duration, admission wait, writer wait, SQLite time, cancellation and response bytes. Record per-operation aggregates, not a metric label per query, source path or memory ID. Logs contain operation, request ID, duration, code/reason and process instance; no user text.

Status reads maintained counters with their freshness. It does not run an integrity scan or block behind provider work. Explicit Validate/Doctor arrive later. A counter failure cannot become a reason to expose raw SQL or return invented zero counts.

Validate store file/sidecar permissions, checkpoint behavior, free space and pressure conditions. Failed checkpoints are observable. Old read snapshots cannot grow WAL indefinitely; use the bounded reader gap described in configuration/storage.

## TDD sequence

1. Unit tests: scope combinations, explicit global versus inferred unscoped directives, expiry at exactly now, invalid expiry, manual/new-ID restoration, repository mappings, FTS metacharacters, Unicode and deterministic ties.
2. SQLite integration: successful transactions visible from an independent connection; exact receipts; concurrent identical keys; conflicting payload; complete rollback after every injected failure.
3. Retry races: commit then drop response, exhaust quota, retry successfully; Forget after uncertain Retain, retry Retain without resurrection; repeat Forget after restart.
4. Policy races: Forget before snapshot is absent; Forget after snapshot follows documented snapshot semantics; no old content with newer returned revision.
5. Lifecycle subprocesses: store/endpoint double ownership, stale socket, different stores/same socket, unsafe permissions/symlinks, long paths, SIGTERM drain, SIGKILL and restart.
6. Load/cancellation: request floods, fast vector-shaped commit simulation, sparse scope, slow readers, Status/retry reservation and queued/running read interruption.
7. Two independent Node clients plus Rust CLI: A retains, B recalls after acknowledgement, B forgets, A sees absence. One client disconnects without killing the daemon.
8. Freeze v1/v2 lexical latency and resource comparison using [validation](validation.md).

## Acceptance and handoff

G2 requires zero policy failures, durable acknowledged writes across process kills, actual Forget coverage, bounded cancelled work and correct endpoint ownership on both OS families. Publish cold/warm lexical results, write latency, CPU/RSS, DB/WAL size and error rates. No inference dependency exists on Recall yet.

The commit must include storage migrations, protocol/schema fixtures, the executable synthetic fixture loader and its safety guard (explicit isolated destination only). Do not accept a test that only mocks SQLite commits. Power-loss claims require additional evidence beyond SIGKILL.

No production adapters, ingestion, automatic spawning, installers, real database import or dashboard in this slice. Their complete plans are downstream; this gate does not waive them.
