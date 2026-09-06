---
title: "Privacy"
description: "Understand what Lore stores, what it reads, and when data can reach a local model."
section: "Reference"
order: 9
---

Lore is local-first. By default it makes no non-loopback outbound network calls, does not sync to the cloud, and does not share memory between machines or users.

## Files Lore uses

| File | Role |
| --- | --- |
| `~/.config/lore/lore.db` | Derived memories, summaries, notes, provenance, and maintenance artifacts |
| `~/.config/lore/lore.json` | Configuration and preferences |
| `~/.copilot/session-store.db` | Raw Copilot session input; Lore reads it and never writes it |

These stores can contain code excerpts, file paths, decisions, and session notes. Treat them as sensitive local data.

## Local inference is explicit

When `localInference.enabled` is true, selected bounded session or reflection evidence is sent to the configured loopback model endpoint. Lore allows only `127.0.0.1`, `localhost`, and `::1`, and rejects credentials embedded in the URL. Embedding vectors are cached locally in `memory_embedding`.

Prompt hooks make no model calls by default. Query expansion, context compression, embeddings, deferred model extraction, and model-backed reflection each have separate opt-ins. If a local provider fails, Lore keeps its deterministic result.

## The dashboard

The optional browser dashboard is experimental, read-only, unauthenticated, and bound to loopback hosts. It can display the full contents of the memory store. Do not proxy, forward, or bind it to a LAN address.

## Protect local files

On a single-user machine, you may restrict permissions:

```sh
chmod 600 ~/.config/lore/lore.db ~/.config/lore/lore.json
```

Backups and exported portability bundles can contain the same sensitive material. Keep them private and remove them using your normal secure local-data policy when they are no longer needed.

## Review before sharing

`memory_portable_bundle` is experimental and exports approved improvement artifacts rather than the full raw corpus. Even so, review every generated JSON or OKF bundle before putting it in a repository or sending it to another person. OKF import is manual and only the OKF format supports import today.

See [Local inference](/guides/local-inference/) for provider boundaries and [Troubleshooting](/guides/troubleshooting/) for safe issue reports.
