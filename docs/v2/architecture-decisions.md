# Architecture decisions

Status: accepted planning decisions, 2026-09-15. Implementation evidence is still required.
Parent: [roadmap](README.md). Review provenance: [disposition](review-disposition.md).

## ADR-001: Rust core and CLI

Implement `lored` and `lore` in one Cargo workspace with shared concrete protocol, policy, store, retrieval, ingestion and extraction modules. JavaScript/TypeScript remains only for host-required Copilot/Pi integration and development/evaluation tooling. A normal v2 CLI installation must not require Node; hosts can still require their own runtime.

Rust is an explicit user preference for a persistent daemon and native distribution. It is not a claim that inference becomes faster. Address porting risk through cross-language behavioral fixtures, incremental gates, and measured v1 comparisons. Do not build a disposable Node daemon or retain JS extraction workers in production.

Use Tokio for socket/network scheduling, Hyper HTTP/1 with `hyper-util` for Unix streams, Serde/serde_json for wire types, rusqlite with bundled SQLite/FTS5 and backup/hooks support, and reqwest with rustls for provider HTTP. Use OS advisory file locks through a small reviewed Unix interface; no custom unsafe transport parser. CLI parsing uses clap. Pin the stable Rust compiler/MSRV and dependencies in the first implementation commit, commit Cargo.lock, and record versions and licenses in G1 evidence. Later dependency upgrades must rerun the applicable fixtures.

Reconsider only if implementation evidence shows an unsatisfied requirement; do not treat a slow provider or a failing retrieval corpus as evidence that Rust itself failed.

## ADR-002: HTTP/JSON over Unix domain sockets

Use explicit versioned POST routes and JSON Schema contracts. Use standard HTTP framing, not a custom JSON-lines parser, JSON-RPC batch protocol, or gRPC code generation. No daemon TCP fallback, proxy discovery, CORS, HTTP upgrades, compression, or streaming RPC is needed in the proof.

Node adapters use `node:http.request` with `socketPath` and active cancellation. Do not assume ordinary `fetch` accepts a Unix socket path. Validate the same adapter under the actual Bun/Pi runtime in G1; incompatibility blocks adoption rather than introducing a second protocol. The Rust CLI uses the shared types and socket transport.

The reason is low host dependency cost and inspectable request/response contracts. Binary encoding is not a success criterion. [Node HTTP documentation](https://nodejs.org/api/http.html#httprequestoptions-callback) documents the socket option and cancellation signal.

## ADR-003: Service ownership and endpoint identity

Use a per-user launchd LaunchAgent or systemd user service in production. The proof starts a foreground process in a temporary home. Client hooks neither spawn nor restart it, and never wait for archive catch-up. Missing/unready/incompatible service means bounded failure and an agent that continues without Lore context.

Choose continuous background progress over client-spawned idle exit. The service starts at user login; enabling Linux lingering is a separate explicit operator action, not an installer side effect. One configured store has an OS-held lock; each socket pathname also has an OS-held lock. Both are required before stale endpoint cleanup. Status exposes immutable store ID plus process instance ID.

## ADR-004: Bounded new-query inference

Permit one query embedding within a maximum 100 ms inference allowance and 200 ms end-to-end prompt-hook budget. Lexical retrieval runs concurrently. All model startup, connection setup, provider admission, network, parsing, and vector validation time counts against the inference allowance. No inline retry, no waiting for a memory batch, and no continuing detached work after the last interested request cancels.

Keep memory embeddings durable and background. Exact-key query vectors live in a bounded memory-only cache; unseen queries do not depend on recurrence. Cache-only remains an evaluation mode, not the product default. `PrepareQuery`, previous-turn vector substitution and query canonicalization are deferred because they are unnecessary for this path and can change meaning. Never compare query and memory vectors from different model spaces.

An external provider can serialize requests internally despite separate daemon lanes. The deadline still holds; the semantic availability and quality gates detect the resulting fallback. If the configured provider cannot satisfy G3, stop and review provider deployment or an explicitly revised design. Do not silently loosen the deadline.

## ADR-005: Authority independent of indexing capacity

An authoritative memory and its current embedding intent commit together. The intent is a coalescing per-memory state, not an unbounded executable queue. A bounded scheduler materializes jobs from it. Queue pressure delays coverage; disk failure or authoritative quotas can reject a new write.

Suppression, memory identity, manual authority, retry receipts and source checkpoints are durable contracts. Vectors and runnable work are rebuildable. Leases fence late completions; reconciliation respects terminal failures. Deleting derived data must neither delete memories nor clear suppression.

## ADR-006: Bounded SQLite vector paging

Start with exact cosine scoring over eligible vectors read in bounded pages and reciprocal-rank fusion with lexical candidates. Avoid a full-corpus heap copy. This gives a concrete resource baseline; a contiguous index or ANN is a later measured change with the same eligibility and deletion fixtures.

The cap is observable partial coverage, not permission to filter after limiting foreign rows. Include sparse eligible scopes, large dimensions, rapid vector commits and read-pool sweeps in G3. A 100 MiB idle RSS target is meaningful only with explicit SQLite cache, vector cache and worker limits.

## ADR-007: Separate storage and conservative cutover

New v2 state has its own configuration and store ID. Read v1 through an explicit, consistent snapshot; never open the live source with a v2 migration runner. Migration is staged, resumable and accounted for before activation. A schema downgrade and a switch back to v1 are different operations, neither automatically available.

A rollback must not revive content forgotten since a backup. Preserve current tombstones, evidence suppression and retry receipts when restoring. If those cannot be reconciled, recovery stops before replacement. Raw source bytes and backups remain sensitive and are not securely erased by Forget/Purge.

## ADR-008: Full capability replacement without broader authority

Port all current user-facing operations and optional capabilities, retaining their enablement defaults, read-only previews and explicit apply semantics. No new arbitrary plugin execution, remote service or generic SQL API. Host adapters receive only capabilities actually implemented by the connected daemon. Keep the nine canonical model tools; extras remain available to humans/scripts.

The read-only dashboard becomes a separate Rust loopback gateway serving the current static assets and daemon-backed view APIs. It does not open SQLite or expose arbitrary operation dispatch. Keep the existing visual design; this project is not a dashboard redesign.

## ADR-009: Measurement and v1 coexistence

Use frozen synthetic prompts and independent expected outcomes, plus optional consented local replay. Measure request latency separately from cold hook-process cost and provider latency. Compare like-for-like modes and budgets; a manual-only proof cannot pass persona or episode parity on behalf of later slices.

Only correctness/security and required host compatibility fixes are assumed during dual maintenance. Any additional v1 work must explicitly update the parity inventory. Release support waits for all-client certification and soak; changing a gate requires an amended decision with failed results retained.

## Runtime implementation references

- [SQLite WAL](https://www.sqlite.org/wal.html): long overlapping reads can prevent checkpoint completion; bound read transactions and schedule checkpoints.
- [SQLite backup API](https://www.sqlite.org/backup.html): use database-aware snapshots rather than copying a live main file without its journal state.
- [Tokio blocking tasks](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html): cancelling an async handle does not stop an already-running blocking task; implement cooperative cancellation and SQLite interruption.

These references establish implementation constraints. Performance figures in reviewer opinions are hypotheses until reproduced by the validation suite.
