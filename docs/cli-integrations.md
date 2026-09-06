# Native CLI integrations

Codex CLI, Claude Code, and Google Antigravity CLI connect to Lore through local
command hooks. Hooks inject relevant memories before the model runs and extract
conversation evidence automatically as work completes. Direct memory operations
use `lore-cli.mjs tool`; there is no MCP server or background daemon.

## Install

The recommended entry point for every supported client is `npm run setup` from
the Lore checkout. It detects installed CLIs, asks which to install globally,
merges their settings, and enables shared memory. See the
[guided setup documentation](../website/src/content/docs/setup.md).
The commands below are advanced alternatives for project-scoped or manual setup,
not extra steps required after the guided installer.

Keep this checkout in a stable location. Enable Lore using the README's
[configuration instructions](../README.md#configure). These adapters honor
`LORE_HOME`, `LORE_CONFIG`, `LORE_ENABLED`, the XDG default home, and the existing
legacy-home fallback. They never migrate user data automatically.

The installer defaults to a dry run. Add `--write` to apply its configuration:

```sh
node scripts/install-hooks.mjs codex --project /absolute/project --write
node scripts/install-hooks.mjs claude --project /absolute/project --write
node scripts/install-hooks.mjs antigravity --global --write
```

Codex and Claude also accept `--global`. Target files:

| Client | Project installation | Global installation |
|---|---|---|
| Codex | `.codex/hooks.json` | `$CODEX_HOME/hooks.json`, normally `~/.codex/hooks.json` |
| Claude Code | `.claude/settings.local.json` | `$CLAUDE_CONFIG_DIR/settings.json`, normally `~/.claude/settings.json` |
| Antigravity CLI | Not used: the observed 1.1.27 target did not discover the documented `.agents/hooks.json` location in live checks | `~/.gemini/config/hooks.json` |

Run the installer for one scope per client to avoid duplicate hook invocation.
It records absolute, shell-quoted Node and entrypoint paths, merges existing
settings, and saves a uniquely named `.lore-backup-*` file before replacing a
config. An unrelated Antigravity group named `lore` is not overwritten. Repeat
installation is idempotent. Remove the same installation with `--remove --write`;
other handlers and settings remain intact. Remove hooks before moving the Lore
checkout or changing its Node installation, then reinstall from the new location.

Restart clients after installing. In Codex, open `/hooks` to review and trust the
exact hook definitions. Project configuration must also be trusted, and hooks
must not be disabled by local or managed settings. Claude may require approving
project hooks. Antigravity's `/hooks` lists the installed `lore` group.

For Antigravity 1.1.27, explicitly mount the current project:

```sh
agy --add-dir "$PWD"
```

Without `--add-dir`, this version can send an empty `workspacePaths` array and
run the hook from the shared config directory. Lore refuses to treat that config
directory as your project. `LORE_WORKSPACE=/absolute/project` is an explicit
fallback if needed. With multiple mounted directories, the first is Lore's
default repository; set `LORE_REPOSITORY` to select a different shared identifier.

## Lifecycle behavior

| Purpose | Codex | Claude Code | Antigravity CLI |
|---|---|---|---|
| Initialize / recall on startup, resume, compaction | `SessionStart` | `SessionStart` | `PreInvocation` |
| Recall for current work | `UserPromptSubmit` | `UserPromptSubmit` | `PreInvocation` reads the current user request from the supplied transcript |
| Capture completed work | `Stop`, `SessionEnd` | `Stop`, `SessionEnd` | `PostInvocation`, `Stop` |
| Capture before compaction | `PreCompact` | `PreCompact` | No equivalent documented event; captures after model invocations |
| Optional categorical tool observations | `PostToolUse` | `PostToolUse`, `PostToolUseFailure` | `PostToolUse` |

Codex and Claude receive `hookSpecificOutput.additionalContext`. Antigravity
receives `injectSteps` containing an `ephemeralMessage`. Lore context is wrapped
in `<lore_context>` so it is stripped if encountered during later extraction.
Lore never changes permission decisions, blocks a stop, requests continuation,
or launches tools from a hook. Failures return neutral JSON and a diagnostic on
stderr, allowing the agent to continue.

The adapters reuse Lore's deterministic recall, onboarding, retention, and
extraction code. Session IDs are namespaced by client. Repeated capture of the
same transcript is skipped using a content fingerprint in the episode's source
field. Changed conversations refresh the same session atomically. Concurrent
capture hooks serialize database writes, and semantic durability is checked
through an independent connection after commit.

Post-tool observations require `rollout.postToolUse`; error telemetry requires
`rollout.errorTelemetry`. Both remain default-off. They retain categories and
success/failure only, not command arguments, outputs, error messages, or stacks.
The adapters do not register permission or blocking pre-tool hooks.

## Repository scope and explicit memory operations

Lore derives `owner/repository` from the workspace's Git origin. Without an
origin, it uses the Git root name; outside Git, it uses the absolute workspace
path. Set `LORE_REPOSITORY` in the client environment to share an existing
identifier explicitly. All agents must use the same Lore home and repository
identifier to find the same repository-scoped memories.

The injected context tells the agent how to invoke these native commands. You
can also run them directly, supplying arguments as JSON on stdin:

```sh
printf '%s\n' '{"prompt":"What did we decide about storage?"}' | node /absolute/lore/lore-cli.mjs tool lore_recall
printf '%s\n' '{"content":"Use SQLite for this project","type":"user_preference","repository":"owner/repo"}' | node /absolute/lore/lore-cli.mjs tool lore_retain
printf '%s\n' '{"userName":"Alex"}' | node /absolute/lore/lore-cli.mjs tool lore_onboard
printf '%s\n' '{}' | node /absolute/lore/lore-cli.mjs tool memory_status
```

Available operations are `lore_recall`, `lore_retain`, `lore_onboard`,
`memory_search`, `memory_save`, `memory_forget`, and `memory_status`, declared in
the capability manifest. These are shell-invoked commands, not registered model
tools. They return a nonzero exit status for failures. Supply an explicit
`repository` if invoking from a directory other than your project. For global
preferences use `lore_retain` with `scope: "global"`.

## Compatibility and boundaries

These adapters are experimental. The available verification targets are Codex
CLI 0.153.4, Claude Code 2.1.263, and Antigravity CLI 1.1.27 on macOS with
Node's built-in SQLite/FTS5. These are available targets, not certifications or
established minimum versions. Older hosts may lack events or use a different
transcript format. This integration targets Claude Code, not Claude Desktop,
and Antigravity CLI, not the separate IDE extension.

Live verification on 2026-09-06 passed automatic memory injection and completed
session capture in all three CLI versions listed above, using isolated Lore
stores and synthetic prompts. Codex and Claude used native session/prompt/stop
hooks; Antigravity used shared hook configuration with an explicitly mounted
workspace. The temporary Antigravity verification hook was removed afterwards.

Only the transcript supplied for the active session is read. There is no archive
scan or import of unrelated sessions. Codex's conversation message records,
Claude's active parent chain, and Antigravity's completed user/model steps are
normalized to Lore's session artifacts. Thinking, reasoning, tool output, and
Antigravity's appended prompt metadata are excluded. Files and refs are not
inferred from arbitrary shell output. Automatic recall uses deterministic
retrieval; explicit `lore_recall` retains the shared tool's optional local query
expansion and embedding behavior.

Transcript snapshots are capped at 32 MiB and hook input at 1 MiB. Oversized or
malformed input produces a diagnostic and is not imported. An incomplete final
JSONL record is deferred until a later capture. Hosts that disable transcript
persistence cannot provide automatic extraction. Hook timeouts are 10 seconds,
except Codex `SessionEnd` at its 3-second maximum; `Stop` provides the normal
capture point before shutdown. Hook metrics, automatic maintenance, raw archive
backfill, and subagent-specific scope tracking are not wired into these adapters.

Memory storage remains local. Context returned to a host is sent to that host's
configured model as part of the conversation. Lore opens no listening socket.

These observations do not certify a client or establish its version floor. A
client can be promoted only after a 14-day release-candidate soak with
successful checks on at least 10 distinct days for that client.

## Verify

```sh
node --test tests/unit/cli-session-reader.test.mjs tests/unit/cli-transactions.test.mjs tests/smoke/cli-hooks.test.mjs
npm test
npm run lint
```

The smoke suite drives actual hook subprocesses with isolated homes, checks
cross-client recall and capture, duplicate events, direct commands, disabled
configuration, error handling, installation, and removal.

Optional live tests invoke an installed, authenticated CLI with synthetic data:

```sh
node scripts/verify-cli-hooks.mjs codex
node scripts/verify-cli-hooks.mjs claude
node scripts/verify-cli-hooks.mjs antigravity --global-hook-probe
```

These tests consume a small model request, keep an isolated Lore store and
outputs under a printed temporary directory, and require both recall of a seeded
word and capture of the resulting session. Codex's test bypasses hook trust only
for the test invocation with the generated hooks; sandbox and tool permissions
remain in force. Antigravity's test temporarily adds a unique shared hook group
restricted to its synthetic workspace and removes it in `finally`, preserving
other entries. Normal installation never bypasses host trust.

Native hook contracts:
[Codex](https://developers.openai.com/codex/hooks),
[Claude Code](https://code.claude.com/docs/en/hooks), and
[Antigravity](https://antigravity.google/docs/hooks).
