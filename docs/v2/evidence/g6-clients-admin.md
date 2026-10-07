# G6 evidence — stage 6A clients and stage 6B administration/dashboard

Gate: G5 (stages 5B-6B) per [06-client-adapters](../06-client-adapters.md) and
[06-administration-dashboard](../06-administration-dashboard.md). This record
covers the stage-6 half; G5 still requires real host evidence and full
capability parity, as recorded under gaps.
Platform: macOS arm64 (Apple M5); hermetic CI for the Rust suites and the
Node adapter proofs.

## 6A — thin clients and compatible commands

| Piece | Detail |
| --- | --- |
| Capability catalog | `daemon/clients/capability-catalog.json`, exported from the v1 manifest by `daemon/tests/export-capability-catalog.mjs`; 27 canonical rows with aliases, surfaces, mutability, support state and route. Golden-tested against the manifest. |
| Registry dispatch | `lore tool <canonical-or-alias>` resolves through one Rust registry; aliases (`lore_save`, `memory_save`, `memory_forget`, `memory_status`, …) share the canonical receipt namespace. Planned operations fail explicitly (`unimplemented operation: …`) before any spawn. |
| Output contract | `--json` still selects JSON *input*; `--output text|json` selects output. `lore recall <text>` is a human verb over the same dispatch. |
| Native hooks | `lore hook <client> <event>` for codex/claude/antigravity: bounded stdin (1 MiB), prompt extraction from tolerant host shapes, Recall within a 190 ms budget, and neutral failure — a missing daemon never fails the host. Antigravity `Stop` keeps `{"decision":"stop"}`. |
| Journal | `uncertain-writes.json` in the owned data dir, 0600, atomic temp+fsync+rename, capacity 100 before dispatch, payload dropped on resolve; `lore retries list|resolve`. |
| Thin adapter | `daemon/clients/js/lore-adapter.mjs`: capability negotiation, cached store identity, Recall/Retain/Forget with `AbortSignal` cancellation that destroys the in-flight request. No SQLite import. |

Implemented canonical operations: `lore_status`, `lore_retain`, `lore_forget`,
`lore_recall` (4 of 27). The remaining 23 are marked `planned` in the catalog
and refuse dispatch.

## 6B — administration and dashboard

| Piece | Detail |
| --- | --- |
| View routes | `/v2/views/{overview,health,memories,memories/filters,maintenance,episodes,drilldown}` — read-only, store-scoped, keyset pagination with a 200-row cap, capability `views.read`. |
| Gateway | `lore browser [--port N] [--open]` binds 127.0.0.1 only, prints the URL, serves the checked-in assets, and translates `/api/<view>` into view calls as `{data: …}`. No SQL, no mutation proxy, dies with the foreground process. |
| Security | Loopback bind + loopback peer check, Host allowlist (127.0.0.1/localhost/::1), Origin rejection, CSP `default-src 'self'`, `X-Content-Type-Options`, `no-store`, `X-Frame-Options: DENY`, read-only methods, and `..` rejection in both static and view paths. |

## Verification

- Rust: 26 suites pass, including `views_flow` (store-ready → filters →
  drilldown → suppression state), `cli_surface` (catalog, planned refusal,
  hook context, neutral failure, non-prompt short-circuit),
  `browser_gateway` (assets, translation, Host/Origin rejection, 405, 404 for
  traversal and unknown views), plus registry/journal/hooks unit tests.
- JS: `capability-catalog.test.mjs`, `adapter.test.mjs`,
  `two-client.test.mjs`, `lexical-quality.test.mjs` — 9 passing; the catalog
  and adapter proofs run in the daemon CI job.
- clippy `-D warnings` and `cargo fmt --check` clean.

## Known gaps (honest boundary)

- **No real host evidence.** Pi and Copilot native extensions are not ported;
  hooks are exercised against a fake daemon and the adapter against a real
  daemon, but no host application has been driven. G5's per-host integration
  evidence therefore remains open, and support claims stay experimental.
- **23 of 27 canonical operations are planned**, including correct/repair/
  purge/scope-override, maintenance, reflection, backfill, portable bundles
  and validate/replay runs. Human/slash surfaces for those verbs fail
  explicitly rather than pretending support.
- Hook source hints and capture observations are not wired: capture relies on
  the daemon's scheduled discovery, which is proven to catch up without
  hints. Hooks do prompt Recall and lifecycle-neutral responses only.
- The hook repository identity uses host-provided fields; the bounded Git
  fallback is not implemented, so unresolved scope degrades to global-only
  Recall.
- The dashboard serves the existing assets and maps v1 API paths to v2 view
  data, but panel-by-panel field parity with the v1 browser server is partial:
  overview/memories/filters/maintenance/episodes/drilldown render from v2
  shapes; there is no visual redesign and no screenshot capture in this pass.
- Views expose no episode digests or day summaries because extraction does
  not produce them yet; the episodes view says so explicitly.
