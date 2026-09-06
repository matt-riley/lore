# v1 release evidence

Status: **implementation in progress; not a release certification**.

## Contract

- Target: all five adapters stable on macOS, Node >=24.0.0. Linux core CI remains supported as verification, with best-effort host integrations; Windows unsupported.
- Stable adapter capabilities differ. Experimental features do not automatically graduate.
- Required observation: 14 calendar days, each client exercised on at least 10 distinct days. Core behavior fixes restart the window; documentation-only fixes require targeted checks.
- No publication or support promotion until all gates are complete.

## Implementation ledger

| Task | Dependency | Status |
|---|---|---|
| A runtime floor and diagnostics | none | in progress |
| B database upgrades and safety | none | in progress |
| C quality and performance gates | none | in progress |
| D client-independent recovery | B | pending |
| E install/update/removal | A | pending |
| F Copilot/Pi certification | A | pending |
| G Codex/Claude certification | A | pending |
| H Antigravity certification | A | pending |
| I documentation consistency | A–H | pending |
| J independent safety review | B, D, E | pending |
| K rendered dashboard/website QA | integrated branch | pending |

Rulings: use isolated worktrees and three Luna workers at a time. Shared package/CI/docs integration belongs to the coordinator. Tests and certification use synthetic data; no unattended shared-settings probes. Existing privacy/support discrepancies must be corrected without claiming unperformed certification.

## Validation

Baseline commit: `31081e193639d51089c78a0fc4641ff14fd53393`.
Baseline: 824 tests passed, none skipped; lint and schema parity passed. Current changes require a fresh integrated run.

## Host certification

All certifications are pending. Installed executable detection alone is not certification. Record client and Node versions, commit, scenario outcomes and redacted evidence for installation, save/recall, automatic capture/new-session recall, scope isolation, reload, failure handling, update and removal.

## Candidate and soak

Not started. No candidate tag has been created. Do not count development sessions as candidate soak evidence.

Each daily entry must record date, candidate commit, host versions, clients exercised, save/capture/restart/recall outcome, regressions and redacted evidence references. The final release needs 14 elapsed days and at least 10 distinct successful days per client.
