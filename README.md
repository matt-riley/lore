# Lore 🧠✨

**Lore** is local-first memory and continuity for GitHub Copilot CLI, Pi, Codex CLI, Claude Code, and Google Antigravity CLI.
It helps your coding agent remember useful context across sessions so you do not have to keep re-explaining your project, your recent decisions, or the thing that broke yesterday.

Lore runs on your machine, plugs into native agent lifecycle hooks, and stores its derived memory in a local SQLite database. No cloud sync, no hosted service, no runtime dependency pile.

---

## What it does

Every time you work with your coding agent, you build up context — decisions made, patterns discovered, blockers hit, things learned. Normally that context evaporates when a session ends. **Lore changes that.**

Lore quietly captures what matters from your sessions and surfaces it again when it's relevant. Ask about your work yesterday and Lore will remember. Ask about a pattern you keep hitting and Lore has examples. Ask about a decision from three weeks ago and Lore might have the answer.

At a glance, Lore can:

- recall prior work, decisions, and recent session context
- search memories by meaning, not just keywords, when a local embeddings endpoint is configured
- retain explicit notes and memories with scope controls
- explain why a given memory result was selected
- run bounded maintenance and backfill flows over the local session store
- expose an optional localhost-only browser dashboard for inspecting stored memories

**Zero runtime dependencies.** Lore is plain ESM built on Node's built-in `node:sqlite` module. No npm bloat. No surprises.

Lore has a stable core and an experimental ring. The support boundary for each surface lives in [`docs/support-matrix.md`](docs/support-matrix.md).

Capabilities vary by adapter: Codex, Claude Code, and Antigravity integrations are experimental and provide automatic recall/capture plus a small shell-command surface. They do not run automatic maintenance or archive backfill, or expose Copilot's full diagnostics and tool set.

---

## Requirements

Lore keeps things simple, but it does expect a modern runtime:

- **Node.js:** 22.5.0 or later
- **Agent:** Copilot CLI with extension hooks, Pi, or a hook-capable Codex CLI, Claude Code, or Antigravity CLI release (see [native CLI compatibility](docs/cli-integrations.md))
- **Operating system:** macOS is the primary supported platform; Linux is expected to work; Windows is not supported

For the full compatibility contract, including browser and database notes, see [`docs/compatibility.md`](docs/compatibility.md).

---

## Install

Choose your agent; you do not need Copilot installed to use the others:

| Agent | Integration | Setup |
| --- | --- | --- |
| Copilot CLI | Native extension | [Copilot installation](#github-copilot-cli) |
| Pi | Native extension and `/lore` commands | [Pi installation](#pi-coding-agent) |
| Codex CLI | Experimental native lifecycle hooks | [CLI hook installation](#codex-cli-claude-code-and-antigravity-cli) |
| Claude Code | Experimental native lifecycle hooks, not Claude Desktop | [CLI hook installation](#codex-cli-claude-code-and-antigravity-cli) |
| Antigravity CLI | Experimental native lifecycle hooks, not the IDE integration | [CLI hook installation](#codex-cli-claude-code-and-antigravity-cli) |

### GitHub Copilot CLI

Clone Lore directly into your Copilot extensions directory, then [enable Lore](#configure):

```sh
git clone https://github.com/matt-riley/lore.git ~/.copilot/extensions/lore
```

Then restart the Copilot CLI process so it rescans the extensions directory and loads Lore.

To update later:

```sh
cd ~/.copilot/extensions/lore
git pull
```

If you prefer to work from a separate development checkout, Lore also includes a helper that copies that checkout into the live extensions directory:

```sh
git clone https://github.com/matt-riley/lore.git ~/dev/lore
cd ~/dev/lore
node scripts/dev-install.mjs --dry-run
node scripts/dev-install.mjs
```

### Codex CLI, Claude Code, and Antigravity CLI

These experimental integrations use native command hooks for automatic recall
and session capture, not MCP. Use an existing stable Lore checkout or clone one:

```sh
git clone https://github.com/matt-riley/lore.git ~/dev/lore
cd ~/dev/lore
```

First [configure and enable Lore](#configure), then preview and install the
relevant hooks from that checkout. Replace `/path/to/project` with your project:

```sh
node scripts/install-hooks.mjs codex --project /path/to/project
node scripts/install-hooks.mjs codex --project /path/to/project --write
node scripts/install-hooks.mjs claude --project /path/to/project --write
node scripts/install-hooks.mjs antigravity --global --write
```

The installer defaults to a dry run; `--write` applies changes. Codex and Claude
also accept `--global`; use one scope per client to avoid duplicate invocations.
Codex requires reviewing and trusting the installed hooks with `/hooks` and
trusting project configuration. Claude may require project hook approval.
Restart the client after installing.

Antigravity 1.1.19 requires the global installation and an explicitly mounted
workspace: launch `agy --add-dir /path/to/project`. Its `/hooks` should list the
`lore` group. The documented project hook location was not discovered in live
checks for that version.

Existing hooks/settings are preserved, and modified files get backups. Use
`--remove --write` with the same client and scope to uninstall Lore's entries.
Remove and reinstall hooks if you move the checkout or change Node installations;
the installer records absolute paths.

All clients share Lore's config and database by default. Repository-scoped recall
also requires the same repository identifier, normally derived from Git origin.
Set `LORE_REPOSITORY` in the client environment to align it explicitly.

From your project directory, verify the store or recall a memory directly:

```sh
printf '%s\n' '{}' | node /absolute/path/to/lore/lore-cli.mjs tool memory_status
printf '%s\n' '{"prompt":"What did we decide about storage?"}' | node /absolute/path/to/lore/lore-cli.mjs tool lore_recall
```

These are shell-invoked commands, not registered model tools. Live automatic
recall and completed-session capture passed on macOS on 2026-09-06 with Codex
0.153.4, Claude Code 2.1.263, and Antigravity CLI 1.1.19. These are verified
versions, not established minimum versions.

See [native CLI integrations](docs/cli-integrations.md) for event mappings, global
installation, direct memory commands, verification, and limitations.

### Pi (coding agent)

Lore also ships an adapter for [Pi](https://pi.dev), the terminal coding agent. [`lore-pi.ts`](lore-pi.ts) maps Lore's hooks onto Pi events and exposes the shared memory store through `lore_save`, `lore_onboard`, `lore_recall`, and `lore_status`, plus a `/lore` command. It uses the same default config and database as the other adapters; no Copilot installation is required.

Install by cloning the repository into Pi's global extensions directory:

```sh
git clone https://github.com/matt-riley/lore.git ~/.pi/agent/extensions/lore
```

The repository's `package.json` declares the adapter under `"pi": { "extensions": ["./lore-pi.ts"] }`, so Pi auto-discovers it from `~/.pi/agent/extensions/` — no `settings.json` entry is required. Then reload Pi (`/reload`) or restart it.

To update later:

```sh
git -C ~/.pi/agent/extensions/lore pull
```

then `/reload` again.

After [enabling Lore](#configure), verify it loaded: you should see a `lore: memory ready` notification on startup, and `/lore status` should print memory counts and store information. The `lore_save`, `lore_onboard`, `lore_recall`, and `lore_status` tools are then available to the agent.

Requirements and notes:

- **Node.js 22.5+ on PATH.** Pi's extension runtime is bun, which does not implement `node:sqlite`; the adapter spawns your system `node` to run [`lore-server.mjs`](lore-server.mjs), which owns the database. If `node` is not on PATH (for example, a mise or fnm shim), set `LORE_NODE` to the absolute path.
- **`"enabled": true` in the Lore config.** All adapters use the shared config and store by default.
- Ambient recall is injected into the model context each prompt but hidden from the Pi TUI, cached per session, and pruned to the most recent injection so the memory cost stays bounded.
- The Pi worker buffers streamed responses and restarts on the next operation if it exits unexpectedly. Shutdown drains queued extraction before closing the database, with a bounded forced-stop fallback.
- Pi vector search refreshes cached embeddings when memory content, provider, model, or vector dimensions change. Each search indexes at most `min(localInference.embeddings.maxInputs, 24)` memories, plus the query, and has a 10-second default deadline. Cold stores fill incrementally across searches; errors fall back to lexical retrieval, and results must meet `minSimilarity`.
- Archive import scans a bounded number of entries in the background and resumes across batches. Its restart cursor lives beside the Lore database (`lore.db.pi-archive-cursor.json`); the source Pi session files remain read-only. Foreground requests can run between imported sessions.

---

## Configure

For a fresh install, create or edit the config in the Lore home. If you already have Lore data under `~/.copilot`, migrate it first; creating an empty new Lore home selects it and disables the legacy fallback. See [configuration and migration](docs/compatibility.md#lorejson-config) for the steps. If you set `XDG_CONFIG_HOME`, it must be an absolute path.

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/lore"
${EDITOR:-vi} "${XDG_CONFIG_HOME:-$HOME/.config}/lore/lore.json"
```

For a new file, start with:

```json
{ "enabled": true }
```

For an existing file, merge that key without replacing other settings. Restart your client, or `/reload` Pi, after enabling Lore.

[`lore.example.json`](lore.example.json) is a fuller example, not a minimal or "all features on" config. It enables the maintenance scheduler, session-start archive import, and several rollout-gated experimental surfaces, but leaves local inference disabled. Review and merge only the features you need; adapter-specific limits still apply.

`LORE_HOME` overrides the Lore directory, while `LORE_CONFIG` overrides the config file path without relocating the database. `LORE_COPILOT_HOME` changes where Lore looks for Copilot inputs such as `session-store.db` and instructions; legacy fallback still applies when no new Lore home exists.

---

## Optional features

The checked-in example config turns on most experimental features, but deliberately leaves local inference disabled. These are the main opt-in features worth knowing about.

### `localInference`

`localInference` optionally connects Lore to an OpenAI-compatible model server running on the same machine. It is deliberately disabled in both runtime defaults and `lore.example.json`, accepts loopback URLs only, and adds no runtime dependency.

```json
{
  "localInference": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:12434/v1",
    "model": "local-chat-model",
    "timeoutMs": 30000,
    "reflection": {
      "enabledByDefault": false
    },
    "queryExpansion": {
      "enabled": false,
      "maxTerms": 8
    },
    "contextCompression": {
      "enabled": false,
      "minInputTokens": 900,
      "targetTokens": 700,
      "maxSections": 8
    },
    "analysis": {
      "consolidation": {
        "enabled": true,
        "maxItems": 4
      },
      "contradictions": {
        "enabled": true,
        "maxItems": 4
      },
      "trends": {
        "enabled": true,
        "maxItems": 4,
        "minOccurrences": 2
      },
      "qualityEvaluation": {
        "enabled": false,
        "minSupport": 0.8,
        "minSpecificity": 0.6,
        "minUsefulness": 0.6
      }
    },
    "embeddings": {
      "enabled": true,
      "model": "local-embedding-model",
      "maxInputs": 24,
      "topK": 6,
      "minSimilarity": 0.2,
      "groundingMinSimilarity": 0.35
    }
  },
  "deferredExtraction": {
    "staleJobAfterMinutes": 30,
    "useLocalInference": true
  }
}
```

The provider and each consuming surface have separate opt-ins:

- Deferred extraction requires both `localInference.enabled: true` and `deferredExtraction.useLocalInference: true`.
- `lore_reflect` uses `localInference.reflection.enabledByDefault` when the call omits `useLocalInference`; an explicit `true` or `false` on the call always overrides the configured default.
- Query expansion is independently default-off. It changes retrieval terms only, retries the deterministic query when expansion finds no evidence, and cannot change routing, temporal scope, or repository eligibility.
- Model-backed reflection can return advisory consolidation proposals, possible contradictions or supersessions, and recurring trends. Every finding cites bounded evidence and never mutates trusted memory.
- Quality evaluation is independently default-off. When enabled, it rejects generated candidates below the configured support, specificity, or usefulness thresholds and falls back to deterministic reflection if no acceptable insight remains.
- Context compression is independently default-off. It preserves required identity, directive, and commitment sections, keeps source indexes, and falls back to the uncompressed deterministic capsule on any failure.
- Embedding-based evidence ranking is optional. `maxInputs` bounds the candidate pool, `topK` bounds evidence sent to the chat model, and `minSimilarity` removes weakly related evidence.
- When embeddings are enabled, Lore embeds generated claims in a second bounded pass and discards claims below `groundingMinSimilarity`. If no grounded insight remains, Lore returns the deterministic reflection.
- Embedding-based semantic memory search is opt-in via `embeddings.enabled` + `model`. When enabled, `lore_recall` appends meaning-ranked matches (cosine similarity) to its lexical results. Memory vectors are cached in the local `memory_embedding` table and reused across searches, so only the query and any new memories are re-embedded. Search fails open to lexical-only when the endpoint is unavailable.

Prompt-context hooks make no model calls by default. In the Copilot adapter, enabling query expansion or context compression permits bounded loopback-only inference during context assembly and can add latency. Codex, Claude Code, and Antigravity automatic recall remains deterministic; their explicit `lore_recall` command can use optional local query expansion and embeddings. Invalid output, missing citations, ungrounded claims, timeouts, or an unavailable model server are reported while Lore preserves its deterministic retrieval, capsule, extraction, or reflection result. Embedding vectors are cached locally in `memory_embedding`; Lore's inference requests go only to the configured loopback endpoint. Recalled context can separately reach your coding agent's model, as explained under [Privacy and security](#privacy-and-security).

### `traceRecorder`

`traceRecorder` records bounded samples of Lore's prompt-need classification and retrieval decisions so you can debug why context was injected, skipped, or filtered.

To enable it, turn on the rollout flag and then optionally tune the recorder limits:

```json
{
  "rollout": {
    "traceRecorder": true
  },
  "traceRecorder": {
    "maxRecords": 80,
    "persistDurableSample": true,
    "durableSampleRate": 0.5
  }
}
```

Use `memory_status` for recorder health and recent samples. `includeRecentTraces: true` appends recent in-memory entries, and `includeRecentTrajectoryArtifacts: true` shows persisted durable samples. For a single prompt, `memory_explain` is the quickest way to inspect the current retrieval decision.

### `maintenanceScheduler`

`maintenanceScheduler` is the opt-in maintenance loop for automated memory hygiene, deferred extraction processing, validation and replay corpus runs, backlog review, and index upkeep. On Copilot session start, Lore evaluates the maintenance plan and runs the bounded `memoryHygiene` and `deferredExtraction` tasks when they are enabled and due. The work is deferred so the session-start hook remains responsive. The same scheduler also powers manual or scripted sweeps through `maintenance_schedule_run` and `node scripts/run-maintenance.mjs`. Codex, Claude Code, and Antigravity hooks do not run automatic maintenance; use the standalone script.

> **Session hooks do not guarantee wall-clock cadence.** For reliable periodic upkeep independent of session frequency, wire `scripts/run-maintenance.mjs` into cron or launchd. See [`docs/maintenance-scheduling.md`](docs/maintenance-scheduling.md) for the full guide including cron and launchd examples, failure detection, and the isolated-database rule.

```json
{
  "maintenanceScheduler": {
    "enabled": true,
    "autoRunOnSessionStart": true,
    "staleRunAfterMinutes": 30,
    "maxTasksPerRun": 4,
    "memoryHygiene": {
      "mode": "shadow",
      "maxItems": 50,
      "includeGlobal": true
    },
    "tasks": {
      "memoryHygiene": true,
      "deferredExtraction": true,
      "validationCorpus": true,
      "replayCorpus": true,
      "backlogReview": true,
      "indexUpkeep": true
    }
  }
}
```

Memory hygiene is non-blocking and defaults to `off`. Use `shadow` first: Lore records candidates and unresolved evidence without changing memories. After reviewing a forced run, switch to `apply` to supersede only memories with deterministic completion evidence. Repo-scoped commit-promotion items may use local Git ancestry; global items always require an exact normalized target plus explicit later completion evidence. Later episode open items prevent automatic resolution.

Maintenance also self-recovers interrupted work. Deferred extraction jobs without lease metadata are reclaimed after `deferredExtraction.staleJobAfterMinutes` (default 30 minutes), while abandoned maintenance runs are marked failed after `maintenanceScheduler.staleRunAfterMinutes` (default 30 minutes). Reclaimed deferred jobs are immediately retryable, and stale workers cannot resurrect recovered maintenance runs or task state.

Every applied run uses an `auto-hygiene:<run-id>` marker and writes trajectory artifacts. To reverse one run, call `maintenance_schedule_run` with `action: "rollback_hygiene"` and the exact marker; Lore restores only rows carrying that marker and records a rollback audit artifact. The latest completed hygiene summary is added to the next Lore prompt or session context. It never denies write tools.

#### `sessionStartBackfill`

If you want Lore to import older session history gradually as you keep working, enable `maintenanceScheduler.sessionStartBackfill`:

```json
{
  "maintenanceScheduler": {
    "enabled": true,
    "sessionStartBackfill": {
      "enabled": true,
      "includeOtherRepositories": true,
      "batchSize": 25,
      "maxCandidates": 250
    }
  }
}
```

This uses the controlled backfill engine during Copilot session start, stays read-only against `session-store.db`, and reports progress in the CLI as it works through queued history. Pi has its own bounded archive importer. The Codex, Claude Code, and Antigravity adapters capture only the active supplied transcript, not session archives.

---

## Validate

Before trusting a config change, validate that the runtime defaults and schema still agree:

```sh
npm run validate-schema
# or
node scripts/validate-config-schema.mjs
```

To run the full test suite:

```sh
npm test
```

To run only the smoke tests:

```sh
npm run test:smoke
```

---

## First-run behavior

On first use, Lore bootstraps a lightweight profile so it can act more like a consistent teammate than a blank slate every session.

That includes:

- seeding a default personality profile
- asking for the user's preferred name at a natural moment
- leaving Lore's own final name to real onboarding rather than hardcoding one too early

If you want to complete or refresh that setup explicitly, use `lore_onboard`.

Lore can also optionally run a session-start archive import from the raw Copilot session store. When enabled, it reuses the controlled backfill engine, reports progress in the CLI, and stays read-only against `session-store.db`.

---

## Tool and surface overview

Lore has two main rings:

- **Supported core** for stable hooks and core memory tools
- **Experimental surfaces** for newer capabilities that are useful but still evolving

The canonical breakdown lives in [`docs/support-matrix.md`](docs/support-matrix.md). For the Copilot adapter, the short version is:

- stable session hooks: `onSessionStart`, `onUserPromptSubmitted`, `onSessionEnd`
- stable core verbs such as `lore_recall`, `lore_retain`, `lore_onboard`, `memory_search`, `memory_save`, and `memory_forget`
- stable diagnostics such as `memory_status`, `memory_explain`, and `memory_validate`
- experimental reflection, backfill, portability, maintenance, browser, and self-diagnostic surfaces gated by rollout flags

Pi exposes `lore_save`, `lore_onboard`, `lore_recall`, and `lore_status`, plus `/lore status`, `/lore save <text>`, and `/lore search <query>`.

The experimental Codex, Claude Code, and Antigravity adapters expose these shell commands through `lore-cli.mjs tool <name>`: `lore_recall`, `lore_retain`, `lore_onboard`, `memory_search`, `memory_save`, `memory_forget`, and `memory_status`. They do not expose `memory_explain`, `memory_validate`, or the experimental Copilot tools. Their native event names and lifecycle mappings are listed in the [CLI integration guide](docs/cli-integrations.md#lifecycle-behavior).

For runtime and platform promises, see [`docs/compatibility.md`](docs/compatibility.md).

### Portable exports and the OKF viewer

`memory_portable_bundle` accepts a `format` argument: `json` (default, machine-readable) or `okf`. The `okf` format writes an [Open Knowledge Format v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md) bundle -- one markdown file with YAML frontmatter per approved improvement artifact, plus a root `index.md` -- so approved Lore improvements can be reviewed, archived, or shared outside the CLI with any OKF-aware tool.

To browse an OKF bundle visually, render it into a self-contained HTML viewer:

```sh
npm run visualize-okf -- --bundle path/to/bundle --out viz.html
```

This produces a force-directed graph of the bundle's concepts (colored by type, with search, a type filter, and a detail panel showing backlinks), loading Cytoscape.js and marked from CDN at view time -- no npm runtime dependency is added. It mirrors the `visualize` subcommand of the OKF reference agent.

To import an OKF bundle back into Lore's own memory (making its concepts retrievable via `memory_search`), call `memory_portable_bundle` with `action: "import"` and `format: "okf"`:

```
memory_portable_bundle({ action: "import", bundlePath: "path/to/bundle", format: "okf" })
```

Each concept is retained as a `type: "okf_concept"` semantic memory row, tagged `okf_import`, at a lower default confidence (`0.7`) than self-authored memory (`memory_save`'s default is `0.9`) since it's externally sourced content. Import is always a manual, explicit tool call -- it is never wired into a hook or schedule. Re-importing the same bundle reinforces existing rows (matched by a stable `repository::conceptId` key) instead of duplicating them, but a later import does not overwrite already-stored content -- the first import wins. To revert an unwanted import: `memory_search(query: "okf_import", type: "okf_concept")` to find the rows, then `memory_forget(id: ..., supersededBy: "reverted okf import")` per row. `format: "json"` import is not yet implemented.

---

## Privacy and security

Lore is local-first by design.

It stores derived memory in `~/.config/lore/lore.db` (or `$XDG_CONFIG_HOME/lore/lore.db`), reads Copilot CLI's raw `session-store.db` from `~/.copilot` as input, and keeps configuration in `~/.config/lore/lore.json`. Lore does **not** sync memory to the cloud or expose a network API. If you explicitly enable `localInference`, selected session or reflection evidence is sent only to the configured loopback model endpoint.

Pi reads its own session files, normally under `~/.pi/agent/sessions`. Codex, Claude Code, and Antigravity hooks read only the active transcript supplied by the host, excluding thinking, reasoning, tool output, and injected Lore context from extraction. These adapters do not scan unrelated sessions. Optional post-tool/error observations are default-off and retain categories and success/failure, not raw arguments, outputs, error messages, or stacks.

**Local storage does not mean model context stays local.** Memories injected into a conversation, or read through a shell command by the agent, become context for the host's configured model, which may be cloud-hosted. Lore does not override the host's permissions or model privacy settings.

Existing installations remain compatible: when no Lore home is configured and the new home does not exist, Lore continues using a legacy `~/.copilot/lore.json` and `~/.copilot/lore.db` (including `~/.copilot/backups/lore`). Once the new Lore home exists, it is used. To migrate explicitly, stop Lore sessions and run `npm run migrate-home -- --from <old> --to <new>`; the command defaults to the legacy and new homes, copies the database snapshot, config, backups, and cursor without overwriting the destination, leaves the source untouched, and preserves custom configured paths. If you choose a custom destination, set `LORE_HOME` to it in each harness. Update or unset any `LORE_CONFIG` override that still points to the old config. Lore never migrates a real user's data automatically.

If you enable the optional browser dashboard, keep in mind:

- it is **read-only**
- it is meant for **loopback hosts only** (`127.0.0.1`, `localhost`, or `::1`)
- it has **no authentication**
- it can display sensitive local memory content, including code, notes, file paths, and decisions

Useful, yes. Internet-facing, absolutely not.

For the full security model, see [SECURITY.md](SECURITY.md).

---

## Scripts and repository layout

Lore is plain ESM on Node's built-in `node:sqlite`. There is no build step and no runtime install dance.

Useful commands:

| Command | What it does |
| --- | --- |
| `npm test` | Run the full unit + smoke test suite |
| `npm run test:smoke` | Run smoke tests only |
| `npm run validate-schema` | Validate config/schema parity |
| `npm run lint` | Lint runtime, adapters, browser, and scripts |
| `npm run dev-install` | Copy a dev checkout into `~/.copilot/extensions/lore` |
| `npm run install-hooks -- <client> [--global] [--write]` | Preview or install native Codex, Claude Code, or Antigravity lifecycle hooks |
| `npm run migrate-home -- --from <old> --to <new>` | Explicitly copy a Lore home without overwriting the destination |
| `npm run maintenance` | Run the maintenance script |
| `npm run browser` | Start the local browser dashboard |
| `npm run visualize-okf -- --bundle <dir>` | Render an interactive `viz.html` for an OKF-format `memory_portable_bundle` export |

High-level layout:

```text
extension.mjs          # Copilot CLI entrypoint
lore-pi.ts             # Pi (coding agent) entrypoint
lore-server.mjs        # JSON-lines server backing the Pi adapter
lore-cli.mjs           # Native Codex, Claude, and Antigravity hooks/direct commands
lib/                   # Core runtime and memory logic
browser/               # Local read-only dashboard
scripts/               # Dev and maintenance scripts
schemas/               # Config schema
docs/                  # Compatibility, support matrix, and release docs
tests/                 # Unit and smoke tests
website/               # Separate Astro documentation site and interactive examples
```

---

## Docs and contributing

The [documentation website](website/README.md) is a separate Astro site with setup guides for all five agents and an interactive memory walkthrough. It requires Node.js 22.12+ and pnpm 11.24.0, unlike Lore's build-free runtime. Run it locally with `cd website && pnpm install --frozen-lockfile && pnpm dev`; its own README covers checks and Cloudflare Workers static-asset hosting.

If you want the deeper contract, these are the main references:

- [docs/support-matrix.md](docs/support-matrix.md) — supported vs experimental surfaces
- [docs/compatibility.md](docs/compatibility.md) — runtime, OS, browser, and DB expectations
- [docs/cli-integrations.md](docs/cli-integrations.md) — native Codex, Claude Code, and Antigravity setup, lifecycle behavior, and verification
- [CONTRIBUTING.md](CONTRIBUTING.md) — local workflow and PR guidance
- [docs/releasing.md](docs/releasing.md) — release process and rollback guidance
- [CHANGELOG.md](CHANGELOG.md) — release history
- [SUPPORT.md](SUPPORT.md) — where to go for help
- [SECURITY.md](SECURITY.md) — security reporting and local risk model

Lore is still in the `0.x` stage, so the supported core is intentionally small and the experimental ring is where faster iteration happens. If you contribute, keep the support matrix, compatibility notes, and tool metadata in sync when behavior changes.
