# Slice 1: protocol and compatibility contracts

Status: planned. Depends on the [decisions](architecture-decisions.md), [limits/storage](configuration-storage.md) and [validation](validation.md). Exit: G1.

## Deliverables and first executable proof

Create a Cargo workspace under `daemon/` with `lored` and `lore` binaries, shared protocol types, pinned toolchain and Cargo.lock. Define JSON Schema 2020-12 request/response documents under `schemas/v2/`; schema definitions and golden JSON are the language-independent contract. Rust types and adapter validation must pass the same fixtures. Do not introduce protobuf or a Node production daemon.

Start with a tiny Rust Status server, a Node/Bun client and the Rust CLI on an isolated Unix socket. Test host loading, connect/disconnect, deadline and cold-process overhead before adding storage handlers. Then freeze contract fixtures under `tests/v2/fixtures/` for stages 2-3. No live hooks or databases are touched.

## HTTP framing and versioning

- HTTP/1.1 POST only for RPCs; `Content-Type: application/json`. UTF-8, no compression, redirects, upgrades, pipelining or batch envelopes. A persistent connection can make sequential requests.
- Routes: `/v2/status`, `/v2/retain`, `/v2/recall`, `/v2/forget`. Later routes are listed below; an unimplemented route returns `UNIMPLEMENTED`.
- Major version is in the path. Status reports `apiMajor: 2`, `apiMinor: 0` initially. A breaking scope, acknowledgement, deletion or authority change needs a new major, even if JSON parses.
- Reject unknown request fields and enum values. Additive request features require advertised capability negotiation before sending; old clients continue sending their existing shape. Ignore unknown additive response fields. Never reinterpret an old field.
- Require explicit Content-Length in shipped clients; a standards-compliant HTTP parser may accept chunked bodies under the same streaming byte cap. Reject conflicting framing, invalid UTF-8, duplicate JSON keys, NaN/infinity, unsafe numeric integers and excessive nesting.
- Enforce body/header limits while reading, including peers that never finish a body. Header/body receive deadline is 1 second, independent of operation execution deadline; close partial/oversized requests.
- Use a fixed HTTP Host header `lore.local`, independent of the socket path. Reject other Host values and Origin-bearing requests. Never use proxy environment variables for socket transport.
- Request execution time starts at admission after a complete validated body. The client measures the complete deadline from before identity resolution and process/connection setup, sends remaining `timeoutMs`, and destroys the request when its own deadline expires.

## Common envelope

All keys use camelCase. All successful responses include `ok`, `requestId`, `storeId`, and `result`. Errors include the same identifiers where available and `error: {code, reason, retryable, message}`. Error messages are safe summaries; clients branch on code/reason.

```json
{
  "meta": {
    "clientId": "pi",
    "requestId": "request-uuid",
    "sessionId": "native-session-id",
    "expectedStoreId": "store-uuid",
    "timeoutMs": 160,
    "requiredCapabilities": ["recall.lexical"]
  },
  "params": {
    "query": "How are repository identities normalized?",
    "repository": "github.com/matt-riley/lore",
    "includeOtherRepositories": false,
    "limit": 6,
    "contextBytes": 8192
  }
}
```

`clientId` is stable across restarts/upgrades: `copilot`, `pi`, `codex`, `claude`, `antigravity`, `cli`, `dashboard`, or `test.<name>`. Allow 1-64 ASCII letters/digits/dot/underscore/hyphen for configured integrations. It is attribution, not authentication. Request IDs are unique diagnostics, 1-128 bytes; session IDs are optional, at most 256 bytes. Required capabilities are unique strings, at most 32.

Initial Status may omit expectedStoreId. All other requests require it; mismatch is `STORE_MISMATCH`. Missing timeout uses the operation's server default. Server clamps the deadline to its maximum, never extends the caller's remaining time. Nonpositive timeout is rejected before work.

Repository identities are at most 1,024 UTF-8 bytes. Resolve Git remote host plus full path, normalized across supported transports; preserve host, nested path and case-sensitive repository path. Local repositories use a hash of the canonical Git common directory, unifying linked worktrees. Explicit legacy mappings require one unambiguous destination. No basename matching or cwd inference inside the daemon. The CLI/shared adapter resolver must pass existing repository-identity fixtures.

## Status

Params: optional expectedApiMajor. Result contains:

- API major/minor, daemon version, schema version, storeId, processInstanceId, uptimeMs.
- Implemented capability IDs and enabled/disabled state; a disabled or planned feature is not advertised as usable.
- Readiness `ready | degraded | unavailable`, and stable reason codes.
- Memory revision and derived generation as unsigned decimal strings; counts of active/retired memories.
- Embedding configuration identity without credentials/secret URL components; provider state, coverage counters, counterObservedAtMs and counterRevision.
- Queued, running, retryWait, failed and pendingIntent counts, oldest work age, last success and last categorical error.
- Source states/progress after stage 4, resource pressure and bounded histogram summaries.

Ready means authoritative reads/writes can be served. Disabled optional providers are normal. Degraded means lexical/manual operations remain available but enabled indexing/capture or resource targets are impaired. Unavailable means the requested core cannot operate safely. During startup before binding, missing socket is the readiness signal.

Reasons include `PROVIDER_OFFLINE`, `PROVIDER_AUTH`, `PROVIDER_MODEL_INVALID`, `EMBEDDING_BACKLOG`, `EMBEDDING_FAILED`, `SOURCE_UNAVAILABLE`, `SOURCE_SKIPPED`, `SOURCE_AMBIGUOUS`, `DISK_PRESSURE`, `WAL_PRESSURE`, `CONFIG_RELOAD_REJECTED`, `MIGRATION_INCOMPLETE` and `SHUTTING_DOWN`.

An explicitly disabled installation reports unavailable with `CONFIG_DISABLED`; optional providers disabled inside an enabled installation do not make it unavailable.

Status does not warm models, scan vectors, ingest transcripts, migrate, or run integrity checks. Coverage denominator is currently eligible memories for the active embedding configuration across the store, evaluated by the bounded reconciler at the reported time/revision. It is not import completion.

## Retain

Proof params: `idempotencyKey`, `type`, `content`, `scope`, `repository`, optional `confidence`, `expiresAtMs`, `tags`, `sourceSessionId`. Proof supports manual semantic writes only. Type is a nonempty 1-64 byte identifier; confidence is finite 0-1, default 1. Expiry is null by default; a past expiry is permitted and immediately ineligible. Omitted tags normalize to an empty array.

Scope is `global | repo | transferable`. Global requires repository null; repo/transferable require a canonical repository. Reject incompatible combinations. Clients cannot supply authority, suppression bypass, extraction provenance or daemon job state. Stage 5A adds explicitly typed domain/workstream operations without weakening this boundary.

Result: `memoryId`, `committedRevision`, `writeResult: created`, `embeddingStatus: disabled | pending`. Pending means durable intent, whether or not a runnable job exists.

Idempotency rules:

1. Namespace keys by store ID, stable client ID and canonical operation. Keys are 1-128 ASCII bytes. New manual saves use fresh random keys.
2. Hash a deterministic canonical semantic payload: explicit defaults, sorted unique tags, repository/scope, confidence, expiry, source attribution, and exact content bytes. Exclude request ID, timeout, capability requirements and transport metadata. Reject unsupported fields before hashing.
3. After bounded validation/admission, look up an existing receipt before applying new-write quotas. Same payload returns the original acknowledgement, including original embedding status; do not recompute it as a new deduplication result.
4. Different payload under the same key is `IDEMPOTENCY_CONFLICT`. Concurrent identical requests create one record and receipt.
5. Commit memory, FTS change, revision, receipt and embedding intent atomically before acknowledgement. The current index status belongs in Status, not a modified retry receipt.
6. Retrying a save whose memory was later forgotten returns its original receipt but never recreates the row. Different keys are independent deliberate writes; no fuzzy deduplication.
7. Timeout/disconnect is uncertain, not rollback. Preserve the original key until resolved. Never retry against a different store or v1.

## Forget

Params: `idempotencyKey`, `memoryId`, optional `reason` (at most 512 bytes). Acts on one existing semantic memory in the proof. Later dependency handling extends to all context forms as specified in stages 5A/6B.

In one transaction mark the original ID forgotten, write scoped ID/canonical/evidence/content tombstones, retire its context eligibility, invalidate embedding intent/vector usability, advance memory revision and store the receipt. A repeated Forget with a new key for an already forgotten known ID returns `alreadyForgotten` without another memory revision. An unknown ID returns `NOT_FOUND`; it does not create an unspecific tombstone.

Result: `memoryId`, `committedRevision`, `writeResult: forgotten | alreadyForgotten`. Old IDs stay hidden even when their authority was manual. Fingerprint suppression prevents automatic re-extraction; a fresh deliberate manual save with a new ID/key is allowed. A Retain retry is not such a save. Preserve these distinctions on restore.

## Recall

Params: query, repository (nullable), includeOtherRepositories (default false), limit and contextBytes. Only stage 6A compatibility translation accepts v1's `prompt` spelling; the wire schema uses `query`.

Default eligibility is explicit global evidence plus same-repository evidence. Without a repository, only global evidence qualifies, even with includeOtherRepositories. With a repository and explicit cross-repository consent, foreign transferable evidence may qualify; private foreign repo rows never do. Expiry, tombstones, supersession and active evidence are enforced before ranking and final rendering. No model/provider response can alter scope.

Result includes:

- Complete structured records: ID, type/kind, content, scope/repository, authority, confidence, expiry and bounded provenance.
- `context` and ordered `sections` with represented IDs and any explicit excerpts/omissions.
- `memoryRevision`, `evaluatedAtMs`, `derivedGeneration` and diagnostics.
- Diagnostics: `retrievalMode: lexical | hybrid`, cache state `hit | miss | disabled`, vector contribution count, coverage observation, bounded-work reasons and fallback reason.

Lexical-only stage 2 performs no provider work. Stage 3 permits bounded query embedding per [embeddings](03-background-embeddings.md). Fallback reasons include `DISABLED`, `CACHE_MISS` (cache-only evaluation), `QUERY_TIMEOUT`, `QUERY_CAPACITY`, `PROVIDER_OFFLINE`, `PROVIDER_INVALID`, `NO_CURRENT_VECTORS`, `VECTOR_BUDGET` and `NO_RELEVANT_VECTOR`. Zero topical hits is valid.

Read-your-writes means a mutation acknowledged before the final read snapshot affects the returned eligibility. The final memory rows, policy state and returned revision come from one snapshot; expiry is evaluated at its start. A concurrent mutation after that snapshot may affect the next recall, not retroactively this response. Do not promise that already-delivered context is revoked.

### Output budgeting

The 1 MiB cap covers the fully JSON-encoded body, including escaping, structured content, rendered text and diagnostics. Build within a bounded serializer before sending headers. Take complete records in final ranking order while they fit; reserve envelope/diagnostic space first. Never return half a structured memory. Report `RESPONSE_BYTES` and the omitted count, distinct from candidate-work truncation.

Rendering has its own contextBytes cap. Required context sections precede topical sections once implemented. Within a section retain deterministic rank order. A single long memory may produce a UTF-8-safe excerpt explicitly marked as partial and linked to its complete structured record; no invented provenance or unlabeled sentence changes. Include headers and omission markers in the byte count. Records absent from the structured list cannot appear unreferenced in rendered context. Test heavily escaped 64 KiB content, 20 maximum-size rows, emoji, and an insufficient budget for mandatory sections.

## Errors

| HTTP | Code | Typical reason / recovery |
| --- | --- | --- |
| 400 | INVALID_ARGUMENT | INVALID_JSON, INVALID_SCOPE, INVALID_REPOSITORY, UNKNOWN_FIELD, INVALID_DEADLINE; correct input |
| 404 | NOT_FOUND | MEMORY_NOT_FOUND or RUN_NOT_FOUND |
| 405 / 415 | INVALID_ARGUMENT | METHOD_NOT_ALLOWED / UNSUPPORTED_MEDIA_TYPE |
| 409 | ALREADY_EXISTS | IDEMPOTENCY_CONFLICT; do not change the key to hide a conflict |
| 412 | FAILED_PRECONDITION | API_MAJOR_MISMATCH, STORE_MISMATCH, CAPABILITY_REQUIRED, SCHEMA_UNSUPPORTED, PREVIEW_STALE |
| 413 | RESOURCE_EXHAUSTED | REQUEST_BYTES; reduce input, never blindly retry |
| 429 | RESOURCE_EXHAUSTED | REQUEST_CAPACITY, CLIENT_CAPACITY, STORE_QUOTA, JOURNAL_FULL |
| 503 | UNAVAILABLE | STARTING, SHUTTING_DOWN, STORE_CORRUPT, IO_FAILURE, ENDPOINT_IN_USE |
| 504 | DEADLINE_EXCEEDED | REQUEST_DEADLINE; write outcome may be uncertain |
| 501 | UNIMPLEMENTED | ROUTE_UNIMPLEMENTED or OPERATION_UNIMPLEMENTED |
| 500 | INTERNAL | INTERNAL_FAILURE; request ID only, no SQL/payload |

Connection cancellation has local code `CANCELLED`; a disconnected peer need not receive an HTTP response. Retryable indicates whether the same request may be retried, never proof that it did not commit. Reads may retry only within the original deadline; writes always preserve their key. Decode errors, schema/identity mismatch and store corruption are not transient retries.

## Later interface additions

Stage 3 adds `/v2/jobs/status`, `/v2/jobs/retry` and `/v2/config/reload`. Jobs/status accepts providerId, state and a bounded cursor (default 50/max 200 results). Jobs/retry requires an idempotencyKey and either providerId or at most 200 memoryIds; it acknowledges a durable retry epoch, with the bounded reconciler resetting only selected terminal failures. It does not invalidate already-current vectors or run inference inline. Config/reload takes an idempotencyKey and revalidates the originally configured file; it cannot choose a new filesystem path. Failed reload keeps the active generation.

Stage 4 adds `/v2/sources/register`, `/v2/sources/hint`, and `/v2/sources/status`. Stage 5A adds complete context/domain/workstream behavior and optional Recall `timezone` (validated IANA identifier, default UTC), negotiated through `recall.temporal`. Stage 5B introduces local offline migration/recovery commands, not remotely callable filesystem mutation.

Stage 6 exposes `/v2/operations/<canonicalName>` for the fixed capability inventory and `/v2/runs/get`, `/v2/runs/cancel`, `/v2/runs/retry` for durable operations. Alias normalization maps to one canonical handler; the four proof routes and their operation equivalents share that handler and receipt namespace. No arbitrary function invocation. All mutations require idempotencyKey in the envelope's params alongside operation arguments.

All long work is acknowledged by run ID and polled with bounded pages. Cancellation stops uncommitted future work; already committed per-item effects remain and are reported. New operations must define schema, capability, mutability, scope, snapshot behavior, cancellation and fixture coverage in the same commit.

Stage 6B also adds explicit `/v2/analysis` for non-durable query expansion/context compression, and fixed read-only `/v2/views/<name>` routes. Analysis is the documented exception to durable long runs because original query text must remain memory-only; see the administration plan for timeout/restart behavior.

| Initial capability IDs | Introduced when implemented |
| --- | --- |
| status.basic | 1 |
| memory.retain.manual, memory.forget, recall.lexical | 2 |
| recall.semantic.bounded, embedding.status, embedding.retry, config.reload | 3 |
| sources.register, sources.hint, sources.status | 4 |
| recall.context, recall.temporal, memory.retain.domain, memory.retain.workstream | 5A |
| operation.<canonicalName>, runs.get, runs.cancel, runs.retry | 6A/6B; each individual operation only after its handler is complete |
| analysis.queryExpansion, analysis.contextCompression, views.<name> | 6B |

Capabilities are exact strings, not wildcard permissions. The operation/view notation in this table expands to one ID per fixed registry entry. Store schema support and binary/service commands are not falsely advertised as model tools.

## TDD and acceptance

1. Fail JSON round-trip, duplicate-key, enum/default, malformed framing and response-size tests before handlers.
2. Prove Rust/Node/Bun exchange over temporary sockets, cold CLI execution, deadlines, disconnect/reconnect, major mismatch and additive responses.
3. Freeze stable client, repository, scope, idempotency, output and deletion fixtures. Normalize only intended wire defaults, never expected semantic outcomes.
4. Test socket/store mismatch, two stores targeting one live socket, slow bodies and bounded overload.
5. Add schema/type drift checks to macOS/Linux CI with Cargo caching and the current supported Node floor.

G1 passes only when all clients use one protocol without host-specific framing shims, the Rust CLI path works without Node, and the published evidence identifies dependency versions and unsupported capabilities. G1 validates contracts; durable behavior remains G2.
