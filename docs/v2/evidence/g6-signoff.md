# G6 gate sign-off

Status: **NOT SIGNED.** This page is the criterion-by-criterion record for the
stage 7 gate. It exists so that signing is a fact check, not a feeling. Every
row names its evidence; open rows say what is missing and who can unblock it.

Gate definition ([07-rollout.md](../07-rollout.md)): release artifacts,
service lifecycle and cutover pass, all clients finish the documented soak,
the parity matrix is satisfied (including documented deliberate differences),
docs agree, and no unresolved safety or correctness regression remains.

## Criteria

| # | Criterion | Status | Evidence / what is missing |
| --- | --- | --- | --- |
| 1 | All canonical operations implemented | **Met** | 27/27 in the capability catalog; registry test refuses a silently `planned` row. [G6 evidence](g6-clients-admin.md) |
| 2 | Parity matrix satisfied, differences documented | **Met** | CAP-01…CAP-27 implemented; deliberate differences (no trace persistence, no Windows, CDN-free OKF export) recorded in [capability-parity.md](../capability-parity.md) |
| 3 | Release artifacts build, verify and reject tampering | **Met** | `daemon/tests/packaging.test.mjs`; `package.mjs --verify` on the archive and its manifest |
| 4 | macOS artifacts signed and notarized | **Open — credentials** | Pipeline and runbook landed ([signing-notarization.md](../signing-notarization.md)); no Apple secrets exist, so builds report `unsigned-development-build` |
| 5 | Service lifecycle: install, start, stop, restart, reload, status, uninstall | **Met** | `service_surface.rs`: previews, ownership hashes, idempotent reruns, refusal to overwrite edited units, uninstall limited to owned files |
| 6 | Service runs a real load | **Open — real machine** | Unit content and lifecycle proofs exist; no real launchd/systemd load has been observed for a full day |
| 7 | Cutover from v1 is rehearsed | **Met (fixtures)** | `migration_proof.rs` cutover drill: round trips and suppression on the migrated store, v1 source byte-identical |
| 8 | Cutover on a real v1 store | **Met (one pilot store)** | One real v1 store has been migrated to v2 and is in pilot use (~300 memories). Attach the import and verification output to [G5 evidence](g5-migration.md) before counting it as a second pilot; further stores follow [migration-guide.md](../migration-guide.md) |
| 9 | Recovery: backup/restore and suppression survive | **Met** | Migration and governance suites; restore preserves later deletions and receipts |
| 10 | All five clients pass the documented soak | **In progress — live** | The operator is running v2 as their daily memory system on a real machine from 2026-10-10: Pi tools and prompt-time injection, capture from Pi/Codex/Claude roots, the dashboard, service restarts, and a migrated v1 store (~300 memories). CI also runs the bounded soak. Remaining: the calendar window (≥10 distinct successful days per client) |
| 11 | Real-host certification (Pi, Copilot, Codex, Claude, Antigravity) | **Open — Copilot and Antigravity** | Pi, Codex and Claude are live (row 10). Copilot and Antigravity still need a recorded real-session capture, recall and restart; adapters are otherwise proven against synthetic hosts and a real daemon |
| 12 | Client adapters fail open | **Met** | Neutral hook output when the daemon is stopped or unhealthy; no automatic write fallback |
| 13 | Mode selection is explicit and defaults to v1 | **Met** | `mode status` reports `v1 (configured: false)`; `--apply` required to change; installer tests cover the default |
| 14 | Docs agree (README, support matrix, guides) | **Met** | Runbooks linked from the stage index; support levels unchanged this cycle |
| 15 | No unresolved safety or correctness regression | **Met with a note** | Bugs found and fixed this cycle are listed below; one pre-existing v1 smoke flake (`cli-background-maintenance`, `database is locked`) is recorded and unrelated to v2 |

## Regressions found and fixed this cycle

| Bug | Impact | Fix |
| --- | --- | --- |
| Dashboard gateway sent view requests without `expectedStoreId` | every panel returned 502 against a real daemon; fake-daemon tests missed it | negotiate and cache the store identity, refresh once on mismatch |
| Daemon bound its socket before installing signal handlers | a clean stop during startup died with signal 15 | handlers installed first |
| Digest quoted extracted propositions verbatim | a later forget could be resurrected through the digest body | digests carry counts, never proposition text |
| Digests built before extraction settled | zero-proposition digests | gated on settled extraction, upserted in place |
| Concurrent sweeps minted duplicate generations | duplicate digests and work | one process-wide sweep lock |
| Soak markers were single-character tokens | harness could not recall its own row | padded FTS tokens |
| Service unit ignored `--config` | unit pointed at the wrong config file | `service install` honours the passed config |

## Live findings from the real-host soak

| Symptom | Cause | Resolution |
| --- | --- | --- |
| Tool output vanished and took the TUI down | adapter returned a bare string where Pi requires content blocks | tools return `{ content: [{ type: "text", text }] }`; the test asserts the shape |
| A spawned daemon fought the installed service for one socket | `lored` read `LORE_V2_SOCKET`, a client-side variable, for its own endpoint | the daemon endpoint is config-only; a test proves the variable cannot move it |
| The same memory appeared twice in one prompt | identical copies in the store (v1 history, re-extraction) plus a required item that also matched the query | recall collapses repeated ids and bodies and excludes bodies already in the required sections |
| 29 rows shared a content hash | duplicates span scopes and repositories; only 2 were genuine within-scope copies | hygiene retires within-scope copies (oldest kept, marker + exact rollback); cross-scope copies are deliberately kept |

## Known gaps to close later

Recorded here so they are not rediscovered as surprises:

| Gap | What exists | What is missing |
| --- | --- | --- |
| Antigravity has no in-session tools | Capture works (its `brain/` transcripts are a configured source) and prompt-time injection works through its own `hooks.json`, which now calls the v2 CLI. The hook path also resolves the repository from the payload's workspace, so its recall is repo-scoped. | No `lore_recall`-style tools inside Antigravity. It has no extension API in v2; the only route to tools is **MCP**: Antigravity reads `~/.gemini/config/mcp_config.json` (a DaVinci Resolve server is already configured there) and documents the format in `~/.gemini/antigravity-cli/builtin/skills/agy-customizations/docs/mcp_servers.md`. v2 ships no MCP server, so this needs a small stdio JSON-RPC server wrapping the daemon's routes, plus one entry in that config. |
| Copilot tools need a host restart | The v2 extension is installed at `~/.copilot/extensions/lore-v2/` with v1's moved to `~/.lore/backups/copilot-extension-v1-<stamp>/`, and it resolves the socket without host input. | A running Copilot session keeps the old extension loaded; nothing else is outstanding. |

## To sign

1. Add the Apple secrets and produce one signed, notarized release
   ([runbook](../signing-notarization.md)).
2. Run the daemon as a real service for at least a day and record the load.
3. Record the verification output for the pilot store in G5 evidence, then import and verify one more real v1 store per the migration guide.
4. Run the five-client cohort for the agreed soak window and record it in
   [G7 evidence](g7-rollout.md).
5. Re-check rows 4, 6, 8, 10 and 11, then replace this status line with the
   sign-off date, the release tag and the operator.

Items 1 and 3 can be prepared now; 2, 4 and 5 need calendar time and real
hosts.
