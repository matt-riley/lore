# Slice 1: protocol and storage contracts

Status: planned. Depends on: none. Exit: interoperable contract and runnable fixtures, not a production daemon.

## Purpose

Define the smallest stable boundary that lets clients stop owning memory infrastructure. Freeze a v2 API major version and additive evolution rules; do not prematurely freeze all v1 behavior into a new protocol.

## Deliverables

- `proto/lore/v2/lore.proto`: Status, Recall, Retain and their message types.
- `daemon/`: Rust crate, pinned toolchain/MSRV and Cargo.lock selected at implementation time.
- Generated Rust and Node test bindings with reproducible generation/check commands.
- `tests/v2/fixtures/`: synthetic requests, expected policy outcomes, malformed and incompatible inputs.
- An architecture decision record for transport, process ownership, and storage separation.
- A Node/Rust Unix-socket interoperability check; no real client installation changes.

## RPC contract

### Common conventions

- Package `lore.v2`. Breaking semantics require a new package major.
- Every request carries a client identifier, optional native session identifier, and request ID for diagnostics.
- Client identifiers are attribution, not authentication or permission boundaries.
- Explicit `repository` is a canonical identity, not a daemon working-directory inference. An absent repository means global-only retrieval; it never means all repositories.
- Store timestamps as UTC epoch milliseconds in protobuf and document conversion to SQLite.
- Validate enum values, lengths, timestamp ranges, counts, and scope combinations on the server.
- No raw prompt or memory content in ordinary logs or metrics.
- Initial request/response message cap: 1 MiB. Retained content cap: 64 KiB UTF-8. Recall query cap: 16 KiB UTF-8. Reject, never silently truncate, invalid inputs.
- No streaming RPC in this proof. Clients set deadlines and propagate cancellation.

### Status

Request: common metadata and optional expected API major.

Response:

- API major/minor, daemon version, schema version, supported capabilities.
- Readiness: `ready`, `degraded`, or `unavailable`, plus categorical reasons.
- Memory count, current memory revision, uptime.
- Embedding provider/model identity and queue counts: `queued`, `running`, `retry_wait`, `failed`.
- Embedding coverage of eligible memories, stale count, oldest queued age, last success time.
- Last provider error category without provider response bodies.

Status must not start a model, mutate memory, perform ingestion, or scan all vectors. Expensive integrity checks belong to a future explicit diagnostic operation. Zero jobs is not proof of fully imported history.

### Retain

Request:

- Required idempotency key, memory type, content, scope.
- Repository required for `repo` and `transferable`; forbidden for `global`.
- Optional bounded confidence, expiry, source session attribution, and tags.
- Initial scope: explicit manual semantic writes only. No generated extraction writes, overlays, domains, or arbitrary client-supplied authority metadata.

Response: stable memory ID, committed revision, write result (`created` or `deduplicated`), embedding status (`queued` or `disabled`).

Rules:

- Manual content remains authoritative; never lower its authority because a background worker later sees similar text.
- Key namespace includes client ID. Same key plus identical normalized request returns the original result. Same key with different payload is `ALREADY_EXISTS`.
- Retain acknowledgement follows the durable transaction containing memory, idempotency result, and embedding invalidation/job intent.
- A timeout is not evidence of rollback. Retrying the same key is the recovery mechanism.
- Persist idempotency records without automatic expiry during the proof; enforce a configurable store quota rather than deleting retry safety records silently.

### Recall

Request: query, repository, optional explicit cross-repository consent, result limit, context byte budget.

Response:

- Structured memories with ID, type, content, scope, repository, confidence, expiry, and supported provenance.
- Rendered context produced by the daemon; adapters must not reinterpret scope or rebuild rankings.
- Memory revision and diagnostics: lexical/vector contribution, query cache hit/miss, stale/missing vector coverage, bounded-work indicators.

Rules:

- Default limit 6, maximum 20; rendered context default 8 KiB, maximum 32 KiB. Use bytes for protocol budgeting; do not claim exact tokenizer accounting.
- Global plus same-repository rows are eligible by default. Explicit cross-repository consent admits transferable rows, not private foreign repo rows.
- Suppression, supersession, and expiry filtering precede ranking and final rendering.
- Slice 2 returns lexical results only. Slice 3 may use a previously computed exact-query vector, never synchronous inference.
- First-seen queries may return lexical-only results; report that limitation explicitly.
- No implicit full-result cache in the proof. If added later, revision, scope, expiry, and suppression must invalidate it.

### Error and compatibility behavior

Use standard gRPC statuses: `INVALID_ARGUMENT`, `ALREADY_EXISTS`, `RESOURCE_EXHAUSTED`, `DEADLINE_EXCEEDED`, `CANCELLED`, `UNAVAILABLE`, `FAILED_PRECONDITION`, `INTERNAL`.

Unknown API major or unsupported required capability fails explicitly. Unknown additive protobuf fields remain compatible. Reserve removed field numbers and names. Never reuse enum values. Clients must not parse error prose for control flow. Internal errors contain a request ID, not SQL or source content.

## Storage contract

- Default experimental data root: `<resolved Lore home>/v2/`; database `lore-v2.db`. Respect explicit configuration and never reinterpret v1 paths as v2 targets.
- Storage version and wire version are independent.
- Proposed schema entities: manual semantic memories, suppression records, idempotency results, metadata/revision, embedding jobs, memory vectors, query-vector cache. Define exact DDL alongside slice-2/3 tests, not speculative v1 table copies.
- SQLite foreign keys on, WAL mode, synchronous FULL for acknowledged writes. Crash tests verify this rather than trusting defaults.
- One daemon owns writes. Readers use consistent snapshots. Embeddings are disposable derived data; memories, suppression, and idempotency results are not.
- Source revision/content hash, provider endpoint identity, model identifier, configured model revision, vector dimensions, and preprocessing version form embedding validity. A mutable `latest` tag alone cannot prove model identity.
- A separate explicit fixture loader accepts only synthetic proof data. Real v1 migration is slice 5.

## Socket and process contract

- Unix socket directory mode 0700; socket and database mode 0600; restrictive umask before creation.
- Prefer an owned XDG runtime directory on Linux; otherwise an owned per-user runtime directory. Allow an explicit socket path for tests and long home paths.
- Reject unsafe ownership, symlinks at managed endpoints, and overlong socket paths with actionable errors.
- Acquire an OS-held exclusive lock for the canonical v2 store before binding. A second instance fails cleanly.
- Remove a stale socket only after acquiring the lock and confirming it is an owned socket in the expected directory. Never unlink an arbitrary path.
- No TCP fallback. Same-user process access is the stated trust boundary.

## TDD implementation sequence

1. Write wire round-trip and invalid-input fixtures before handlers.
2. Prove Node client -> Rust server on a temporary Unix socket: success, deadline, cancellation, oversized message, disconnect, and reconnect.
3. Add additive-field and API-major mismatch tests.
4. Specify policy fixtures for scope, expiry, suppression, manual authority, and idempotency.
5. Add generation drift checks and schema version fixtures.
6. Record dependencies, licenses, MSRV, and transport decision.

## Acceptance gate

CI on macOS and Linux generates/checks bindings and passes interoperability and policy-contract tests. A reviewer can identify which v1 behaviors are supported, deferred, or explicitly rejected. No live Lore database, config, or agent settings are touched. If the transport needs custom unsafe framing or extensive adapter-specific shims, reconsider it before slice 2.
