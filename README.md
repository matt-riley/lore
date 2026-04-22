# Lore 🧠✨

**Lore** is a local-first memory and continuity extension for the GitHub Copilot CLI.
It helps Copilot remember useful context across sessions so you do not have to keep re-explaining your project, your recent decisions, or the thing that broke yesterday.

Lore runs entirely on your machine, plugs into Copilot CLI's extension hooks, and stores its derived memory in a local SQLite database. No cloud sync, no hosted service, no runtime dependency pile.

---

## What it does

Every time you work with Copilot, you build up context — decisions made, patterns discovered, blockers hit, things learned. Normally that context evaporates when a session ends. **Lore changes that.**

Lore quietly captures what matters from your sessions and surfaces it again when it's relevant. Ask about your work yesterday and Lore will remember. Ask about a pattern you keep hitting and Lore has examples. Ask about a decision from three weeks ago and Lore might have the answer.

At a glance, Lore can:

- recall prior work, decisions, and recent session context
- retain explicit notes and memories with scope controls
- explain why a given memory result was selected
- run bounded maintenance and backfill flows over the local session store
- expose an optional localhost-only browser dashboard for inspecting stored memories

**Zero runtime dependencies.** Lore is plain ESM built on Node's built-in `node:sqlite` module. No npm bloat. No surprises.

Lore has a stable core and an experimental ring. The support boundary for each surface lives in [`docs/support-matrix.md`](docs/support-matrix.md).

---

## Requirements

Lore keeps things simple, but it does expect a modern runtime:

- **Node.js:** 22.5.0 or later
- **GitHub Copilot CLI:** a version that supports the `extensions/` directory and the `onSessionStart`, `onUserPromptSubmitted`, and `onSessionEnd` hooks
- **Operating system:** macOS is the primary supported platform; Linux is expected to work; Windows is not supported

For the full compatibility contract, including browser and database notes, see [`docs/compatibility.md`](docs/compatibility.md).

---

## Install

The primary install layout is to clone Lore directly into your Copilot extensions directory:

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

---

## Configure

Copy the example config into your Copilot home:

```sh
cp lore.example.json ~/.copilot/lore.json
```

The checked-in example is the "all features on" starting point. It enables Lore itself, turns on the maintenance scheduler, enables session-start archive import, and opts into the current rollout-gated experimental surfaces.

If you want a quieter setup, copy the file first and then dial features back in `~/.copilot/lore.json`.

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

The canonical breakdown lives in [`docs/support-matrix.md`](docs/support-matrix.md), but the short version is:

- stable session hooks: `onSessionStart`, `onUserPromptSubmitted`, `onSessionEnd`
- stable core verbs such as `lore_recall`, `lore_retain`, `lore_onboard`, `memory_search`, `memory_save`, and `memory_forget`
- stable diagnostics such as `memory_status`, `memory_explain`, and `memory_validate`
- experimental reflection, backfill, portability, maintenance, browser, and self-diagnostic surfaces gated by rollout flags

For runtime and platform promises, see [`docs/compatibility.md`](docs/compatibility.md).

---

## Privacy and security

Lore is local-only by design.

It stores derived memory in `~/.copilot/lore.db`, reads Copilot CLI's raw `session-store.db` as input, and keeps configuration in `~/.copilot/lore.json`. Lore does **not** send memory content to a hosted service, sync your data to the cloud, or expose a network API.

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
| `npm run dev-install` | Copy a dev checkout into `~/.copilot/extensions/lore` |
| `npm run maintenance` | Run the maintenance script |
| `npm run browser` | Start the local browser dashboard |

High-level layout:

```text
extension.mjs          # Copilot CLI entrypoint
lib/                   # Core runtime and memory logic
browser/               # Local read-only dashboard
scripts/               # Dev and maintenance scripts
schemas/               # Config schema
docs/                  # Compatibility, support matrix, and release docs
tests/                 # Unit and smoke tests
```

---

## Docs and contributing

If you want the deeper contract, these are the main references:

- [docs/support-matrix.md](docs/support-matrix.md) — supported vs experimental surfaces
- [docs/compatibility.md](docs/compatibility.md) — runtime, OS, browser, and DB expectations
- [CONTRIBUTING.md](CONTRIBUTING.md) — local workflow and PR guidance
- [docs/releasing.md](docs/releasing.md) — release process and rollback guidance
- [CHANGELOG.md](CHANGELOG.md) — release history
- [SUPPORT.md](SUPPORT.md) — where to go for help
- [SECURITY.md](SECURITY.md) — security reporting and local risk model

Lore is still in the `0.x` stage, so the supported core is intentionally small and the experimental ring is where faster iteration happens. If you contribute, keep the support matrix, compatibility notes, and tool metadata in sync when behavior changes.
