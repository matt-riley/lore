# Summary of Lore v2 Model Opinions

**Sources:** `Astra.md`, `Claude-Opus.md`, `Fable.md`, `Gemini.md`, `GLM.md`, `Grok.md`, and `Kimi.md` in this directory.

**Review date:** 2026-09-14

**Citation format:** citations such as `Grok.md:24-43` identify the source file and relevant line range. Citations are intentionally plain text so this document is easy to grep.

## Executive summary

All seven reviews consider the v2 direction credible: a single per-user daemon should own the store and scheduler, move memory-side background work away from prompt handling, and preserve repository isolation, suppression, expiry, manual authority, idempotency, and honest socket trust boundaries. (`Astra.md:11-26`, `Claude-Opus.md:8-18`, `Fable.md:7-14`, `Gemini.md:8-27`, `GLM.md:9-19`, `Grok.md:8-20`, `Kimi.md:7-23`)

The sharpest shared warning is Slice 3's exact-query, cache-only vector path. Exact prompt repeats are rare and `PrepareQuery` followed immediately by `Recall` usually loses the race, so semantic retrieval could become lexical-only for normal interactive use. Six reviews explicitly recommend changing or pre-planning an alternative; Kimi is the important nuance, calling cache-only the best proof extreme while still requesting recurrence instrumentation and a fallback decision. (`Astra.md:30-50`, `Claude-Opus.md:30-37`, `Fable.md:58-68`, `Gemini.md:33-50`, `GLM.md:78-112`, `Grok.md:22-43`, `Kimi.md:15-17`, `Kimi.md:33-39`)

The main implementation disagreement is Rust timing. Gemini is Rust-forward and sees in-process inference as a major benefit. Claude Opus, Fable, GLM, and Grok want the daemon boundary proven in Node first; Astra says Rust is reasonable but unproven, while Kimi approves slices 1–3 without making language the central issue. (`Gemini.md:8-18`, `Gemini.md:47-50`, `Claude-Opus.md:20-28`, `Fable.md:38-47`, `GLM.md:114-136`, `Grok.md:68-72`, `Astra.md:11-15`, `Kimi.md:5-9`)

## Where the models agree

### 1. The daemon boundary is the right architectural bet

The reviews consistently support one long-lived per-user process with one authoritative store writer, shared scheduling, and background work. They connect this to v1's independent client processes, SQLite contention, prompt-path embedding, and lack of a shared scheduler.

- Astra supports one authoritative writer, a separate v2 store, and a small proof API (`Astra.md:17-28`).
- Claude Opus says the safety thinking is sound and identifies the missing shared background worker as a v1 problem (`Claude-Opus.md:8-18`).
- Fable says the architectural bet is right because a single process removes the structural source of the latency and contention (`Fable.md:7-20`).
- Gemini identifies the clean process boundary and decoupled heavy work as core strengths (`Gemini.md:22-27`).
- GLM says slices 1–3 should prove the shared scheduler/store architecture (`GLM.md:7-19`).
- Grok frames one writer owning memory, suppression, and jobs as the central thing to prove (`Grok.md:10-20`).
- Kimi endorses the per-user daemon, durable background work, and disciplined proof gates (`Kimi.md:7-19`).

### 2. Safety and coexistence rules are load-bearing

All seven treat safety semantics as acceptance criteria rather than optional features. The shared protected set is: separate v2 state, no implicit migration or fallback writes, repository scoping, suppression/supersession/expiry before and after ranking, manual-memory authority, durable idempotency, bounded input, and an honest same-user Unix-socket trust boundary.

- Astra emphasizes policy enforcement on every retrieval path and explicit migration (`Astra.md:19-26`).
- Claude Opus says to keep the safety contracts and add fixtures for a possible global-scope leak (`Claude-Opus.md:46-59`).
- Fable lists separate storage, filtering, manual authority, idempotency, byte budgets, TTLs, and the no-TCP boundary as decisions to keep (`Fable.md:24-35`).
- Gemini names repository isolation, manual precedence, suppression, expiry, and v1-store isolation as strengths (`Gemini.md:22-27`).
- GLM specifically defends no automatic v1 writes, idempotent Retain, embedding identity, bounded messages, durability, and suppression (`GLM.md:21-46`).
- Grok keeps the separate store, fail-closed schema handling, policy filters, transactional outbox, query-text TTL, and same-user trust caveat (`Grok.md:74-84`).
- Kimi praises the safety invariants, trust-boundary honesty, and disciplined v1 coexistence policy (`Kimi.md:17-23`).

### 3. The proof must measure quality as well as latency

The models agree with the staged go/no-go approach, but repeatedly ask for realistic prompt traces, v1 comparisons, explicit quality metrics, and failure-path evidence before committing to later extraction, migration, or parity work. (`Astra.md:38-50`, `Claude-Opus.md:10-18`, `Fable.md:70-79`, `Gemini.md:12-18`, `GLM.md:90-112`, `Grok.md:86-90`, `Kimi.md:27-39`)

The common measurement principle is: do not let a relaxed p95 target or repeated-query benchmark make a degraded retrieval system look successful. Compare cold and warm behavior, realistic unique prompts, provider failure/latency, policy outcomes, and a measured v1 baseline.

### 4. Exact-query cache-only recall is a central product risk

The proposed exact UTF-8 query cache is useful as an experiment or optimization, but the reviews agree that `PrepareQuery` cannot be assumed to make semantic results available for the prompt immediately following it. The proposed remedies all preserve lexical fail-open behavior:

- bounded synchronous query embedding;
- a local/in-process query encoder;
- more realistic cache instrumentation and an explicit acceptance of any quality regression if neither is chosen.

The suggested budgets vary substantially: Grok suggests roughly 30–50 ms, Claude Opus 50–150 ms, Gemini 50–120 ms, and Fable 150–300 ms. (`Grok.md:34-43`, `Claude-Opus.md:30-37`, `Gemini.md:47-50`, `Fable.md:62-68`)

Kimi is the outlier in framing, not in risk detection: it calls the cache-only decision “brave” and appropriate for protecting the prompt path, but also says exact-query recurrence must be measured before relying on it. (`Kimi.md:13-17`, `Kimi.md:33-39`)

### 5. JSON over a Unix socket deserves a serious comparison with gRPC

Fable, Gemini, and Grok directly recommend making JSON/JSON-RPC/REST over Unix sockets first-class. Claude Opus asks for a side-by-side spike; GLM says dependency and debugging cost across all five clients must be an ADR criterion; Astra retains HTTP/JSON as the documented alternative. (`Fable.md:49-56`, `Gemini.md:54-64`, `Grok.md:50-51`, `Claude-Opus.md:38-45`, `GLM.md:150-161`, `Astra.md:52-64`)

The shared reasons are zero or low client dependency cost, compatibility with the existing JSON-lines worker, human-debuggability, and avoiding code-generation overhead before a measured need exists.

### 6. Derived embedding work should not make authoritative memory hostage to backlog

A strong majority rejects coupling a full disposable embedding queue to failure of an otherwise valid `Retain`. Their common direction is to commit the authoritative memory and durable embedding intent, expose degraded coverage in `Status`, and let reconciliation recover derived work. (`Astra.md:102-110`, `Claude-Opus.md:46-49`, `GLM.md:48-76`, `Grok.md:45-48`, `Kimi.md:47-51`)

Kimi proposes evicting the oldest retryable jobs by priority; Astra prefers a durable per-memory “needs embedding” state; GLM, Claude Opus, and Grok favor acknowledging the memory while reporting the coverage gap. These are variations on the same authority principle.

## Where the models disagree

### 1. Rust now versus Node first

**Gemini:** keep Rust as the core implementation and use it for an in-process quantized encoder, SIMD scoring, and a high-performance daemon (`Gemini.md:8-18`, `Gemini.md:47-50`, `Gemini.md:67-75`).

**Claude Opus, Fable, GLM, and Grok:** prove the daemon independently in Node, reusing the existing policy and worker code, then choose Rust only if measurements, a static-binary distribution goal, or a demonstrated resource constraint justifies the second implementation (`Claude-Opus.md:20-28`, `Fable.md:38-47`, `GLM.md:114-136`, `Grok.md:68-72`).

**Astra:** treats Rust as reasonable but not demonstrated, and asks the plan to separate the daemon, language, and transport decisions (`Astra.md:11-15`, `Astra.md:52-64`). **Kimi** approves the proof slices as written without making a competing language recommendation (`Kimi.md:5-9`).

The Node-first position is mainly about policy-parity and maintenance risk: suppression, expiry, repository identity, and eligibility would otherwise exist in a second implementation (`Claude-Opus.md:20-28`, `Fable.md:20-22`, `GLM.md:120-136`, `Grok.md:71-72`).

### 2. How to repair query embedding

The models agree on the problem but not the first implementation:

- Claude Opus prefers bounded online embedding against a warm provider with lexical fallback (`Claude-Opus.md:30-37`).
- Fable makes bounded synchronous embedding the default and recommends keeping the provider warm (`Fable.md:62-68`).
- Gemini prefers an in-process Rust encoder, with query canonicalization as a cache optimization (`Gemini.md:47-50`).
- GLM wants the quality metric and fallback ADR frozen before Rust is written, with either bounded cancellable online embedding or a local encoder (`GLM.md:90-112`).
- Grok allows a short configurable provider budget, but says a local encoder is the alternative if Recall must never perform provider I/O (`Grok.md:34-43`).
- Astra prefers keeping `PrepareQuery` experimental until realistic replay shows it useful, then reviewing bounded online embedding if needed (`Astra.md:38-50`).
- Kimi retains cache-only as the proof posture but asks for recurrence measurement before treating it as a production-quality decision (`Kimi.md:33-45`).

The unresolved product choice is therefore bounded external/local inference versus local inference built into the daemon, with cache-only remaining either a deliberately measured proof extreme or an explicitly accepted quality trade-off.

### 3. In-memory vectors versus paged SQLite reads

Gemini recommends a contiguous, scope-filtered in-memory vector buffer to avoid reading thousands of SQLite BLOBs on every query (`Gemini.md:67-75`). Grok recommends paging vectors from SQLite to protect the 100 MiB RSS target and avoid heap-loading the corpus (`Grok.md:65-66`). Kimi adds a related concern: measure foreground `Retain` latency during vector commits (`Kimi.md:63-67`).

This is a direct latency-versus-memory trade-off. It should be settled with the target corpus, dimensions, I/O behavior, and RSS budget rather than the cosine-scoring cost alone.

### 4. Daemon startup and lifecycle

The reviews agree that client ergonomics and fail-open behavior matter, but differ on the contract:

- Gemini proposes a socket probe, lazy auto-spawn, a 200 ms readiness wait, then fail-open (`Gemini.md:78-90`).
- Fable proposes a client-spawned, idle-exiting daemon and argues that service-manager work can be removed from the proof (`Fable.md:81-83`).
- Grok wants a fake prompt-hook client early, covering missing sockets, deadlines, and daemon death (`Grok.md:53-54`).
- Claude Opus warns that cold CLI subprocess and gRPC setup could erase the daemon's gains and asks for a spike (`Claude-Opus.md:38-45`).

These can be combined, but startup ownership, readiness budget, idle exit, and formal service-manager scope still need one explicit contract.

### 5. How much to front-load before the first useful proof

Gemini views the vertical slices and gates as major strengths. Claude Opus wants a quick Bun, cold-subprocess, and transport spike; Fable proposes a concrete Slice 0; Grok wants a realistic prompt-hook client moved earlier. Astra keeps the seven-slice structure but adds experiments and contract work before proceeding beyond Slice 3. Kimi approves Slices 1–3 as written. (`Gemini.md:12-18`, `Claude-Opus.md:38-45`, `Fable.md:70-79`, `Grok.md:53-54`, `Astra.md:164-177`, `Kimi.md:5-9`)

The practical synthesis is to preserve the gates while running a small executable boundary proof before expensive portability and hardening work.

## Distinctive or outlier ideas by reviewer

“Distinctive” means especially characteristic of one review in this set; it does not mean the idea is necessarily unsupported elsewhere.

### Astra

- **Response-budget arithmetic:** 20 valid 64 KiB memories already exceed the 1 MiB response cap, so structured-response and rendering budgets need separate, explicit rules (`Astra.md:66-82`).
- **Executable deletion/restoration semantics:** test that backup restore, re-extraction, deliberate manual re-save, and uncertain Retain retries cannot resurrect forgotten data incorrectly (`Astra.md:84-100`).
- **Lease fencing and provider-state recovery:** use claim generations/tokens, define terminal-failure recovery, avoid reconciliation retry loops, and pause provider-wide failures as shared state (`Astra.md:112-124`).
- **Lower-layer bounds and identity:** bound decoded vector memory, database work, cancellation, WAL growth, capacity fairness, coherent snapshots, and socket-to-store identity (`Astra.md:126-151`).

### Claude Opus

- **Measured v1 baseline:** plain lexical recall is cited at about 1.1 ms p95 for 10k prompts, so v2's 100 ms target could pass while being much slower than v1 (`Claude-Opus.md:10-18`).
- **Shared behavioral fixtures:** run the same `tests/v2/fixtures` specification against v1 and v2 to prevent policy drift (`Claude-Opus.md:20-28`).
- **Bun and cold-subprocess risk:** test Pi under Bun and shell-launched Claude Code/Codex hooks before assuming a daemon or gRPC saves time (`Claude-Opus.md:38-45`).
- **Global-default leakage fixture and previous-turn vectors:** test cross-repository standing-directive leakage and consider using a prior-turn vector for tool-initiated recalls (`Claude-Opus.md:34-36`, `Claude-Opus.md:46-50`).

### Fable

- **Concrete Slice 0:** start with a Node socket daemon, JSON-lines, Retain/Recall/Status/Forget, two clients, a warm provider, and real-prompt latency measurements (`Fable.md:70-79`, `Fable.md:100-109`).
- **Client-spawned idle exit:** use the already-working Pi process model to avoid making service management and installers prerequisites for the proof (`Fable.md:81-83`).
- **Add Forget to the proof:** exercise the real suppression write path instead of relying only on fixture-seeded suppression (`Fable.md:85-87`).
- **Migration precision:** call out `synchronous=FULL`, timestamp conversion, legacy repository identity mapping, and retired session evidence as explicit obligations (`Fable.md:89-98`).

### Gemini

- **In-memory contiguous vector buffer:** keep scope-filtered vectors in `lored` and score without recurring SQLite BLOB reads (`Gemini.md:67-75`).
- **Query canonicalization:** normalize whitespace, case, and trailing punctuation to make cache reuse less brittle (`Gemini.md:47-50`).
- **Lazy auto-spawn protocol:** specify probe, spawn, readiness wait, and fail-open behavior in the client contract (`Gemini.md:78-90`).
- **Modular extraction workers/plugins:** keep volatile transcript parsing and extraction rules outside a monolithic Rust daemon, using Retain/BatchRetain APIs (`Gemini.md:94-101`).
- **Rust-local-inference upside:** uniquely emphasizes a quantized in-process encoder and a low-millisecond CPU inference target as a reason to choose Rust (`Gemini.md:47-50`).

### GLM

- **Named retrieval-quality metric:** use `recall@k` / MRR on `tests/fixtures/reliability-corpus.mjs`, comparing lexical-only and warm fusion before deciding that cache-only quality is unacceptable (`GLM.md:90-112`).
- **Pre-rewrite v1 prefetch experiment:** add prompt-time query-vector prefetch to the existing Node worker to measure the real `PrepareQuery` hit rate before freezing v2 semantics (`GLM.md:106-112`).
- **Hybrid language option:** consider a Rust transport/shell with policy logic ported fixture-by-fixture from v1 tests (`GLM.md:114-130`).
- **Contract details for grep-stable behavior:** enumerate Status reason codes, make read-your-writes explicit, and list bundled FTS5 and `synchronous=FULL` requirements (`GLM.md:163-180`).

### Grok

- **Adapter-level client IDs:** use stable IDs such as `pi` and `codex`, not process-instance IDs, so reconnect retries remain idempotent (`Grok.md:56-57`).
- **Short socket paths and operator model generations:** account for macOS `sockaddr_un` limits and require an explicit configured model revision rather than trusting a mutable `latest` tag (`Grok.md:59-63`).
- **RSS-conscious vector paging:** page from SQLite instead of heap-loading the corpus, directly opposing Gemini's in-memory-buffer proposal (`Grok.md:65-66`).
- **Dual-maintenance release risk:** freeze non-critical v1 movement or explicitly budget for a long period of v1/v2 maintenance (`Grok.md:68-72`).
- **Early failure-mode client:** exercise missing sockets, startup deadlines, and mid-recall daemon death with a throwaway `UserPromptSubmit` client (`Grok.md:53-54`).

### Kimi

- **Cache-only as a deliberate proof extreme:** unlike the other reviews, Kimi calls the strict cache-only decision the bravest and best call, while still requiring exact-query recurrence measurement before relying on it (`Kimi.md:13-17`, `Kimi.md:33-39`).
- **Memory-only query-text encryption:** consider a daemon-generated in-memory key so optional query jobs cannot leave plaintext prompts at rest across restarts (`Kimi.md:41-45`).
- **Priority eviction for derived jobs:** when the queue is full, obsolete the oldest retryable memory jobs instead of rejecting authoritative Retain (`Kimi.md:47-51`).
- **Targeted contention tests:** sweep the read-pool size and measure Retain latency during vector commits, not only Recall during provider slowness (`Kimi.md:53-67`).
- **Backup permissions:** ensure database backups inherit the socket/database sensitivity rules (`Kimi.md:69-75`).

## Lowest-regret synthesis

The combined evidence supports this sequence:

1. Preserve the safety boundary: separate store, no implicit migration or fallback writes, one writer, policy checks before and after ranking, bounded inputs, and honest fail-open behavior.
2. Run a small Node daemon proof over JSON on a Unix socket, with Retain, Recall, Status, and Forget, two clients, real prompt traces, and a v1 baseline.
3. Keep memory-side embedding durable and background; queue pressure should degrade coverage/status rather than silently lose intent or block valid manual saves.
4. Treat exact-query caching as an experiment/optimization. Measure realistic recurrence and retrieval quality, and pre-agree the bounded-inference or local-encoder fallback.
5. Test Bun, cold subprocesses, startup/death behavior, stable client IDs, response limits, repository identity, deletion semantics, model generations, and worker recovery before adapter rollout.
6. Decide Rust from measured latency/RSS, static-binary distribution needs, or the value of in-daemon inference. If selected, port behind the frozen protocol and protect policy parity with shared fixtures.

This preserves the broad agreement while turning the remaining disagreements into explicit, measurable decisions.

## Source index

- `Astra.md` — retrieval-quality gates, response/idempotency contracts, deletion and identity fixtures, worker recovery, resource bounds, and consistency (`Astra.md:30-177`).
- `Claude-Opus.md` — v1 baseline, Node-versus-Rust and transport spikes, cache behavior, Bun/cold-start risks, queue semantics, and global-scope leakage (`Claude-Opus.md:10-59`).
- `Fable.md` — Node-first daemon, JSON transport, bounded query embedding, Slice 0, lifecycle simplification, Forget, and migration details (`Fable.md:7-111`).
- `Gemini.md` — Rust-forward architecture, in-process embeddings, vector cache, lazy auto-spawn, and modular extraction (`Gemini.md:8-114`).
- `GLM.md` — queue decoupling, retrieval metrics, language ADR, v1 baseline, transport cost, and contract details (`GLM.md:7-199`).
- `Grok.md` — product-proof framing, bounded query embedding, client contracts, resource limits, and dual-maintenance risks (`Grok.md:8-90`).
- `Kimi.md` — proof-gate discipline, cache-only defense plus timing concern, query privacy, queue eviction, pool sizing, and write contention (`Kimi.md:7-79`).
