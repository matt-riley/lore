---
title: "Troubleshooting"
description: "Diagnose the common installation, retrieval, database, and local model problems."
section: "Reference"
order: 7
---

Start with the smallest check that matches the symptom. Lore keeps useful diagnostics local and does not need access to your database contents for these checks.

## Lore does not load

Check Node and configuration:

```sh
node --version
node -e 'console.log(process.versions.node)'
```

Node must be 22.5.0 or later. Confirm `~/.config/lore/lore.json` exists and includes `"enabled": true`. Restart Copilot CLI after installing or updating the extension so it rescans `~/.copilot/extensions/`.

## Hooks seem silent

Lore depends on Copilot CLI extension support for `onSessionStart`, `onUserPromptSubmitted`, and `onSessionEnd`. If the CLI is too old to support the extension directory or these hooks, update the CLI. Ask for `memory_status` after starting a fresh session.

## Recall is empty

Save a small test note with `memory_save`, then search it with `memory_search`. If that works but ambient recall does not, use `memory_explain` for the exact prompt: it reports eligible scopes and filtered branches. Repository-scoped memories do not automatically cross repository boundaries.

The `memory_explain` and `memory_validate` advice on this page is for Copilot CLI. Native CLI adapters expose a smaller [command set](/guides/tools/#native-cli-commands); use `memory_status` and `lore_recall` there.

## Native CLI hooks do not recall or capture

For Codex CLI, Claude Code, and Antigravity CLI, check the [installation guide](/guides/cli-integrations/) first:

- The installer is a dry run unless you pass `--write`. Restart the host after applying hooks, and install only one scope per client.
- In Codex, review and trust the definitions with `/hooks` and trust project configuration. Check that local or managed settings have not disabled hooks. Claude may require project hook approval.
- In Antigravity 1.1.19, use the global installation and launch with `agy --add-dir "$PWD"` from your project. Check `/hooks` for the `lore` group. An empty workspace is not treated as the shared config directory; `LORE_WORKSPACE` can provide an explicit fallback.
- If you moved Lore or changed Node installations, remove and reinstall hooks so their absolute paths are correct.
- Check that clients use the same Lore home and repository identifier. `LORE_REPOSITORY` can align the scope explicitly.

Run `memory_status` and a synthetic `lore_recall` through `lore-cli.mjs tool` from the project directory. If direct recall works but automatic recall does not, inspect the host's hook diagnostics. Lore fails open, so the agent continuing normally is not proof that hooks ran.

For missing capture, confirm the host persists and supplies the active transcript. Malformed or oversized transcripts (over 32 MiB) are not imported; an unfinished last JSONL record waits for a later capture. The verified host versions and unsupported features are listed in [Compatibility and current limits](/guides/cli-integrations/#compatibility-and-current-limits).

## A database or schema error appears

Run `memory_validate` in a session. Existing databases use additive migrations. If validation reports drift on an old database, run `maintenance_schedule_run` in dry-run mode and inspect the result before changing settings. Do not manually downgrade the schema.

## Local inference fails

Confirm the server is running at the configured loopback URL and exposes `/v1/chat/completions`. Check that `model` is non-empty and that the URL has no credentials or non-loopback host. Inference is optional: timeouts and malformed responses should preserve deterministic retrieval and reflection.

## Pi says Node is missing

Pi's bun runtime cannot provide `node:sqlite`. Put Node 22.5+ on Pi's `PATH`, or set `LORE_NODE` to an absolute Node path, then `/reload`.

## Maintenance did not run

Session-start maintenance is due-based and only runs when a session begins. It is not a daemon. Use `node scripts/run-maintenance.mjs --status` and `--dry-run`, then schedule the script with an absolute Node path if you need wall-clock execution. Check both stdout and stderr logs for unknown task names or a non-zero exit.

The Codex, Claude Code, and Antigravity adapters do not run automatic maintenance or archive backfill. Use the standalone script rather than expecting their startup hooks to perform it.

## Dashboard cannot be reached

The browser dashboard is experimental, read-only, unauthenticated, and loopback-only. Start it with `npm run browser`; use `127.0.0.1`, `localhost`, or `::1`. It is intentionally not available through a LAN address.

## Still stuck?

Capture the Node version, Lore version or checkout revision, operating system, exact symptom, and output from `memory_status` or `memory_validate`. Do not attach `lore.db`, `lore.json`, or raw session data; they can contain sensitive work details. See the project's support guidance before opening an issue.
