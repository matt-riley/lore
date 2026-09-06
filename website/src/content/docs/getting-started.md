---
title: "Use with Copilot CLI"
description: "Install Lore as a Copilot CLI extension and verify your first memory."
section: "Start here"
order: 2
---

## Make yourself at home

You’ll need **Node.js 24.0.0 or later** and a Copilot CLI that supports extensions and session hooks. Lore runs on your machine and keeps its memory in a local SQLite database. No build step or runtime dependency installation needed.

macOS is the primary supported platform. Linux is best effort; Windows is unsupported. Using Pi? Start with [Start with Pi](/guides/pi/) instead. For Codex CLI, Claude Code, or Antigravity CLI, use the [native hooks guide](/guides/cli-integrations/).

## 1. Add Lore to Copilot

Use the [guided installer](/guides/setup/) and select Copilot CLI:

```sh
git clone https://github.com/matt-riley/lore.git ~/dev/lore
cd ~/dev/lore
npm run setup
```

## 2. Turn memory on

Setup enables memory for you while preserving existing settings. Continue to step 3. The instructions below are only needed for manual configuration.

For a fresh install, create the Lore config directory, then create or edit `~/.config/lore/lore.json`. If you already have Lore data under `~/.copilot`, [migrate it first](/guides/configuration/#migrating-an-existing-installation); creating an empty new Lore home selects it and disables the legacy fallback. If that file already exists, keep it and add the Lore settings you want; do not replace it wholesale. If you set `XDG_CONFIG_HOME`, it must be an absolute path:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/lore"
${EDITOR:-vi} "${XDG_CONFIG_HOME:-$HOME/.config}/lore/lore.json"
```

For a new file, start with this minimal config:

```json
{ "enabled": true }
```

You can review `lore.example.json` for a fuller example, but it enables session-start maintenance, gradual archive import, and several experimental rollout features. Local inference remains disabled. Merge any settings you need into an existing config rather than copying over it.

See [Configuration](/guides/configuration/) before changing optional features.

## 3. Save your first memory

Restart Copilot CLI so it rescans the extensions directory. Lore should initialise its local store from the session-start hook. Ask Copilot to use `memory_status`, or ask it to check Lore’s status. You should see database health and memory counts.

Then save a deliberately non-sensitive test note:

```text
Remember that this project uses the example Lore verification note.
```

Ask Copilot to call `memory_save`, and in a later session ask it to recall that note. `lore_recall` is the main recall tool; `memory_search` provides keyword search. Use `memory_explain` when you want to see why a prompt would receive particular context.

## Finish onboarding

Lore can ask for your preferred name naturally. You can also ask Copilot to call `lore_onboard` explicitly. This stores your name and Lore's assistant/style profile in the local store.

## Keep Lore up to date

Pull the latest changes, then restart Copilot CLI:

```sh
git -C ~/dev/lore pull
cd ~/dev/lore
npm run setup
```

## If nothing appears

Run `memory_validate` and check that Node is at least 24.0.0. Confirm the Lore config contains `"enabled": true`, then restart Copilot CLI so it rescans extensions. [Troubleshooting](/guides/troubleshooting/) covers missing hooks, paths, and database errors.
