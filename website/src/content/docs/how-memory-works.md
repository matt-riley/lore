---
title: "How memory works"
description: "Learn what Lore captures, how it chooses context, and how scopes keep memories useful."
section: "Understand Lore"
order: 3
---

Lore turns session activity into a local derived memory store. It does not replay your entire transcript into every prompt. Instead, each agent adapter maps its lifecycle events to Lore's memory operations and shared store, then extracts useful facts, retrieves eligible evidence, and assembles bounded context.

## The session lifecycle

### Pi events

Pi maps `session_start` to lazy runtime initialisation and onboarding seed, `before_agent_start` to ambient recall injected into the agent context, and `session_shutdown` to final extraction followed by database shutdown. Explicit Pi commands and tools use the Pi server process, and the resulting memories are written to the shared local store.

Pi also cleans prompt terms for lexical recall and uses a typed fallback for explicit `/lore search` and `lore_recall` misses. This is a Pi adapter convenience; the underlying store and scope rules remain shared.

### Copilot CLI events

1. `onSessionStart` initialises the database, loads configuration, and performs cheap pre-warming.
2. `onUserPromptSubmitted` classifies whether memory is useful, retrieves matching evidence, and injects a bounded capsule when appropriate.
3. `onSessionEnd` extracts useful session information into the derived store on a best-effort, non-blocking path.

Copilot CLI runs Lore in its extension runtime. It and Pi use separate adapter runtimes, but a shared `lore.json` and `lore.db` lets memories move between the two agents on one machine.

Temporal questions use normalised dates and day or episode summaries first. Lore only falls back to bounded raw session-store verification when that evidence is missing.

## What gets stored

The derived store can contain semantic memories, episode and day summaries, commitments, working-profile information, and provenance. A memory may include a repository scope, category, confidence, source, and supersession history.

Lore reads Copilot's raw `session-store.db` for extraction and backfill. It never writes to that raw store. The derived database is `~/.copilot/lore.db` by default.

## Retrieval and scope

Lore keeps global memories eligible across repositories. Repository-scoped memories are eligible for their repository; cross-repository results are bounded and require the relevant request or configuration. Workstream overlays can add active project context when the feature is enabled.

The shared retrieval concepts are exposed through adapter-specific names. In Pi, use `lore_recall`; in Copilot CLI, use `memory_search` for keyword search and `memory_explain` to inspect a prompt decision:

| Adapter | Tool | Use it for |
| --- | --- | --- |
| Pi | `lore_recall` | Explicit query search with lexical and optional semantic matches |
| Copilot CLI | `memory_search` | Explicit keyword search |
| Copilot CLI | `memory_explain` | Why a prompt was matched, filtered, or skipped |

With local embeddings enabled, `lore_recall` appends meaning-ranked matches to lexical results. Embeddings augment lexical retrieval; they do not replace it, and endpoint failures fall back to lexical search.

## Writing and retiring memories

In Copilot CLI, use `lore_retain` for a structured memory with scope and category, `memory_save` for an explicit freeform note or decision, and `memory_forget` to soft-delete a memory by marking it superseded. In Pi, use `lore_save` and provide an explicit `scope` when you need to control classification. Lore keeps provenance so a later review can understand where a result came from.

## Reflection is advisory

`lore_reflect` is experimental. It synthesises patterns, blockers, decisions, or next actions from bounded evidence. Optional local model findings about consolidation, contradictions, supersession, and trends are advisory and do not mutate trusted memories automatically.

## Keeping context bounded

Budgets and retrieval limits prevent memory from crowding out the current task. If a prompt has no useful match, Lore can skip injection. If a model-backed expansion, compression, or embedding step fails, Lore preserves the deterministic result.

For configuration examples, see [Configuration](/guides/configuration/). For a tool-by-tool map, see [Tools](/guides/tools/).
