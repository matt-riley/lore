//! Client integration setup and versioned upgrades.
//!
//! `lore setup` manages only files lore creates under `<home>/.lore`; it
//! never edits a host's own settings. `lore upgrade` installs a versioned
//! package under `<home>/.lore/versions`, validates the staged binary and
//! only then switches the stable launcher, keeping the previous version.
//!
//! Every mutating verb requires `--apply`; without it the exact plan is
//! printed and nothing is touched. `--home` redirects everything, so tests
//! never touch a real home.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

pub const CLIENTS: [&str; 5] = ["pi", "copilot", "codex", "claude", "antigravity"];

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn sha256_hex(bytes: &[u8]) -> String {
    lore_core::policy::sha256_hex(bytes)
}

pub fn integrations_path(home: &Path) -> PathBuf {
    home.join(".lore/integrations.json")
}

pub fn versions_root(home: &Path) -> PathBuf {
    home.join(".lore/versions")
}

pub fn launcher_dir(home: &Path) -> PathBuf {
    home.join(".lore/bin")
}

fn integration_file(home: &Path, client: &str) -> PathBuf {
    home.join(".lore/integrations")
        .join(format!("{client}.json"))
}

fn backup_dir(home: &Path) -> PathBuf {
    home.join(".lore/integrations/.backup")
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
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

fn validate_selection(clients: &[String]) -> Result<Vec<String>, String> {
    let mut selected: Vec<String> = Vec::new();
    for client in clients {
        let client = client.trim().to_lowercase();
        if client.is_empty() {
            continue;
        }
        if !CLIENTS.contains(&client.as_str()) {
            return Err(format!(
                "unknown client {client}; supported: {}",
                CLIENTS.join(", ")
            ));
        }
        if !selected.contains(&client) {
            selected.push(client);
        }
    }
    if selected.is_empty() {
        return Err(format!(
            "select at least one client ({}), or `all`",
            CLIENTS.join(", ")
        ));
    }
    Ok(selected)
}

fn expand_selection(clients: &[String]) -> Result<Vec<String>, String> {
    if clients
        .iter()
        .any(|client| client.trim().eq_ignore_ascii_case("all"))
    {
        return Ok(CLIENTS.iter().map(|client| client.to_string()).collect());
    }
    validate_selection(clients)
}

fn integration_document(client: &str, socket: Option<&Path>, version: &str) -> Value {
    json!({
        "formatVersion": 1,
        "client": client,
        "clientId": client,
        "socketPath": socket.map(|path| path.display().to_string()),
        "adapterPath": format!("$LORE_HOME/.lore/versions/{version}/clients/{client}"),
        "installedBy": "lore setup",
        "version": version,
    })
}

/// Enumerate the exact plan for `lore setup`.
pub fn setup_preview(
    home: &Path,
    clients: &[String],
    remove: bool,
    version: &str,
    socket: Option<&Path>,
) -> Result<Value, String> {
    let selected = expand_selection(clients)?;
    let manifest = read_json(&integrations_path(home));
    let mut managed = Vec::new();
    for client in &selected {
        let path = integration_file(home, client);
        let document = integration_document(client, socket, version);
        let rendered = serde_json::to_string_pretty(&document).unwrap_or_default();
        let hash = sha256_hex(rendered.as_bytes());
        let owned = manifest
            .as_ref()
            .and_then(|value| value["managed"][client]["hash"].as_str())
            .map(str::to_string);
        managed.push(json!({
            "client": client,
            "path": path.display().to_string(),
            "exists": path.exists(),
            "owned": owned.is_some(),
            "wouldChange": path.exists()
                && std::fs::read(&path).map(|bytes| sha256_hex(&bytes)).ok().as_deref() != Some(&hash),
            "contentHash": hash,
        }));
    }
    Ok(json!({
        "action": if remove { "setup remove" } else { "setup" },
        "version": version,
        "home": home.display().to_string(),
        "installRoot": versions_root(home).join(version).display().to_string(),
        "launcher": launcher_dir(home).join("lore").display().to_string(),
        "socketPath": socket.map(|path| path.display().to_string()),
        "serviceLabel": crate::service::LABEL,
        "mode": read_json(&crate::service::mode_path(home))
            .and_then(|value| value["mode"].as_str().map(str::to_string))
            .unwrap_or_else(|| "v1".to_string()),
        "clients": selected,
        "managedFiles": managed,
        "applied": false,
    }))
}

/// Apply `lore setup` for the selected clients.
pub fn setup_apply(
    home: &Path,
    clients: &[String],
    remove: bool,
    replace_unowned: bool,
    version: &str,
    socket: Option<&Path>,
) -> Result<Value, String> {
    let mut plan = setup_preview(home, clients, remove, version, socket)?;
    let selected = expand_selection(clients)?;
    let mut manifest =
        read_json(&integrations_path(home)).unwrap_or_else(|| json!({ "managed": {} }));
    let mut actions = Vec::new();

    for client in &selected {
        let path = integration_file(home, client);
        if remove {
            if !path.exists() {
                actions.push(json!({ "client": client, "state": "absent" }));
                continue;
            }
            let recorded = manifest["managed"][client]["hash"]
                .as_str()
                .map(str::to_string);
            let current = std::fs::read(&path)
                .map(|bytes| sha256_hex(&bytes))
                .unwrap_or_default();
            if recorded.as_deref() != Some(current.as_str()) {
                actions.push(json!({
                    "client": client,
                    "state": "retained",
                    "reason": "file was modified outside lore; not removing",
                }));
                continue;
            }
            std::fs::remove_file(&path).map_err(|error| format!("remove {path:?}: {error}"))?;
            if let Some(map) = manifest["managed"].as_object_mut() {
                map.remove(client);
            }
            actions.push(json!({ "client": client, "state": "removed" }));
            continue;
        }

        let document = integration_document(client, socket, version);
        let rendered = serde_json::to_string_pretty(&document).unwrap_or_default();
        let hash = sha256_hex(rendered.as_bytes());
        if path.exists() {
            let current = std::fs::read(&path)
                .map(|bytes| sha256_hex(&bytes))
                .unwrap_or_default();
            let recorded = manifest["managed"][client]["hash"]
                .as_str()
                .map(str::to_string);
            let owned = recorded.as_deref() == Some(current.as_str());
            if hash == current {
                actions.push(json!({ "client": client, "state": "unchanged" }));
                continue;
            }
            if !owned && !replace_unowned {
                return Err(format!(
                    "{} exists and is not owned by lore; rerun with --replace-unowned to replace it",
                    path.display()
                ));
            }
            // Recoverable copy before replacing an owned entry.
            std::fs::create_dir_all(backup_dir(home))
                .map_err(|error| format!("create backup dir: {error}"))?;
            let backup = backup_dir(home).join(format!("{client}.{}.json", now_ms()));
            std::fs::copy(&path, &backup).map_err(|error| format!("backup {path:?}: {error}"))?;
        }
        write_private(&path, rendered.as_bytes())?;
        manifest["managed"][client] = json!({
            "path": path.display().to_string(),
            "hash": hash,
            "updatedMs": now_ms(),
        });
        actions.push(json!({ "client": client, "state": "written" }));
    }
    if !remove {
        manifest["formatVersion"] = json!(1);
        manifest["updatedMs"] = json!(now_ms());
    }
    if remove
        && manifest["managed"]
            .as_object()
            .is_none_or(|map| map.is_empty())
    {
        let _ = std::fs::remove_file(integrations_path(home));
    } else {
        write_private(
            &integrations_path(home),
            serde_json::to_vec_pretty(&manifest)
                .unwrap_or_default()
                .as_slice(),
        )?;
    }
    plan["applied"] = json!(true);
    plan["actions"] = json!(actions);
    Ok(plan)
}

/// Inspect an unpacked package root and report the upgrade plan.
pub fn upgrade_preview(home: &Path, from: &Path) -> Result<Value, String> {
    let version_file = read_json(&from.join("VERSION.json"));
    let version = version_file
        .as_ref()
        .and_then(|value| value["version"].as_str())
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "{} is not an unpacked package (missing VERSION.json)",
                from.display()
            )
        })?;
    for binary in ["lore", "lored"] {
        if !from.join("bin").join(binary).is_file() {
            return Err(format!("{} is missing bin/{binary}", from.display()));
        }
    }
    let target = versions_root(home).join(&version);
    let active = read_json(&crate::service::mode_path(home))
        .and_then(|value| value["activeVersion"].as_str().map(str::to_string));
    Ok(json!({
        "action": "upgrade",
        "version": version,
        "target": version_file
            .as_ref()
            .and_then(|value| value["target"].as_str())
            .unwrap_or("unknown"),
        "from": from.display().to_string(),
        "installPath": target.display().to_string(),
        "alreadyInstalled": target.exists(),
        "activeVersion": active,
        "launcher": launcher_dir(home).join("lore").display().to_string(),
        "applied": false,
    }))
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|error| format!("create {to:?}: {error}"))?;
    for entry in std::fs::read_dir(from).map_err(|error| format!("read {from:?}: {error}"))? {
        let entry = entry.map_err(|error| error.to_string())?;
        let target = to.join(entry.file_name());
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            copy_tree(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)
                .map_err(|error| format!("copy {:?}: {error}", entry.path()))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn switch_launcher(home: &Path, version: &str) -> Result<(), String> {
    let directory = launcher_dir(home);
    std::fs::create_dir_all(&directory).map_err(|error| format!("create launcher dir: {error}"))?;
    for binary in ["lore", "lored"] {
        let target = PathBuf::from(format!("../versions/{version}/bin/{binary}"));
        let link = directory.join(binary);
        let temp = directory.join(format!("{binary}.new"));
        let _ = std::fs::remove_file(&temp);
        std::os::unix::fs::symlink(&target, &temp)
            .map_err(|error| format!("symlink {temp:?}: {error}"))?;
        std::fs::rename(&temp, &link).map_err(|error| format!("switch {link:?}: {error}"))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn switch_launcher(_home: &Path, _version: &str) -> Result<(), String> {
    Err("upgrades are supported on macOS and Linux only".to_string())
}

/// Apply an upgrade: stage, validate, switch, keep the previous version.
pub fn upgrade_apply(home: &Path, from: &Path) -> Result<Value, String> {
    let mut plan = upgrade_preview(home, from)?;
    let version = plan["version"]
        .as_str()
        .ok_or_else(|| "missing version".to_string())?
        .to_string();
    let target = versions_root(home).join(&version);
    if target.exists() {
        std::fs::remove_dir_all(&target).map_err(|error| format!("replace {target:?}: {error}"))?;
    }
    copy_tree(from, &target)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for binary in ["lore", "lored"] {
            let path = target.join("bin").join(binary);
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
        }
    }

    // Validate the staged binary before the launcher moves.
    let staged = target.join("bin/lore");
    let output = Command::new(&staged)
        .arg("--version")
        .output()
        .map_err(|error| format!("staged binary did not run: {error}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&target);
        return Err("staged binary failed --version; upgrade aborted".to_string());
    }
    switch_launcher(home, &version)?;

    let mut manifest = read_json(&crate::service::mode_path(home)).unwrap_or_else(|| json!({}));
    manifest["activeVersion"] = json!(version);
    manifest["upgradedMs"] = json!(now_ms());
    if manifest["mode"].is_null() {
        manifest["mode"] = json!("v1");
    }
    write_private(
        &crate::service::mode_path(home),
        serde_json::to_vec_pretty(&manifest)
            .unwrap_or_default()
            .as_slice(),
    )?;

    // Record what is installed; previous versions stay until an operator
    // removes them, so a rollback binary remains available.
    let mut installed: Vec<String> = std::fs::read_dir(versions_root(home))
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    installed.sort();
    plan["installedVersions"] = json!(installed);
    plan["pruned"] = json!([]);
    plan["applied"] = json!(true);
    plan["validated"] = json!(true);
    Ok(plan)
}
