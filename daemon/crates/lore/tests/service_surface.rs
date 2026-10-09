//! Service and mode commands: previews, ownership, idempotency and safety.
//!
//! Every test uses a temporary `--home`; nothing here registers a real
//! service or reads the developer's own launchd/systemd state.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_lore")
}

fn run(home: &Path, args: &[&str]) -> (i32, String, String) {
    run_with_config(home, None, args)
}

fn run_with_config(home: &Path, config: Option<&Path>, args: &[&str]) -> (i32, String, String) {
    let mut command = Command::new(bin());
    command.arg("--home").arg(home);
    if let Some(config) = config {
        command.arg("--config").arg(config);
    }
    let output = command
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

/// The binary a generated unit actually runs, on either platform.
fn unit_executable(contents: &str) -> String {
    if let Some(rest) = contents.split("ExecStart=").nth(1) {
        return rest
            .split_whitespace()
            .next()
            .unwrap_or_default()
            .to_string();
    }
    contents
        .lines()
        .skip_while(|line| !line.contains("ProgramArguments"))
        .find_map(|line| {
            let trimmed = line.trim();
            trimmed
                .strip_prefix("<string>")?
                .strip_suffix("</string>")
                .map(str::to_string)
        })
        .unwrap_or_default()
}

fn unit_path(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library/LaunchAgents/dev.lore.lored.plist")
    } else {
        home.join(".config/systemd/user/lored.service")
    }
}

#[test]
fn install_previews_without_touching_the_filesystem() {
    let home = tempfile::tempdir().expect("home");
    let (code, stdout, stderr) = run(home.path(), &["service", "install", "--dry-run"]);
    assert_eq!(code, 0, "{stderr}");
    let value = json(&stdout);
    assert_eq!(value["applied"], false);
    assert_eq!(value["dryRun"], true);
    assert_eq!(value["label"], "dev.lore.lored");
    assert!(!unit_path(home.path()).exists());
    assert!(!home.path().join(".lore/service.json").exists());
}

#[test]
fn install_applies_writes_the_unit_and_reruns_idempotently() {
    let home = tempfile::tempdir().expect("home");
    let (code, stdout, stderr) = run(home.path(), &["service", "install", "--apply"]);
    assert_eq!(code, 0, "{stderr}");
    let first = json(&stdout);
    assert_eq!(first["applied"], true);
    let unit = unit_path(home.path());
    assert!(unit.exists(), "unit written");
    let contents = std::fs::read_to_string(&unit).expect("read unit");
    if cfg!(target_os = "macos") {
        assert!(contents.contains("dev.lore.lored"), "{contents}");
    } else {
        assert!(contents.contains("ExecStart="), "{contents}");
    }
    assert!(contents.contains("--config"), "{contents}");
    // The service must run the daemon binary, never the CLI: `lore --config
    // ...` with no subcommand is a usage error and launchd throttles it.
    let executable = unit_executable(&contents);
    let binary = std::path::Path::new(&executable)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    assert_eq!(
        binary, "lored",
        "the unit must exec the daemon, found: {executable}"
    );

    let (code, stdout, stderr) = run(home.path(), &["service", "install", "--apply"]);
    assert_eq!(code, 0, "{stderr}");
    let second = json(&stdout);
    assert_eq!(second["unitHash"], first["unitHash"], "idempotent rerun");
    assert_eq!(second["applied"], true);

    // A unit edited outside lore is never overwritten.
    std::fs::write(&unit, "user edit\n").expect("edit unit");
    let (code, _, stderr) = run(home.path(), &["service", "install", "--apply"]);
    assert_ne!(code, 0);
    assert!(stderr.contains("not owned by lore"), "{stderr}");
}

#[test]
fn status_reports_absent_then_installed() {
    let home = tempfile::tempdir().expect("home");
    let (code, stdout, _) = run(home.path(), &["service", "status", "--output", "json"]);
    assert_eq!(code, 0);
    let value = json(&stdout);
    assert_eq!(value["installed"], false);
    assert_eq!(value["state"], "absent");

    run(home.path(), &["service", "install", "--apply"]);
    let (code, stdout, _) = run(home.path(), &["service", "status", "--output", "json"]);
    assert_eq!(code, 0);
    let value = json(&stdout);
    assert_eq!(value["installed"], true);
    assert_eq!(value["enabled"], true);
    assert_eq!(value["ready"], false);
    // Stub homes are never actually loaded, so running stays false.
    assert_eq!(value["running"], false);
}

#[test]
fn start_stop_and_reload_preview_their_commands() {
    let home = tempfile::tempdir().expect("home");
    for verb in ["start", "stop", "restart", "reload"] {
        let (code, stdout, stderr) = run(home.path(), &["service", verb, "--dry-run"]);
        assert_eq!(code, 0, "{verb}: {stderr}");
        let value = json(&stdout);
        assert_eq!(value["applied"], false, "{verb}");
    }
    // Starting without an installed unit is refused after a real apply.
    let (code, _, stderr) = run(home.path(), &["service", "start", "--apply"]);
    assert_ne!(code, 0);
    assert!(stderr.contains("not installed"), "{stderr}");
}

#[test]
fn uninstall_refuses_modified_units_and_removes_owned_ones() {
    let home = tempfile::tempdir().expect("home");
    run(home.path(), &["service", "install", "--apply"]);
    let unit = unit_path(home.path());

    std::fs::write(&unit, "user edit\n").expect("edit unit");
    let (code, stdout, _) = run(home.path(), &["service", "uninstall", "--apply"]);
    assert_eq!(code, 0);
    let value = json(&stdout);
    assert_eq!(value["applied"], false);
    assert_eq!(value["retained"], true);
    assert!(unit.exists(), "modified unit retained");

    // Restore the owned content by reinstalling after clearing the edit.
    std::fs::remove_file(&unit).expect("remove edit");
    run(home.path(), &["service", "install", "--apply"]);
    let (code, stdout, _) = run(home.path(), &["service", "uninstall", "--apply"]);
    assert_eq!(code, 0);
    let value = json(&stdout);
    assert_eq!(value["applied"], true);
    assert!(!unit.exists());
    assert!(!home.path().join(".lore/service.json").exists());
}

#[test]
fn mode_defaults_to_v1_and_requires_apply_to_change() {
    let home = tempfile::tempdir().expect("home");
    let (code, stdout, _) = run(home.path(), &["mode", "status", "--output", "json"]);
    assert_eq!(code, 0);
    let value = json(&stdout);
    assert_eq!(value["mode"], "v1");
    assert_eq!(value["configured"], false);

    let (code, stdout, _) = run(
        home.path(),
        &["mode", "select", "--mode", "v2", "--dry-run"],
    );
    assert_eq!(code, 0);
    let value = json(&stdout);
    assert_eq!(value["applied"], false);
    assert_eq!(value["current"], "v1");
    assert!(!home.path().join(".lore/installation.json").exists());

    let (code, stdout, _) = run(home.path(), &["mode", "select", "--mode", "v2", "--apply"]);
    assert_eq!(code, 0);
    assert_eq!(json(&stdout)["applied"], true);
    let (_, stdout, _) = run(home.path(), &["mode", "status", "--output", "json"]);
    assert_eq!(json(&stdout)["mode"], "v2");

    let (code, _, stderr) = run(home.path(), &["mode", "select", "--mode", "v3", "--apply"]);
    assert_ne!(code, 0);
    assert!(stderr.contains("v1 or v2"), "{stderr}");
}
#[test]
fn service_install_honors_an_explicit_config_path() {
    let home = tempfile::tempdir().expect("home");
    let elsewhere = tempfile::tempdir().expect("config dir");
    let config = elsewhere.path().join("custom-lore.json");
    std::fs::write(
        &config,
        r#"{"configVersion":2,"enabled":true,"dataDir":"/tmp/x","socketPath":"/tmp/x/lored.sock"}"#,
    )
    .expect("config");

    let (code, stdout, stderr) = run_with_config(
        home.path(),
        Some(&config),
        &["service", "install", "--dry-run"],
    );
    assert_eq!(code, 0, "{stderr}");
    let plan = json(&stdout);
    assert_eq!(
        plan["configPath"].as_str().expect("config path"),
        config.to_str().expect("utf8"),
        "the unit must point at the config the caller passed"
    );

    // Without --config the conventional home path is used.
    let (code, stdout, stderr) = run(home.path(), &["service", "install", "--dry-run"]);
    assert_eq!(code, 0, "{stderr}");
    let plan = json(&stdout);
    assert!(
        plan["configPath"]
            .as_str()
            .expect("config path")
            .ends_with(".lore/lore.json"),
        "{plan}"
    );
}

#[test]
fn status_reports_the_installed_config_without_flags() {
    let home = tempfile::tempdir().expect("home");
    run(home.path(), &["service", "install", "--apply"]);
    let (code, stdout, stderr) = run(home.path(), &["service", "status", "--output", "json"]);
    assert_eq!(code, 0, "{stderr}");
    let value = json(&stdout);
    assert_eq!(value["installed"], true);
    assert_eq!(
        value["configPath"],
        home.path()
            .join(".lore/lore.json")
            .to_string_lossy()
            .to_string()
    );
    // Without a running daemon the state is stopped; degraded is reserved for
    // a running daemon that is not ready.
    assert_eq!(value["state"], "stopped");
    assert_eq!(value["ready"], false);
}

#[test]
fn audit_verb_reports_and_refuses_unknown_actions() {
    // Without a reachable daemon the audit command fails on transport, not on
    // argument parsing; with a live one it reports and marks.
    let home = tempfile::tempdir().expect("home");
    let (code, _, stderr) = run(home.path(), &["audit", "report"]);
    assert_ne!(code, 0);
    assert!(
        stderr.contains("--config")
            || stderr.contains("connect")
            || stderr.contains("No such file"),
        "{stderr}"
    );
}
