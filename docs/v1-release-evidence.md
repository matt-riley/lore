# v1 release evidence

Status: **stabilisation implementation complete; host certification and release gates pending**.

## Contract

- Target: all five adapters stable on macOS, Node >=24.0.0. Linux has core CI verification and best-effort host integrations; Windows is unsupported.
- Stable adapter capabilities differ. Experimental features do not automatically graduate.
- Required observation: 14 calendar days, each client exercised on at least 10 distinct days. Core behavior fixes restart the window; documentation-only fixes require targeted checks.
- No publication or support promotion until all gates are complete.

## Implementation ledger

| Task | Status and evidence |
|---|---|
| A runtime floor and diagnostics | Implemented: Node 24.0.0 minimum, SQLite/FTS5 preflight, neutral native-hook failures, package/CI/docs alignment. |
| B database upgrades and safety | Implemented: read-only future-version guard, backup before legacy adoption, transactional migrations, private new files, real released schema fixtures (13, 15, 18), and legacy index-order correction. |
| C quality and performance gates | Implemented: 48 actual recall cases with scope/forgotten/superseded checks; conversational and date retrieval fixes; repeatable 1k/10k/100k benchmarks. |
| D client-independent recovery | Implemented: standalone status, consistent backup, restore preview, explicit write/stopped-client flags, snapshot validation, rescue and rollback including WAL/SHM. |
| E install/update/removal | Implemented: ownership manifest/fingerprints, path updates, safe removal, concurrent-edit preservation, rollback quarantine outside extension discovery. |
| F Copilot/Pi certification | Runners and lifecycle regressions implemented; authenticated real-host certification remains pending. |
| G Codex/Claude certification | Simulated capture, duplicate handling, scope and neutral failure checks pass; authenticated real-host certification remains pending. |
| H Antigravity certification | Dedicated-home opt-in runner and isolation safeguards implemented; authenticated global-hook certification remains pending. |
| I documentation consistency | Implemented across README, security/support/compatibility/release docs and website. Current support labels remain separate from v1 targets. |
| J independent safety review | Luna review completed; migration, schema validation, installer ownership and verifier issues addressed with regressions. Integrated verification passed below. |
| K rendered dashboard/website QA | Completed with synthetic data on desktop/mobile Chrome; accessible filter labels and bounded long-memory previews fixed. |

Implementation used isolated worktrees with focused Luna workers and coordinator review/integration. Baseline commit: `31081e193639d51089c78a0fc4641ff14fd53393` (824 tests passed, no skips). Work is on `feat/v1-stabilisation`; the original main checkout is unchanged.

## Development verification (2026-09-06)

These checks are development evidence, not candidate certification. Hosted CI has not run on this unpublished branch.

Final tested code commit: `e880133` (the following evidence-only commit adds this record and synthetic artifacts).

- Full unit/smoke suite: **878 passed, zero failures/skips** independently on Node **24.0.0**, **24.18.0**, and **26.8.1**.
- Separate smoke suite: **65 passed**, zero failures/skips. Runtime capability, lint, schema parity and whitespace checks pass.
- Extension evidence runner: **7 supporting checks passed**, 10 live/unperformed checks pending, zero failures. Native Codex and Claude: six simulated checks each pass; authenticated recall remains pending. No result is treated as complete host certification.

- Quality: 48/48 cases, positive recall 1.0, zero safety failures. Assertions use returned persisted IDs, actual included rows and rendered context. Ranked candidates alone do not count as recall.
- Released SQL fixtures: versions 13 (`lore-v0.2.0`), 15 (`lore-v0.3.0`), and 18 (`lore-v0.10.0`) upgrade and reopen without losing marker data. The tag audit found no released schemas 14, 16, or 17.
- Isolated tagged rehearsal: install all five integrations from `lore-v0.12.0`, save a memory, update to development commit `cd2c97b`, recall it, backup/restore, then remove all integrations while preserving database bytes. Used Node 24.0.0, paths with spaces, temporary homes and stub client executables; [rehearsal result](assets/v1/tagged-rehearsal.json). This proves installer behavior, not host compatibility.
- Website: 0 diagnostic errors/warnings/hints, 11 tests pass, 16 pages build, 515 local links/assets pass. Build emits a bundle-size advisory. Used `npm run` for the existing scripts because pnpm rejected the dependency-directory symlink in the isolated worktree; dependencies were not changed.
- Rendered Chrome at 1440×1000 and 390×844: all five dashboard tabs, empty filtered state, long preview and full-detail opening, keyboard focus/scroll, website search/mobile navigation, and demo save/new-session/recall. No page errors or document overflow observed. Synthetic screenshots: [desktop dashboard](assets/v1/dashboard-desktop.png), [mobile dashboard](assets/v1/dashboard-mobile.png), [mobile website](assets/v1/website-mobile.png).
- Dashboard server rejects wildcard, remote and empty hosts before creating a listener; subprocess regression passes.

### Performance

Reference machine: Apple M5, macOS arm64. Each size uses 10 warmups and 100 measured samples. Startup means reopening the populated database and building session-start context. OS caches are not flushed; these are Lore core timings, excluding host launch and model inference.

| Runtime | 10k startup p95 | 10k prompt p95 | Gate |
|---|---:|---:|---|
| Node 24.0.0 | 2.71 ms | 1.13 ms | Pass (<300 ms / <200 ms) |
| Node 26.8.1 | 2.98 ms | 1.27 ms | Pass (<300 ms / <200 ms) |

The 1k/100k runs also completed; informational Node 26.8.1 100k p95 was 20.43 ms startup / 10.59 ms prompt. Raw benchmark results: [Node 24](assets/v1/benchmark-node24.json), [Node 26](assets/v1/benchmark-node26.json). Reproduce with `npm run benchmark` on the candidate commit.

## Host certification

**All five complete host certifications remain pending.** Installed executable detection, mocked SDK tests, synthetic transcripts and worker subprocess checks are supporting evidence only.

Observed versions: Copilot 1.0.80, Pi 0.84.3, Codex 0.153.4, Claude Code 2.1.263, Antigravity 1.1.27. These are available targets, not certified minimum versions.

Codex and Claude isolated probes require authentication. Copilot needs a verified isolated host setup; Antigravity needs a dedicated authenticated home for its global hook probe. No credentials are copied. A development Pi probe exposed incomplete source-archive isolation; its temporary artifacts were removed and its result discarded. The corrected runner isolates HOME and archive paths as well as the destination database. Its fresh bounded Pi launch remains pending because the installed mise shim requires trust in the isolated home. No trust settings were changed.

For each client, record client/Node versions, commit, scenario outcomes and redacted evidence for tagged installation, save/recall, automatic capture/fresh-session recall, repository/global scope, reload, failure handling, update, removal and recovery. Run `node scripts/verify-extension-clients.mjs --help` for Copilot/Pi and `node scripts/verify-cli-hooks.mjs <codex|claude|antigravity> --json` for native-hook evidence. Antigravity's global probe additionally requires `--global-hook-probe --test-home <dedicated-directory>`.

## Candidate and soak

Not started. No candidate tag has been created, no release has been published, and no adapter has been promoted by this work. Do not count development sessions as candidate soak evidence.

After hosted CI and full authenticated host certification, freeze a candidate commit. Each daily entry must record date, candidate commit, host versions, clients exercised, save/capture/restart/recall outcomes, regressions and redacted evidence references. Final release requires 14 elapsed calendar days and at least 10 distinct successful days per client. See [the release gate](releasing.md#v1-candidate-gate).
