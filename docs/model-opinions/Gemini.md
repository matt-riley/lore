# Lore v2 Plan Review: Gemini

**Date:** 2026-09-14
**Subject:** Evaluation of Lore v2 daemon rewrite plan (`docs/v2/`)

---

## Executive Summary

The v2 architectural direction is fundamentally sound. Consolidating storage ownership, vector indexing, transcript ingestion, and scheduling into a single per-user Rust daemon (`lored`) directly solves the multi-agent concurrency, database contention, and prompt-latency problems currently experienced when running multiple assistants (Pi, Copilot, Codex, Claude Code, Antigravity) side-by-side.

The planning discipline is exemplary:
- Clear vertical slices with incremental proof points.
- Explicit go/no-go gates after Slice 3 before porting complex ingestion and extraction logic.
- Preservation of Lore's core safety invariants (suppression/forget, manual authority, expiry, repository isolation).
- Isolation of v2 state in `lore-v2.db` without prematurely touching v1 data.

However, there is **one major architectural flaw** in Slice 3 regarding query embeddings that would severely degrade real-world semantic search, alongside several practical considerations regarding transport, vector I/O, daemon lifecycle, and extraction maintenance.

---

## Key Strengths

1. **Clean Process Boundary:** Moving away from each client spawning independent worker processes or competing for SQLite locks towards a single per-user daemon provides predictable scheduling and resource bounds.
2. **Decoupled Heavy Work from Prompts:** Isolating transcript discovery, parsing, and embedding generation outside prompt evaluation keeps agent turnaround fast.
3. **Safety and Integrity:** Strict repository scoping, manual memory precedence over derived/extracted memories, and immediate enforcement of suppression/expiry across all retrieval paths.
4. **Pragmatic Go/No-Go Milestone:** Stopping after Slices 1–3 to evaluate real latency, memory, and retrieval metrics before committing to rewriting all extraction logic in Rust is excellent risk mitigation.

---

## Critical Concerns & Recommended Changes

### 1. The "Cache-Only Query Vector" Dilemma (Slice 3)

#### The Problem
In [03-background-embeddings.md](../03-background-embeddings.md):
> *"Recall uses lexical retrieval immediately. An exact-query cache hit may add vector results. A cache miss remains lexical-only; Recall does not synchronously compute or enqueue a vector... A client may call PrepareQuery when a completed prompt is submitted, then Recall immediately. It must not wait for preparation..."*

In interactive AI coding workflows, **over 90% of user prompts are unique**. Exact byte-for-byte query matches are rare. If:
1. `Recall` never computes a query vector on a cache miss, and
2. `PrepareQuery` runs asynchronously while `Recall` returns immediately without waiting,

then for nearly all interactive prompts, the query embedding will finish *after* `Recall` has already rendered context and injected it into the prompt. By the next turn, the user will issue a different prompt.

**Result:** Lore v2 would effectively function as an **FTS lexical-only retrieval engine** for interactive prompts, causing a significant functional regression compared to v1's semantic search.

#### Recommendations
- **Bounded Synchronous Budget:** Allow `Recall` an optional, tight query-embedding deadline (e.g., 50–120 ms). If a local or fast remote provider answers within budget, fuse vector and lexical results immediately. If it times out or fails, fall back to lexical immediately and cache the vector when it completes.
- **In-Process Local Embeddings (High Leverage):** Because `lored` is in Rust, leverage an in-process quantized embedding model (e.g., `all-MiniLM-L6-v2` or `bge-small` via `fastembed`, `candle`, or ONNX Runtime). Running inference in-process on CPU with SIMD computes embeddings in **3–12 ms**, completely eliminating external network jitter and provider availability dependencies on the prompt path.
- **Query Canonicalization:** If query caching is used, exact UTF-8 byte matching is too strict. Normalize queries (trim whitespace, collapse spaces, lowercase, strip trailing punctuation) so minor variations hit the cache.

---

### 2. Transport & Zero-Dependency Principles (Slice 1)

#### The Problem
Lore's design philosophy emphasizes Node 24+ ESM with zero runtime dependencies and no build step. Implementing **gRPC / Protobuf** over Unix Domain Sockets in pure Node without a build step requires heavyweight dependencies (`@grpc/grpc-js`, `@grpc/proto-loader`) or pre-compiling client bindings. Furthermore, debugging gRPC over UDS requires specialized tooling.

#### Recommendations
- Elevate **JSON-RPC 2.0 or REST over Unix Domain Sockets** as a primary option rather than just a fallback:
  - Node 24+ natively supports `socketPath` in `node:http` and `fetch` with **zero external dependencies**.
  - Trivial to implement in Rust via `axum`, `actix-web`, or `hyper` over `tokio::net::UnixListener`.
  - Human-debuggable using standard command-line tools: `curl --unix-socket /path/to/lored.sock http://localhost/v2/recall`.

---

### 3. In-Memory Vector Cache vs. SQLite BLOB I/O (Slice 3)

#### The Problem
Slice 3 caps candidate vector scoring at 10,000 vectors without an ANN index. Computing cosine similarity over 10,000 vectors (e.g., 768-dimension `f32`) in Rust using SIMD takes only **1–2 ms**. However, executing a `SELECT` to read and deserialize 10,000 vector BLOBs from SQLite disk storage on every query could take **20–50+ ms** of I/O latency.

#### Recommendations
- Maintain an **in-memory contiguous vector buffer** in `lored`, keyed by memory ID and filtered by repository scope, kept synchronized on write transactions.
- Score against this in-memory buffer at recall time to keep vector retrieval sub-millisecond without disk I/O bottlenecks.

---

### 4. Daemon Lifecycle & Client Ergonomics (Slices 2 & 6)

#### The Problem
Slice 2 defers service management, and Slice 6 specifies that prompt handling never waits for daemon startup. Formal service management (`launchd`/`systemd`) is deferred until Slice 7.

During early slices, and for users who do not configure background system services, every invocation of a CLI agent (e.g., `pi` or `codex` in a new terminal) would fail to connect or require running a separate terminal with `lored` manually.

#### Recommendations
- Implement a **Lazy Auto-Spawn Protocol** in the client adapters:
  1. Probe the socket with a brief timeout (~20 ms).
  2. If missing/unresponsive, spawn `lored --daemonize` (or a detached subprocess).
  3. Wait up to 200 ms for the socket to become ready, then execute the RPC.
  4. If unavailable, fail open (proceed without memory context).

---

### 5. Ingestion & Extraction Scope in Rust (Slices 4 & 5)

#### The Problem
In Lore v1, extraction heuristics and agent transcript parsers (`lib/extract/`, `lib/clients/`) are the most volatile, frequently tuned components as agent CLI output formats evolve. Porting all heuristic rules and parsers into compiled Rust creates a substantial maintenance overhead and requires binary recompilations for minor heuristic tweaks.

#### Recommendations
- Treat `lored` primarily as the high-performance storage engine, vector indexer, FTS engine, and retrieval coordinator.
- Consider keeping extraction rules as modular worker scripts or plugins that interact with `lored` via `Retain` / `BatchRetain` APIs, rather than hard-coding all parsing heuristics into the monolithic daemon binary.

---

## Summary Matrix of Recommended Adjustments

| Area | Current Proposal in `docs/v2` | Suggested Revision |
| :--- | :--- | :--- |
| **Recall Vectors** | Cache-only; miss returns lexical-only with no query embedding. | Add a bounded synchronous deadline (~100 ms) or an in-process local encoder (`fastembed`/`candle`) in `lored`. |
| **Transport** | gRPC/protobuf over UDS with HTTP/JSON as backup. | Elevate JSON-RPC or REST over UDS to first-class to keep client adapters zero-dependency. |
| **Vector Storage** | Stored in SQLite; ANN deferred. | Maintain an in-memory vector cache in `lored` to avoid 10k BLOB disk reads per query. |
| **Query Cache Key**| Exact UTF-8 query bytes + model ID. | Normalize query strings (trim, lowercase, punctuation collapse). |
| **Daemon Startup** | Manual startup or deferred to `launchd`/`systemd` (Slice 7). | Implement client-side lazy auto-spawning for frictionless CLI usage. |
| **Extraction (Slice 5)**| Full extraction logic rewrite in Rust. | Keep extraction modular/pluggable via `Retain` APIs rather than monolithic in Rust. |
