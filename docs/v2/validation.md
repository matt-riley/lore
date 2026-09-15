# Validation, TDD and release evidence

Status: planned acceptance specification. Parent: [roadmap](README.md).
No figures below are claimed measurements of an implemented v2 daemon.

## Test architecture

Create language-independent JSON fixtures under `tests/v2/fixtures/` with request/input, fixed clock, repository/source identities, initial state, expected eligibility/authority/provenance and allowed outcome. Use synthetic content only. Rust and v1 evaluation runners read the same fixtures; expected outcomes are curated independently of both implementations.

Separate contract, policy, parser, extraction, migration, lifecycle, provider and adapter suites. Use a fake clock/provider for deterministic races and real SQLite/subprocesses for commits, leases, locks and restarts. Golden serialization tests verify bytes/fields; semantic tests verify behavior rather than mirroring helper implementation.

For each slice: write the failing behavior test first, implement the smallest path, refactor and run affected regressions. Record the initial failure and passing command in implementation evidence. Documentation-only work needs link/inventory/consistency checks; it does not justify changing runtime code to manufacture a TDD cycle.

Initial implementation commands to add: `cargo test --workspace --locked`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, and Node contract/evaluation runners under `tests/v2/`. Add explicit package commands when those runners exist; do not imply they are runnable today. G1 adds CI on macOS/Linux, Cargo caching, and Node floor/current plus Bun transport checks.

Existing regression commands remain `npm test`, `npm run validate-schema`, `npm run lint`, `npm run test:quality` and `npm run test:reliability`. Website changes also require its pinned-toolchain check/test/build/link commands. Tests must isolate HOME/LORE_HOME, host settings, credentials and Git signing for temporary repositories; never alter the real user's configuration.

## Safety and correctness gates

Zero tolerance in every stage for foreign private context, false global promotion, forgotten/superseded/expired/retired evidence leakage, automatic override of manual authority, acknowledged lost writes, or resurrected IDs after retries/restoration.

Required scenarios include global-only requests, same repository, explicit transferable consent, broad administrative search, linked worktrees, identical basenames, normalized remote transports, ambiguous legacy mappings, unknown identity, expiry at exactly now, and explicit global versus inferred unscoped guidance.

Deletion/recovery fixtures distinguish original manual ID deletion, automatic proposition suppression, deliberate manual re-save with new ID, uncertain-write replay and backup restoration. Exercise all derived context forms, not just semantic rows. Zero policy failures cannot be traded for better latency or aggregate relevance.

Durability tests use failpoints before/after transaction commit, after acknowledgement generation, before response, around lease claims, vector commit, checkpoint commit, migration chunks and restore renames. Track every acknowledged mutation and every durable intent. SIGKILL proves process-crash recovery; power-loss guarantees require storage/fsync review and separate platform fault evidence.

## Retrieval corpus and metrics

Build from `tests/fixtures/reliability-corpus.mjs` plus separately authored retrieval cases: unique prompts, paraphrases, code identifiers, exact repeats, corrections, unrelated queries, negative scope and mandatory sections. Retain at least 120 independent semantic scenario families. Each family has fixed relevant memory IDs and forbidden IDs; all paraphrases/host variants stay in the same split.

Deterministic split: sort family IDs by SHA-256, first 20% for calibration and remaining 80% for held-out evaluation. Freeze corpus hash, model identity, preprocessing, threshold and output budgets before held-out runs. If no similarity threshold satisfies calibration gates, G3 fails; do not tune against held-out answers.

Report:

- recall@6: fraction of eligible gold memories returned among six results, macro-averaged over positive queries.
- MRR@6: reciprocal rank of the first eligible gold result, zero when absent, macro-averaged.
- Irrelevant-context rate: non-gold returned topical rows divided by returned topical rows; report negative-only prompts separately.
- Mandatory-context completeness and forbidden content in rendered output independently of topical ranking.
- Exact cache hit rate, query inference attempt/success/fallback rate, vector contribution, and semantic availability on first-seen queries.
- Capture, extraction and embedding coverage with source gaps, denominator and observation time.

Compare identical supported content and output budgets across v1 lexical, v1 semantic, v2 lexical, v2 first-seen bounded semantic, and v2 cached semantic. Precompute memory vectors for the semantic comparisons; never prewarm unseen query vectors. Also run the real pending-coverage workflow separately. Record v1's unbounded/current inference latency rather than pretending it had v2's deadline.

G2 lexical and G3 healthy semantic modes must have recall@6 and MRR@6 at least their equivalent v1 mode and no higher irrelevant-context rate on the held-out corpus. All mandatory/negative safety fixtures must pass individually. Provider-offline v2 is compared with the lexical baseline; report its loss versus healthy semantics explicitly. Do not make offline mode pass by comparing it only to another failed provider call.

Semantic availability is measured, not inferred from cache hit rate. Unique-query/healthy-provider results must satisfy the quality gates with real deadlines; failure means provider deployment/design review, not a cache-only success claim.

## Extraction gates

Retain the existing independent reliability requirements:

| Metric | Gate |
| --- | --- |
| Extraction precision | >= 0.95 |
| Explicit proposition recall | >= 0.90 |
| Retention recall | >= 0.90 |
| Independent semantic scenarios | >= 120 |
| False global promotions | 0 |
| Critical failures | 0 |
| Negative false positives | 0 |
| Mandatory global-style/global-reversals failures | 0 |

Do not remove difficult families or reduce denominators when porting. Report per-client/per-family metrics and missing sections. A manual-only proof cannot claim the extraction or persona gate.

## Latency and resource benchmarks

Use release Rust builds, 10,000 deterministic synthetic memories and four independent clients on a documented developer machine. Run five measured repetitions, publish each and median/tail summaries. Freeze dataset/seed, compiler, OS, architecture, CPU/RAM, provider deployment/model/dimensions, SQLite pragmas, request mix and budgets.

Measure v1 in-process lexical baseline separately from v1 hook subprocess/worker baseline. Compare daemon service time separately from complete host-hook elapsed time. Record cold daemon, warm daemon, cold process, cached query, unique query, warm/cold provider and disabled/offline provider.

| Workload | Gate / reporting rule |
| --- | --- |
| Lexical/cached daemon recall under backlog | Original ceiling: p95 <= 100 ms and p99 <= 250 ms; server cancellation bound still applies |
| Pure lexical comparison | p95 <= max(5 ms, 2 x measured v1 in-process lexical p95), as well as the absolute ceiling |
| Query inference attempt | <= 100 ms including validation; no unbounded residual daemon task |
| Bounded semantic server work | <= 160 ms execution deadline; no slow-provider exception |
| Full prompt hook | <= 200 ms client deadline; p95/p99 elapsed reported including cold CLI startup |
| Foreground Retain under indexing | p95 <= 100 ms, p99 <= 250 ms on the declared machine |
| Idle RSS with populated cache | <= 100 MiB |
| Peak RSS in declared four-client workload | <= 192 MiB; larger valid-input stress also reported |
| Idle CPU | <= 1% of one core averaged over five minutes after catch-up |

The original 100/250 ms ceiling applied to cache-only recall. With the approved bounded-inference change, preserve it for lexical/cached work and explicitly use the 160/200 ms execution/hook budgets for new-query work. This distinction must remain visible in reports; do not average the modes to hide slow unique prompts. The strict lexical comparison prevents a permissive ceiling from concealing a large regression over v1.

Deadline tests use a monotonic clock and controlled sleeping providers; assert cancellation is scheduled at the bound and no further work is admitted under the old permit. Wall-clock process scheduling jitter is reported, not dismissed or hidden in a relaxed timeout. Missing the practical hook target blocks host certification.

Stress cases: slow 30-second provider, immediate provider, 10,000 queued jobs plus pending intents, maximum request/escaping, dimensions 384/768/3,072, sparse eligible scopes among foreign/suppressed rows, sustained Retain/Forget, expired leases, read-pool sizes 1/2/4, blocked checkpoints, client cancellation floods, full quota, disk failure and sleeping/resumed daemon.

Publish latency histograms, queue/DB wait, provider time, write contention, RSS/CPU, DB/WAL size, candidate/scoring counts, coverage, fallback categories and all error rates. An error is not a fast successful request. Do not run competing benchmarks simultaneously.

## Acceptance evidence and issue handling

Use `docs/v2/evidence/<stage>/<commit>/` for synthetic machine-readable reports and a short Markdown gate result. Required fields: stage, commit, source baseline, corpus/schema hash, toolchain, platform, commands, counts, per-case failures, benchmark configuration, measured results, known gaps, reviewer/owner and go/no-go decision. Store personal replay outside Git with content-free summary only if explicitly selected.

G1-G6 require every applicable test, not only the local subset. The final release ledger covers every parity row and target host. Track blockers with requirement ID, reproduction, owner, severity and retest evidence. Data-loss/scope/deletion failures block progress until fixed; ordinary deferred features remain visibly unimplemented.

No gate is passed because a deadline, time budget or project schedule expired. Record failed runs, then rerun only after a relevant change. Amend targets before a new measured run if the owner explicitly changes the requirement.

## Documentation completion checks

For this planning change, verify every local Markdown link/anchor, model-review citation range, current capability name/alias, rollout flag, hook, source table and slice destination. Search for superseded gRPC/cache-only/queue-rejection requirements and unresolved placeholders. Preserve historical review documents unchanged.

Confirm the diff is limited to `docs/v2/`, run whitespace checks and current core/schema/lint regressions, then commit/push the v2 branch. Verify the pushed commit and any triggered checks. The current CI workflow only runs pushes to main and PRs targeting main; a v2-only docs push may correctly have no CI run. Never report absent hosted checks as passing.
