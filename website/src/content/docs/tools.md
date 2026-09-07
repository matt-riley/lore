---
title: "Tools"
description: "Find the right Lore tool and understand which surfaces are stable or experimental."
section: "Reference"
order: 8
---

Lore has a small supported core and a larger experimental ring. Experimental interfaces can change between releases; the support matrix is the source of truth. The Pi adapter exposes its own small command and tool surface over the shared Lore server.

## Pi tools and commands

Pi's agent tools are:

| Tool | What it does |
| --- | --- |
| `lore_save` | Saves a decision, pattern, preference, gotcha, blocker, or open loop |
| `lore_onboard` | Saves your preferred name and Lore's interaction profile |
| `lore_recall` | Searches local memory for a query |
| `lore_status` | Shows memory counts, database path, and schema version |

The `/lore` command provides the same daily workflow:

```text
/lore status
/lore save Use the narrow adapter boundary for this integration.
/lore search adapter boundary
```

These Pi names are adapter names. Pi does not expose the Copilot extension's `memory_*` tools as native Pi tools.

Copilot and Pi provide the supported native adapter surfaces. Their shared store
also supports the experimental native hook adapters, but capabilities differ:

| Capability | Copilot CLI | Pi | Native CLI adapters |
|---|---|---|---|
| Registered tools | Full Copilot tool surface | `lore_*` tools | None; commands run through the shell |
| Automatic recall and capture | Supported | Supported | Experimental and host-event dependent |
| Archive backfill | Copilot store, experimental | Pi sessions, experimental | Not wired |
| Maintenance and diagnostics | Full supported diagnostics | `lore_status` | `memory_status`; Copilot-only diagnostics unavailable |

## Copilot CLI tools

| Tool | What it does |
| --- | --- |
| `lore_recall` | Retrieves prompt-relevant memories with provenance |
| `lore_retain` | Stores a scoped semantic memory or workstream overlay |
| `lore_onboard` | Stores your preferred name and Lore's profile |
| `memory_search` | Searches semantic memory by keyword |
| `memory_save` | Saves an explicit freeform note or decision |
| `memory_forget` | Soft-deletes a memory by marking it superseded; residual data may remain for provenance and recovery |
| `memory_status` | Reports health, counts, latency, and maintenance state |
| `memory_explain` | Explains a retrieval or suppression decision |
| `memory_validate` | Checks database integrity and schema parity |
| `memory_skill_validate` | Validates `SKILL.md` files and frontmatter integrity |

These are the supported Copilot CLI tools to build everyday workflows around. Pi uses the adapter names described above; it does not expose these `memory_*` names as native Pi tools.

## Experimental Copilot CLI surfaces

| Surface | Purpose |
| --- | --- |
| `lore_reflect` | Synthesis over bounded evidence; optional persisted observations |
| `memory_backfill` | Import older sessions from the raw store |
| `memory_deferred_process` | Process queued extraction jobs |
| `maintenance_schedule_run` | Run, inspect, or roll back bounded maintenance |
| `memory_replay` | Check retrieval behavior against a replay corpus |
| `memory_portable_bundle` | Export approved improvement artifacts; OKF import is manual |
| `memory_scope_override` / `memory_scope_audit` | Inspect or override active scope |
| `memory_doctor_report` | Generate an observe-only health report |
| `memory_intent_journal` | Inspect or record durable intent/routing journal entries |
| `memory_improvement_backlog` | Inspect or update durable improvement artifacts |
| `memory_evolution_ledger` | Review-gated evolution ledger and proposal generation |
| `memory_capability_inventory` | Scan local skills, agents, and tool surfaces with rollout state |
| `memory_review_gate` | Evaluate review gates for proposals and changes |
| Browser dashboard | Inspect local memories through a read-only loopback UI |

Some experimental tools require rollout flags such as `evolutionLedger`, `loreDoctor`, or `refreshableObservations`. They do not receive the same stability promise as the core.

## Read-only administration previews

The native CLI also registers `memory_correct`, `memory_repair`, and
`memory_purge`. Each command defaults to a read-only preview and accepts a JSON
object on stdin. A preview reports its affected derived records and a
`planFingerprint`; applying a plan requires that exact fingerprint and explicit
selection of any repair or aggregate candidates.

```sh
printf '%s\n' '{"memoryId":"<id>","content":"<replacement>","reason":"<why>"}' | node /absolute/path/to/lore/lore-cli.mjs tool memory_correct
printf '%s\n' '{"sessionIds":["<session-id>"]}' | node /absolute/path/to/lore/lore-cli.mjs tool memory_repair
printf '%s\n' '{"memoryIds":["<id>"]}' | node /absolute/path/to/lore/lore-cli.mjs tool memory_purge
```

The browser dashboard only generates these preview commands for copying. It
does not execute them and has no write endpoint. Apply requires the same
selector and payload, the preview `planFingerprint`, and explicit actionable
candidate IDs. Repair candidates are limited to source re-extraction and
repository mappings. Source-backed repair scans at most 32 MiB and 10,000
turns; unavailable or oversized legacy sources remain unresolved. Purge
aggregate candidates use typed IDs such as
`aggregate:episode_digest:<json-primary-key>`. If the initial preview reports
residual aggregates, run a new preview with `includeDependentAggregates: true`,
then use that new fingerprint and select every residual aggregate it reports. A correction can set `repository` for the replacement
destination, or explicitly use `scope: "global", repository: null` for a global
replacement. Purge retains raw sources, backups, snapshots, and non-plaintext
suppression, so it is not secure erasure.

The native capture resume command is separate from administration previews. The
dashboard only copies it; running it performs capture and may write evidence.
Each pass reads at most 4 MiB with a 250 ms cooperative read budget, retains at most a 1 MiB incomplete
record, and reports skipped oversized records through categorical health. Its
stdin is `{"cwd":"<source-cwd>","transcriptPath":"<absolute-transcript-path>"}`.

## Native CLI commands

[Codex CLI, Claude Code, and Antigravity CLI](/guides/cli-integrations/) use experimental native lifecycle hooks for automatic recall and capture. Explicit memory operations run through the shell, not MCP or registered model tools:

```sh
printf '%s\n' '{"prompt":"What did we decide about storage?"}' | node /absolute/path/to/lore/lore-cli.mjs tool lore_recall
```

The available commands are `lore_recall`, `lore_retain`, `lore_onboard`, `memory_search`, `memory_save`, `memory_forget`, and `memory_status`. They accept JSON arguments on stdin and signal failures with a nonzero exit status. Run from your project or supply an explicit `repository` argument. Injected context explains these commands to the agent, but normal host shell permissions still apply.

These adapters do not expose the full Copilot tool set: `memory_explain`, `memory_validate`, and the experimental Copilot tools above are not CLI commands. See the [native lifecycle table](/guides/cli-integrations/#what-happens-during-a-session) for each client's events and limits.

## Copilot CLI hooks

The supported hooks are `onSessionStart`, `onUserPromptSubmitted`, and `onSessionEnd`. Passive telemetry and pre-tool observation hooks are experimental and default-off. `onPreMcpToolCall` is deferred and is not registered.

## Picking a tool

In Pi, start with `/lore status`, save a note with `/lore save <text>`, and search with `/lore search <query>`; the agent equivalents are `lore_save`, `lore_onboard`, `lore_recall`, and `lore_status`. In Copilot CLI, use `memory_search` for a known keyword, `lore_recall` for prompt-aware context, and `memory_explain` when you need to understand a match. Use `lore_reflect` for a synthesis request, and label any resulting decision as yours until you review its evidence.

For lifecycle definitions and the complete matrix, see the repository's support matrix. [How memory works](/guides/how-memory-works/) explains the retrieval path in plain language.
