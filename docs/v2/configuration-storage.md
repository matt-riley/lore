# Configuration, resource limits and storage

Status: planned, normative defaults for stages 1-7. Parent: [roadmap](README.md).
Changes to these defaults require updated fixtures and an amended gate report.

## Configuration and path resolution

Use a separate `<resolved Lore home>/v2/lore.json`. Default data directory is that file's directory, database `lore-v2.db`, backups `backups/`, and operation journals `client-journal/`. The existing Lore home resolver remains the compatibility reference; `LORE_HOME` selects the base home, not a v1 database to upgrade. `--config` selects an explicit v2 config; command flags override that config. Defaults fill omitted fields. Relative configured paths resolve against the config directory, never the daemon's launch working directory.

Preserve v1's LORE_CONFIG and LORE_COPILOT_HOME overrides as migration inputs; do not reinterpret LORE_CONFIG as v2 configuration. A v2 service/launcher records its explicit config path in the installation manifest. Creating an experimental v2 directory must not change which legacy home an existing v1 installation selects.

Introduce `configVersion: 2`, `enabled: false`, `dataDir`, `socketPath`, `backupDir`, `sources`, `providers`, `limits`, `rollout`, and `maintenance`. Sources and providers are empty/disabled initially. Installer configuration is an explicit preview/apply operation. No environment scanning or automatic host-source registration on daemon startup. Provider credentials use a named environment-variable reference; do not put them in command arguments or diagnostic output.

With enabled=false, a deliberately launched daemon can serve Status/config validation but admits no memory/capture/provider operations. Synthetic proof configs explicitly set enabled=true. Effective readiness reports the disabled installation separately from a broken store.

Strictly validate types, ranges, unknown keys and path collisions before creating storage. Reject a v1 database, v1 backup directory used as a v2 managed directory, nested source/output overlap, unsupported config version, and the same file resolving as source and destination. Preserve existing custom paths verbatim in migration provenance and show their resolved destinations in previews.

Config changes take effect through `lore service reload` after complete validation; an invalid replacement leaves the old effective config active with `CONFIG_RELOAD_REJECTED`. Data directory/socket changes require a stopped service and explicit reconfiguration. Provider identity changes advance a configuration generation and invalidate only affected derived state. Disabling a feature cancels future work without deleting authoritative data.

Port every existing rollout flag and default in [capability parity](capability-parity.md). Map v1 timing/budget configuration explicitly during config import: v1 token-oriented budgets are not byte counts. Preserve the old values in the import report and show the selected v2 byte budget before apply. Unknown settings block unattended conversion; never silently ignore enabled capabilities.

## Initial limits

All byte quantities below are bytes, KiB = 1,024, MiB = 1,048,576. These are implementation defaults, not measured guarantees. Operator increases remain subject to validation and invalidate the corresponding resource certification.

| Setting | Default / maximum | Behavior at limit |
| --- | --- | --- |
| JSON request or response body | 1 MiB / 1 MiB | Reject input; bound complete output before writing headers |
| HTTP headers / JSON nesting | 8 KiB / 32 levels | Reject and close malformed or excessive requests |
| Retained content / recall query | 64 KiB / 16 KiB | Reject; preserve valid content bytes exactly |
| Tags | 32 unique, 128 bytes each | Reject excess; sorted unique tags for retry hashing |
| Metadata/provenance per memory | 4 KiB encoded | Reject oversized writes; no raw transcript in provenance |
| Recall result count | 6 / 20 | Validate request; output may contain fewer complete rows |
| Rendered context | 8 KiB / 32 KiB | Deterministic section budgeting and explicit omissions |
| Prompt hook total | 200 ms | Cancel and continue host without additional context |
| Recall server work | 160 ms / 160 ms | Client may supply less; no host deadline extension |
| Query inference, all stages included | 100 ms / 100 ms | Lexical fallback, no inline retry |
| Final recall snapshot/work reserve | 30 ms | Skip vector work if remaining time is insufficient |
| Other RPC deadline | 5 s / 30 s | Long operations return a durable run ID |
| Status deadline | 100 ms / 100 ms | Cheap cached counters only |
| Shutdown drain | 5 s | Stop accepting; unresolved clients retry the original key |
| Connections / active foreground work | 64 / 32 | Reject overload; no unbounded wait queue |
| Per-client foreground share | 8 requests | Stable client ID is fairness attribution, not security |
| Read workers / writer / CPU scoring workers | 4 / 1 / 2 | Bounded channels and shared admission |
| SQLite cache per connection | 2 MiB | Five connections; no unbounded mmap allocation |
| Active read transaction | 50 ms maximum | Interrupt; no provider wait inside a transaction |
| Query provider slots / background embedding slots | 2 / 1 | Query does not queue behind background work |
| Optional chat provider slots | 1 | Background/explicit operations only; no prompt-path chat calls |
| Query coalescing waiters | 8 per key, within 32 foreground total | Excess request falls back to lexical |
| Background provider deadline | 30 s | Retry according to job policy |
| Embedding batch | 24 inputs, 256 KiB serialized | Split before dispatch; oversized single input fails explicitly |
| Provider response body / dimensions | 16 MiB / 3,072 | Bound while reading and decoding |
| Decoded vector page | 128 vectors, 2 MiB | Enforce both limits before allocation |
| Scoring work per recall | 10,000 eligible vectors | Report partial coverage; stable keyset order |
| Lexical candidate pool | 200 eligible rows | Report capped candidates; safe FTS and query-plan tests |
| Query-vector cache | 1,000 entries, 16 MiB, 24 h TTL | In-memory LRU; restart discards the cache |
| Materialized embedding jobs | 10,000 outstanding | Coalescing intents wait durably outside runnable queue |
| Background retry | 5 attempts, 1 s base, 60 s cap | Full jitter; terminal failure persists until explicit retry/config repair |
| Job lease / heartbeat | 60 s / 10 s | New claim token fences every completion |
| Source work quantum | 4 MiB or 1,000 records or 50 ms | Persist progress and yield, whichever arrives first |
| Source record / parser state | 1 MiB / 4 MiB per active source | Record diagnostic; no unbounded buffer |
| Active source parsers / total parser state | 2 / 8 MiB | Other sources retain only durable checkpoints |
| Discovery sweep / cursor page | every 60 s / 256 entries | Durable cursors, round-robin source fairness |
| Reconciliation page / interval | 256 targets / 30 s | Respect retry state and backpressure |
| Store file budget | 4 GiB total DB, WAL and SHM | Pause derived growth at 90%; deny new growth at cap |
| Free-space reserve | 256 MiB | Pause ingestion/derived writes; reject new growth before disk-full where observable |
| Authoritative record / retry receipt caps | 100,000 memories / 1,000,000 receipts | Reject new non-deletion writes; never expire retry safety silently |
| WAL soft / hard pressure | 64 MiB / 256 MiB | Checkpoint and pause derived commits; bound growth by stopping new growing writes |
| Managed backup budget | 10 files or 5 GiB | Stop before creating a required snapshot; operator archives/removes explicitly |
| Client uncertain-write journal | 128 entries, 16 MiB | Reject new write locally before dispatch; preserve uncertain entries |
| Rotated operational logs | 5 files of 10 MiB | Drop oldest operational log only; no memory payloads |

Payload budgets are independently enforced: a permitted input can still be too large for an operation's derived provider batch. That failure affects embedding coverage, not the retained content. Status reports the category and suggested configuration action.

Reserve foreground capacity: four slots for Status/identity/idempotency lookups, twelve for Recall, eight for mutations and eight shared slots. Completed-write lookup may use reserved slots before write admission. Per-client quotas apply within these classes. No role can consume another role's reservation; unused reservations are not borrowed in the proof. Keep permits until underlying work has stopped.

Store pressure is not a guarantee that any particular write will fit. Forget and cleanup bypass logical new-record quotas, but still fail honestly if their durable transaction cannot commit. Do not claim deletion success when the disk is full. Budget WAL and backups separately in diagnostics.

## Store ownership and runtime paths

Canonicalize the managed data directory once and hold its `store.lock` for the process lifetime. Default Linux runtime base is an owned, mode-0700 `XDG_RUNTIME_DIR` when present; otherwise use `/tmp/lore-<uid>`. On macOS use `/tmp/lore-<uid>`. Create/validate the private leaf under the OS temporary directory without following a hostile symlink.

Socket basename is the first 24 hex characters of SHA-256 of the canonical data directory, followed by `.sock`. Its endpoint lock is the same basename plus `.lock`. Store the full canonical-path hash in endpoint metadata and verify it to detect truncated-hash collisions. Explicit socket paths are supported, but the encoded path must be at most 100 bytes on all targets. Fail with `SOCKET_PATH_TOO_LONG` instead of truncating.

Take the store lock, then the endpoint lock, both non-blocking. A failure releases any acquired lock. Never delete lock files to break a lock. Before unlinking a stale socket, both locks must be owned, the target must be an owned socket, and a liveness probe must not find a responder. A successful or ambiguous live probe is `ENDPOINT_IN_USE`, regardless of advertised store ID.

Use umask 077; managed directories 0700 and files/socket 0600, including SQLite sidecars, journals, snapshots and staging files. Reject unsafe ownership, managed leaf symlinks, wrong file kinds, and unexpected writable ancestors. Trusted OS path aliases such as macOS `/tmp` are resolved once; tests cover the canonical destination. Do not chmod arbitrary user directories to make startup pass.

Store ID is a randomly generated UUID persisted on initialization; process instance ID is a new UUID per start. Requests other than initial Status include the expected store ID. A moved/restored store preserves its ID; an independently initialized or imported destination gets a new ID. Readiness responses never reveal raw configured paths.

## Logical schema and transaction ownership

Use SQLite foreign keys, WAL, synchronous FULL, strict tables where supported, parameterized SQL, and explicit application/schema metadata. Do not reuse v1's schema version numbers. v2 schema 1 belongs to stage 2; later stages add forward migrations with fixtures. Unknown/future schemas fail closed before serving requests.

| Entity | Minimum contract | Authority and indexes |
| --- | --- | --- |
| store_metadata | store ID, schema, memory revision, derived generation, config generation | Singleton; revision increments once per authoritative transaction |
| memories | UUID, kind/type, UTF-8 content/hash, scope/repository, authority, confidence, created/updated/expiry ms, revision, superseded/forgotten state | Authoritative; scope/type/expiry and active-row lookup indexes |
| memory_fts | content/type search terms linked to memory ID | Derived FTS5; updated with authoritative memory transaction |
| suppressions | memory ID and/or scoped canonical/evidence/content fingerprints, reason, mutation revision, lineage | Authoritative tombstones; indexed ID and scoped fingerprints |
| idempotency_receipts | client ID + operation + key, normalized request hash, original acknowledgement, created ms | Authoritative unique key; no automatic expiry |
| embedding_intents | memory ID, desired revision/hash/model identity, state, attempts, next time, terminal reason | One current intent per memory/provider configuration; transactional with mutations |
| embedding_jobs | target identity, state, lease token/expiry, attempt, timestamps | Bounded materialized work; unique active target generation |
| memory_vectors | memory ID/revision/hash, model identity, dimensions, finite normalized float32 BLOB | Derived, unique current target/model; little-endian encoding |
| sources / checkpoints | client/native identity, approved root, generation, offsets, parser revision/state, health | Authoritative progress; unique client + source identity |
| evidence / memory_evidence | stable evidence keys, source generation/record identity, role, content hash, active/retired status | Authoritative provenance and links; retired evidence cannot qualify auto memory |
| normalized_turns | source/turn identity, role-attributed bounded text, completeness, parser revision | Sensitive captured evidence; atomically committed with checkpoints |
| episodes / day_summaries / domains / observations | scoped content, explicit authority, supporting evidence and revision | Preserve user inputs; derived summaries are rebuildable under suppression |
| operation_runs / run_items | operation/input hash, snapshot/preview fingerprint, cursor, item results, state | Durable recovery and bounded long-operation progress |
| scope_audit / intent_journal / improvement_backlog / trajectory_artifacts | existing identities, scope, provenance, statuses and links | Preserve user/approval records; never activate proposals automatically |
| maintenance_state / activity / diagnostics | schedule/cursor, freshness, categorical counters | Bounded operational state; no query text by default |
| migration_manifest / migration_items | source snapshot identity, table/key, disposition, destination ID/hash | Durable import accounting; independent of model indexing |

Define executable DDL with migration tests in each slice. The table above fixes ownership and keys; extra indexes require query-plan evidence. Use UTC epoch milliseconds as signed SQLite integers; invalid v1 timestamps become explicit unresolved rows. IDs and 64-bit counters/revisions are strings on the wire; timestamps fit JSON's safe integer range.

Separate memory revision from derived generation: an embedding commit changes the latter, not the former. Expiry eligibility uses the request evaluation time, not a revision bump. Coverage counters carry their observation revision/time, so Status does not pretend stale counts are a live scan.

## Checkpointing and sensitive data

Perform passive WAL checkpoints on the writer maintenance lane after 1,000 pages or 30 seconds. At soft pressure pause derived commits and arrange a bounded reader gap; attempt truncate/restart checkpoint only outside an active foreground transaction. At hard pressure reject growing writes until recovery, continue reads/diagnostics where safe, and never delete WAL files manually.

Backups use SQLite's backup API, integrity checks, file/directory fsync where supported, and restrictive permissions before publication. Backup/restore procedures are defined in [migration/recovery](05-migration-recovery.md). A process-kill test does not certify power-loss durability.

Queries and their hashes/vectors are memory-only in v2; no persistent query job or raw query trace. OS swap, crash dumps and the configured provider can still retain data; disable application crash payload dumps and state this limit honestly. Existing opt-in v1 trace samples are handled explicitly during migration, not silently added to default logs.
