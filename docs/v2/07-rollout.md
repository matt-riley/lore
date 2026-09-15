# Slice 7: packaging, services, cutover and retirement

Status: planned. Depends on G5 for full replacement. Exit: G6.
Operational prerequisites: [migration/recovery](05-migration-recovery.md), [client adapters](06-client-adapters.md), [validation](validation.md).

## Distribution and release artifacts

Publish versioned native archives containing `lore`, `lored`, adapter assets, static dashboard assets, version/capability metadata, checksums, licenses and an SBOM. Bundle SQLite; do not require Node for CLI, daemon, ingestion, extraction, migration or dashboard. Copilot/Pi still run their required host runtimes.

Initial build targets: macOS arm64/x86_64 and Linux x86_64/aarch64. Test native artifacts on the claimed target before advertising support; an artifact that only cross-compiles remains experimental. Windows is not included. Pin Rust/toolchain/dependencies and build actions; cache Cargo by target/toolchain/lockfile.

Record minimum tested macOS and Linux libc/kernel baseline in the first packaging evidence. Choose macOS 14+ and Ubuntu 22.04-compatible glibc as initial certification targets; if dependencies cannot build/run there, block those artifacts until an explicit support amendment. Do not label macOS executables fully static. Verify dynamically linked dependencies and absence of accidental build-machine paths.

Sign/notarize macOS release binaries where release credentials are configured. All artifacts require a checksum manifest and provenance tied to the release commit; verify archives before installation and validate the installed executable version/store compatibility. Test tampered/truncated downloads, unsupported architectures and failed signature/checksum verification. An unsigned development build is labeled as such, never silently substituted for a release artifact.

Keep release-please Conventional Commit/release flow compatible with the new Cargo/package versions. Add Rust release jobs without changing v1 support status until the cutover release. Generate capability metadata from the same versioned registry used by adapters.

## Installer ownership and commands

Planned commands: `lore setup --clients <selection> --dry-run|--apply`, `lore service install|start|stop|restart|status|reload|uninstall`, `lore upgrade --dry-run|--apply`, and `lore mode status|select`.

Install preview enumerates exact managed files, host hook entries, selected mode/store, service label and versions. Apply records ownership hashes and a recoverable copy of replaced managed entries. It preserves unrelated JSON/TOML/client settings, user modifications, PATH shims and all data. Reruns are idempotent. Conflicting unowned entries require an explicit conflict resolution, not replacement by filename alone.

Install versioned files under an explicitly resolved per-user install root, with a stable launcher selecting the active version. Never overwrite a running binary in place. Switch the launcher only after validation; preserve the previous version until the upgrade is accepted. Uninstall removes only owned unmodified integration/service files; modified files are reported and retained. Databases, configs, backups, transcripts and migration stages are always retained unless a separate explicit deletion operation targets them.

Tests use dedicated temporary homes and fake host configs. Installer tests must never register services or edit settings in the developer's real home.

## Per-user service contract

macOS: LaunchAgent label `dev.lore.lored`, RunAtLoad, restart after unexpected failure with at least a 10-second throttle, explicit config/executable paths and bounded private logs. Linux: `lored.service` under the user's systemd units, Restart=on-failure, RestartSec=10s and restrictive UMask. No root system service or automatic login lingering.

Stop drains for five seconds. Service restart policies must not hot-loop incompatible-schema/config/permission failures: those exit with a configuration-failure category and require operator repair/start. Use an equivalent supervisor wrapper if needed to enforce that distinction on launchd. Validate crash and clean-stop behavior in service integration tests.

Production service starts on user login after opt-in installation and stays alive between clients. Sleep pauses execution; resume reconciles sources, leases and due tasks. No promise of work while asleep/logged out/stopped. No client hook starts or restarts the service.

Service status distinguishes installed, enabled, running, ready, degraded and incompatible. A running PID is not readiness. Health uses the socket Status/store identity, not process-name matching. Operational logs rotate at the configured bound and never contain memory/query text.

## Mode selection and final cutover

Store an explicit installation mode `v1 | v2` in the integration selection manifest. Unconfigured existing installations remain v1. New experimental v2 installs are explicit. The selection is per installation across all enabled clients, not per failed request.

Cutover procedure:

1. Verify G5 evidence, artifact integrity and target platform. Preview selected client/service changes and config mapping.
2. Stop v1 clients/capture/maintenance that can write; verify managed hooks and known processes, and record the operator's stopped-writer acknowledgement.
3. Take the final consistent v1 snapshot, migrate/validate the separate v2 target, and resolve or explicitly accept itemized quarantine/exclusions. Preserve originals and recovery snapshots.
4. Start lored with that store, verify store ID/config/capabilities, run isolated health reads and confirm capture roots/permissions. Pending embeddings are allowed but reported.
5. Apply all selected adapters to v2 in one recoverable installer transaction while hosts remain stopped. If any entry fails, restore modified settings and keep v1 mode selected before reopening hosts.
6. Write the mode manifest last, then reopen hosts. Validate one manual retain/recall/forget round-trip using clearly marked synthetic data and inspect source/index coverage.
7. Capture readiness/quality/latency evidence and begin the soak. Publish any known source gaps; do not call an empty queue a successful archive migration.

No live dual writes. If one client cannot switch, leave the installation in v1 until its incompatibility is resolved, or explicitly disable that client integration during the cohort. Do not let separate hooks pick a write store automatically.

## Upgrade and failure runbook

Before upgrade: verify artifact and schema compatibility, quiesce clients, create a validated snapshot, stop service, install the new version, apply forward v2 migrations under exclusive ownership, start and check identity/readiness, then resume clients. Migration failure preserves rescue artifacts and keeps the previous mode/data selected where compatible.

For missing socket: inspect service state and configured endpoint, start it through the service command, then verify store identity. For provider errors: inspect sanitized reason/config generation and retry failed intents explicitly after repair; lexical/manual operations continue. For source gaps: inspect source status and mappings, repair the root/identity then retry. For disk pressure: archive selected backups or increase storage through explicit operator action; never delete WAL or suppression to make space.

For store corruption/schema mismatch: stop automatic restarts and run read-only diagnostics. Restore only through suppression/receipt-preserving recovery. If the necessary current ledger cannot be read, preserve all files and stop before activating historical data.

A stopped/unhealthy daemon causes neutral hook output and a supported visible diagnostic. There is no automatic read-only v1 fallback in this release, because v1 cannot honor later v2 suppression. There is no fallback write path.

Binary rollback is allowed only if the prior binary explicitly supports the current schema. Otherwise use the validated recovery procedure or forward fix. After v2 writes, returning to v1 is not a supported downgrade; preserve v2 and disable Lore temporarily if necessary.

## Cohort, soak and v1 retirement

Progress through synthetic development -> explicit experimental cohort -> release candidate -> supported v2. Record enabled capabilities and gaps at each stage. A cohort does not authorize collecting personal prompts or telemetry remotely.

Use the current support-matrix graduation rule: a 14-day release-candidate soak with successful checks on at least ten distinct days for each of the five clients. Count host/version/OS, retain/recall/forget, capture/coverage, restart/recovery, latency/resources and open failures. Missed days are not fabricated successes. Policy/data-loss failures reset affected certification after the fix.

Retire v1 only when the complete parity matrix is satisfied (including documented deliberate differences), migration/recovery drills pass, all five clients finish soak, current docs agree, and no unresolved safety/correctness regression remains. Publish a deprecation notice and migration guide before removing supported v1 surfaces in the major release. Keep a tagged v1 release and restore instructions; never delete personal v1 stores during retirement.

## TDD and acceptance

Test install selection/cancellation, rerun, modified/unowned entries, rollback after each file replacement, config/version skew, unsupported hosts, checksum failure, service crash throttling, two instances, endpoint mismatch and clean shutdown. Run upgrade/rollback drills with every supported v2 schema transition and v1 cutover fixtures.

G6 evidence includes artifact checksums/provenance, native target results, isolated installer coverage, actual service-manager drills, final cutover rehearsal, all-client soak ledger and recovery instructions exercised by a fresh operator. Local unit tests alone cannot certify release packaging or host support.
