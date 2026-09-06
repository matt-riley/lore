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
| A runtime floor and diagnostics | none | implemented; exact-minimum suite found installer fixture issue under review |
| B database upgrades and safety | none | implemented; independent review pending |
| C quality and performance gates | none | in progress |
| D client-independent recovery | B | in progress |
| E install/update/removal | A | in progress |
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

## Development verification (not candidate certification)

- 2026-09-06: installed executables report Copilot 1.0.80, Pi 0.84.3, Codex 0.153.4, Claude Code 2.1.263, Antigravity 1.1.27. These are available targets, not certified minimums.
- Website initial check: 0 errors/warnings; 11 tests pass; 16 pages build; 515 local links/assets pass. Used `npm run` for the existing package scripts because pnpm rejected a dependency-directory symlink in the isolated worktree. Dependencies were not changed.
- Initial rendered Chrome checks at 1440x1000 and 390x844: dashboard and website load with no page errors or document overflow. Synthetic long memory content, demo save/new-session/recall and documentation search exercised. Added accessible names to dashboard filters. Expanded QA pending.
- Dashboard exported server now validates loopback before creating a listener; regression passes for wildcard, remote and empty hosts.
