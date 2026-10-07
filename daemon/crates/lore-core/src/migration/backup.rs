//! Consistent snapshots and suppression-safe restoration.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    pub store_id: String,
    pub schema_version: i64,
    pub memory_revision: i64,
    pub created_ms: i64,
    pub checksum: String,
    pub tool_version: String,
    pub memories: i64,
    pub suppressions: i64,
    pub receipts: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestorePreview {
    pub snapshot: String,
    pub target: String,
    pub snapshot_store_id: String,
    pub target_store_id: String,
    pub snapshot_memories: i64,
    pub target_memories: i64,
    pub current_suppressions: i64,
    pub plan_fingerprint: String,
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreReport {
    pub target: String,
    pub rescue: String,
    pub snapshot: String,
    pub restored_memories: i64,
    pub merged_suppressions: i64,
    pub merged_receipts: i64,
}

fn file_checksum(path: &Path) -> CoreResult<String> {
    let bytes = std::fs::read(path)?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(format!("{:x}", hasher.finalize()))
}

fn manifest_path(snapshot: &Path) -> PathBuf {
    PathBuf::from(format!("{}.manifest.json", snapshot.display()))
}

fn require_healthy(connection: &Connection) -> CoreResult<()> {
    let integrity: String = connection.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(CoreError::precondition(
            "RESTORE_INTEGRITY",
            format!("integrity check failed: {integrity}"),
        ));
    }
    let foreign_key_failures: i64 =
        connection.query_row("SELECT COUNT(*) FROM pragma_foreign_key_check", [], |row| {
            row.get(0)
        })?;
    if foreign_key_failures > 0 {
        return Err(CoreError::precondition(
            "RESTORE_INTEGRITY",
            "foreign key check failed",
        ));
    }
    Ok(())
}

/// Create a consistent, integrity-checked snapshot plus a manifest sidecar.
pub fn backup(source: &Path, destination: &Path, now_ms: i64) -> CoreResult<BackupManifest> {
    if destination.exists() {
        return Err(CoreError::precondition(
            "BACKUP_EXISTS",
            "backup destination already exists",
        ));
    }
    let source_connection =
        Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(
            |error| CoreError::precondition("BACKUP_SOURCE_UNREADABLE", format!("{error}")),
        )?;
    let mut target = Connection::open(destination)?;
    {
        let backup = rusqlite::backup::Backup::new(&source_connection, &mut target)
            .map_err(|error| CoreError::internal("BACKUP_FAILED", format!("{error}")))?;
        backup
            .run_to_completion(256, std::time::Duration::from_millis(0), None)
            .map_err(|error| CoreError::internal("BACKUP_FAILED", format!("{error}")))?;
    }
    target.pragma_update(None, "journal_mode", "DELETE")?;
    require_healthy(&target)?;
    let (store_id, schema_version, memory_revision): (String, i64, i64) = target.query_row(
        "SELECT store_id, schema_version, memory_revision FROM store_metadata WHERE id = 1",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    let memories: i64 = target.query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))?;
    let suppressions: i64 =
        target.query_row("SELECT COUNT(*) FROM suppressions", [], |row| row.get(0))?;
    let receipts: i64 =
        target.query_row("SELECT COUNT(*) FROM idempotency_receipts", [], |row| {
            row.get(0)
        })?;
    drop(target);
    crate::migration::set_private(destination)?;
    let checksum = file_checksum(destination)?;
    let manifest = BackupManifest {
        store_id,
        schema_version,
        memory_revision,
        created_ms: now_ms,
        checksum,
        tool_version: env!("CARGO_PKG_VERSION").to_string(),
        memories,
        suppressions,
        receipts,
    };
    let sidecar = manifest_path(destination);
    std::fs::write(&sidecar, serde_json::to_vec_pretty(&manifest)?)?;
    crate::migration::set_private(&sidecar)?;
    Ok(manifest)
}

/// Verify a snapshot and return its manifest.
pub fn inspect(snapshot: &Path) -> CoreResult<BackupManifest> {
    if !snapshot.is_file() {
        return Err(CoreError::precondition(
            "RESTORE_SNAPSHOT_UNREADABLE",
            "snapshot file is missing",
        ));
    }
    let raw = std::fs::read(manifest_path(snapshot)).map_err(|_| {
        CoreError::precondition("RESTORE_MANIFEST_MISSING", "snapshot manifest is missing")
    })?;
    let manifest: BackupManifest = serde_json::from_slice(&raw)?;
    let checksum = file_checksum(snapshot)?;
    if checksum != manifest.checksum {
        return Err(CoreError::precondition(
            "RESTORE_CHECKSUM_MISMATCH",
            "snapshot checksum does not match its manifest",
        ));
    }
    let connection =
        Connection::open_with_flags(snapshot, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(
            |error| CoreError::precondition("RESTORE_SNAPSHOT_UNREADABLE", format!("{error}")),
        )?;
    let has_metadata: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'store_metadata'",
        [],
        |row| row.get(0),
    )?;
    if has_metadata == 0 {
        return Err(CoreError::precondition(
            "RESTORE_INCOMPATIBLE",
            "snapshot is not a v2 store",
        ));
    }
    require_healthy(&connection)?;
    Ok(manifest)
}

/// Preview a restore against the current target without changing anything.
pub fn restore_preview(snapshot: &Path, target: &Path) -> CoreResult<RestorePreview> {
    let manifest = inspect(snapshot)?;
    if !target.is_file() {
        return Err(CoreError::precondition(
            "RESTORE_TARGET_UNREADABLE",
            "restore target is missing",
        ));
    }
    let target_connection =
        Connection::open_with_flags(target, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(
            |error| CoreError::precondition("RESTORE_TARGET_UNREADABLE", format!("{error}")),
        )?;
    let (target_store_id, target_schema, _target_revision): (String, i64, i64) = target_connection
        .query_row(
            "SELECT store_id, schema_version, memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
    let mut blockers = Vec::new();
    if manifest.schema_version > target_schema {
        blockers.push("snapshot schema is newer than the target".to_string());
    }
    if target_store_id != manifest.store_id {
        blockers.push("snapshot belongs to a different store id".to_string());
    }
    if let Some(state) = target_connection
        .query_row(
            "SELECT state FROM migration_manifest ORDER BY started_ms DESC LIMIT 1",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        && state != "validated"
        && state != "complete"
    {
        blockers.push(format!("target has an unfinished import: {state}"));
    }
    let target_memories: i64 =
        target_connection.query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))?;
    let current_suppressions: i64 =
        target_connection.query_row("SELECT COUNT(*) FROM suppressions", [], |row| row.get(0))?;
    drop(target_connection);
    let mut hasher = Sha256::new();
    hasher.update(manifest.checksum.as_bytes());
    hasher.update(target_store_id.as_bytes());
    hasher.update(target_memories.to_string().as_bytes());
    hasher.update(current_suppressions.to_string().as_bytes());
    Ok(RestorePreview {
        snapshot: snapshot.display().to_string(),
        target: target.display().to_string(),
        snapshot_store_id: manifest.store_id,
        target_store_id,
        snapshot_memories: manifest.memories,
        target_memories,
        current_suppressions,
        plan_fingerprint: format!("{:x}", hasher.finalize()),
        blockers,
    })
}

/// Apply a previewed restore, merging durable suppression and receipt state
/// from the current target so deleted context never resurrects.
pub fn restore_apply(
    snapshot: &Path,
    target: &Path,
    plan_fingerprint: &str,
    clients_stopped: bool,
    now_ms: i64,
) -> CoreResult<RestoreReport> {
    if !clients_stopped {
        return Err(CoreError::precondition(
            "RESTORE_CLIENTS_RUNNING",
            "apply requires --clients-stopped",
        ));
    }
    let preview = restore_preview(snapshot, target)?;
    if !preview.blockers.is_empty() {
        return Err(CoreError::precondition(
            "RESTORE_BLOCKED",
            preview.blockers.join("; "),
        ));
    }
    if preview.plan_fingerprint != plan_fingerprint {
        return Err(CoreError::precondition(
            "RESTORE_STALE_PLAN",
            "target changed since preview; run a new preview",
        ));
    }
    let rescue = PathBuf::from(format!("{}.rescue-{now_ms}", target.display()));
    let stage = PathBuf::from(format!("{}.restore-stage", target.display()));
    if stage.exists() {
        let _ = std::fs::remove_file(&stage);
    }
    // Rescue current state, then stage the snapshot.
    {
        let source =
            Connection::open_with_flags(target, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut destination = Connection::open(&rescue)?;
        let backup = rusqlite::backup::Backup::new(&source, &mut destination)
            .map_err(|error| CoreError::internal("RESTORE_RESCUE_FAILED", format!("{error}")))?;
        backup
            .run_to_completion(256, std::time::Duration::from_millis(0), None)
            .map_err(|error| CoreError::internal("RESTORE_RESCUE_FAILED", format!("{error}")))?;
    }
    {
        let source =
            Connection::open_with_flags(snapshot, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut destination = Connection::open(&stage)?;
        let backup = rusqlite::backup::Backup::new(&source, &mut destination)
            .map_err(|error| CoreError::internal("RESTORE_STAGE_FAILED", format!("{error}")))?;
        backup
            .run_to_completion(256, std::time::Duration::from_millis(0), None)
            .map_err(|error| CoreError::internal("RESTORE_STAGE_FAILED", format!("{error}")))?;
    }
    // Merge current suppressions and receipts into the staged copy.
    let (merged_suppressions, merged_receipts) = {
        let connection = Connection::open(&stage)?;
        connection.execute_batch(&format!(
            "ATTACH DATABASE '{}' AS current;",
            target.display()
        ))?;
        let suppressions = connection.execute(
            "INSERT OR IGNORE INTO suppressions (memory_id, scope, repository, fingerprint, reason, revision, created_ms, state) \
             SELECT memory_id, scope, repository, fingerprint, reason, revision, created_ms, state FROM current.suppressions",
            [],
        )? as i64;
        let receipts = connection.execute(
            "INSERT OR IGNORE INTO idempotency_receipts (client_id, operation, idempotency_key, request_hash, response_json, created_ms) \
             SELECT client_id, operation, idempotency_key, request_hash, response_json, created_ms FROM current.idempotency_receipts",
            [],
        )? as i64;
        // A suppression is an authoritative deletion: rows restored from an
        // older snapshot become forgotten again, never resurrected.
        connection.execute(
            "DELETE FROM memory_fts WHERE memory_id IN ( \
               SELECT memory_id FROM current.suppressions WHERE state = 'active')",
            [],
        )?;
        connection.execute(
            "UPDATE memories SET forgotten = 1, content = '', revision = revision + 1 \
             WHERE id IN (SELECT memory_id FROM current.suppressions WHERE state = 'active')",
            [],
        )?;
        connection.execute(
            "UPDATE store_metadata SET active_memories = ( \
               SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL), \
             forgotten_memories = (SELECT COUNT(*) FROM memories WHERE forgotten = 1) \
             WHERE id = 1",
            [],
        )?;
        connection.execute_batch("DETACH DATABASE current;")?;
        require_healthy(&connection)?;
        connection.pragma_update(None, "journal_mode", "DELETE")?;
        (suppressions, receipts)
    };
    // Swap: current target becomes the rescue, validated stage takes its place.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&stage, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(target, &rescue)?;
    if let Err(error) = std::fs::rename(&stage, target) {
        // Best-effort recovery: put the rescue back if the swap failed.
        let _ = std::fs::rename(&rescue, target);
        return Err(CoreError::internal(
            "RESTORE_SWAP_FAILED",
            format!("{error}"),
        ));
    }
    let restored: i64 =
        Connection::open(target)?
            .query_row("SELECT COUNT(*) FROM memories", [], |row| row.get(0))?;
    let _ = now_ms;
    Ok(RestoreReport {
        target: target.display().to_string(),
        rescue: rescue.display().to_string(),
        snapshot: snapshot.display().to_string(),
        restored_memories: restored,
        merged_suppressions,
        merged_receipts,
    })
}
