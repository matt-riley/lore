---
title: "Codex, Claude & Antigravity"
description: "Connect Codex CLI, Claude Code, and Antigravity CLI using native lifecycle hooks—not MCP."
section: "Start here"
order: 2.5
---

Lore can bring the same local memory to **Codex CLI, Claude Code, and Google Antigravity CLI**. Native command hooks recall context before the model runs and capture useful conversation evidence as work completes. There is no MCP server, background daemon, or listening socket.

These integrations are **experimental**. They target Claude Code, not Claude Desktop, and Antigravity CLI, not its separate IDE integration. Pi and Copilot keep their existing native extensions; see [Start with Pi](/guides/pi/) or [Use with Copilot CLI](/guides/getting-started/).

## Recommended: guided setup

Use the same [guided installer](/guides/setup/) as Pi and Copilot:

```sh
git clone https://github.com/matt-riley/lore.git ~/dev/lore
cd ~/dev/lore
npm run setup
```

Choose the detected clients you want and confirm. Setup installs global hooks, enables shared memory, and preserves existing settings. Restart your clients and follow the reported trust steps; Antigravity still needs an explicitly mounted workspace. Then [verify a memory](#4-verify-a-memory).

The numbered instructions below are advanced alternatives for project-only hooks or manual setup; they are not additional steps after guided setup.

## 1. Keep Lore in a stable location

You need Node.js 24.0.0 or later with built-in SQLite/FTS5. macOS is the primary platform; Linux is best effort and Windows is unsupported. No build or runtime dependency installation is needed for Lore itself.

If you already have a Lore checkout, use it. Otherwise, clone into a location you intend to keep:

```sh
git clone https://github.com/matt-riley/lore.git /absolute/path/to/lore
cd /absolute/path/to/lore
```

Replace the absolute paths in this guide with your own. The installer records absolute Node and Lore paths, so moving either later requires reinstalling the hooks.

## 2. Enable the shared memory store

Create or edit `~/.config/lore/lore.json` and merge `"enabled": true` into the existing JSON object. A new file can contain:

```json
{ "enabled": true }
```

Keep existing settings. If you have older Lore data under `~/.copilot`, [migrate it first](/guides/configuration/#migrating-an-existing-installation): creating a new Lore home disables the legacy fallback. These adapters honor `LORE_HOME`, `LORE_CONFIG`, `LORE_ENABLED`, and the XDG default home; they never migrate your data automatically.

All clients use the same Lore database by default. See [Configuration](/guides/configuration/) for custom paths and optional features.

## 3. Install your client's hooks

Run these commands from the Lore checkout. The installer previews changes by default:

```sh
node scripts/install-hooks.mjs codex --project /absolute/project
```

Add `--write` to apply. Choose the command for your client:

```sh
node scripts/install-hooks.mjs codex --project /absolute/project --write
node scripts/install-hooks.mjs claude --project /absolute/project --write
node scripts/install-hooks.mjs antigravity --global --write
```

Codex and Claude also accept `--global`. Choose **one scope per client** to avoid duplicate hook invocations.

| Client | Project configuration | Global configuration |
| --- | --- | --- |
| Codex CLI | `.codex/hooks.json` | `$CODEX_HOME/hooks.json`, normally `~/.codex/hooks.json` |
| Claude Code | `.claude/settings.local.json` | `$CLAUDE_CONFIG_DIR/settings.json`, normally `~/.claude/settings.json` |
| Antigravity CLI | Not supported by Lore's installer | `~/.gemini/config/hooks.json` |

The installer merges existing handlers and settings, saves a uniquely named `.lore-backup-*` file before replacing a config, and is safe to repeat. It refuses to overwrite an unrelated Antigravity hook group named `lore`.

Restart your client. In Codex, use `/hooks` to review and trust the exact definitions; project configuration must also be trusted. Claude may require approval for project hooks. In Antigravity, `/hooks` should list the `lore` group. Installation does not bypass host trust or managed settings.

### Antigravity: mount your project explicitly

With the observed Antigravity CLI 1.1.27 target, launch from your project using:

```sh
agy --add-dir "$PWD"
```

That version did not discover the documented project hook location in live checks, so Lore uses global hooks. Without `--add-dir`, it can provide no workspace and run hooks from its shared config directory. Lore refuses to treat that directory as your project. Set `LORE_WORKSPACE=/absolute/project` in the client environment as an explicit fallback if needed.

With multiple mounted directories, Lore uses the first by default. Use `LORE_REPOSITORY` to select a different shared repository identifier.

## 4. Verify a memory

From your project directory, check the store using the absolute Lore path:

```sh
printf '%s\n' '{}' | node /absolute/path/to/lore/lore-cli.mjs tool memory_status
printf '%s\n' '{"content":"Use the example Lore verification note for this project","type":"user_preference"}' | node /absolute/path/to/lore/lore-cli.mjs tool lore_retain
printf '%s\n' '{"prompt":"What is the Lore verification note?"}' | node /absolute/path/to/lore/lore-cli.mjs tool lore_recall
```

Then start a fresh client session in that project and ask about the verification note. Relevant context should arrive automatically through the prompt hook. Complete a short conversation, then check `memory_status` again to verify session capture. Use synthetic, non-sensitive content for this check.

Explicit operations are **shell-invoked commands**, not registered model tools. Injected context explains how the agent can invoke them through its normal shell permissions. Available names are `lore_recall`, `lore_retain`, `lore_onboard`, `memory_search`, `memory_save`, `memory_forget`, and `memory_status`. Commands accept JSON on stdin and return a nonzero exit status on failure. See [Tools](/guides/tools/#native-cli-commands).

## What happens during a session

| Purpose | Codex CLI | Claude Code | Antigravity CLI |
| --- | --- | --- | --- |
| Startup context | `SessionStart` | `SessionStart` | First `PreInvocation` |
| Prompt-relevant recall | `UserPromptSubmit` | `UserPromptSubmit` | `PreInvocation` |
| Capture completed work | `Stop`, `SessionEnd` | `Stop`, `SessionEnd` | `PostInvocation`, `Stop` |
| Capture before compaction | `PreCompact` | `PreCompact` | No equivalent wired; capture follows invocations |

Repeated capture of an unchanged transcript is skipped. A changed conversation refreshes the same session atomically, and client-prefixed session IDs prevent collisions. Hook failures emit a diagnostic and let the agent continue. Lore does not change permission decisions, block a stop, request continuation, or launch tools from a hook.

Automatic recall is deterministic. Explicit `lore_recall` can use the shared tool's optional local query expansion and embeddings. Optional categorical tool observations (`rollout.postToolUse`) and error telemetry (`rollout.errorTelemetry`) are both off by default; neither retains raw arguments, outputs, error messages, or stacks.

### Sharing memory across clients

Clients must use the same Lore home and repository identifier to retrieve the same repository-scoped memories. Lore derives the identifier from Git's origin (`owner/repository`), falls back to the Git root name, or uses the absolute workspace path outside Git. Set `LORE_REPOSITORY` in the client environment to override it.

For direct commands run outside your project, pass an explicit `repository` argument. To retain a preference across projects, use `lore_retain` with `scope: "global"`.

### Capture and privacy boundaries

Only the supplied active-session transcript is read; these adapters do not scan archives or import unrelated sessions. Thinking, reasoning, tool output, injected Lore context, and Antigravity prompt metadata are excluded from extraction. Hosts that disable transcript persistence cannot provide automatic capture.

Hook input is limited to 1 MiB and transcript snapshots to 32 MiB. Malformed or oversized input is not imported; an unfinished final JSONL record is deferred. Hooks have a 10-second timeout, except Codex `SessionEnd` at 3 seconds; `Stop` is its normal capture point.

Memory storage stays local, but context injected into a conversation goes to the host's configured model. See [Privacy](/guides/privacy/) before using sensitive material.

## Compatibility and current limits

Available targets are Copilot CLI **1.0.80**, Pi **0.84.3**, Codex CLI **0.153.4**, Claude Code **2.1.263**, and Antigravity CLI **1.1.27**. These are targets, not certifications or established minimum requirements. No client is promoted until a 14-day release-candidate soak has successful checks on at least 10 distinct days for that client.

Automatic maintenance, raw archive backfill, host hook metrics, and subagent-specific scope tracking are not wired into these adapters. Use the separate [maintenance script](/guides/maintenance/) when needed. [Troubleshooting](/guides/troubleshooting/#native-cli-hooks-do-not-recall-or-capture) covers trust, paths, and missing transcripts.

## Update or remove

Pull updates in your Lore checkout and restart the client. Before moving the checkout or changing its Node installation, remove the old hooks, then reinstall from the new location:

```sh
node scripts/install-hooks.mjs codex --project /absolute/project --remove --write
node scripts/install-hooks.mjs claude --project /absolute/project --remove --write
node scripts/install-hooks.mjs antigravity --global --remove --write
```

Use the same client and scope you originally installed. Removal targets exact Lore handlers and preserves other settings; it does not delete your memory database.
