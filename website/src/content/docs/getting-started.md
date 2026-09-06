---
title: "Use with Copilot CLI"
description: "Install Lore as a Copilot CLI extension and verify your first memory."
section: "Start here"
order: 2
---

## Make yourself at home

You’ll need **Node.js 22.5 or later** and a Copilot CLI that supports extensions and session hooks. Lore runs on your machine and keeps its memory in a local SQLite database. No build step or runtime dependency installation needed.

macOS is the primary supported platform. Linux is expected to work; Windows is unsupported. Using Pi? Start with [Start with Pi](/guides/pi/) instead.

## 1. Add Lore to Copilot

Clone Lore into Copilot’s extensions directory:

```sh
git clone https://github.com/matt-riley/lore.git ~/.copilot/extensions/lore
```

## 2. Turn memory on

Create the config directory, then create or edit `~/.copilot/lore.json`. If that file already exists, keep it and add the Lore settings you want; do not replace it wholesale:

```sh
mkdir -p ~/.copilot
${EDITOR:-vi} ~/.copilot/lore.json
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
git -C ~/.copilot/extensions/lore pull
```

## If nothing appears

Run `memory_validate` and check that Node is at least 22.5.0. Confirm `~/.copilot/lore.json` contains `"enabled": true`, then restart Copilot CLI so it rescans extensions. [Troubleshooting](/guides/troubleshooting/) covers missing hooks, paths, and database errors.
