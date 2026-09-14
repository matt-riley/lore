# Astra review of the Lore v2 plan

Date: 2026-09-14

Reviewed: all five documents in `docs/v2/`, on branch `v2` at `fea3ec3`

Scope: independent assessment of the proposed architecture, implementation sequence, and acceptance gates. Other files in `docs/model-opinions/` were not read.

## Verdict

Yes, I think the daemon is a good idea, and this plan is disciplined enough to justify a bounded proof. Shared storage ownership, durable background work, and predictable prompt handling address real problems in Lore's current architecture.

I would proceed with slices 1–3 after tightening the contracts below. I would keep the decision to replace v1 open until the proof establishes retrieval usefulness as well as speed. The plan already makes that distinction; my main recommendation is to give the quality decision the same precision as the latency decision.

Rust is a reasonable implementation choice. It is not yet a demonstrated requirement. The strongest case for this work is that clients should stop managing memory infrastructure independently. The case for changing languages needs its own evidence.

## What I would keep

- **One authoritative writer per configured store.** This gives scheduling, retries, and consistency a clear owner across clients.
- **Separate v2 storage and explicit migration.** Preserving v1 while testing a new implementation is essential for a memory product.
- **A small proof API.** Status, Retain, and Recall are enough to exercise the core boundary without porting the entire product.
- **Durable acknowledgement and idempotent retry.** Committing the memory, retry record, and embedding intent together is the right foundation.
- **An explicit query-embedding tradeoff.** Slice 3 correctly acknowledges that precomputed memory vectors cannot supply a vector for an unseen query.
- **Policy enforcement across every retrieval path.** Repository scope, expiry, suppression, and supersession must survive ranking changes.
- **Failure tests and measurable exit gates.** Process crashes, provider failures, bounded queues, and cross-client reads belong in the first implementation.
- **Deferred service management, ANN indexing, dashboards, and full parity.** I would preserve these boundaries. The proof does not need more features to become useful evidence.

The motivation is supported by current code: [semanticSearch](../../lib/memory/semantic-search.mjs) embeds the query and may embed missing memories during retrieval; [fusePromptContext](../../lib/context/recall-assembler.mjs) awaits that search; and [lore-pi.ts](../../lore-pi.ts) awaits recall before starting the agent. Moving that work changes a real prompt path.

## 1. Make first-query usefulness a decision gate

Priority: before committing to slice 3's query-cache implementation.

The largest product risk is in [slice 3's query embedding policy](../v2/03-background-embeddings.md#critical-design-tradeoff-query-embeddings). A completed prompt followed immediately by `PrepareQuery` and `Recall` does not guarantee that preparation finishes in time. If the user never submits those exact query bytes again within the same scope and cache lifetime, the prepared vector may never help a recall.

I expect exact repeats of substantial coding prompts to be less common than warm-cache benchmarks suggest. That is a hypothesis to measure, not a finding about actual usage. The current Pi adapter also skips repeated recall for its cached prompt/session combination, so that behavior needs an explicit decision when adapters are ported.

The plan already asks for a quality report. I would make it a reproducible experiment with predefined pass criteria:

- Replay ordered prompt sequences without prewarming unseen queries.
- Include paraphrases, identifiers, corrections, unrelated queries, and cross-repository negatives.
- Compare v1 lexical retrieval, v1 semantic retrieval when enabled, v2 cold lexical retrieval, and v2 genuinely available cached-vector retrieval.
- Record relevant-memory recall at six results, irrelevant-context rate, exact-query cache hit rate, preparation-to-first-use delay, and the proportion of preparation work never consumed.
- Define acceptable quality loss before reviewing the results. Keep policy violations at zero regardless of relevance scores.

Use identical supported memories and output budgets for comparisons. A manual-memory proof cannot establish parity for omitted persona, episode, or directive behavior.

Also specify when vector retrieval should return nothing. Reciprocal-rank fusion combines rankings; it does not itself establish that the top vector result is relevant. Current v1 has a `minSimilarity` filter and tests for it. v2 needs a calibrated relevance/abstention rule, without blindly copying v1's numeric threshold.

My preference is to keep `PrepareQuery` experimental until this replay shows a useful hit rate. If first-query quality is unacceptable, the plan's proposed review of bounded online embedding is appropriate. A different lightweight query encoder would still need a compatible embedding space; its vectors cannot simply be compared with unrelated memory embeddings.

## 2. Separate the daemon decision from the Rust and transport decisions

Priority: in the slice-1 architecture decision record.

The existing plan fairly compares v2 with v1 lexical retrieval and acknowledges feature differences. I would add a short investigation of how much benefit comes from sharing a process and moving work out of recall, independent of language.

A small Node reuse spike or profile may be sufficient; I would not require a second production daemon. Node supports worker threads for CPU work, so scheduling separation alone does not establish that a Rust port is necessary. That is my architectural inference from the existing implementation and the [Node worker documentation](https://nodejs.org/api/worker_threads.html).

Rust may still win on resource use, packaging, implementation clarity, or long-term maintenance. Record those reasons and the cost of maintaining Rust, protobuf generation, and Node client code. The root package currently has no runtime dependencies; decide explicitly where new client dependencies belong.

Similarly, the gRPC spike should demonstrate that the client boundary is convenient to ship and debug. Add a tiny, isolated Pi-host exercise to the protocol proof, using a temporary store and no real hook changes. Production adapter rollout can remain in slice 6. This catches host loading or lifecycle assumptions before the daemon grows around them.

I would retain HTTP/JSON over a Unix socket as the documented alternative if gRPC's costs outweigh its benefits. Binary encoding is not a meaningful success criterion on its own.

## 3. Resolve response budgeting and retry semantics before freezing the API

Priority: before slice 1 exits.

[The contract](../v2/01-contracts.md#rpc-contract) contains one concrete limits mismatch: 20 memories at the permitted 64 KiB content size total 1,310,720 bytes, or 1.25 MiB. That already exceeds the 1 MiB response cap, before provenance, other fields, and rendered context. The 32 KiB rendering budget does not bound the structured memories.

Define an encoded-response budget covering both representations. My preference is to return fewer complete structured rows, report why the result was bounded, and explicitly identify which rows appear in the rendered context. Large valid retained memories should not make ordinary recall fail unexpectedly. Specify how a single memory larger than the context budget is represented or omitted.

Idempotency also needs a few precise rules:

- Define the hashed semantic payload. Request IDs and other retry-varying diagnostics must not change it. Specify handling of omitted defaults and tag ordering; preserve authoritative content bytes.
- Give client IDs stable meaning across reloads and upgrades. An uncertain write must retain its original client namespace and key.
- Once admitted, check for a committed idempotency result before rejecting a retry because the store or embedding queue is now full. Otherwise the recovery mechanism can fail precisely when it is needed.
- Clarify that a replay returns the original acknowledgement, including its original embedding status. Current embedding progress belongs in a separate read.
- Define machine-readable error reasons as well as gRPC status codes. A transport deadline, queue capacity rejection, and incompatible schema require different recovery behavior.

Add a failpoint test in which a write commits, its response is lost, capacity is exhausted, and the same request is retried successfully without creating another row or job.

## 4. Specify deletion, manual restoration, and repository identity as executable contracts

Priority: before slice 2 exits; public deletion tools before real-user adoption.

The plan is right to preserve suppression and manual authority. Those concepts need more precise interactions than a general promise to retain both.

Current tests distinguish three outcomes:

1. Restoring a backup must not resurrect a forgotten manual memory with its original ID.
2. Re-extracting the same proposition must remain suppressed.
3. A fresh, deliberate manual save may restore that proposition under a new ID.

See [snapshot-manual-suppression.test.mjs](../../tests/unit/snapshot-manual-suppression.test.mjs) and [retrieval-policy.test.mjs](../../tests/unit/retrieval-policy.test.mjs). The eligibility implementation exempts manual rows from some fingerprint suppression checks, so copying that predicate without the surrounding retirement/restore behavior would be insufficient.

Represent these distinctions in v2 fixtures now. Include the uncertain-Retain retry after its original memory has subsequently been forgotten: replaying an acknowledgement must never recreate the deleted memory. Public Forget/Correct/Purge RPCs can stay outside the synthetic proof, but their required semantics should precede real migration and adapter use.

Likewise, “canonical repository identity” needs shared fixtures. Existing [repository-identity.test.mjs](../../tests/unit/repository-identity.test.mjs) covers transport normalization, host and nested-path preservation, ambiguous legacy mappings, separate local repositories with the same basename, and linked worktrees. Include those cases in the language boundary. A correctly enforced string comparison still fails isolation if clients construct incompatible identities.

## 5. Reconsider coupling explicit saves to embedding backlog capacity

Priority: decide deliberately in slice 3.

Rejecting Retain when 10,000 memory jobs are outstanding is safe and clearly documented. It also means an optional derived feature can eventually prevent the user from saving authoritative memory during a long provider outage.

I would prefer a durable per-memory “needs embedding” state, committed with the memory and discovered by the already-planned bounded reconciler. Limit runnable queue entries separately and coalesce work by memory revision. A full runnable queue then delays indexing without losing its durable intent or preventing saves, until the authoritative store reaches its own explicit quota.

This is a design choice, not an atomicity defect in the existing proposal. If the simpler reject-on-full policy is retained for the proof, make its user-visible consequence and recovery procedure part of the acceptance report. Do not describe provider outages as affecting only semantic retrieval.

## 6. Complete the durable worker lifecycle

Priority: before slice 3 exits.

The queue has good foundations, but a few transitions remain underspecified:

- **Fence job completion by the current lease claim.** Checking target revision and model identity does not prove that the completing worker still owns the job. Give each claim a generation/token and reject completion from an expired claim, even when its target is unchanged.
- **Define recovery from terminal failure.** After credentials or provider configuration are repaired, how do failed jobs become eligible again? Provide an explicit retry path or a documented configuration-generation transition.
- **Make reconciliation respect failure policy.** A failed vector is still missing coverage. Reconciliation must not reset the attempt budget and recreate an endless retry cycle.
- **Treat provider-wide failures as provider state.** One authentication problem should not need thousands of individually doomed attempts. Pause dispatch until a permitted retry or configuration change.
- **Define lease and TTL behavior across sleep and restart.** Expired query payloads must be discarded before dispatch after resume. A one-hour TTL cannot promise physical deletion while the daemon is stopped.

Use the fake clock already proposed for tests. Add an expired-claim/late-completion race, provider repair after terminal failure, and repeated reconciliation of permanently failed work.

## 7. Make work bounds apply below the RPC layer

Priority: before the slice-2 and slice-3 performance gates.

The proposed request, queue, and candidate counts are a useful start. They do not fully specify CPU, memory, or disk bounds.

- Set a maximum supported embedding dimension and a decoded-vector byte budget. If materialized together, 10,000 vectors of 3,072 float32 values occupy about 117 MiB before any process overhead. This is an arithmetic example, not a measured implementation result. Bound scoring batches and concurrency accordingly.
- Bound database work as well as returned rows. A SQL limit or vector-candidate cap does not necessarily bound filtering and sorting work. Test a repository with very few eligible matches among many foreign or suppressed rows.
- Carry cancellation into running reads and scoring loops. Moving SQLite work off Tokio's reactor prevents one class of blocking, but does not make that work cancellable: started `spawn_blocking` tasks cannot be aborted merely by aborting their handle. [Tokio documentation](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html).
- Release request capacity only when underlying work has stopped. Otherwise timed-out requests can leave hidden work running while replacements are admitted.
- Reserve some capacity for Status/Recall and completed-write retry lookup under Retain or preparation floods. A total limit of 32 does not establish fairness between operations or clients.
- Specify WAL checkpointing, maximum read-transaction lifetime, and disk-pressure behavior. Long read transactions can prevent checkpoint progress and overlapping readers can allow WAL growth. [SQLite WAL documentation](https://www.sqlite.org/wal.html).

Benchmark maximum-size valid input, sustained writes, and a provider that returns instantly as well as one that sleeps. A sleeping provider tests isolation from network waits; a fast provider stresses vector commits, validation, and checkpointing.

## 8. Define the consistency and endpoint identities clients can rely on

Priority: during slices 1–2.

“Consistent snapshots” and “current eligibility” need one documented interpretation. I would specify that Recall reads content, scope, suppression, and the returned memory revision from one coherent snapshot. A forget acknowledged before that snapshot must take effect. Define the evaluation time for expiry and the behavior of mutations concurrent with an already-running Recall.

If vector scoring happens after releasing the read transaction, define how final validation reconciles changed rows and which revision the response reports. Otherwise a reply can mix old content with a newer revision and imply consistency it did not provide.

Distinguish authoritative memory revision from derived index generation. A query vector does not become mathematically stale because an unrelated memory was retained; eligibility and any result cache must reflect memory changes, while query-vector validity follows query/model identity.

For process identity, add a stable store identifier to Status and a deterministic socket-to-store mapping. Test two different stores configured with the same socket path. Holding the second store's lock must not permit unlinking the first store's live socket. The current per-store lock requirement alone does not define endpoint ownership across that case.

## Smaller clarifications worth making

- `PrepareQuery` should have a complete request/response, capability, coalescing, and privacy contract before implementation. Explicit remote-provider opt-in should cover submitted query text as well as retained memory content.
- Slice 3 promises LRU eviction and also says cache lookup performs no mutation. Specify whether this means no persistent mutation, with bounded in-memory recency, or choose an eviction policy that does not update on lookup.
- Status coverage needs a defined scope, denominator, and observation time. Expiry changes eligibility without a new write; an asynchronously maintained count should expose its freshness.
- Provider/status diagnostics should use sanitized identities, excluding credentials and secret-bearing URL components.
- Test server-side deadlines for clients that omit deadlines, not only well-behaved test clients.
- Distinguish process-crash recovery evidence from power-loss durability evidence. SIGKILL tests are valuable but do not simulate storage losing power.
- Decide at the language-boundary stage whether SQLite is bundled or supplied by the platform, and verify required FTS capabilities on both supported operating systems.
- Before adapter rollout, enumerate which standing directives and other mandatory context sections must remain available independently of topical retrieval. Current [recall-assembler.mjs](../../lib/context/recall-assembler.mjs) explicitly treats several sections as required. Deferring full persona parity should not accidentally remove them from the eventual product.

## Suggested sequence and decision

I would keep the seven slices and add a small experiment before substantial implementation:

1. Freeze representative retrieval inputs and expected policy outcomes; agree quality and latency gates.
2. Record the daemon/language/transport decision and run the planned Node-to-Rust spike, including a disposable host-loading check.
3. Complete slice 1 with response budgets, idempotency semantics, identity fixtures, and explicit error reasons.
4. Complete slice 2 with coherent snapshots, cancellation, capacity fairness, and actual durability evidence.
5. Complete slice 3 with worker recovery tests and realistic prompt-sequence evaluation.
6. Review the evidence before authorizing ingestion/extraction parity and migration work.

I would continue beyond slice 3 only if the shared daemon demonstrably improves the operational experience, cold-query retrieval meets an agreed usefulness threshold, privacy/correction fixtures all pass, and its maintenance cost is acceptable.

My overall judgment: this is a sound direction and a credible experimental plan. The most important change is to prove that fast recall still supplies the memories the agent needs. Fix the protocol limits and recovery ambiguities early, then let the proof determine how much of the rewrite deserves to proceed.

## Review evidence and verification

Read all of `docs/v2/README.md`, `01-contracts.md`, `02-daemon-core.md`, `03-background-embeddings.md`, and `04-later-slices.md`. Checked relevant current retrieval, policy, repository-identity, Pi lifecycle, and suppression-test code. Technical runtime observations were checked against the primary documentation linked above.

The following focused command passed on Node `v26.8.2`:

```sh
node --test --test-reporter=dot \
  tests/unit/retrieval-policy.test.mjs \
  tests/unit/semantic-search.test.mjs \
  tests/unit/recall-assembler.test.mjs \
  tests/unit/snapshot-manual-suppression.test.mjs
```

These tests verify the existing behavior used as review evidence. They do not validate an unimplemented daemon or measure v2 performance. This review adds documentation only; it does not implement the proposed changes or modify personal Lore data or client settings.
