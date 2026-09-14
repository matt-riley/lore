# Summary of Lore v2 Model Opinions

**Sources:** `Claude-Opus.md`, `Fable.md`, `Gemini.md`, and `Grok.md` in this directory.

**Review date:** 2026-09-14

**Citation format:** citations such as `Grok.md:24-43` identify the source file and the relevant line range. The format is intentionally plain text so the document is easy to grep.

## Executive summary

The four reviews agree that Lore v2 should prove a long-lived, per-user daemon that owns the store and scheduler, moves ingestion and memory-side embedding off the prompt path, and preserves the existing safety contracts. They also agree that Slice 3's exact-query, cache-only vector path will usually miss on real interactive prompts and therefore risks turning semantic recall into lexical-only recall.

The strongest disagreement is about implementation order rather than the desired architecture:

- Gemini accepts Rust as the core implementation and proposes exploiting it for in-process embeddings and an in-memory vector cache.
- Claude Opus, Fable, and Grok recommend proving the daemon boundary in Node first, then choosing Rust only if measurements or a distribution goal justify a second implementation.

There is also broad support for making JSON over a Unix socket a first-class transport, or at least comparing it seriously with gRPC before committing to protobuf/code-generation overhead.

## Where the models agree

### 1. The daemon boundary is the right architectural direction

All four reviews support a single per-user process that owns SQLite access, scheduling, and background work. They connect this to the same v1 problems: repeated process/database setup, competing clients, prompt-path embedding, and the absence of a shared scheduler.

- Claude Opus: the daemon design and safety contracts are sound, while v1 lacks a shared background worker (`Claude-Opus.md:8-18`).
- Fable: one long-lived process removes the structural causes of v1's latency and contention (`Fable.md:7-20`).
- Gemini: a single Rust daemon gives predictable scheduling, resource bounds, and decoupled heavy work (`Gemini.md:8-27`).
- Grok: one writer owning memory, suppression, and jobs is the thing worth proving (`Grok.md:8-20`).

### 2. v2 must preserve the safety contracts

The reviews consistently defend separate v2 state, no implicit v1 migration, repository scoping, suppression/expiry/supersession filtering, manual-memory authority, bounded inputs, and honest same-user socket trust. These are treated as proof obligations, not optional polish.

- Claude Opus: keep the safety contracts and verify them through the revised sequence (`Claude-Opus.md:52-59`).
- Fable: lists separate storage, filtering, manual authority, idempotency, byte budgets, status semantics, embedding identity, TTLs, and the no-TCP boundary as decisions to keep (`Fable.md:24-35`).
- Gemini: identifies repository isolation, manual precedence, suppression, expiry, and v1-store isolation as core strengths (`Gemini.md:12-18`, `Gemini.md:22-27`).
- Grok: explicitly keeps the separate store, fail-closed schema handling, scope filters, transactional outbox, query-text TTL, and same-user socket caveat (`Grok.md:74-84`).

### 3. Exact-query cache-only semantic recall is not viable for normal prompts

This is the clearest technical consensus. The proposed cache key is exact query text, but interactive prompts are usually unique. `PrepareQuery` followed immediately by `Recall` is expected to lose a race, so a cache miss will usually return lexical results without semantic results.

- Claude Opus: predicts a near-zero realistic hit rate and recommends changing the go/no-go criterion (`Claude-Opus.md:30-37`).
- Fable: calls the failure predictable and says the alternative must be planned before Slice 3 (`Fable.md:58-68`).
- Gemini: says the design would effectively regress to FTS-only retrieval for interactive prompts (`Gemini.md:33-50`).
- Grok: says ambient recall is one unique prompt per turn and that repeated-query benchmarks would hide the regression (`Grok.md:22-43`).

The shared remedy is lexical fallback plus one of these options:

- bounded synchronous query embedding;
- an in-process local encoder;
- or an explicitly documented acceptance of a semantic-quality regression.

The models differ on the preferred option and timeout, but not on the problem. Suggested budgets range from roughly 30-50 ms (`Grok.md:34-41`) through 50-150 ms (`Claude-Opus.md:34-36`) and 50-120 ms (`Gemini.md:47-50`) to 150-300 ms (`Fable.md:62-68`).

### 4. JSON over a Unix socket deserves first-class treatment

No review accepts the current gRPC-first direction without qualification. Fable, Gemini, and Grok directly recommend elevating JSON/JSON-RPC/REST over a Unix socket; Claude Opus recommends a side-by-side JSON-versus-gRPC spike.

- Claude Opus: compare JSON-lines over a Unix socket and gRPC rather than treating JSON as only a fallback (`Claude-Opus.md:38-45`).
- Fable: flip the default to JSON over the socket and reserve protobuf for a measured need (`Fable.md:49-56`).
- Gemini: prefer JSON-RPC or REST over UDS for zero dependencies and easy debugging (`Gemini.md:54-64`).
- Grok: treat gRPC as a spike and start from the existing JSON-over-socket shape (`Grok.md:50-51`).

### 5. Memory-side embedding should be background work

The reviews agree that durable memory embedding belongs in the daemon's background work, with leases/reconciliation and status coverage rather than prompt-path blocking. Fable states this explicitly; Claude and Grok also reject making a full embedding queue reject an otherwise valid memory write (`Fable.md:64-68`, `Claude-Opus.md:46-49`, `Grok.md:45-48`).

The narrower consensus is: `Retain` should not fail merely because disposable derived embedding work is backpressured. The write and its intent should remain durable, while status reports the coverage gap.

## Where the models disagree

### 1. Rust now versus Node first

This is the main implementation disagreement.

**Gemini's position:** the Rust daemon is the right architectural bet now. Rust enables an in-process quantized embedding model and fast SIMD scoring (`Gemini.md:8-18`, `Gemini.md:47-50`).

**Claude Opus, Fable, and Grok's position:** prove the daemon independently of the language in Node, reusing the existing runtime and policy code. Rust should follow measurements, a static-binary requirement, or a demonstrated resource problem (`Claude-Opus.md:20-28`, `Fable.md:36-47`, `Grok.md:68-72`).

The practical reason for the Node-first majority view is policy-parity risk: copying scope and suppression rules into a second codebase creates another place for memory leaks and drift (`Claude-Opus.md:20-28`, `Fable.md:20-22`, `Grok.md:71-72`).

### 2. How to solve query embedding

The models agree that cache-only is inadequate, but propose different implementations:

- Claude Opus: allow bounded online query embedding against a warm provider, with lexical fallback (`Claude-Opus.md:30-37`).
- Fable: make bounded synchronous embedding the default, keep the provider warm, and retain an in-process encoder as a possible Rust justification (`Fable.md:62-68`, `Fable.md:44-47`).
- Gemini: prefer an in-process local encoder in Rust, with canonicalized query caching as an additional optimization (`Gemini.md:47-50`).
- Grok: use a short, configurable, fail-open provider budget, or choose an in-process encoder if zero provider I/O is required (`Grok.md:34-43`).

The unresolved product choice is therefore not whether to improve query recall, but whether the first proof should use bounded external/local-provider inference or make local inference part of the daemon.

### 3. In-memory vector cache versus paged SQLite reads

Gemini recommends loading a contiguous, scope-filtered vector buffer into memory so recall avoids reading and deserializing thousands of SQLite BLOBs (`Gemini.md:67-75`). Grok recommends the opposite operational trade-off: page vectors from SQLite and avoid heap-loading the corpus so the 100 MiB RSS target is not defeated (`Grok.md:65-66`).

This is a direct unresolved trade-off between query latency and memory footprint. It should be measured with the target corpus size and RSS budget rather than settled from synthetic cosine-scoring numbers alone.

### 4. Daemon lifecycle and startup behavior

The reviews agree that client ergonomics matter, but differ on the concrete lifecycle:

- Gemini proposes lazy auto-spawn, a short socket probe, up to 200 ms readiness wait, then fail-open behavior (`Gemini.md:78-90`).
- Fable prefers a client-spawned, idle-exiting daemon and argues that service managers can be removed from the proof (`Fable.md:81-83`).
- Grok wants a throwaway prompt-hook client in Slice 2 to exercise missing sockets, startup deadlines, and daemon death early (`Grok.md:53-54`).
- Claude Opus highlights the opposite risk: cold subprocess and gRPC setup may cost more than the daemon saves for shell-launched clients, so it calls for a spike (`Claude-Opus.md:38-45`).

These ideas are compatible at a high level, but the startup deadline, ownership of spawning, idle-exit policy, and service-manager scope still need one explicit contract.

### 5. How much of the plan should be front-loaded

Gemini considers the vertical slices and go/no-go gates a major strength (`Gemini.md:12-18`, `Gemini.md:22-27`). Claude Opus, Fable, and Grok all want an earlier, smaller proof or spike before the full hardening sequence:

- Claude Opus: run a quick Bun, cold-subprocess, and transport spike first (`Claude-Opus.md:38-45`).
- Fable: add a Slice 0 with a Node socket daemon, four operations, two clients, and real-prompt measurements (`Fable.md:70-79`).
- Grok: move a realistic prompt-hook client into Slice 2 and measure first unique prompts, not only repeated queries (`Grok.md:53-54`, `Grok.md:86-90`).

The useful synthesis is to keep Gemini's gates but place a small, executable boundary proof before the more expensive portability and hardening work.

## Distinctive or outlier ideas by reviewer

These are ideas that are especially characteristic of one review in this set. “Distinctive” does not mean the idea is wrong or that no other reviewer could support it.

### Claude Opus

- **Baseline v1 before setting v2 targets.** Add measured v1 problems and compare v2 against the actual lexical and semantic baselines rather than accepting a target that could be much slower than v1 (`Claude-Opus.md:10-18`).
- **Shared fixtures for v1 and v2.** Make `tests/v2/fixtures` a shared specification so policy behavior cannot quietly drift between implementations (`Claude-Opus.md:20-28`).
- **Bun and cold-subprocess validation.** The Pi/Bun path, shell-launched hooks, and startup/channel costs should be tested before committing to the transport or language (`Claude-Opus.md:38-45`).
- **Previous-turn query vectors.** Consider reusing the vector prepared on the previous turn for tool-initiated recalls (`Claude-Opus.md:34-36`).
- **Global-default leakage fixture.** Add a fixture for the observed case where standing directives from another project appeared in this repository's session, and tighten what qualifies as global (`Claude-Opus.md:46-50`).

### Fable

- **Add `Forget` to the executable proof.** The proof should exercise the real suppression write path rather than relying only on fixture-seeded suppression (`Fable.md:81-87`).
- **Client-spawned idle-exit as the process model.** Fable argues that a service manager, installer, and much of Slice 7 can be deferred or removed if clients spawn the daemon and it exits when idle (`Fable.md:81-83`).
- **Make Slice 0 concrete.** The proposed first slice includes Retain, Recall, Status, Forget, a warm provider, bounded query embedding, two clients, and real transcript latency measurements (`Fable.md:70-79`, `Fable.md:100-109`).
- **Durability and migration precision.** It calls out the exact meaning of `synchronous=FULL`, timestamp conversion from v1 ISO strings, repository identity mapping, and retired session evidence as specific migration/proof obligations (`Fable.md:89-98`).

### Gemini

- **In-process contiguous vector buffer.** Keep vectors in memory and score them without recurring SQLite BLOB reads, subject to validating the RSS cost (`Gemini.md:67-75`).
- **Query canonicalization.** Normalize whitespace, case, and trailing punctuation so the query cache is not limited to exact UTF-8 identity (`Gemini.md:47-50`).
- **Lazy auto-spawn protocol.** Define a concrete probe, spawn, readiness wait, and fail-open sequence for client adapters (`Gemini.md:78-90`).
- **Extraction as modular workers/plugins.** Keep volatile transcript parsing and extraction rules outside a monolithic Rust daemon, interacting through Retain/BatchRetain APIs (`Gemini.md:94-101`).
- **Explicit Rust-local-inference upside.** Gemini is the most positive about using Rust to run a quantized encoder in-process and quotes a low-millisecond CPU inference target (`Gemini.md:47-50`).

### Grok

- **Stable adapter-level client IDs.** `client_id` should be `pi`, `copilot`, `codex`, and so on, rather than a new identity for each process, so reconnect retries remain idempotent (`Grok.md:56-57`).
- **Short default socket paths.** Account for macOS `sockaddr_un` limits and provide an explicit socket override instead of assuming a long home or temporary path will work (`Grok.md:59-60`).
- **Operator-controlled model generation.** Require a configured `modelRevision` generation instead of trusting an endpoint's mutable `latest` tag for cache identity (`Grok.md:62-63`).
- **Do not heap-load the vector corpus.** Protect the RSS budget by paging from SQLite, directly opposing Gemini's in-memory vector-buffer proposal (`Grok.md:65-66`).
- **Dual-maintenance risk as a release concern.** Freeze non-critical v1 movement or document the cost of maintaining a moving v1 and an in-progress v2 through slices 4-7 (`Grok.md:68-72`).
- **Early failure-mode client.** Use a fake `UserPromptSubmit` client in Slice 2 to test missing sockets, startup deadlines, and mid-recall daemon death (`Grok.md:53-54`).

## Recommended combined direction

The reviews support this lowest-regret sequence:

1. Preserve the v2 safety boundary: separate store, no implicit migration, one writer, strict scope/suppression/expiry checks, bounded inputs, and fail-open prompt behavior where appropriate.
2. Build a small Node daemon proof around the existing server runtime and JSON over a Unix socket. Include Retain, Recall, Status, and Forget, with two clients and real prompt traces.
3. Make memory-side embedding fully background and durable. A full derived-data queue must affect coverage/status, not reject a valid Retain.
4. Replace cache-only query semantics with bounded query embedding plus lexical fallback, while retaining exact-query caching as an optimization. Measure cache hit rate on realistic prompts.
5. Test startup, Bun, cold subprocesses, missing sockets, daemon death, stable client IDs, path limits, and model-generation invalidation before freezing the protocol.
6. Decide whether Rust is justified by measured latency/RSS, a static-binary distribution requirement, or the value of in-daemon inference. If Rust is selected, port behind the frozen protocol and use shared behavioral fixtures to protect policy parity.

This preserves the broad architectural agreement while keeping the main disagreements measurable rather than implicit.

## Source index

- `Claude-Opus.md` — baseline measurements, Node-versus-Rust spike, cache behavior, Bun/cold-start risks, queue semantics, and global-scope leakage (`Claude-Opus.md:10-59`).
- `Fable.md` — Node-first daemon proposal, JSON transport, bounded query embedding, Slice 0, lifecycle simplification, and migration details (`Fable.md:7-111`).
- `Gemini.md` — Rust-forward architecture, in-process embeddings, vector cache, lazy auto-spawn, and modular extraction (`Gemini.md:8-114`).
- `Grok.md` — product-proof framing, bounded query embeddings, client contracts, resource limits, and dual-maintenance risks (`Grok.md:8-90`).
