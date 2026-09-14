# Lore v2 Plan Review: Grok

**Date:** 2026-09-14
**Subject:** Evaluation of Lore v2 daemon rewrite plan (`docs/v2/`)

---

The plan is a good idea. The architecture is right, the sequencing is disciplined, and the safety rules are the ones that actually matter for Lore. I would not start over. I would change one product decision before slice 3, and a handful of smaller contract choices in slices 1–2.

## Verdict

The thing worth proving is not “Rust is faster.” The docs already say that. The thing worth proving is:

1. One writer owns memory, suppression, and jobs.
2. Prompt handling does not embed, ingest, or scan archives.
3. Scope, expiry, suppression, and manual authority still hold after fusion.

That is the right rewrite. v1 already shows why: `semantic-search.mjs` embeds the query **and** indexes up to 24 memories on the recall path, with a 10s deadline. Cold stores fill across searches. Pi already has a per-session Node worker (`lore-server.mjs`) because the host cannot open the DB. Five adapters sharing a file is not the same as five adapters sharing a scheduler.

Slices 1–3 as a proof, separate store, no implicit migration, no competing v1/v2 writers: all correct. Keep that.

## The decision I would change

**Exact-query cache as the only vector path will not serve ambient recall.**

Slice 3 says: Recall is lexical immediately; a cache hit may add vectors; a cache miss stays lexical; `PrepareQuery` only acknowledges. Clients may prepare on submit, then Recall without waiting.

Ambient recall is one unique prompt string per turn. Users do not resubmit the same UTF-8 bytes. `PrepareQuery` then Recall loses the race every time: the hook budget is tens to hundreds of milliseconds, and the vector is not ready yet. The next turn is a different query, so the cache still misses.

So for the primary product path, slice 3 is lexical-only v1, plus a cache that helps retries and tests. v1 added embeddings specifically because FTS with no stemming misses paraphrases. A go/no-go that compares “first-query lexical vs warm-query fusion” will look fine in synthetic repeated-query benches and bad on real prompts.

Memory-side background indexing is the actual win. Query-side strictness is stricter than the latency problem requires.

I would lock this in the slice 1 contract, not after building the queue:

- Memory embeddings: always background. Uncontroversial.
- Query embeddings: bounded, fail-open, optional. If the provider returns within a short deadline (on the order of 30–50ms, configurable), fuse. Otherwise lexical, and enqueue the query for later. Recall still never waits on memory indexing, archive scans, or a cold model.
- `PrepareQuery` can stay as an optional hint. Do not rely on it for the first prompt.
- Keep the invariant “Recall does not index memories and does not block on a backlog.” Drop the invariant “Recall never touches the provider.”

If you want zero provider I/O on Recall, the alternative is an in-process query encoder (Candle/ONNX in the daemon). That is a different slice 3. The current plan defers it until quality fails. Name the likely failure now: **unique-prompt ambient recall will almost never hit the query cache.**

The existing “stop and review alternatives rather than quietly adding inference back into Recall” is the right process. I would just review it before the RPC is frozen.

## Other changes I would make

**Do not reject Retain because the embedding queue is full.**
Slice 3 says a full 10k job queue returns `RESOURCE_EXHAUSTED` on Retain. That contradicts “embeddings are disposable derived data.” If the provider is down, users should still be able to save a memory. Reject Retain for memory/idempotency quota. Record embedding intent as backpressured and let reconciliation catch up. Status already has coverage/lag fields; use those.

**Treat gRPC as a spike, not the default.**
JSON over a Unix socket matches what you already run (`lore-server` JSON-lines), is debuggable, and is irrelevant to a 100ms recall budget at a 1 MiB cap. Freeze the *schema* in protobuf or JSON Schema; do not pay `@grpc/grpc-js` + codegen in every adapter unless the spike is clearly better. The plan already allows HTTP/JSON if the spike fails. I would start there and only take gRPC if you need streaming later (you explicitly do not in the proof).

**Put a throwaway client hook in slice 2, not slice 6.**
Slice 2 already has two Node clients. That does not prove “prompt hook must not wait for daemon startup / PrepareQuery / archive.” A fake `UserPromptSubmit` client with a 200ms deadline, missing socket, and mid-recall kill would catch the actually-shipped failure mode years earlier than production adapters.

**Stable client IDs are adapter names, not process instances.**
Idempotency is namespaced by client ID. If a reconnect generates a new ID, retries duplicate. State that `client_id` is `pi` / `copilot` / `codex` / …, and session IDs stay in the optional session field.

**Config and socket paths are underspecified for a daemon.**
Slice 3 needs endpoint, model, dimensions, and a generation counter. Do not invent that by quietly reading v1 `lore.json` in a way that can write it back. Explicit `--config` or a v2 config file. On macOS, `sockaddr_un` is 104 bytes; `$TMPDIR` and long homes will fail. Default to a short path (`/tmp/lore-$UID/lored.sock` or a dedicated runtime dir) and keep the explicit `--socket` override.

**Model identity: require an operator generation, do not discover one.**
OpenAI-compatible endpoints will not give you a trustworthy digest for `latest`. `modelRevision` in config, default 1, bump to invalidate. Otherwise cache poisoning from tag moves will dominate slice 3 bugs.

**RSS vs brute-force vectors.**
10k × 768-d × f32 is ~30 MiB if you load them all. Idle RSS target is 100 MiB. Page from SQLite like v1 (256-row pages). Do not heap-load the vector corpus on startup to make the benchmark pretty.

**Say what happens to v1 while this is in flight.**
The failure mode for this plan is not the daemon. It is 4–7 more slices while schema v20, five adapters, extraction, temporal recall, overlays, and the dashboard keep moving. Freeze non-critical v1 features or accept a long dual-maintenance window in the README. Slice 5 will otherwise be a port of a moving target.

**Rust is a product bet, not a proof requirement.**
Shared scheduling, one store, background embeddings all work in Node. You already have a worker process. Rust is justified if you want a small always-on binary and a 100 MiB RSS envelope. It is not required to prove the architecture, and it makes you port `db-retrieval-policy.mjs` by hand — the plan correctly warns not to copy SQL without caller assumptions. If you want Rust, keep it; just do not let language choice expand slice 2 before the protocol is boring.

## What I would not change

- Separate `~/…/v2/` store, fail-closed on unknown schema, no implicit v1 import.
- One OS-held lock, careful stale-socket unlink, no TCP.
- Suppression/expiry/supersession applied before ranking and again before render.
- Manual Retain as the only write in the proof; fixture-seeded forget/expiry.
- Transactional outbox for embedding intent, leases, revision checks on commit.
- Query text TTL and “no query text in diagnostics.”
- Honest Windows deferral and “same-user socket is not auth.”
- TDD + failpoints + two-client interop as the slice 2 gate.
- Later slices staying outlines until 1–3 have measurements.

## Suggested slice 1–3 bar, restated

Prove two clients, durable Retain, lexical Recall under a dead/slow provider, no memory indexing on the prompt path, and no scope leaks. Measure p95 against v1 with local inference disabled, as written.

Do **not** treat “first unique prompt is lexical-only” as success for semantic search. Either allow a bounded query embed on Recall, or put a local encoder in the daemon, or accept a known quality regression and write that down as the go/no-go criterion.
