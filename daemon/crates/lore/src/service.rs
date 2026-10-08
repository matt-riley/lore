//! Per-user service management and installation mode selection.
//!
//! Every mutating service command requires `--apply`; without it the command
//! prints the exact plan and touches nothing. Callers can redirect the home
//! directory with `--home`, which keeps installer tests away from the real
//! launchd/systemd state.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

pub const LABEL: &str = "dev.lore.lored";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    MacOs,
    Linux,
    Unsupported,
}

pub fn platform() -> Platform {
    if cfg!(target_os = "macos") {
        Platform::MacOs
    } else if cfg!(target_os = "linux") {
        Platform::Linux
    } else {
        Platform::Unsupported
    }
}

pub fn unit_path(home: &Path, platform: Platform) -> Option<PathBuf> {
    match platform {
        Platform::MacOs => Some(
            home.join("Library/LaunchAgents")
                .join(format!("{LABEL}.plist")),
        ),
        Platform::Linux => Some(home.join(".config/systemd/user/lored.service")),
        Platform::Unsupported => None,
    }
}

pub fn manifest_path(home: &Path) -> PathBuf {
    home.join(".lore/service.json")
}

pub fn mode_path(home: &Path) -> PathBuf {
    home.join(".lore/installation.json")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    lore_core::policy::sha256_hex(bytes)
}

fn unit_contents(platform: Platform, executable: &Path, config: &Path) -> String {
    let executable = executable.display();
    let log = config
        .parent()
        .map(|parent| parent.join("lored.log").display().to_string())
        .unwrap_or_else(|| "/tmp/lored.log".to_string());
    let config = config.display();
    match platform {
        Platform::MacOs => format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>{executable}</string>
    <string>--config</string>
    <string>{config}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict>
</plist>
"#,
        ),
        Platform::Linux => format!(
            r#"[Unit]
Description=Lore v2 memory daemon
After=default.target

[Service]
ExecStart={executable} --config {config}
Restart=on-failure
RestartSec=10s
UMask=0077

[Install]
WantedBy=default.target
"#
        ),
        Platform::Unsupported => String::new(),
    }
}

fn read_manifest(home: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(manifest_path(home)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("create {parent:?}: {error}"))?;
    }
    std::fs::write(path, bytes).map_err(|error| format!("write {path:?}: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn probe_running(platform: Platform) -> bool {
    let output = match platform {
        Platform::MacOs => Command::new("launchctl")
            .args(["print", &format!("gui/{}/{}", user_id(), LABEL)])
            .output(),
        Platform::Linux => Command::new("systemctl")
            .args(["--user", "is-active", "lored"])
            .output(),
        Platform::Unsupported => return false,
    };
    match output {
        Ok(output) => {
            let text = String::from_utf8_lossy(&output.stdout).to_lowercase();
            if platform == Platform::MacOs {
                text.contains("state = running") || text.contains("pid =")
            } else {
                text.trim() == "active"
            }
        }
        Err(_) => false,
    }
}

fn user_id() -> u32 {
    Command::new("id")
        .arg("-u")
        .output()
        .ok()
        .and_then(|output| String::from_utf8_lossy(&output.stdout).trim().parse().ok())
        .unwrap_or(0)
}

fn load_command(platform: Platform, unit: &Path) -> Option<(String, Vec<String>)> {
    match platform {
        Platform::MacOs => Some((
            "launchctl".to_string(),
            vec![
                "bootstrap".to_string(),
                format!("gui/{}", user_id()),
                unit.display().to_string(),
            ],
        )),
        Platform::Linux => Some((
            "systemctl".to_string(),
            vec![
                "--user".to_string(),
                "enable".to_string(),
                "--now".to_string(),
                "lored".to_string(),
            ],
        )),
        Platform::Unsupported => None,
    }
}

fn stop_command(platform: Platform) -> Option<(String, Vec<String>)> {
    match platform {
        Platform::MacOs => Some((
            "launchctl".to_string(),
            vec![
                "bootout".to_string(),
                format!("gui/{}/{}", user_id(), LABEL),
            ],
        )),
        Platform::Linux => Some((
            "systemctl".to_string(),
            vec![
                "--user".to_string(),
                "stop".to_string(),
                "lored".to_string(),
            ],
        )),
        Platform::Unsupported => None,
    }
}

/// Plan or apply `lore service install`.
pub fn install(home: &Path, apply: bool, socket: Option<&Path>) -> Result<Value, String> {
    let platform = platform();
    let unit = unit_path(home, platform)
        .ok_or_else(|| "the service contract supports macOS and Linux only".to_string())?;
    let executable =
        std::env::current_exe().map_err(|error| format!("resolve executable: {error}"))?;
    let config = home.join(".lore/lore.json");
    let contents = unit_contents(platform, &executable, &config);
    let hash = sha256_hex(contents.as_bytes());
    let mut plan = json!({
        "action": "service install",
        "platform": format!("{platform:?}").to_lowercase(),
        "label": LABEL,
        "unitPath": unit.display().to_string(),
        "manifestPath": manifest_path(home).display().to_string(),
        "executable": executable.display().to_string(),
        "configPath": config.display().to_string(),
        "unitHash": hash,
        "applied": false,
    });
    if !apply {
        plan["dryRun"] = json!(true);
        return Ok(plan);
    }
    if unit.exists() {
        let current = std::fs::read_to_string(&unit).unwrap_or_default();
        let recorded =
            read_manifest(home).and_then(|value| value["unitHash"].as_str().map(str::to_string));
        let owned = recorded.is_some_and(|hash| sha256_hex(current.as_bytes()) == hash);
        if !owned {
            return Err(format!(
                "{} exists and is not owned by lore; refusing to overwrite",
                unit.display()
            ));
        }
    }
    write_private(&unit, contents.as_bytes())?;
    let manifest = json!({
        "label": LABEL,
        "unitPath": unit.display().to_string(),
        "unitHash": hash,
        "executable": executable.display().to_string(),
        "configPath": config.display().to_string(),
        "installedMs": now_ms(),
    });
    write_private(
        &manifest_path(home),
        serde_json::to_vec_pretty(&manifest)
            .unwrap_or_default()
            .as_slice(),
    )?;
    plan["applied"] = json!(true);
    plan["loaded"] = json!(false);
    if socket.is_none() {
        plan["next"] = json!("run `lore service start --apply` to load the service");
    }
    Ok(plan)
}

/// Plan or apply `lore service start`.
pub fn start(home: &Path, apply: bool) -> Result<Value, String> {
    let platform = platform();
    let unit = unit_path(home, platform)
        .ok_or_else(|| "the service contract supports macOS and Linux only".to_string())?;
    let (program, args) =
        load_command(platform, &unit).ok_or_else(|| "unsupported platform".to_string())?;
    let mut plan = json!({
        "action": "service start",
        "unitPath": unit.display().to_string(),
        "command": format!("{program} {}", args.join(" ")),
        "applied": false,
    });
    if !apply {
        plan["dryRun"] = json!(true);
        return Ok(plan);
    }
    if !unit.exists() {
        return Err(format!(
            "{} is not installed; run `lore service install --apply` first",
            unit.display()
        ));
    }
    let output = Command::new(&program)
        .args(&args)
        .output()
        .map_err(|error| format!("{program}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    plan["applied"] = json!(true);
    Ok(plan)
}

/// Plan or apply `lore service stop`.
pub fn stop(home: &Path, apply: bool) -> Result<Value, String> {
    let platform = platform();
    let (program, args) =
        stop_command(platform).ok_or_else(|| "unsupported platform".to_string())?;
    let mut plan = json!({
        "action": "service stop",
        "command": format!("{program} {}", args.join(" ")),
        "applied": false,
    });
    if !apply {
        plan["dryRun"] = json!(true);
        plan["note"] = json!("the daemon drains in-flight work and exits cleanly on SIGTERM");
        return Ok(plan);
    }
    let output = Command::new(&program)
        .args(&args)
        .output()
        .map_err(|error| format!("{program}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{program} failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    plan["applied"] = json!(true);
    let _ = home;
    Ok(plan)
}

/// Report installed/enabled/running/ready without mutating anything.
/// Readiness is supplied by the caller from a bounded socket status probe.
pub fn status(home: &Path, ready: bool) -> Result<Value, String> {
    let platform = platform();
    let unit = unit_path(home, platform);
    let manifest = read_manifest(home);
    let installed = unit.as_ref().is_some_and(|path| path.exists()) && manifest.is_some();
    let enabled = unit.as_ref().is_some_and(|path| path.exists());
    let running = if installed {
        probe_running(platform)
    } else {
        false
    };
    Ok(json!({
        "label": LABEL,
        "platform": format!("{platform:?}").to_lowercase(),
        "unitPath": unit.map(|path| path.display().to_string()),
        "installed": installed,
        "enabled": enabled,
        "running": running,
        "ready": ready,
        "state": if !installed { "absent" } else if ready { "ready" } else if running { "degraded" } else { "stopped" },
        "configPath": manifest.as_ref().and_then(|value| value["configPath"].as_str()),
        "unitHash": manifest.as_ref().and_then(|value| value["unitHash"].as_str()),
    }))
}

/// Plan or apply `lore service reload` (restart after a config change).
pub fn reload(home: &Path, apply: bool) -> Result<Value, String> {
    let mut stopped = stop(home, apply)?;
    stopped["action"] = json!("service reload");
    if !apply {
        stopped["dryRun"] = json!(true);
        return Ok(stopped);
    }
    let started = start(home, apply)?;
    Ok(json!({
        "action": "service reload",
        "applied": true,
        "stop": stopped,
        "start": started,
    }))
}

/// Plan or apply `lore service uninstall`.
pub fn uninstall(home: &Path, apply: bool) -> Result<Value, String> {
    let platform = platform();
    let unit = unit_path(home, platform)
        .ok_or_else(|| "the service contract supports macOS and Linux only".to_string())?;
    let manifest = read_manifest(home);
    let mut plan = json!({
        "action": "service uninstall",
        "unitPath": unit.display().to_string(),
        "manifestPath": manifest_path(home).display().to_string(),
        "applied": false,
    });
    if !unit.exists() && manifest.is_none() {
        plan["note"] = json!("nothing is installed");
        return Ok(plan);
    }
    if apply {
        if unit.exists() {
            let current = std::fs::read_to_string(&unit).unwrap_or_default();
            let recorded = manifest
                .as_ref()
                .and_then(|value| value["unitHash"].as_str());
            if recorded.is_some_and(|hash| sha256_hex(current.as_bytes()) != hash) {
                plan["retained"] = json!(true);
                plan["reason"] = json!("unit was modified outside lore; not removing");
                return Ok(plan);
            }
            std::fs::remove_file(&unit).map_err(|error| format!("remove unit: {error}"))?;
        }
        if manifest_path(home).exists() {
            std::fs::remove_file(manifest_path(home))
                .map_err(|error| format!("remove manifest: {error}"))?;
        }
        plan["applied"] = json!(true);
    } else {
        plan["dryRun"] = json!(true);
        plan["note"] = json!("databases, configs and backups are always retained");
    }
    Ok(plan)
}

/// Read the installation mode, defaulting to v1 for unconfigured homes.
pub fn mode_status(home: &Path) -> Value {
    let manifest: Option<Value> = std::fs::read_to_string(mode_path(home))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok());
    json!({
        "mode": manifest
            .as_ref()
            .and_then(|value| value["mode"].as_str())
            .unwrap_or("v1"),
        "configured": manifest.is_some(),
        "path": mode_path(home).display().to_string(),
        "updatedMs": manifest.as_ref().and_then(|value| value["updatedMs"].as_i64()),
    })
}

/// Plan or apply `lore mode select`.
pub fn mode_select(home: &Path, mode: &str, apply: bool) -> Result<Value, String> {
    if mode != "v1" && mode != "v2" {
        return Err(format!("mode must be v1 or v2, got {mode}"));
    }
    let mut plan = json!({
        "action": "mode select",
        "mode": mode,
        "path": mode_path(home).display().to_string(),
        "applied": false,
    });
    if !apply {
        plan["dryRun"] = json!(true);
        plan["current"] = mode_status(home)["mode"].clone();
        return Ok(plan);
    }
    write_private(
        &mode_path(home),
        serde_json::to_vec_pretty(&json!({
            "mode": mode,
            "updatedMs": now_ms(),
        }))
        .unwrap_or_default()
        .as_slice(),
    )?;
    plan["applied"] = json!(true);
    Ok(plan)
}
