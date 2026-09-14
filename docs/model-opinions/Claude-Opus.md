# Lore v2 Plan Review: Claude Opus

**Date:** 2026-09-14
**Subject:** Evaluation of Lore v2 daemon rewrite plan (`docs/v2/`)

---

The safety thinking in this plan is really good. Scope isolation, suppression, idempotency, bounded queues and honest gates are the parts rewrites usually skip, and the plan covers all of them. I don't think the plan is wrong, but I'd change the order of the bets and push back on three specific design choices.

## 1. Say what's broken in v1, with numbers

The README lists things to prove but never says what problem v1 has. The evidence in the repo points somewhere specific:

- **Plain recall is already fast.** `docs/v1-release-evidence.md:63` records a 10k prompt p95 of about **1.1 ms** (as far as I can tell, with embeddings off). The v2 target of p95 ≤ 100 ms is about 100× looser. As written, v2 could pass its gate while being much slower than v1.
- **The real latency problem is semantic search.** Recall awaits `semanticSearch` (`lib/context/recall-assembler.mjs:185`), which calls the embedding model on every prompt, with a **10 s** default deadline (`lib/memory/semantic-search.mjs:59`).
- **No shared background worker.** v1 explicitly has "no background daemon" (`docs/cli-integrations.md:6`, `docs/maintenance-scheduling.md:50`), so each agent does its own ingestion and embedding.

**Suggestion:** add a short "v1 problems" section with measurements. Then set targets relative to v1, e.g. "no worse than v1 lexical p95 plus X ms".

## 2. Test "daemon" and "Rust" as separate bets

Go/no-go criteria 1–6 are about the daemon design, not the language. A Node daemon reusing `node:sqlite` and the existing policy code could prove all of them. Rust adds a second toolchain, protobuf codegen and, most importantly, **a second copy of the scope and suppression rules**. That copy has to stay in sync with v1 through slices 1–7, which is exactly where leaks come from.

**Suggestions:**

- Pull the cheap wins into v1 first: background memory embedding plus a short deadline on query embedding. That gets most of the latency benefit without a rewrite.
- Include a Node daemon as the comparison in the slice-2/3 benchmarks. Choose Rust only if the measurements say so. Idle RSS is the one place Rust clearly helps, and 100 MiB may be reachable in Node too (worth measuring).
- Make `tests/v2/fixtures` a shared spec that also runs against v1, so the two implementations can't quietly drift apart.

## 3. Cache-only query vectors will probably mean almost no semantic recall

The cache key is the exact UTF-8 query. Agent prompts almost never repeat word for word, and "PrepareQuery, then Recall immediately" is a race that Recall nearly always loses. My guess is the cache hit rate on real prompts will be close to zero, so semantic recall effectively disappears. The plan does say "evaluate quality", but I'd plan for this now:

- **Change go/no-go criterion 3.** "No provider request attributable to Recall" builds the design choice into the gate. Something like "Recall latency holds with the provider offline or slow" allows **bounded online query embedding** (e.g. 50–150 ms against a warm local model, lexical fallback). v1's actual mistake is the 10 s deadline, not calling the model at all.
- Consider using the vector prepared on the previous turn for tool-initiated recalls.
- Add "cache hit rate on realistic prompt traces" to the slice-3 gate.

## 4. Run a quick spike before the full slices

Slices 1–3 are thorough: codegen drift checks, failpoints, lease crash tests, and two-OS CI. That's a lot of work before learning the risky answers. A few days of throwaway spike would answer:

- **Bun, not just Node.** `lore-server.mjs:1` says Pi's extension runs on Bun, and the Pi adapter comes first. gRPC client support under Bun is the riskier path, and the slice-1 test only covers Node.
- **Cold-subprocess cost.** Claude Code and Codex hooks run `node lore-cli.mjs` as a fresh process each time. Node startup plus gRPC channel setup could cost more than the daemon saves. A tiny native client binary might be the real win for those hosts.
- **Compare JSON and gRPC side by side.** There is already a JSON-lines protocol (`lore-server-runtime.mjs`). Treat JSON over a Unix socket as an equal option in the spike, not just the fallback if gRPC fails.

## 5. Smaller points

- **Don't let the embedding queue block writes.** Vectors are disposable, and the reconciliation scan can rebuild missing coverage from the memory rows. So a full embedding queue shouldn't make Retain fail with `RESOURCE_EXHAUSTED`. Acknowledge the write and report the coverage gap in Status.
- **Idempotency records with no expiry plus a hard quota** will eventually make Retain fail with no recovery path. That's acceptable for a proof, but write down what happens when the quota fills.
- **The global default leaks, and the review session showed it.** Lore's hook injected "Standing Directives" from other projects into a session in this repo, like "output should be saved in copilot/assets/video/" and "He should make the audience feel uncomfortable". The hook output doesn't show whether those rows are marked global or wrongly scoped. Either way, v2 keeps "global + same-repo by default", so add a fixture for this case. Consider stricter rules for what counts as global, e.g. manual-only or specific types.

## Bottom line

Keep the safety contracts almost exactly as they are. Change the plan in this order:

1. Write down v1's problems and baseline numbers.
2. Fix the semantic latency in v1.
3. Spike the daemon in Node versus Rust, with Bun and cold-subprocess clients.
4. Then run the rigorous slices on whichever wins.
