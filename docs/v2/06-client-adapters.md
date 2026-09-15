# Slice 6A: thin clients and compatible commands

Status: planned. Depends on G4 and migration/recovery implementation for real-data trials. Exit contributes to G5.
References: `extension.mjs`, `lore-pi.ts`, `lib/clients/setup.mjs`, `lib/clients/cli-runtime.mjs`, `lib/runtime/slash-dispatch.mjs`, `lib/capabilities/capability-manifest.mjs`.

## Outcome and rollout order

Integrate Pi first, then Copilot, Codex, Claude Code and Antigravity, one host at a time. G1 already proves Node/Bun socket transport and a disposable native prompt-hook process. Production adapters add host lifecycle, supported notifications and compatible tools; they do not add a second store or extractor.

Adapters own only host event/input translation, bounded repository identity resolution, capability negotiation, request cancellation, uncertain-write journals and output presentation. All ranking, rendering, capture parsing, extraction, memory authority and database writes live in Rust.

An early synthetic Pi trial may use manually launched lored. Real-user cutover requires the installer/service and migration prerequisites in stage 7. Do not replace real client settings merely to test an adapter.

## Interface mapping

| Surface | v2 mapping | Compatibility obligation |
| --- | --- | --- |
| Copilot native extension | Small ESM socket adapter | Native hooks, nine canonical model tools, /lore commands, supported UI notifications |
| Pi extension | Small TS adapter using the validated Node/Bun HTTP path | TypeBox tool schemas, lifecycle cancellation, slash commands; no per-Pi DB/model worker |
| Codex native CLI hooks | Rust `lore hook codex <event>` | Existing hook stdin/stdout contract and neutral failure |
| Claude Code native CLI hooks | Rust `lore hook claude <event>` | Existing hook contract, including PostToolUseFailure |
| Antigravity hooks | Rust `lore hook antigravity <event>` | Configured/mounted workspace behavior and host-specific Stop response |
| Human command | `lore <verb> [arguments]` | Preserve aliases, positional text and JSON argument forms |
| Script tool | `lore tool <canonical-or-alias>` with JSON stdin | Existing text output by default; explicit `--output json` for v2 structured result |
| Shell capture compatibility | `lore capture --resume --client <client> --session <id>` | Send bounded source hint/run query, never scan sources in the hook process |

Only Copilot and Pi register model tools, exactly: lore_recall, lore_retain, lore_onboard, lore_search, lore_forget, lore_status, lore_explain, lore_validate, lore_correct. Do not register legacy aliases as extra model tools. All 26 canonical operations remain available via human/slash/script dispatch with their existing flags.

Use a shared checked-in JSON capability catalog generated from the Rust operation schema during development, with golden comparison to the v1 manifest until retirement. Host adapters consume the catalog without a runtime code-generation/build step. JSON Schema-to-TypeBox conversion must preserve enums, nullable fields, nested arrays and bounds. Canonical dispatch happens once in the daemon.

Preserve the current `--json` input option; do not repurpose it to mean output. `--output json` is the new structured-output selector. Malformed JSON and invalid preview/apply requests fail before any write. Human/script errors use nonzero exit status; hooks follow host neutral-response conventions and do not crash the host.

## Hook mapping and timing

| Client | Events at planning baseline | Daemon behavior |
| --- | --- | --- |
| Copilot | onSessionStart, onUserPromptSubmitted, onSessionEnd; gated onErrorOccurred, onPostToolUse, onPreToolUse | Capsule/Recall, source hints and categorical optional events |
| Pi | session_start, before_agent_start, context, session_compact, session_tree, tool_call, tool_result, agent_end, session_shutdown | Capsule/Recall, branch/compaction/source hints, gated tool observations, cancel session-owned requests on switch/shutdown |
| Codex | SessionStart, UserPromptSubmit, Stop, SessionEnd, PreCompact, PostToolUse | Capsule/Recall and lifecycle/capture hints |
| Claude Code | SessionStart, UserPromptSubmit, Stop, SessionEnd, PreCompact, PostToolUse, PostToolUseFailure | Same plus failure attribution |
| Antigravity | PreInvocation, PostInvocation, Stop, PostToolUse | Recall/capture mapping based on validated host contract |

Verify exact Pi/Copilot event registration against the installed synthetic host before certification; the shared behavior above is the contract, not invented support for future events. Deferred Copilot onPreMcpToolCall stays unregistered.

Start the 200 ms prompt timer before resolving identity and opening a socket. Native process-start cost is measured by the parent harness. Cache verified repository identity per session; invalidate on workspace switch or observed Git identity/config change. First resolution uses a bounded Git subprocess, cancelled with the remaining deadline. If unresolved, use explicit global-only recall and diagnose the missing scope; never guess a basename.

Status negotiation uses the same prompt deadline, not a second allowance. Cache capabilities/store identity for the connection/session; revalidate after reconnect or daemon-instance change. An identity mismatch is an error, not an instruction to overwrite the expected store. Caller-required features unavailable on this daemon fail explicitly.

Prompt paths never spawn/start/restart the daemon or wait for archive, extraction, PrepareQuery or provider warmup. If the socket is missing, fail immediately. If the service is slow/unavailable, cancel by deadline and provide the host's neutral response. Preserve Antigravity Stop's existing `decision: stop` neutral form; other empty responses follow the fixture.

Use supported host notifications, deduplicated to one warning per category/session with recovery notice. Do not write daemon logs into a host terminal renderer. Native human commands can print concise stderr diagnostics; protocol stdout stays valid host JSON or requested tool output.

## Cancellation, reload and session isolation

Every session owns its in-flight requests, not the daemon. On reload/session switch/shutdown cancel and await local request cleanup within the existing deadline, remove listeners and close idle adapter sockets. One adapter shutdown must never kill lored or another client's request.

Do not cache complete recall results across prompts initially. Any later capsule/result cache needs memory revision, scope, expiry and suppression invalidation; identical prompt text alone is insufficient. Do not substitute the previous turn's query vector for the current query.

Send only completed submitted prompts. Never send partial keystrokes. Transcript hooks send source hints and categorical observations, not unlimited tool inputs/results. Source discovery still succeeds when hints are lost.

## Durable uncertain-write journal

Before sending a mutation, assign the stable client namespace, canonical operation and random key. Persist the exact normalized semantic payload, target store ID and key in a private bounded journal using atomic write/fsync. The journal is sensitive because explicit manual write content is needed for recovery; it contains no ambient recall queries.

After receiving a committed acknowledgement, atomically mark the entry resolved, then remove its payload. If the connection fails or a deadline expires, preserve it as uncertain. A later reconnect retries the identical operation/key only against the same store. Automatic retries are at most one per interaction within its deadline; an explicit `lore retries list|resolve` handles remaining entries. Never change clientId/key, regenerate timestamps or reroute to v1.

On journal capacity or persistence failure, reject a new write before dispatch. Read operations and already persisted retries remain available. Missing/corrupt journal entries are reported; no guess-based replay. Stable aliases map to the same receipt namespace, preventing duplicated saves when an alias is retried through its canonical name.

## Compatibility and certification tests

Test host reload, workspace/session switch, duplicate lifecycle events, stop during Recall, reconnect, API/store mismatch, disabled capabilities, two simultaneous different hosts and a stopped daemon. Fake hosts prove protocol behavior; real-host tests prove actual integration and UI notification behavior.

Exercise each model tool, slash command, human command and JSON-on-stdin alias against the same core outcome. Preserve read-only correction defaults, selected candidate IDs, plan fingerprints and output errors. Explicit broad search remains an administrative selection; ambient recall stays constrained.

Run Rust hook binaries without Node on PATH; Node/Bun adapters cannot import node:sqlite or spawn the v1 worker. Inspect process trees and module/import graphs to verify the architectural boundary. Test journal crash-before-send, commit-before-response, reconnect after Forget and store mismatch.

Record host/version, OS, observed events, installation configuration and evidence per matrix row. Unsupported/untested combinations remain experimental. G5 requires every adapter's implemented lifecycle/tool tests and the [validation](validation.md) foreground/quality gates; support graduation additionally requires stage-7 soak.
