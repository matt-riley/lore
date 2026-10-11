//! Installer surface: setup ownership rules and versioned upgrades.
//!
//! Every test uses a temporary `--home` and fake package roots; nothing here
//! touches a real home, host settings or a running daemon.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_lore")
}

fn run(home: &Path, args: &[&str]) -> (i32, String, String) {
    let output = Command::new(bin())
        .env_remove("LORE_V2_SOCKET")
        .env_remove("LORE_SOCKET")
        .env_remove("LORE_V2_CONFIG")
        .env_remove("LORE_V2_DATA_DIR")
        .arg("--home")
        .arg(home)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("run lore");
    (
        output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
    )
}

fn json(stdout: &str) -> serde_json::Value {
    serde_json::from_str(stdout).unwrap_or_else(|error| panic!("{error}: {stdout}"))
}

fn fake_package(dir: &Path, version: &str, runnable: bool) -> PathBuf {
    let root = dir.join(format!("lore-{version}-test-target"));
    std::fs::create_dir_all(root.join("bin")).expect("mkdir bin");
    std::fs::create_dir_all(root.join("clients/js")).expect("mkdir clients");
    for binary in ["lore", "lored"] {
        let path = root.join("bin").join(binary);
        let script = if runnable {
            format!("#!/bin/sh\necho \"{binary} {version}\"\n")
        } else {
            "#!/bin/sh\nexit 3\n".to_string()
        };
        std::fs::write(&path, script).expect("write binary");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        }
    }
    std::fs::write(
        root.join("VERSION.json"),
        format!("{{\"version\":\"{version}\",\"target\":\"test-target\"}}\n"),
    )
    .expect("version file");
    std::fs::write(root.join("clients/js/lore-adapter.mjs"), "// adapter\n").expect("adapter");
    root
}

#[test]
fn setup_preview_enumerates_files_without_touching_them() {
    let home = tempfile::tempdir().expect("home");
    let (code, stdout, stderr) = run(
        home.path(),
        &[
            "setup",
            "--clients",
            "pi,copilot",
            "--dry-run",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");
    let value = json(&stdout);
    assert_eq!(value["applied"], false);
    assert_eq!(value["clients"], serde_json::json!(["pi", "copilot"]));
    assert_eq!(value["serviceLabel"], "dev.lore.lored");
    let files = value["managedFiles"].as_array().expect("files");
    assert_eq!(files.len(), 2);
    assert!(files.iter().all(|file| file["exists"] == false));
    assert!(!home.path().join(".lore/integrations.json").exists());

    // `all` expands to the supported client set.
    let (code, stdout, _) = run(
        home.path(),
        &["setup", "--clients", "all", "--dry-run", "--output", "json"],
    );
    assert_eq!(code, 0);
    assert_eq!(
        json(&stdout)["clients"].as_array().expect("clients").len(),
        5
    );
}

#[test]
fn setup_applies_idempotently_and_removes_only_owned_files() {
    let home = tempfile::tempdir().expect("home");
    let (code, stdout, stderr) = run(
        home.path(),
        &["setup", "--clients", "pi", "--apply", "--output", "json"],
    );
    assert_eq!(code, 0, "{stderr}");
    let first = json(&stdout);
    assert_eq!(first["applied"], true);
    let pi_file = home.path().join(".lore/integrations/pi.json");
    assert!(pi_file.exists());
    let document: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&pi_file).expect("read")).expect("parse");
    assert_eq!(document["client"], "pi");
    assert_eq!(document["formatVersion"], 1);
    assert!(document["socketPath"].is_null() || document["socketPath"].is_string());

    let (_, stdout, _) = run(
        home.path(),
        &["setup", "--clients", "pi", "--apply", "--output", "json"],
    );
    let second = json(&stdout);
    assert_eq!(second["actions"][0]["state"], "unchanged");

    // A modified file is retained, not deleted.
    std::fs::write(&pi_file, "{\"user\":\"edit\"}\n").expect("edit");
    let (code, stdout, stderr) = run(
        home.path(),
        &[
            "setup",
            "--clients",
            "pi",
            "--remove",
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");
    let removed = json(&stdout);
    assert_eq!(removed["actions"][0]["state"], "retained");
    assert!(pi_file.exists(), "edited file retained");

    // Restore ownership by replacing, then remove cleanly.
    let (code, _, stderr) = run(
        home.path(),
        &[
            "setup",
            "--clients",
            "pi",
            "--replace-unowned",
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");
    let (code, stdout, stderr) = run(
        home.path(),
        &[
            "setup",
            "--clients",
            "pi",
            "--remove",
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");
    assert_eq!(json(&stdout)["actions"][0]["state"], "removed");
    assert!(!pi_file.exists());
}

#[test]
fn setup_refuses_unowned_targets_without_the_explicit_flag() {
    let home = tempfile::tempdir().expect("home");
    std::fs::create_dir_all(home.path().join(".lore/integrations")).expect("mkdir");
    std::fs::write(home.path().join(".lore/integrations/pi.json"), "{}\n").expect("seed");
    let (code, _, stderr) = run(
        home.path(),
        &["setup", "--clients", "pi", "--apply", "--output", "json"],
    );
    assert_ne!(code, 0);
    assert!(stderr.contains("not owned by lore"), "{stderr}");
}

#[test]
fn setup_rejects_unknown_clients_and_empty_selections() {
    let home = tempfile::tempdir().expect("home");
    let (code, _, stderr) = run(home.path(), &["setup", "--clients", "vim", "--dry-run"]);
    assert_ne!(code, 0);
    assert!(stderr.contains("unknown client"), "{stderr}");
    let (code, _, stderr) = run(home.path(), &["setup", "--dry-run"]);
    assert_ne!(code, 0);
    assert!(stderr.contains("select at least one client"), "{stderr}");
}

#[test]
fn upgrade_previews_validates_and_switches_the_launcher() {
    let home = tempfile::tempdir().expect("home");
    let package_dir = tempfile::tempdir().expect("packages");
    let package = fake_package(package_dir.path(), "9.9.9", true);

    let (code, stdout, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            package.to_str().expect("utf8"),
            "--dry-run",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");
    let preview = json(&stdout);
    assert_eq!(preview["version"], "9.9.9");
    assert_eq!(preview["applied"], false);
    assert!(!home.path().join(".lore/versions/9.9.9").exists());

    let (code, stdout, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            package.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");
    let applied = json(&stdout);
    assert_eq!(applied["applied"], true);
    assert_eq!(applied["validated"], true);
    let launcher = home.path().join(".lore/bin/lore");
    assert!(launcher.exists(), "launcher installed");
    let resolved = std::fs::read_link(&launcher).expect("launcher is a symlink");
    assert!(resolved.to_string_lossy().contains("9.9.9"));
    let mode = home.path().join(".lore/installation.json");
    let document: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(mode).expect("mode")).expect("parse");
    assert_eq!(document["activeVersion"], "9.9.9");
    assert_eq!(document["mode"], "v1", "upgrade never selects v2 by itself");

    // A second upgrade keeps the previous version on disk.
    let second = fake_package(package_dir.path(), "9.9.10", true);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            second.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");
    assert!(home.path().join(".lore/versions/9.9.9").is_dir());
    assert!(home.path().join(".lore/versions/9.9.10").is_dir());
}

#[test]
fn upgrade_refuses_a_broken_package_and_keeps_the_launcher() {
    let home = tempfile::tempdir().expect("home");
    let package_dir = tempfile::tempdir().expect("packages");
    let good = fake_package(package_dir.path(), "1.0.0", true);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            good.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");

    let broken = fake_package(package_dir.path(), "1.0.1", false);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            broken.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_ne!(code, 0);
    assert!(stderr.contains("failed --version"), "{stderr}");
    let resolved = std::fs::read_link(home.path().join(".lore/bin/lore")).expect("launcher");
    assert!(
        resolved.to_string_lossy().contains("1.0.0"),
        "launcher stays on the previous version"
    );
    assert!(!home.path().join(".lore/versions/1.0.1").exists());

    // A directory without VERSION.json is not a package.
    let empty = tempfile::tempdir().expect("empty");
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            empty.path().to_str().expect("utf8"),
            "--dry-run",
        ],
    );
    assert_ne!(code, 0);
    assert!(stderr.contains("not an unpacked package"), "{stderr}");
}

#[test]
fn upgrade_refuses_a_version_that_escapes_the_versions_directory() {
    let home = tempfile::tempdir().expect("home");
    let package_dir = tempfile::tempdir().expect("packages");
    let package = fake_package(package_dir.path(), "9.9.20", true);
    std::fs::write(
        package.join("VERSION.json"),
        "{\"version\":\"../../victim\",\"target\":\"test-target\"}\n",
    )
    .expect("hostile version file");
    let victim = home.path().join(".lore/victim");
    std::fs::create_dir_all(&victim).expect("victim dir");
    std::fs::write(victim.join("keep.txt"), "keep").expect("victim file");

    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            package.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_ne!(code, 0, "traversal version is refused");
    assert!(stderr.contains("not a plain version string"), "{stderr}");
    assert!(
        victim.join("keep.txt").exists(),
        "nothing outside versions/ was removed"
    );
}

#[test]
fn reapplying_the_same_version_leaves_no_staging_directories() {
    let home = tempfile::tempdir().expect("home");
    let package_dir = tempfile::tempdir().expect("packages");
    let package = fake_package(package_dir.path(), "9.9.21", true);
    let args = [
        "upgrade",
        "--from",
        package.to_str().expect("utf8"),
        "--apply",
        "--output",
        "json",
    ];
    let (code, _, stderr) = run(home.path(), &args);
    assert_eq!(code, 0, "{stderr}");
    let (code, _, stderr) = run(home.path(), &args);
    assert_eq!(code, 0, "{stderr}");
    let entries: Vec<String> = std::fs::read_dir(home.path().join(".lore/versions"))
        .expect("versions")
        .flatten()
        .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
        .collect();
    assert_eq!(
        entries,
        vec!["9.9.21".to_string()],
        "no staging or previous directories remain"
    );
}

#[test]
fn a_failed_same_version_upgrade_keeps_the_live_version_runnable() {
    let home = tempfile::tempdir().expect("home");
    let package_dir = tempfile::tempdir().expect("packages");
    let good = fake_package(package_dir.path(), "9.9.22", true);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            good.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");

    // A broken package claiming the same version must not replace the live copy.
    let broken = fake_package(package_dir.path(), "9.9.22-broken", false);
    std::fs::write(
        broken.join("VERSION.json"),
        "{\"version\":\"9.9.22\",\"target\":\"test-target\"}\n",
    )
    .expect("version file");
    let (code, _, _) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            broken.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_ne!(code, 0, "the broken package is refused");
    let live = home.path().join(".lore/versions/9.9.22/bin/lore");
    let output = std::process::Command::new(&live)
        .arg("--version")
        .output()
        .expect("live binary runs");
    assert!(output.status.success(), "the live version still runs");
}

#[test]
fn setup_refuses_before_writing_any_client_when_a_later_target_is_unowned() {
    let home = tempfile::tempdir().expect("home");
    std::fs::create_dir_all(home.path().join(".lore/integrations")).expect("mkdir");
    std::fs::write(home.path().join(".lore/integrations/codex.json"), "{}\n")
        .expect("seed unowned");
    let (code, _, stderr) = run(
        home.path(),
        &[
            "setup",
            "--clients",
            "pi,codex",
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_ne!(code, 0, "{stderr}");
    assert!(
        !home.path().join(".lore/integrations/pi.json").exists(),
        "no client file is written when a later one is refused"
    );
}

#[test]
fn a_failed_setup_restores_the_clients_it_already_wrote() {
    let home = tempfile::tempdir().expect("home");
    let integrations = home.path().join(".lore/integrations");
    std::fs::create_dir_all(&integrations).expect("mkdir");
    std::fs::write(integrations.join("codex.json"), "{}\n").expect("unowned codex");
    // A file where the backup directory should be makes codex's backup step fail
    // after pi (processed first) has already been written.
    std::fs::write(integrations.join(".backup"), "not a directory").expect("block backups");
    let (code, _, stderr) = run(
        home.path(),
        &[
            "setup",
            "--clients",
            "pi,codex",
            "--apply",
            "--replace-unowned",
            "--output",
            "json",
        ],
    );
    assert_ne!(code, 0, "{stderr}");
    assert!(
        !integrations.join("pi.json").exists(),
        "pi is rolled back when codex fails"
    );
    assert_eq!(
        std::fs::read_to_string(integrations.join("codex.json")).expect("codex intact"),
        "{}\n"
    );
}

#[test]
fn a_failed_manifest_write_restores_the_client_files_it_describes() {
    let home = tempfile::tempdir().expect("home");
    let integrations = home.path().join(".lore/integrations");
    std::fs::create_dir_all(&integrations).expect("mkdir");
    // The manifest path is a directory, so writing it fails after pi's file is written.
    std::fs::create_dir_all(home.path().join(".lore/integrations.json")).expect("block manifest");
    let (code, _, stderr) = run(
        home.path(),
        &["setup", "--clients", "pi", "--apply", "--output", "json"],
    );
    assert_ne!(code, 0, "{stderr}");
    assert!(
        !integrations.join("pi.json").exists(),
        "pi's file is rolled back when its manifest entry cannot be saved"
    );
}

#[cfg(unix)]
#[test]
fn a_failed_launcher_switch_puts_the_cli_back_on_its_previous_version() {
    let home = tempfile::tempdir().expect("home");
    let package_dir = tempfile::tempdir().expect("packages");
    let first = fake_package(package_dir.path(), "9.9.30", true);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            first.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");
    let launcher = home.path().join(".lore/bin");
    let before = std::fs::read_link(launcher.join("lore")).expect("lore launcher");

    // Blocking the daemon's launcher with a directory makes the second switch fail
    // after the CLI's launcher has already moved to the new version.
    std::fs::remove_file(launcher.join("lored")).expect("remove lored launcher");
    std::fs::create_dir_all(launcher.join("lored")).expect("block lored launcher");
    let second = fake_package(package_dir.path(), "9.9.31", true);
    let (code, _, _) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            second.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_ne!(code, 0, "the switch fails");
    assert_eq!(
        std::fs::read_link(launcher.join("lore")).expect("lore launcher still a link"),
        before,
        "the CLI launcher is restored to its previous version"
    );
}

#[cfg(unix)]
#[test]
fn a_failed_version_record_leaves_the_previous_launchers_in_place() {
    let home = tempfile::tempdir().expect("home");
    let package_dir = tempfile::tempdir().expect("packages");
    let first = fake_package(package_dir.path(), "9.9.40", true);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            first.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");
    let launcher = home.path().join(".lore/bin");
    let before = std::fs::read_link(launcher.join("lore")).expect("lore launcher");

    // The version record cannot be written: its path is a directory.
    let record = home.path().join(".lore/installation.json");
    std::fs::remove_file(&record).expect("remove record");
    std::fs::create_dir_all(&record).expect("block record");
    let second = fake_package(package_dir.path(), "9.9.41", true);
    let (code, _, _) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            second.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_ne!(code, 0, "the upgrade reports the failed record");
    assert_eq!(
        std::fs::read_link(launcher.join("lore")).expect("lore launcher"),
        before,
        "the launchers are back on the version the record names"
    );
}

#[cfg(unix)]
#[test]
fn a_failed_reinstall_of_the_active_version_keeps_that_version_runnable() {
    let home = tempfile::tempdir().expect("home");
    let package_dir = tempfile::tempdir().expect("packages");
    let package = fake_package(package_dir.path(), "9.9.50", true);
    let args = [
        "upgrade",
        "--from",
        package.to_str().expect("utf8"),
        "--apply",
        "--output",
        "json",
    ];
    let (code, _, stderr) = run(home.path(), &args);
    assert_eq!(code, 0, "{stderr}");

    // Re-applying the active version replaces its directory; blocking the daemon's
    // launcher makes that switch fail afterwards.
    let launcher = home.path().join(".lore/bin");
    std::fs::remove_file(launcher.join("lored")).expect("remove lored launcher");
    std::fs::create_dir_all(launcher.join("lored")).expect("block lored launcher");
    let (code, _, _) = run(home.path(), &args);
    assert_ne!(code, 0, "the reinstall fails");
    let live = home.path().join(".lore/versions/9.9.50/bin/lore");
    let output = std::process::Command::new(&live)
        .arg("--version")
        .output()
        .expect("runs");
    assert!(
        output.status.success(),
        "the active version directory is still there and runs"
    );
}

#[test]
fn upgrade_refuses_when_a_launcher_name_is_an_unowned_file() {
    let home = tempfile::tempdir().expect("home");
    let package_dir = tempfile::tempdir().expect("packages");
    let good = fake_package(package_dir.path(), "1.0.0", true);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            good.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");

    // A user file at the launcher name is not ours; the upgrade must not replace it.
    let launcher = home.path().join(".lore/bin/lored");
    std::fs::remove_file(&launcher).expect("remove symlink");
    std::fs::write(&launcher, "not a launcher").expect("write user file");

    let next = fake_package(package_dir.path(), "1.0.1", true);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            next.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_ne!(code, 0, "{stderr}");
    assert!(stderr.contains("not a launcher link"), "{stderr}");
    assert_eq!(
        std::fs::read_to_string(&launcher).expect("user file kept"),
        "not a launcher"
    );
    assert!(!home.path().join(".lore/versions/1.0.1").exists());
}

#[test]
fn upgrade_refuses_a_launcher_link_the_installer_did_not_make() {
    let home = tempfile::tempdir().expect("home");
    let package_dir = tempfile::tempdir().expect("packages");
    let good = fake_package(package_dir.path(), "1.0.0", true);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            good.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");

    // A symlink the user made elsewhere is not the installer's link; it stays put.
    let launcher = home.path().join(".lore/bin/lored");
    std::fs::remove_file(&launcher).expect("remove installer link");
    let elsewhere = package_dir.path().join("their-own-binary");
    std::fs::write(&elsewhere, "theirs").expect("write");
    std::os::unix::fs::symlink(&elsewhere, &launcher).expect("user link");

    let next = fake_package(package_dir.path(), "1.0.1", true);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            next.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_ne!(code, 0, "{stderr}");
    assert!(stderr.contains("not a launcher link"), "{stderr}");
    assert_eq!(
        std::fs::read_link(&launcher).expect("user link kept"),
        elsewhere
    );
}

#[test]
fn upgrade_refuses_a_launcher_link_that_climbs_out_of_the_versions_directory() {
    let home = tempfile::tempdir().expect("home");
    let package_dir = tempfile::tempdir().expect("packages");
    let good = fake_package(package_dir.path(), "1.0.0", true);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            good.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_eq!(code, 0, "{stderr}");

    // Starts in the versions directory, then climbs back out of it: not the installer's link.
    let launcher = home.path().join(".lore/bin/lored");
    std::fs::remove_file(&launcher).expect("remove installer link");
    let climbing = std::path::PathBuf::from("../versions/../../their-own-binary");
    std::os::unix::fs::symlink(&climbing, &launcher).expect("user link");

    let next = fake_package(package_dir.path(), "1.0.1", true);
    let (code, _, stderr) = run(
        home.path(),
        &[
            "upgrade",
            "--from",
            next.to_str().expect("utf8"),
            "--apply",
            "--output",
            "json",
        ],
    );
    assert_ne!(code, 0, "{stderr}");
    assert!(stderr.contains("not a launcher link"), "{stderr}");
    assert_eq!(
        std::fs::read_link(&launcher).expect("user link kept"),
        climbing
    );
}
