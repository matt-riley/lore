---
title: "Install Lore"
description: "One guided installer for Pi, Copilot, Codex, Claude Code, and Antigravity CLI."
section: "Start here"
order: 0
---

Run one command, choose your coding agents, and let Lore set up their integrations and shared memory. You do not need to install Copilot to use another client.

## Run the installer

You need Node.js 22.5 or later with built-in SQLite/FTS5 and at least one supported CLI installed on `PATH`. macOS is the primary platform; Linux is expected to work and Windows is unsupported.

```sh
git clone https://github.com/matt-riley/lore.git ~/dev/lore
cd ~/dev/lore
npm run setup
```

If you already have a Lore checkout, run `npm run setup` there. No npm dependency installation or runtime build is needed.

The installer lists detected clients: Copilot (`copilot`), Pi (`pi`), Codex (`codex`), Claude Code (`claude`), and Antigravity CLI (`agy`). Enter names or numbers separated by commas, or `all`. Review the installation paths and confirm with `y`. An empty selection or declining confirmation cancels without changes.

Detection means the executable is available, not that the client is authenticated or its version is compatible. Codex, Claude Code, and Antigravity integrations remain [experimental](/guides/cli-integrations/#compatibility-and-current-limits). Claude Desktop and the Antigravity IDE integration are not targets.

## What setup handles

- Installs globally for only your selected clients: extension directory copies for Copilot/Pi, native command-hook configuration for Codex/Claude/Antigravity. No MCP server is installed.
- Enables Lore in the resolved shared config, preserving other settings. New configs enable only Lore; no experimental rollout flags are opted into.
- Preserves existing memory paths, including legacy fallback. It does not migrate or delete your database.
- Backs up changed configs and replaced Lore extension directories under `<Lore home>/install-backups/<run-id>/`, outside extension discovery paths.
- Checks planned configs before writing, refuses unrelated extension directories and symlink targets, and restores completed changes if installation fails.
- Verifies written configuration and extension entrypoints. This is an installation check, not a live authenticated model test.

Keep the source checkout and Node installation in place: native hook commands reference their absolute paths. Existing modified Antigravity groups named `lore` require manual review rather than being overwritten. Avoid installing both global and project hooks for the same client.

Local memories can become context for your client's configured model. Read [Privacy](/guides/privacy/) before using sensitive material.

## Finish in your client

Some steps are controlled by the host and cannot be bypassed by an installer:

| Client | After setup |
| --- | --- |
| Copilot CLI | Restart for extension discovery; check `memory_status`. |
| Pi | `/reload` or restart; look for `lore: memory ready`, then run `/lore status`. |
| Codex CLI | Restart, then review and trust Lore's definitions in `/hooks`. Managed settings can still disable hooks. |
| Claude Code | Restart and approve hooks if prompted. |
| Antigravity CLI | Restart with `agy --add-dir /absolute/project`; `/hooks` should list `lore`. |

For daily use and verification, see [Pi](/guides/pi/), [Copilot CLI](/guides/getting-started/), or [Codex, Claude & Antigravity](/guides/cli-integrations/).

## Preview or automate

```sh
npm run setup -- --clients all --dry-run
npm run setup -- --clients codex,claude --yes
npm run setup -- --help
```

`--dry-run` never writes. `--yes` skips confirmation but requires an explicit `--clients` selection. `all` selects all detected supported clients. An unavailable or unknown client causes an error; setup does not install the CLI itself.

## Existing and custom installations

Setup honors `LORE_HOME`, `LORE_CONFIG`, `LORE_COPILOT_HOME`, and absolute `XDG_CONFIG_HOME` through the shared path resolver. Native client settings also honor `CODEX_HOME` and `CLAUDE_CONFIG_DIR`; Pi's extension destination honors `PI_CODING_AGENT_DIR`. Use the same environment when launching your clients. If `LORE_ENABLED` disables Lore, unset it or set it to `true` first.

Malformed JSON, overlapping destinations, and unrelated existing directories stop setup before installation. Review the reported file; do not replace it wholesale. Backups preserve the previous contents if you need to recover a replaced install or config; each run's `manifest.json` maps numbered backups to their original paths. Treat backups as sensitive data.

If a CLI is missing from the list, put its executable on `PATH` and rerun. Shell aliases alone are not detected. Pi's worker also needs Node on `PATH`, or an explicit `LORE_NODE`.

## Update

Pull your source checkout and rerun the same installer:

```sh
git -C ~/dev/lore pull
cd ~/dev/lore
npm run setup
```

Repeated setup refreshes selected extension copies and merges exact hook definitions without duplicating them. Restart or reload the clients afterwards. Before moving the checkout or changing Node installations, remove old native hook definitions using the [advanced removal instructions](/guides/cli-integrations/#update-or-remove), then rerun setup from the new location.
