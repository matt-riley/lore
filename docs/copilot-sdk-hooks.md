# Copilot CLI extension triggers from the bundled runtime

This document is a local verification snapshot: it inspects the Copilot CLI / bundled SDK installation visible on this machine rather than asserting a universal install location. The primary local source examined here was the package found under `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/` (paths will vary by OS and package manager); consult `npm root -g` or your project's `node_modules` for the equivalent package location in your environment.[^extensions-doc]

## Executive Summary

In the bundled Copilot CLI SDK, extensions have **two upstream trigger surfaces**: **named hooks** and the **generic session event stream**.[^join-config][^event-subscribe]

The **named hook contract in this installed runtime is seven hooks**: `onPreToolUse`, `onPreMcpToolCall`, `onPostToolUse`, `onUserPromptSubmitted`, `onSessionStart`, `onSessionEnd`, and `onErrorOccurred`.[^hooks-type][^dispatch][^examples-hooks]

There is **no bundled named hook called `onSubagentStart`**. Instead, sub-agent activity is exposed through the generic event stream as events like `subagent.started`, `subagent.completed`, `subagent.failed`, `subagent.selected`, and `subagent.deselected`.[^dispatch][^subagent-events]

So the practical answer is: **if you want every supported extension trigger in this runtime, it is seven named hooks plus event-driven triggers via `onEvent`/`session.on(...)`.** If a local extension defines `onSubagentStart`, that name is not part of the installed bundled hook dispatcher shown below.[^join-config][^dispatch]

## Architecture / System Overview

```text
Copilot CLI
   |
   +--> forks extension process
   |
   +--> extension calls joinSession(...)
            |
            +--> registers tools
            +--> registers hooks
            +--> optionally subscribes to session events
```

The bundled extension docs describe extensions as separate Node.js processes that register **tools**, **hooks**, and **event listeners** over JSON-RPC/stdin-stdout. `joinSession(...)` is the extension entrypoint, and the returned session object can send messages, log, and subscribe to events.[^extensions-doc][^join-config]

## Named hook triggers

The installed `types.d.ts` defines the `SessionHooks` interface with seven fields:[^hooks-type]

| Hook | Fires when | Notes |
|---|---|---|
| `onPreToolUse` | before a tool executes | can intercept tool execution[^hooks-type][^examples-hooks] |
| `onPostToolUse` | after a tool executes | can post-process tool results[^hooks-type][^examples-hooks] |
| `onUserPromptSubmitted` | when the user submits a prompt | can rewrite/augment the prompt[^hooks-type][^examples-hooks] |
| `onSessionStart` | when a session starts | startup/resume path[^hooks-type][^examples-hooks] |
| `onSessionEnd` | when a session ends | cleanup/logging path[^hooks-type][^examples-hooks] |
| `onErrorOccurred` | when an error occurs | can choose retry/skip/abort behavior[^hooks-type][^examples-hooks] |

The bundled runtime dispatch table in `copilot-sdk/index.js` confirms that these seven hook names are looked up by the SDK at hook invocation time.[^dispatch]

## Event-driven triggers

Extensions can also attach a generic event handler with `onEvent?: SessionEventHandler` in session config, and the same session object exposes `session.on(eventType, handler)` for typed subscriptions or `session.on(handler)` for all events.[^join-config][^event-subscribe]

That matters because the bundled runtime exposes **many more event types than named hooks**. In particular, the generated event schema includes sub-agent lifecycle events:[^subagent-events]

1. `subagent.started`
2. `subagent.completed`
3. `subagent.failed`
4. `subagent.selected`
5. `subagent.deselected`

So in the installed runtime, **sub-agent reactions are event-driven, not hook-driven**.[^subagent-events]

## What is *not* a bundled named trigger

`onSubagentStart` does **not** appear in the bundled `SessionHooks` type, the bundled extension docs' available hook list, or the bundled runtime's hook dispatch map.[^hooks-type][^dispatch][^examples-hooks]

That means the installed runtime does **not** advertise `onSubagentStart` as a supported named hook surface. The closest supported upstream surface for that use case is subscribing to `subagent.started` and related sub-agent events through the session event stream.[^event-subscribe][^subagent-events]

## Bottom line

For the Copilot CLI installation inspected here, the authoritative named-hook contract in the bundled SDK contains seven hooks: `onPreToolUse`, `onPreMcpToolCall`, `onPostToolUse`, `onUserPromptSubmitted`, `onSessionStart`, `onSessionEnd`, and `onErrorOccurred`. In addition, the runtime exposes a wide event taxonomy that extensions may subscribe to via `onEvent` or `session.on(...)` (for example: `subagent.started`, `subagent.completed`, etc.).

Important: the filesystem paths referenced in this document are a local verification snapshot and will vary across machines, OSes, and package managers. To reproduce this verification in your environment, follow these steps:

1. Locate your node modules root (global or project-local):
   - `npm root -g` for global installs, or inspect `./node_modules` for local installs.
2. Inspect the Copilot SDK package at `<npm-root>/@github/copilot/copilot-sdk` (or the project-local equivalent): open `types.d.ts` to review the `SessionHooks` interface and open `index.js` to inspect the runtime dispatch table.
3. Confirm what the running SDK registers by resolving the package from Node (example):
   - `node -e "console.log(require.resolve('@github/copilot/copilot-sdk'))"`

These steps reproduce the same evidence used for this snapshot without assuming `/opt/homebrew` or any single install path.

If a local extension defines `onSubagentStart`, note that sub-agent lifecycle events are also available via the session event stream; they are present in the generated event schema but not advertised as an additional named hook in the bundled `SessionHooks` surface.[^dispatch]

## Phase 2 passive hooks in Lore

Lore Phase 2 adds two **passive, privacy-preserving** hooks. Both are **default-off** and must be explicitly opted-in via rollout flags.

### `onErrorOccurred` — error telemetry

| Property | Value |
|---|---|
| Rollout flag | `rollout.errorTelemetry` |
| Default | `false` |
| Phase 2 behavior | Passive observation only; **no** `errorHandling` override returned |
| Persisted table | `error_telemetry` |

**What is persisted:** `session_id`, `context_category` (e.g. `tool_use`, `network`, `permission`, `timeout`, `parse`, `unknown`), `recoverability` (`recoverable`, `unrecoverable`, `unknown`), `fingerprint` (non-reversible 16-char SHA-256 prefix), `created_at`.

**What is never persisted:** `error.message`, `error.stack`, tool arguments, tool results, file contents, command output, raw payload blobs.

The category and recoverability are derived from structural payload fields only (`error.name`, `error.code`, the categorical `context` descriptor, and `retryable`). The fingerprint is a SHA-256 hash of the derived categorical fields — it does not encode any free-text from the error.

Retention: the table is pruned by age (`maxAgeMs = 30 days`) and by global row count (`maxRowsGlobal = 500`) every 20 writes.

### `onPostToolUse` — post-tool-use observations

| Property | Value |
|---|---|
| Rollout flag | `rollout.postToolUse` |
| Default | `false` |
| Phase 2 behavior | Passive observation only; no tool result modification |
| Persisted table | `trajectory_artifact` (kind = `passive_hook_observation`) |

**What is derived:** `toolCategory` (one of `bash`, `file`, `search`, `network`, `memory`, `other`) — from the tool name only. `success` — from structural payload fields (`success`, `outcome`, `status`). `argsShape` — structural metadata (is the args value parseable? is it an object? is it empty?) from JSON-string-normalised `toolArgs`.

**What is never persisted:** raw `toolArgs` contents, `toolResult` contents, file contents, command output.

JSON-string `toolArgs` are parsed defensively but only to extract structural shape metadata. The raw args value is never written to the DB.

DB work is always enqueued via `spawnTrackedDeferredTask` (never synchronous in the hook body). Hook failures fail open and log only safe categorical metadata.

### Enabling passive hooks

```json
{
  "enabled": true,
  "rollout": {
    "errorTelemetry": true,
    "postToolUse": true
  }
}
```

Both flags default to `false` and have no parent-flag dependencies.

## Phase 3: sub-agent scoping and pre-tool guardrail

Lore Phase 3 adds **sub-agent scope tracking** via the generic session event stream and a **narrow, default-off pre-tool guardrail**. Both are strictly opt-in.

### Sub-agent scope tracking

**Verified SDK event surface (SDK ≥ 1.0.75, `generated/session-events.d.ts`):**

| Event type | Fires when | Payload fields used |
|---|---|---|
| `subagent.selected` | custom agent selected by user | `data.agentName`, `data.agentDisplayName` |
| `subagent.deselected` | custom agent deselected | _(empty data)_ |
| `subagent.started` | sub-agent execution started | `data.agentName`, `data.agentDisplayName` |
| `subagent.completed` | sub-agent execution completed successfully | _(triggers reset)_ |
| `subagent.failed` | sub-agent execution failed | _(triggers reset; `data.error` is never read)_ |

Lore subscribes via `session.on("subagent.selected", ...)` etc. (not named hooks). Subscriptions are registered unconditionally after `joinSession`; the rollout flag is checked inside each handler at event time.

| Property | Value |
|---|---|
| Rollout flag | `rollout.subagentScopeTracking` |
| Default | `false` |
| State storage | **In-memory only; never persisted** |
| Reset events | `deselected`, `completed`, `failed`, `onSessionStart`, `onSessionEnd` |
| Scope metadata | Additive: `{ activeSubagent: { name, displayName } }` — advisory, never blocks |

**Scope attachment:** When enabled and an agent is active, the active sub-agent name is included as additive context in `onPostToolUse` trajectory artifacts and as `additionalContext` in `onPreToolUse` guardrail output. It does not alter recall results, retention logic, or any core behavior.

**No-op guarantees:**
- Unknown event shapes or malformed payloads → safe no-op.
- `subagent.failed` `data.error` field is never read or retained.
- The tracker holds only `agentName` (max 128 chars) and `agentDisplayName` (max 256 chars).

### `onPreToolUse` guardrail

| Property | Value |
|---|---|
| Rollout flag | `rollout.preToolUseGuardrail` |
| Default | `false` |
| Phase 3 behavior | Observe-only; no `permissionDecision` returned |
| Allowlist | `lore_retain`, `lore_reflect`, `memory_save` |
| Timeout | 50 ms (hard internal timeout; fails open) |

Only tools in the explicit allowlist are observed. All others are unconditional no-ops.

When the guardrail is enabled and an allowlisted tool is called while a sub-agent is active (scope tracking also enabled), it returns `{ additionalContext: "[lore scope] active sub-agent: <name>" }`. In all other cases it returns `void`.

**Fail-open semantics:**
- Timeout (>50 ms) → returns `void`.
- Any thrown error → returns `void`.
- Malformed/absent payload → returns `void`.
- Disabled flag → returns `void`.
- `permissionDecision: "deny"` is **never** returned in Phase 3.
- Raw `toolArgs` are **never** read, logged, or persisted.

### `onPreMcpToolCall` — intentionally not registered

**Capability status:** Verified present in SDK ≥ 1.0.75 (`types.d.ts`). `PreMcpToolCallHookInput` has `{ serverName, toolName, arguments, _meta?, sessionId, timestamp, workingDirectory }`. Output can set `metaToUse: Record<string, unknown> | null` to inject or suppress request `_meta`.

**Phase 3 decision:** No concrete Lore MCP metadata use case is verified at this time. Lore exposes its tools via the SDK tool surface, not via MCP. Injecting Lore-specific `_meta` into outgoing MCP calls has no confirmed downstream consumer. This hook is **intentionally not registered** in Phase 3. A future phase may register it if a verified use case emerges.

### Enabling Phase 3 features

```json
{
  "enabled": true,
  "rollout": {
    "subagentScopeTracking": true,
    "preToolUseGuardrail": true
  }
}
```

Both flags default to `false`, are independent of other rollout flags, and have no effect when disabled.

## Confidence Assessment

- **High confidence** on the seven named hooks, because the installed type definitions, docs, and runtime dispatch table all agree.[^hooks-type][^dispatch][^examples-hooks]
- **High confidence** that sub-agent lifecycle is available as events, because the installed generated event schema enumerates those event names explicitly.[^subagent-events]
- **High confidence** that `onEvent` is part of the join/resume configuration surface for extensions, because `JoinSessionConfig` is derived from `ResumeSessionConfig`, which includes `onEvent`.[^join-config]
- **High confidence** on `onPreMcpToolCall` capability (SDK ≥ 1.0.75 types verify the interface and output shape), but **deferred** in Phase 3 due to no verified Lore-specific MCP metadata use case.
- **Medium confidence** on any undocumented hook names beyond these, because this report intentionally treats the bundled type surface and bundled dispatcher as the source of truth rather than inferring support from ad hoc local extension code.[^dispatch]

## Footnotes

[^extensions-doc]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/docs/extensions.md`
[^join-config]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/extension.d.ts`, `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/types.d.ts`
[^hooks-type]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/types.d.ts`
[^dispatch]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/index.js`
[^examples-hooks]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/docs/examples.md`
[^event-subscribe]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/session.d.ts`
[^subagent-events]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/generated/session-events.d.ts`
