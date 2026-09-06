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

## Copilot CLI tools

| Tool | What it does |
| --- | --- |
| `lore_recall` | Retrieves prompt-relevant memories with provenance |
| `lore_retain` | Stores a scoped semantic memory or workstream overlay |
| `lore_onboard` | Stores your preferred name and Lore's profile |
| `memory_search` | Searches semantic memory by keyword |
| `memory_save` | Saves an explicit freeform note or decision |
| `memory_forget` | Soft-deletes a memory by marking it superseded |
| `memory_status` | Reports health, counts, latency, and maintenance state |
| `memory_explain` | Explains a retrieval or suppression decision |
| `memory_validate` | Checks database integrity and schema parity |

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
| Browser dashboard | Inspect local memories through a read-only loopback UI |

Some experimental tools require rollout flags such as `evolutionLedger`, `loreDoctor`, or `refreshableObservations`. They do not receive the same stability promise as the core.

## Hooks

The supported hooks are `onSessionStart`, `onUserPromptSubmitted`, and `onSessionEnd`. Passive telemetry and pre-tool observation hooks are experimental and default-off. `onPreMcpToolCall` is deferred and is not registered.

## Picking a tool

In Pi, start with `/lore status`, save a note with `/lore save <text>`, and search with `/lore search <query>`; the agent equivalents are `lore_save`, `lore_onboard`, `lore_recall`, and `lore_status`. In Copilot CLI, use `memory_search` for a known keyword, `lore_recall` for prompt-aware context, and `memory_explain` when you need to understand a match. Use `lore_reflect` for a synthesis request, and label any resulting decision as yours until you review its evidence.

For lifecycle definitions and the complete matrix, see the repository's support matrix. [How memory works](/guides/how-memory-works/) explains the retrieval path in plain language.
