---
title: "Start with Pi"
description: "Install Lore as a Pi extension and build a daily memory habit in minutes."
section: "Start here"
order: 1
---

Lore is a local memory companion for [Pi](https://pi.dev), your terminal coding agent. It captures useful decisions, preferences, gotchas, and open loops so your next session starts with continuity instead of a blank slate. Copilot CLI support is available too, but you can use this guide without installing Copilot CLI.

Try the [memory playground](/playground/) after setup for small recall and save demos.

Also use Codex CLI, Claude Code, or Antigravity CLI? Their [native lifecycle integrations](/guides/cli-integrations/) can connect to the same local memory store without MCP.

## Install the adapter

You need Node.js 22.5.0 or later on `PATH`. Pi runs extensions with bun, while Lore's SQLite server uses Node's built-in `node:sqlite` module.

Clone Lore into Pi's global extensions directory:

```sh
git clone https://github.com/matt-riley/lore.git ~/.pi/agent/extensions/lore
```

Pi discovers `lore-pi.ts` through the repository's `package.json`. No `settings.json` entry is required.

Update it later with:

```sh
git -C ~/.pi/agent/extensions/lore pull
```

Reload Pi again after an update.

## Enable Lore without replacing your config

For a fresh install, create or edit the shared config without replacing any settings you already use. If you already have Lore data under `~/.copilot`, [migrate it first](/guides/configuration/#migrating-an-existing-installation); creating an empty new Lore home selects it and disables the legacy fallback. If you set `XDG_CONFIG_HOME`, it must be an absolute path:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/lore"
${EDITOR:-vi} "${XDG_CONFIG_HOME:-$HOME/.config}/lore/lore.json"
```

Merge this key into the JSON object:

```json
{ "enabled": true }
```

The adapter uses `~/.pi/agent/sessions` by default. After saving the config, run `/reload` (or restart Pi) so the adapter retries startup with the new setting.

## Shared storage

The adapter uses:

| Item | Default path |
| --- | --- |
| Configuration | `~/.config/lore/lore.json` |
| Derived memory | `~/.config/lore/lore.db` |
| Pi sessions | `~/.pi/agent/sessions` |

## Verify Pi loaded Lore

On startup, Pi should show a `lore: memory ready` notification. Run:

```text
/lore status
```

The adapter exposes `lore_save`, `lore_onboard`, `lore_recall`, and `lore_status` to the agent, plus the `/lore` command. The three useful slash-command forms are:

```text
/lore status
/lore save The API client uses the retry budget agreed today.
/lore search retry budget
```

`/lore save <text>` records the note for the current repository and uses the `user_preference` type. `lore_save` also accepts a memory type, an explicit repository, and an explicit scope when the agent calls it; Lore may classify scope from the content and type when scope is omitted. Use `lore_onboard` to save your preferred name and interaction style.

## If Pi cannot find Node

Pi's extension runtime is bun, but bun does not provide Node's `node:sqlite`. The adapter therefore starts Lore's server with the system `node` executable. Node 22.5.0 or later must be on `PATH`. If your Node installation uses mise, fnm, or another shim that Pi cannot see, set `LORE_NODE` to the absolute Node path.

## Pi-specific behavior

Ambient recall is added to model context and hidden from the Pi TUI. It is cached per session and pruned to keep the memory cost bounded. The worker buffers streamed responses and can restart after an unexpected exit. Pi archive import is bounded, resumable, and reads the source session files without modifying them.

Vector search and archive import are optional behavior governed by the shared configuration. See [How memory works](/guides/how-memory-works/) and [Local inference](/guides/local-inference/).
