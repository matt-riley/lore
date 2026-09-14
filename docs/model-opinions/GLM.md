# GLM opinion on the v2 daemon rewrite plan

Reviewed: `docs/v2/` (README + slices 1–4) against the current v1 code
(`lib/memory/semantic-search.mjs`, `lib/context/recall-assembler.mjs`,
`lib/db/db-retrieval-policy.mjs`, `lib/server/lore-server-runtime.mjs`).

## Verdict

Good idea, and unusually well-disciplined for a rewrite plan. Approve slices 1–3
as a proof, with two substantive changes (Retain/backpressure coupling and the
PrepareQuery hit-rate problem) and three process changes (language ADR, v1
baseline, retrieval-quality metric) that should land before implementation
starts.

The plan's best property is that it is honest with itself: acceptance targets
are labeled provisional, Rust's benefit is explicitly unproven, the socket trust
boundary is stated as "same-user processes, no finer," and the slice-3 tradeoff
is presented as a tradeoff rather than sold as a win. That tone is the reason I
trust the plan. Keep it.

## What the plan gets right (do not touch)

- **No automatic v1 fallback writes.** Banning dual-authoritative stores in the
  README constraints kills the single most common rewrite failure mode. This
  constraint is worth more than any line of code in the plan.
- **Idempotent Retain.** Idempotency keys namespaced by client, normalized
  request hash, `ALREADY_EXISTS` on payload mismatch, "a timeout is not evidence
  of rollback, retry the same key." This is the correct distributed-writes
  posture and most personal projects never get it right.
- **Embedding validity identity.** Endpoint + model ID + model generation +
  dimensions + preprocessing version, with an explicit rejection of mutable
  `latest` tags as proof of model identity. This is a real-world footgun that
  silently corrupts vector caches; catching it in the contract phase is cheap.
- **Cache-only Recall as a proof extreme.** Making the strictest possible
  posture ("zero provider requests attributable to Recall") the slice-3 default,
  then gating on measured quality, is the right way to run the experiment. My
  concern below is about what comes after the gate, not the gate itself.
- **Reject, never truncate.** Byte budgets, oversized-message tests, and
  "bounded work with reported truncation" instead of silent limits.
- **Durability over exit codes.** Failpoint tests before/after commit, restart
  visibility through an independent connection, "never report success after a
  failed commit." Process-exited-0 is not a durability test and the plan says so.
- **Suppression cannot be forgotten.** "Their omission from the public proof API
  is not permission to ignore them during reads" — this is the exact sentence
  that separates a rewrite that preserves memory-safety semantics from one that
  quietly leaks forgotten content years later.

## Change 1: decouple Retain from embedding backlog (Slice 3)

Slice 3 says: when the outstanding memory-job queue hits 10,000, reject Retain
atomically with `RESOURCE_EXHAUSTED`. I think this inverts the plan's own
authority model. The plan correctly declares embeddings "disposable derived
data" and memories authoritative — but this rule makes the authoritative write
fail because derived work is behind. Concrete failure: provider is offline or
rate-limited for two days, backlog crosses the cap, and the user's agent can no
longer save a preference. That is a trust-destroying UX cliff in exchange for
bounding a resource that is nearly free: memory job rows carry no text payload
(a target ID, revision, and model identity — tens of bytes), and the plan
already has a bounded periodic reconciliation scan that exists precisely to
repair missed coverage.

Suggested remedy:

- Retain always commits the memory and its intent, even when the queue is at
  capacity. Acknowledge with `embedding_status: queued`.
- On queue overflow, pause *optional* work first (query preparation is already
  separately capped), surface degraded coverage in Status, and emit a metric.
  Keep the reconciliation scan as the correctness backstop.
- Reserve `RESOURCE_EXHAUSTED` for genuinely unrecoverable store conditions:
  disk-full, idempotency-store quota, real resource exhaustion.
- If a hard cap is still wanted, make it an alarm threshold (Status `degraded`
  + observability), not a write-rejection threshold.

This keeps every property the plan is protecting — no acknowledged write with
silently lost intent, bounded resources — without making user data hostage to
embedding progress.

## Change 2: acknowledge that PrepareQuery almost never hits (Slice 3)

Prompt-time recall means the query is the user's brand-new prompt. The flow the
plan describes — "call PrepareQuery when a completed prompt is submitted, then
Recall immediately" — is structurally a cache miss every time: the background
worker has not run yet, and partial-keystroke preparation is correctly banned.
So under strict cache-only semantics, vector recall in production fires
approximately never (only identical repeated queries). Slice 3 is honest about
first-query lexical-only behavior, but the plan as written builds the entire
query-vector pipeline for a path with a ~0% production hit rate, then discovers
the quality problem at the go/no-go.

Two suggestions:

1. **Define "unacceptable" now.** Before any Rust is written, freeze the
   retrieval-quality yardstick: recall@k / MRR on `tests/fixtures/
   reliability-corpus.mjs`, measured lexical-only vs. warm fusion. The slice-3
   gate should name the metric and the delta that triggers the fallback review,
   so the decision is data, not vibes.
2. **Pre-commit the fallback postures in the slice-3 ADR.** If first-query
   quality is materially worse (I expect it will be), the plan already names the
   two sane options: bounded online query embedding with a hard deadline smaller
   than v1's current deadline (cancellable, fail-open to lexical), or a local
   lightweight query encoder. Write the ADR now with the decision framework and
   the amended gate: "zero *unbounded* provider requests attributable to
   Recall" instead of zero requests, if bounded online embedding is adopted.
   Otherwise the current gate quietly kills semantic recall permanently.

Cheap de-risk before slice 1: v1 already has a background worker protocol
(`lore-server-runtime.mjs`) and caches memory vectors. A prompt-time
query-vector prefetch in the existing Node worker is the same shape as
PrepareQuery, implementable today in v1, and would measure the real
prefetch-beats-recall hit rate and quality delta before the rewrite commits to
cache-only semantics. If that experiment shows material gains, slice 3's design
conversation happens with evidence.

## Change 3: put the language choice in the Slice 1 ADR

Rust is proposed, not decided. The ADR currently covers transport, process
ownership, and storage separation — add "daemon language" as an explicit
criterion with at least these candidates:

- **Node daemon.** Reuses `lib/db`, `db-retrieval-policy`, the recall assembler,
  and the worker protocol wholesale. Same architectural gains (single scheduler,
  shared store, precomputed retrieval, multi-client serving). Far less porting
  risk on the policy surface.
- **Rust daemon.** Gains: single static binary for slice-7 distribution, tight
  RSS, no GC. Costs: re-deriving the suppression/supersession/expiry/eligibility
  logic — the subtlest and most battle-tested code in the repo — in a second
  language, plus slower iteration for a solo maintainer on exactly the code
  where correctness bugs are costliest.
- **Hybrid.** Rust shell/transport with policy logic ported fixture-by-fixture
  from v1 tests (mechanical translation of v1's test suite, not fresh fixtures).

The README's honesty ("Rust may reduce runtime overhead... measure rather than
assume") is right, but it never offers "don't use Rust" as a branch. Even if
Rust wins on the merits, the decision should be on record with the tradeoffs,
because it is the highest-cost commitment in the plan and the hardest to reverse
once slices 2–3 exist.

## Change 4: measure the v1 baseline users actually feel (Slice 2E)

Slice 2E compares v2 against "a comparable v1 lexical workload with local
inference disabled." That is the wrong comparator for the user-felt problem.
Today, v1 recall blocks on one query-embedding round trip, deadline-bounded
(`createSearchAbortSignal` in `semantic-search.mjs`). Record v1 prompt-path
recall latency *with* inference enabled — cold and warm, same machine as the
provisional targets — before rewriting anything. If v1's deadline already caps
the damage at, say, a few hundred ms, then the rewrite's latency case shrinks to
scheduling, footprint, and multi-client ownership, which changes what "success"
means for the p95 <= 100 ms gate and may change the Rust calculus in Change 3.

## Change 5: weigh client dependency cost in the transport ADR (Slice 1)

tonic/prost is a fine server-side choice, but gRPC makes every thin client
adapter (Pi, Copilot, Codex, Claude Code, Antigravity — five ecosystems) carry
`@grpc/grpc-js` plus generated stubs. Slice 6's stated goal is *thin* adapters;
JSON over a Unix socket keeps them dependency-free and debuggable with `nc`,
while gRPC buys schema-evolution rigor and the additive-field compatibility
rules. The plan currently treats JSON-over-UDS as a fallback only if the
interoperability spike fails. I would elevate "total dependency and debugging
cost across all five client ecosystems" to a first-class ADR criterion, and
isolate the transport behind the versioned API either way so switching later is
additive.

## Minor notes

- **Idempotency quota behavior is unspecified.** "Configurable store quota
  rather than deleting retry safety records silently" — say what happens at the
  quota: reject new writes with `RESOURCE_EXHAUSTED`, or evict only the oldest
  fully-settled records. Pick one and test it.
- **Enumerate Status reason codes in the proto now.** "Categorical reasons" is
  right; reserving the category enum in slice 1 costs nothing and serves the
  grep-stability goal.
- **`synchronous=FULL` + WAL is the correct choice** for a correctness-first
  proof; just note the write-latency cost in the 10k-memory benchmark setup so
  nobody "optimizes" it to NORMAL later without a crash-test rerun.
- **rusqlite needs the bundled FTS5 feature** for the Retain-transaction FTS
  update; trivial, but list it in slice-2 dependencies.
- **Read-your-writes is implicit but should be explicit.** Gate #1 says clients
  "observe committed writes" — add one sentence: a Retain acknowledged on client
  A must be visible to a Recall on client B immediately after the ack, and test
  it (it should be trivially true in-process; say it anyway).
- **Effort realism.** Slices 1–3 are multi-week each for a solo maintainer. The
  gate structure is the right hedge against the second-system effect; the
  residual risk is opportunity cost versus improving v1. Changes 2's step-0
  experiment and Change 4's baseline are cheap ways to bank value before the
  rewrite pays off.

## Bottom line

The plan is a good idea executed in the right order, with the right bans (no
dual authoritative stores, no implicit migration, no silent gate weakening) and
the right tests (failpoints, restarts, policy fixtures before handlers). Fold
Change 1 into `03-background-embeddings.md`, fold Change 2's metric + ADR into
`03-background-embeddings.md` and `01-contracts.md`, and record Changes 3–5 in
the slice-1 ADR and slice-2E procedure. If the slice-3 quality gate does kill
strict cache-only recall, the daemon still wins on scheduling and storage
ownership — but bounded online query embedding should be the pre-agreed next
posture, not a re-litigated architecture.

— GLM
