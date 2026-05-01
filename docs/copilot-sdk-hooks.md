# Copilot CLI extension triggers from the bundled runtime

This report answers the question using the **installed Copilot CLI / bundled SDK source on this machine**, not the `~/.copilot` repo's past extension usage. The key local source is the bundled package under `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/` plus its docs and generated event schema.[^extensions-doc]

## Executive Summary

In the bundled Copilot CLI SDK, extensions have **two upstream trigger surfaces**: **named hooks** and the **generic session event stream**.[^join-config][^event-subscribe]

The **named hook contract is exactly six hooks** in this install: `onPreToolUse`, `onPostToolUse`, `onUserPromptSubmitted`, `onSessionStart`, `onSessionEnd`, and `onErrorOccurred`.[^hooks-type][^dispatch][^examples-hooks]

There is **no bundled named hook called `onSubagentStart`**. Instead, sub-agent activity is exposed through the generic event stream as events like `subagent.started`, `subagent.completed`, `subagent.failed`, `subagent.selected`, and `subagent.deselected`.[^dispatch][^subagent-events]

So the practical answer is: **if you want every supported extension trigger in this runtime, it is six named hooks plus event-driven triggers via `onEvent`/`session.on(...)`.** If a local extension defines `onSubagentStart`, that name is not part of the installed bundled hook dispatcher shown below.[^join-config][^dispatch]

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

The installed `types.d.ts` defines the `SessionHooks` interface with exactly six fields:[^hooks-type]

| Hook | Fires when | Notes |
|---|---|---|
| `onPreToolUse` | before a tool executes | can intercept tool execution[^hooks-type][^examples-hooks] |
| `onPostToolUse` | after a tool executes | can post-process tool results[^hooks-type][^examples-hooks] |
| `onUserPromptSubmitted` | when the user submits a prompt | can rewrite/augment the prompt[^hooks-type][^examples-hooks] |
| `onSessionStart` | when a session starts | startup/resume path[^hooks-type][^examples-hooks] |
| `onSessionEnd` | when a session ends | cleanup/logging path[^hooks-type][^examples-hooks] |
| `onErrorOccurred` | when an error occurs | can choose retry/skip/abort behavior[^hooks-type][^examples-hooks] |

The bundled runtime dispatch table in `copilot-sdk/index.js` confirms that only these six hook names are looked up by the SDK at hook invocation time.[^dispatch]

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

For the Copilot CLI source installed here, an extension can trigger off:

1. **Six named hooks**: `onPreToolUse`, `onPostToolUse`, `onUserPromptSubmitted`, `onSessionStart`, `onSessionEnd`, `onErrorOccurred`.[^hooks-type][^dispatch]
2. **Generic session events** via `onEvent` or `session.on(...)`, including sub-agent events and the wider event taxonomy.[^join-config][^event-subscribe][^subagent-events]

If the question behind this is "why do some extension behaviors never fire?", the most important upstream finding is that **`onSubagentStart` is not part of the bundled named hook dispatcher in this CLI install**.[^dispatch]

## Confidence Assessment

- **High confidence** on the six named hooks, because the installed type definitions, docs, and runtime dispatch table all agree.[^hooks-type][^dispatch][^examples-hooks]
- **High confidence** that sub-agent lifecycle is available as events, because the installed generated event schema enumerates those event names explicitly.[^subagent-events]
- **High confidence** that `onEvent` is part of the join/resume configuration surface for extensions, because `JoinSessionConfig` is derived from `ResumeSessionConfig`, which includes `onEvent`.[^join-config]
- **Medium confidence** on any undocumented hook names beyond these, because this report intentionally treats the bundled type surface and bundled dispatcher as the source of truth rather than inferring support from ad hoc local extension code.[^dispatch]

## Footnotes

[^extensions-doc]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/docs/extensions.md:1-23`; `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/docs/extensions.md:39-60`
[^join-config]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/extension.d.ts:1-19`; `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/types.d.ts:706-757`; `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/types.d.ts:762-766`
[^hooks-type]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/types.d.ts:504-535`
[^dispatch]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/index.js:3851-3863`
[^examples-hooks]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/docs/examples.md:146-159`; `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/docs/examples.md:301-315`
[^event-subscribe]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/session.d.ts:135-159`; `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/session.d.ts:224-232`
[^subagent-events]: `/opt/homebrew/lib/node_modules/@github/copilot/copilot-sdk/generated/session-events.d.ts:2091-2242`
