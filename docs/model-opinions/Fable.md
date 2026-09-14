# Fable review of the v2 daemon plan

Reviewer: Claude Fable 5.1. Date: 2026-09-14. Scope: `docs/v2/*` at commit `a38db6b`, cross-checked against the current v1 code on branch `v2`.

## Verdict

The architectural bet is right. The implementation bet is over-specified and, in two places, aimed at the wrong target.

- **Right:** one long-lived per-user process that owns the SQLite store, keeps embedding and ingestion off the prompt path, and serves every agent host through a socket. v1's pain points all trace back to the absence of exactly that process.
- **Over-specified:** slices 1 and 2 read as a production daemon's hardening checklist, not a go/no-go proof. The roadmap says "prove each slice before starting the next", but slice 1 alone front-loads ADRs, codegen drift checks, two-OS CI, XDG runtime directories, symlink refusals, and licence audits before a single recall has been served.
- **Wrong target, part 1:** Rust is presented as the vehicle but the doc itself concedes Rust cannot remove inference latency, and nothing in v1 is CPU-bound in JavaScript. The latency problem is structural, and a Node daemon fixes it with the code you already have.
- **Wrong target, part 2:** slice 3's strict cache-only query vectors will make semantic recall effectively never fire on real prompts. This is predictable now, not something to discover at the slice-3 review.

Recommendation in one line: build the daemon boundary first in Node, on the JSON-lines protocol you already ship, fix the query-embedding path, measure, and only then decide whether Rust earns its second codebase.

## What v1 actually does today (evidence for the above)

- `lib/memory/semantic-search.mjs` calls `requestLocalInferenceEmbeddings` for the query **synchronously on the prompt path**, with a default deadline of 10 s. `lore-pi.ts` awaits that in `before_agent_start`. That is the latency the user feels, and it is caused by a cold provider plus a generous deadline, not by JavaScript.
- Every CLI hook client (Copilot, Codex, Claude Code, Antigravity) runs `node lore-cli.mjs` per hook via `lib/clients/setup.mjs`. Each invocation opens SQLite from scratch. A daemon removes that entirely, regardless of language.
- `lore-server.mjs` plus `lib/clients/pi-server-client.mjs` is already a client-spawned, JSON-lines, request-ordered DB worker with restart handling. It exists because Pi runs on Bun and Bun lacks `node:sqlite`. That is 90% of a daemon; it just talks over stdio to one parent instead of a socket for many.
- `lib/db/db-retrieval-policy.mjs` is 195 lines of subtle eligibility SQL: canonical fingerprints, evidence fingerprints, retired session evidence, legacy repository identity mapping, manual-source allowlists. Porting it is where the memory-safety risk concentrates. The plan correctly says "read before porting"; it under-weights how much of slice 5 is this.
- `lib/` is about 41k lines and `tests/` about 35k. Slice 5 (extraction parity) is the majority of the port and the part where Rust has the least to offer.

## Keep (these are the good decisions)

- Separate v2 store, opt-in process, v1 untouched, no automatic fallback writes to v1. Correct and non-negotiable.
- Suppression, supersession, and expiry filtering before ranking and again before render. Matches the existing `isSemanticMemoryRowEligible` contract.
- Manual authority never lowered by background workers.
- Idempotency keys on Retain, timeout is not rollback, retry-same-key is the recovery mechanism.
- Byte budgets, not token claims. Reject oversized input rather than truncate.
- Status never starts a model or scans vectors. "Zero jobs is not proof of full import." Progress distinguishes skipped, queued, processing, complete.
- Embedding validity keyed on provider, model, revision, dimensions, content hash, preprocessing version. v1's `validatedCachedEmbeddingVector` already does most of this; reuse the scheme.
- Query text retention bounded by a TTL, hashed afterwards, WAL caveat documented.
- No TCP, same-user socket trust boundary stated honestly.

## Change

### 1. Language: Node daemon first, Rust only on evidence

The README says "Rust may reduce runtime overhead, but cannot remove model inference latency. Measure these gains rather than assuming them." Take that sentence seriously: it argues against choosing Rust before measuring.

Concretely:

- Promote `lore-server-runtime.mjs` to `lored`: bind a Unix socket instead of stdio, accept many connections, keep the existing promise-queue write ordering, add a read path that does not queue behind writes. `lib/` is reused untouched, including all policy SQL and 35k lines of tests.
- This honours the recorded preference for Node built-ins in runtime work (`node:net`, `node:sqlite`).
- Rust becomes justified if one of these is measured or decided: (a) the Node daemon itself is the bottleneck under four clients and 10k memories (I would bet against this), or (b) you want a single static binary so Bun hosts and CLI hooks do not need system Node 24. Reason (b) is real and worth stating in the README as the actual motivation if it is one. Right now the README implies performance, and the doc's own hedges undercut that.
- If Rust does happen, the one place it offers something Node cannot easily do is in-process embedding via `candle` or `ort`. That directly solves the query-embedding problem in change 3 below. If that is the plan, say so; it changes the whole calculus for slice 3.

### 2. Transport: JSON over the socket, protobuf only when measured

gRPC/tonic on the server plus `@grpc/grpc-js` and codegen in every client is a lot of surface for three RPCs. Two practical problems:

- The Pi adapter runs under Bun. Whether `@grpc/grpc-js` behaves under Bun over a Unix socket is exactly the kind of "interoperability spike" the plan already fears. JSON-lines over `node:net` or Bun's socket API needs no dependency.
- CLI hook clients are shell-launched processes; a JSON request over a socket is trivial from any runtime.

The plan already says "if the spike fails, evaluate HTTP/JSON". Flip the default. Keep everything else in the RPC contract section (request IDs, client IDs, caps, error categories, additive evolution) and express the schema as JSON Schema, which the repo already has tooling for (`schemas/`, `npm run validate-schema`). Reserve protobuf for when a measured payload or latency problem exists.

### 3. Slice 3: cache-only query vectors will not work for real prompts

The design keys the query cache on exact UTF-8 bytes plus scope plus model. Real prompts are almost never byte-identical, so the hit rate will round to zero, and vector recall will effectively only work on a repeated prompt. The PrepareQuery-then-Recall dance the doc suggests is a race the client loses every time because Recall follows immediately.

The doc says "if unacceptable, stop and review alternatives." I am saying it is unacceptable now, so plan the alternative now:

- Make **bounded synchronous query embedding** the slice-3 default: a hard deadline in the 150–300 ms range with lexical-only fallback, reported in diagnostics. This is what v1 already does, just with a 10 s deadline and a cold provider.
- The daemon is long-lived, so it can keep the provider warm (periodic tiny request, or at least a warm HTTP connection). Cold start is the dominant cause of v1's slowness; a warm local embedding call for one short query is typically tens of milliseconds.
- Rewrite proof gate 3 from "no provider request attributable to a Recall RPC" to "Recall never waits more than N ms on inference and never blocks on backlog". The current wording forbids the only design that will give first-prompt semantic results.
- Keep the exact-query cache as an optimisation on top, and keep PrepareQuery if an adapter has an earlier hook where the prompt text is known. Most do not.
- Memory-side embedding stays fully background and durable exactly as slice 3 specifies. That part is right.

### 4. Cut the proof down to a proof

Suggested slice 0, a week or less, before any of slices 1–3:

- Node daemon from `lore-server-runtime.mjs`, Unix socket, JSON-lines, client-spawned, idle-exit.
- Retain, Recall (lexical plus bounded query embedding), Status, Forget.
- Two clients, one daemon, committed writes visible across clients.
- Measure p95 and p99 recall with a warm provider versus v1 in-process on your machine, with real prompts from your own transcripts, not only synthetic ones.

Then hold the review the roadmap describes. Most of what slices 1–3 specify (failpoints, symlink checks, XDG, histograms, MSRV pinning) belongs after the boundary is proven, not before.

### 5. Process model: client-spawned, idle-exit, no service manager

Slice 7 plans launchd/systemd units, installers, rollback drills, and version-skew handling. The existing Pi server model is simpler and already works: the client spawns the daemon if the socket is absent, the daemon holds the store lock, and it exits after an idle timeout. Version skew is solved by the client checking Status and, on mismatch, asking the old daemon to drain and exit. This removes most of slice 7 and all of the installer surface. The exclusive store lock and stale-socket rules in slice 1 are still needed and are correctly specified.

### 6. Add Forget to the proof

Proof gate 5 requires that forgotten memories never escape, but the RPC set is Status, Retain, Recall. Suppression can only be seeded by fixtures. Forget is the memory-safety operation users actually exercise; it is small; it should be in slice 2. Otherwise the proof cannot show that a suppression written through the real path is honoured by lexical, cached-query, and vector reads.

## Smaller notes

- **`synchronous=FULL`:** defensible, but be accurate about what it defends. Process crash durability is already covered by WAL with `NORMAL`. `FULL` adds an fsync per commit to defend against power loss and OS crash. If the crash tests are process kills, `NORMAL` passes them. Choose knowingly.
- **Timestamps:** epoch milliseconds in the protocol is fine for a fresh store, but v1 stores ISO strings and uses `julianday()` in policy SQL. Slice 5 migration must convert, and policy fixtures should include expiry boundaries at millisecond precision.
- **Idempotency quota:** "enforce a configurable store quota" needs a stated behaviour at the limit. Presumably Retain returns `RESOURCE_EXHAUSTED`. Say so.
- **Repository identity mapping:** v1's eligibility SQL admits legacy repository identifiers via `repository_identity_mapping`. The proof drops this, which is fine for a fresh store, but it must come back in slice 5 or migrated repo-scoped memories become invisible.
- **Evidence retirement:** v1 hides auto-extracted memories whose session evidence has been retired. Not needed for manual-only writes in the proof. It is a slice-5 requirement and should be listed there explicitly.
- **Read pool of four:** fine. One write executor plus a small read pool is the right shape whether the daemon is Node worker threads or Rust.
- **Two-OS CI with cargo:** add caching from day one or CI time will balloon. Not a blocker.
- **Two codebases:** for a solo-maintained project, the honest cost of Rust is that every policy change lands twice until v1 is retired, and v1 retirement is slice 7. Budget for that period being long.

## Suggested revised sequence

| Step | What | Language | Decision it unlocks |
| --- | --- | --- | --- |
| 0 | Socket daemon from existing server runtime, idle-exit, Retain/Recall/Status/Forget, warm provider, bounded query embedding, two-client test, real-prompt latency measurement | Node | Is the daemon boundary enough on its own? |
| 1 | Freeze JSON protocol, client IDs, caps, error categories, additive rules | Node | Adapters can be written once |
| 2 | Durable background memory embedding queue with leases, obsolete detection, Status coverage counts | Node | Does semantic recall stay fresh without prompt cost? |
| 3 | Thin adapters on the socket: Pi first, then CLI hooks stop spawning node per call | Node | Real-world latency and reliability data |
| 4 | Decide Rust, based on measurements or a stated distribution goal. If yes, port the daemon behind the frozen protocol; adapters do not change | Rust | Single binary, in-daemon embedding via candle/ort |
| 5+ | Ingestion, extraction parity, migration, retirement, as currently outlined | either | As per plan |

This keeps every safety property in the current plan, reaches a usable daemon far sooner, and turns the Rust question from an assumption into a measured decision, which is what the README asks for.
