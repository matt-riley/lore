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
