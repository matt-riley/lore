# Stage 7 evidence: packaging, service lifecycle, cutover and soak

Status: implemented and locally measured 2026-10-08 on `v2` (`2f92d2b` plus
this stage's commits, macOS arm64, Rust 1.99.0, Node 26.9.0). Exit gate: G6.
This stage is *not* a v1 retirement and does not change any v1 default.

## What shipped

### Packaging (`daemon/scripts/package.mjs`)

- Versioned archive `lore-<version>-<target>.tar.gz` containing `bin/lore`,
  `bin/lored`, the JS/Pi/Copilot adapter sources, the capability catalog,
  `VERSION.json`, `SBOM.json`, `MANIFEST.json` and the license.
- Every packaged file is hashed into the manifest; the archive gets a
  `.sha256` file and a `checksums.txt` line.
- `--verify <archive>` re-checks the archive digest, extracts to a temporary
  directory and re-hashes every manifest entry, so a truncated, tampered or
  partially-written archive fails verification.
- `SBOM.json` lists non-workspace Cargo dependencies (name, version, license,
  source) from `cargo metadata --offline`, with an explicit `source:
  "unavailable"` marker when metadata cannot be read.
- macOS signatures are reported as `unsigned-development-build` unless
  `LORE_CODESIGN=1`; no unsigned build is ever labelled signed.
- Proofs: `daemon/tests/packaging.test.mjs` (3 tests) run in CI — layout,
  verification, tamper rejection, SBOM presence.

### Service lifecycle (`lore service …`, `lore mode …`)

- `install|start|stop|restart|reload|status|uninstall` for LaunchAgent
  `dev.lore.lored` (macOS) and a user `lored.service` (Linux, `Restart=on-failure`,
  `RestartSec=10s`, `UMask=0077`).
- Mutating verbs require `--apply`; without it they print the exact plan and
  touch nothing. All commands accept `--home`, so tests never register real
  services.
- Install is idempotent and refuses to overwrite a unit it does not own;
  uninstall removes only owned, unmodified files and reports retained edits.
  Databases, configs and backups are never touched.
- `status` distinguishes absent/stopped/degraded/ready, where readiness is a
  bounded socket status probe, not a process-name match.
- `lore mode status|select` stores the installation mode; unconfigured homes
  report `v1`.
- Proofs: `daemon/crates/lore/tests/service_surface.rs` (6 tests, temporary
  homes, no real launchd/systemd interaction).

### Cutover drill

`migration_proof.rs::cutover_drill_serves_round_trips_on_the_migrated_store`:

1. Build a schema-20 v1 store, preview, apply to a separate destination.
2. Open the published `<destination>/lore-v2.db` exactly as the daemon would.
3. Retain a new memory, recall it and v1-authored content (under the
   migrated canonical repository), confirm the migrated v1 suppression still
   denies its proposition, forget the new memory and confirm it disappears.
4. Assert the v1 source bytes are unchanged and the immutable snapshot
   remains under `.lore-import/`.

### Soak harness (`daemon/tests/soak.mjs`)

Repeated retain/recall/forget across daemon restarts with latency and RSS
sampling. Local runs on the debug binary (macOS arm64):

| Run | Duration | Iterations | Restarts | Recall misses | Failures | retain p95 | recall p95 | forget p95 | RSS peak |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 20 s | 3 072 | 2 | 1 | 0 | 0.87 ms | 3.07 ms | 1.43 ms | 16.2 MB |
| 2 | 30 s | 4 270 | 2 | 0 | 0 | 0.86 ms | 3.95 ms | 1.62 ms | 16.8 MB |

Run 1's single recall miss was not reproduced in run 2 or in a later 8-second
run (1 400 iterations, 0 misses); it is recorded here rather than hidden. CI
runs a 15-second bounded soak on both the Ubuntu and macOS daemon jobs.

## Registry, CI and release plumbing

- CI daemon job adds packaging proofs and the bounded soak alongside the
  existing Rust, adapter and ingestion proofs.
- `.github/workflows/daemon-artifacts.yml` builds release binaries on
  Ubuntu 22.04 and macOS 14, packages and verifies them, and attaches the
  archives, checksums and `checksums.txt` to a published GitHub release.
  `workflow_dispatch` runs the same job without uploading.
- release-please and the v1 npm release flow are unchanged.

## Honest gaps

- No signed or notarized macOS artifacts: the archive self-reports
  `unsigned-development-build` until release credentials exist.
- Packaging is proven on macOS arm64 here; Linux x86_64 coverage comes from
  the artifacts workflow, and no other targets are advertised.
- Service commands are proven with dry-runs and temporary homes only; no test
  loads a real LaunchAgent or systemd unit.
- The soak is minutes, not the 14-day release-candidate cohort; no client is
  certified from it.
- Adapters are still proven against synthetic hosts and a real daemon, not a
  real Pi or Copilot session.
- Windows remains unsupported, and there is no v2 → v1 fallback by design.
