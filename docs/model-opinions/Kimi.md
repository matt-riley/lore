# Kimi's review of the v2 daemon plan

Reviewer: Kimi (Moonshot AI). Independent read of `docs/v2/` — I did not read the other opinions in this directory before writing this.

## Verdict

Yes, this is a good plan. It is the best kind of rewrite plan: one that is visibly afraid of itself. The failure mode of "let's rewrite it in Rust" projects is enthusiasm; this document's dominant emotion is suspicion, and that's correct. The constraints section, the explicit deferral lists, the "record an ADR if gRPC fails and fall back to HTTP/JSON" escape hatch, and the refusal to promise performance numbers before measuring them are all signs the author has been burned before and learned the right lessons.

I would approve slices 1–3 as written, with the suggestions below.

## What's genuinely strong

1. **The go/no-go gate is real.** Seven demonstrable properties, provisional targets explicitly labeled as targets, "change targets only in a reviewed decision, not after silently weakening a failed gate." Most plans write acceptance criteria they intend to fudge. This one pre-commits to not fudging.

2. **The cache-only query embedding decision (slice 3) is the bravest and best call in the document.** Everyone who builds a retrieval daemon eventually faces "new query, no vector yet." The lazy answer is "just embed synchronously, it's fast enough," and then your prompt path has a network call forever. Refusing that up front — and explicitly naming the tradeoff (first-query recall is lexical-only) with a stop-and-review trigger if quality is unacceptable — is exactly how this should be handled.

3. **Idempotency is treated as a durability primitive, not a dedup nicety.** "A timeout is not evidence of rollback," idempotency records never auto-expire during the proof, and queue-full rejects Retain atomically rather than acking a write while losing its embedding intent. These are the details that separate a durable system from a demo.

4. **Safety semantics are framed as invariants, not features.** "Suppression, supersession, and expiry filtering precede ranking" appears as a contract rule, a test fixture, and an acceptance gate. Repetition across layers is deliberate and correct — these are the properties most likely to be quietly dropped under schedule pressure.

5. **Honest scoping of the trust boundary.** "A socket cannot distinguish trusted from malicious processes running as that user." Most daemon plans oversell the security of a Unix socket. This one states the actual guarantee.

6. **The v1 coexistence policy is correct and unusually disciplined.** Separate store, no implicit migration, no fallback writes to v1 (divergent authoritative stores — right), read-only fallback only with latest suppression state. The failure modes of dual-write systems are well known and the plan names and avoids each one.

## Concerns and suggested changes

### 1. The four-client, 10k-memory benchmark may not stress the right thing

The provisional targets (p95 ≤ 100 ms with 10k memories, 4 clients) will pass trivially for lexical FTS on SQLite — you could hit that in v1 Node today. That makes the benchmark weak evidence for the rewrite's actual thesis. The interesting question is whether the benchmark proves anything a v1 measurement wouldn't.

**Suggestion:** Add a benchmark dimension that only the daemon architecture can satisfy, e.g. "recall p95 while a 30-second-sleeping provider holds the embedding queue" (slice 3 step 9 already does this — good), plus an explicit v1 side-by-side under the *same* synthetic corpus. Slice 2 E mentions a "comparable v1 lexical workload" — promote that from a line item to a first-class gate output, because "the daemon is not slower than v1" is a necessary but embarrassingly low bar, and "here is the measured delta" is the only number that justifies continuing.

### 2. PrepareQuery has a subtle timing problem worth naming

The intended flow — client calls PrepareQuery when a prompt is submitted, then Recall immediately — means the query vector almost never exists when first needed. The cache only helps the *second* occurrence of an identical query. For interactive agents, identical queries are rare; near-identical ones are common and explicitly excluded (exact UTF-8 bytes as key, no fuzzy reuse — correctly, for privacy).

So the honest expected state is: vector recall is almost always cold on first use of any query, and warm mainly for repeated/retried queries. The plan acknowledges "first-query lexical-only" but I think it understates how often "first query" is *every* query in real usage.

**Suggestion:** Before slice 3's go/no-go, add an instrumentation task: log (in the proof harness, not production) the distribution of exact-query recurrence across realistic session fixtures. If recurrence is low, the plan's own escape hatch (bounded online query embedding or a small local query encoder) stops being a fallback and becomes the likely main path — better to know that before slice 4/5 work is planned around cache-only semantics.

### 3. The query-text TTL has a gap between "erased" and "gone"

The doc is honest that TTL deletions aren't secure erasure from WAL/backups. Good. But query text sitting in a jobs table for up to an hour is the single most sensitive new artifact v2 introduces — v1's equivalent data at least lives in transcript files the user already owns. A one-hour window of plaintext user prompts in a new database file deserves more than a TTL.

**Suggestion:** Consider storing query text encrypted with a daemon-generated, memory-only key (lost on restart → job becomes `failed`/`obsolete` with a clear category). That converts "sensitive data at rest for up to an hour" into "sensitive data in process memory only," at the cost of losing in-flight query jobs across restarts — which are optional, best-effort work anyway. If that's rejected, at least shorten the default TTL and make the retention window visible in Status.

### 4. Retain queue-full rejection may surprise adapters

"Queue full → reject Retain with RESOURCE_EXHAUSTED" is atomically correct, but the failure mode in production is: a user's embedding provider is down for a day, the 10,000-job queue fills, and now *manual memory writes start failing* — the most trusted, highest-authority path in the system, blocked by the least important one (derived vectors).

**Suggestion:** Make memory jobs evictable by priority class rather than rejecting Retain: when full, drop/obsolete the oldest *retryable* memory-embedding jobs (they're recoverable via the reconciliation scan slice 3 already specifies) rather than refusing the authoritative write. The reconciliation pass already exists precisely to repair missed coverage — lean on it. Keep the hard rejection only for the case where reconciliation couldn't recover (e.g., permanent provider misconfiguration), which Status can surface.

### 5. Slice 2's read pool of four deserves a justification or a test

"Small read pool (initial maximum four)" is fine, but with a 32-request foreground limit, four blocking readers means 28 requests queued behind them under load, and FTS candidate scans are the slow path. This will probably show up in the benchmark as p99 tail latency.

**Suggestion:** Either note that the p99 target is where this number gets tuned, or add a benchmark variant sweeping read-pool size. Cheap to do now, annoying to discover in the slice-3 report.

### 6. Minor: specify what "memory revision" means for cache invalidation ordering

Slice 1 says no implicit full-result cache; slice 3 introduces the query-vector cache keyed on exact query + repository/scope + model identity. But memory *content* changes (suppression, expiry, forget) don't invalidate cached query vectors — correctly, since eligibility is re-checked at merge time. The doc says merged results re-pass policy checks, so this is covered — but state it explicitly in the query-cache section, because it's the kind of invariant a future contributor will "optimize" away by trusting the cached candidate list.

### 7. Missing: an explicit statement about SQLite write contention between foreground and background

Slice 3 says provider calls happen outside transactions and long calls never occupy the foreground executor — good. But the vector *commit* still takes the single writer. Under backlog, batch commits of up to 24 vectors will periodically block Retain. Probably fine at this scale, but WAL + a single writer means "bounded" should be quantified.

**Suggestion:** Add a test to slice 3 step 9 measuring Retain latency *during* vector commit activity, not just Recall latency during provider slowness.

## Smaller observations

- The "reject, never silently truncate" stance plus a 64 KiB content cap is right. Consider documenting the error message format for oversize content so adapters can render something useful.
- "Zero jobs is not proof of fully imported history" — excellent line, keep it. Slice 4's "report exact unresolved/skipped work instead of declaring completion from an empty queue" is the same principle and equally important.
- The socket-hardening rules (0700/0600, symlink refusal, lock-before-unlink) are thorough. The only gap: nothing about the database *backups* inheriting those modes — worth one line in slice 5 (migration) since that's where copies get made.
- TDD sequences in each slice are well-ordered (failpoints before features, fixtures before handlers). The fake clock + fake provider approach for the queue state machine is exactly right.
- The plan consistently refuses to claim Windows support rather than promising it vaguely. Keep that energy through slice 7, where installer pressure will test it.

## Summary

Approve slices 1–3. The architecture is sound, the safety invariants are treated as load-bearing, and the plan's own skepticism is its best feature. My two substantive worries are (a) the benchmark suite may prove the daemon is *not worse* without proving it's *worth it* — fix by making the v1 comparison a first-class gate output — and (b) cache-only query vectors may be cold far more often than the plan's framing implies — fix by measuring exact-query recurrence before slice 4 planning assumes cache-only semantics. Everything else is refinement, not objection.
