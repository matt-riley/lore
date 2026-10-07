//! Explicit v1 → v2 migration: preview, staged apply, resume and accounting.
//!
//! Migration never upgrades an original in place. Preview opens the source
//! read-only and creates nothing; apply copies the source into a private
//! immutable snapshot, imports it into a separate staging store and accounts
//! for every recognized row before the destination is published.

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{CoreError, CoreResult};

pub mod backup;

/// Authentic released schemas this importer supports. Anything else fails
/// closed rather than being stamped as the current version.
pub const SUPPORTED_V1_VERSIONS: &[i64] = &[13, 15, 18, 19, 20];

pub const STAGING_DIR: &str = ".lore-import";
pub const SOURCE_SNAPSHOT: &str = "source-snapshot.db";
pub const STAGING_STORE: &str = "lore-v2.db";

/// v1 tables this importer reads authoritatively.
const SUPPORTED_TABLES: &[&str] = &[
    "semantic_memory",
    "memory_suppression",
    "session_evidence",
    "memory_evidence",
    "repository_identity_mapping",
];

/// Recognized v1 tables that are intentionally not imported yet. Populated
/// rows here are `excluded_by_selection`, never silent drops.
const RECOGNIZED_EXCLUDED: &[&str] = &[
    "episode_digest",
    "day_summary",
    "memory_domain",
    "refreshable_observation",
    "deferred_extraction",
    "scope_override_audit",
    "improvement_backlog",
    "trajectory_artifact",
    "lore_activity_state",
    "coherence_activity_state",
    "retrieval_trace_sample",
    "intent_journal",
    "backfill_run",
    "backfill_run_item",
    "maintenance_run",
    "maintenance_task_state",
    "error_telemetry",
    "memory_embedding",
    "ingestion_checkpoint",
    "action_approval",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInventory {
    pub name: String,
    pub rows: i64,
    pub supported: bool,
    pub recognized: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct V1Inventory {
    pub schema_version: i64,
    pub tables: Vec<TableInventory>,
    pub fingerprint: String,
    pub unknown_populated: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigratePreview {
    pub source: String,
    pub destination: String,
    pub schema_version: i64,
    pub fingerprint: String,
    pub tables: Vec<TableInventory>,
    pub importable_rows: BTreeMap<String, i64>,
    pub excluded_rows: BTreeMap<String, i64>,
    pub unknown_populated: Vec<String>,
    pub destination_exists: bool,
    pub blockers: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MigrateCounts {
    pub imported: BTreeMap<String, i64>,
    pub excluded: BTreeMap<String, i64>,
    pub unresolved: BTreeMap<String, i64>,
    pub remapped_ids: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrateRunStatus {
    pub run_id: String,
    pub state: String,
    pub schema_version: i64,
    pub source_fingerprint: String,
    pub source_path: String,
    pub destination: String,
    pub started_ms: i64,
    pub finished_ms: Option<i64>,
    pub counts: MigrateCounts,
}

fn open_readonly(path: &Path) -> CoreResult<Connection> {
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_NO_MUTEX
        | OpenFlags::SQLITE_OPEN_URI;
    Connection::open_with_flags(path, flags)
        .map_err(|error| CoreError::precondition("MIGRATE_SOURCE_UNREADABLE", format!("{error}")))
}

fn table_exists(connection: &Connection, name: &str) -> CoreResult<bool> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![name],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

fn table_columns(connection: &Connection, name: &str) -> CoreResult<Vec<String>> {
    let mut statement = connection.prepare(&format!("PRAGMA table_info({name})"))?;
    let rows = statement.query_map([], |row| row.get::<_, String>(1))?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// Read the v1 schema version. v13 marks it in `coherence_schema_version`;
/// later releases use `lore_schema_version`.
pub fn read_schema_version(connection: &Connection) -> CoreResult<i64> {
    for table in ["lore_schema_version", "coherence_schema_version"] {
        if table_exists(connection, table)? {
            let versions: Vec<i64> = {
                let mut statement = connection.prepare(&format!("SELECT version FROM {table}"))?;
                let rows = statement.query_map([], |row| row.get(0))?;
                rows.collect::<Result<_, _>>()?
            };
            match versions.as_slice() {
                [version] => return Ok(*version),
                [] => {
                    return Err(CoreError::precondition(
                        "MIGRATE_VERSION_MISSING",
                        "source has no schema version row",
                    ));
                }
                _ => {
                    return Err(CoreError::precondition(
                        "MIGRATE_VERSION_AMBIGUOUS",
                        "source has multiple conflicting schema version rows",
                    ));
                }
            }
        }
    }
    Err(CoreError::precondition(
        "MIGRATE_VERSION_MISSING",
        "source is not a recognized Lore database",
    ))
}

fn row_count(connection: &Connection, name: &str) -> CoreResult<i64> {
    Ok(
        connection.query_row(&format!("SELECT COUNT(*) FROM {name}"), [], |row| {
            row.get(0)
        })?,
    )
}

/// Inventory and logical fingerprint. The fingerprint covers schema version,
/// per-table counts and the authoritative row values, so any input change
/// invalidates a preview.
pub fn inspect(path: &Path) -> CoreResult<V1Inventory> {
    if !path.is_file() {
        return Err(CoreError::precondition(
            "MIGRATE_SOURCE_UNREADABLE",
            "source path is not a regular file",
        ));
    }
    let connection = open_readonly(path)?;
    let schema_version = read_schema_version(&connection)?;
    if !SUPPORTED_V1_VERSIONS.contains(&schema_version) {
        return Err(CoreError::precondition(
            "MIGRATE_VERSION_UNSUPPORTED",
            format!("v1 schema {schema_version} is not in the supported set"),
        ));
    }
    let mut tables = Vec::new();
    let mut unknown_populated = Vec::new();
    let names: Vec<String> = {
        let mut statement = connection.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
             AND name NOT LIKE '%_fts%' ORDER BY name ASC",
        )?;
        let rows = statement.query_map([], |row| row.get(0))?;
        rows.collect::<Result<_, _>>()?
    };
    let mut hasher = Sha256::new();
    hasher.update(schema_version.to_string().as_bytes());
    for name in &names {
        let rows = row_count(&connection, name)?;
        let supported = SUPPORTED_TABLES.contains(&name.as_str());
        let recognized = supported
            || RECOGNIZED_EXCLUDED.contains(&name.as_str())
            || matches!(
                name.as_str(),
                "lore_schema_version" | "coherence_schema_version" | "semantic_fts" | "episode_fts"
            );
        if rows > 0 && !recognized {
            unknown_populated.push(name.clone());
        }
        tables.push(TableInventory {
            name: name.clone(),
            rows,
            supported,
            recognized,
        });
        hasher.update(name.as_bytes());
        hasher.update(rows.to_string().as_bytes());
        if supported && rows > 0 {
            hash_table_rows(&connection, name, &mut hasher)?;
        }
    }
    let fingerprint = format!("{:x}", hasher.finalize());
    Ok(V1Inventory {
        schema_version,
        tables,
        fingerprint,
        unknown_populated,
    })
}

fn hash_table_rows(connection: &Connection, name: &str, hasher: &mut Sha256) -> CoreResult<()> {
    let columns = table_columns(connection, name)?;
    let mut statement = connection.prepare(&format!("SELECT * FROM {name} ORDER BY rowid ASC"))?;
    let mut rows = statement.query([])?;
    while let Some(row) = rows.next()? {
        for index in 0..columns.len() {
            let value: rusqlite::types::Value = row.get(index)?;
            match value {
                rusqlite::types::Value::Null => hasher.update(b"\0"),
                rusqlite::types::Value::Integer(number) => {
                    hasher.update(number.to_le_bytes());
                }
                rusqlite::types::Value::Real(number) => {
                    hasher.update(number.to_le_bytes());
                }
                rusqlite::types::Value::Text(text) => {
                    hasher.update(text.as_bytes());
                }
                rusqlite::types::Value::Blob(bytes) => {
                    hasher.update(bytes);
                }
            }
            hasher.update(b"|");
        }
        hasher.update(b"\n");
    }
    Ok(())
}

/// Preview: inspect the source and report what apply would do. Creates
/// nothing on disk.
pub fn preview(source: &Path, destination: &Path) -> CoreResult<MigratePreview> {
    let inventory = inspect(source)?;
    let mut importable_rows = BTreeMap::new();
    let mut excluded_rows = BTreeMap::new();
    for table in &inventory.tables {
        if table.rows == 0 {
            continue;
        }
        if table.supported {
            importable_rows.insert(table.name.clone(), table.rows);
        } else {
            excluded_rows.insert(table.name.clone(), table.rows);
        }
    }
    let mut blockers = Vec::new();
    if !inventory.unknown_populated.is_empty() {
        blockers.push(format!(
            "unknown populated tables: {}",
            inventory.unknown_populated.join(", ")
        ));
    }
    let destination_exists = destination.exists()
        && std::fs::read_dir(destination)
            .map(|mut entries| entries.next().is_some())
            .unwrap_or(false);
    if destination_exists {
        blockers.push("destination is not empty".to_string());
    }
    Ok(MigratePreview {
        source: source.display().to_string(),
        destination: destination.display().to_string(),
        schema_version: inventory.schema_version,
        fingerprint: inventory.fingerprint,
        tables: inventory.tables,
        importable_rows,
        excluded_rows,
        unknown_populated: inventory.unknown_populated,
        destination_exists,
        blockers,
    })
}

/// Read the manifest of a destination or staging store.
pub fn read_manifest(store_path: &Path) -> CoreResult<Option<MigrateRunStatus>> {
    if !store_path.is_file() {
        return Ok(None);
    }
    let connection = Connection::open_with_flags(store_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| CoreError::precondition("MIGRATE_STORE_UNREADABLE", format!("{error}")))?;
    if !table_exists(&connection, "migration_manifest")? {
        return Ok(None);
    }
    let row = connection
        .query_row(
            "SELECT run_id, state, schema_version, source_fingerprint, source_path, started_ms, \
             finished_ms, counts_json FROM migration_manifest ORDER BY started_ms DESC LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()?;
    let Some((
        run_id,
        state,
        schema_version,
        fingerprint,
        source_path,
        started_ms,
        finished_ms,
        counts,
    )) = row
    else {
        return Ok(None);
    };
    Ok(Some(MigrateRunStatus {
        run_id,
        state,
        schema_version,
        source_fingerprint: fingerprint,
        source_path,
        destination: store_path.display().to_string(),
        started_ms,
        finished_ms,
        counts: serde_json::from_str(&counts).unwrap_or_default(),
    }))
}

/// Apply a previewed migration. Requires the exact preview fingerprint and an
/// explicit clients-stopped acknowledgement from the caller.
pub fn apply(
    source: &Path,
    destination: &Path,
    plan_fingerprint: &str,
    clients_stopped: bool,
    now_ms: i64,
) -> CoreResult<MigrateRunStatus> {
    if !clients_stopped {
        return Err(CoreError::precondition(
            "MIGRATE_CLIENTS_RUNNING",
            "apply requires --clients-stopped",
        ));
    }
    let preview = preview(source, destination)?;
    if !preview.blockers.is_empty() {
        return Err(CoreError::precondition(
            "MIGRATE_BLOCKED",
            preview.blockers.join("; "),
        ));
    }
    if preview.fingerprint != plan_fingerprint {
        return Err(CoreError::precondition(
            "MIGRATE_STALE_PLAN",
            "source changed since preview; run a new preview",
        ));
    }
    std::fs::create_dir_all(destination)?;
    let staging = destination.join(STAGING_DIR);
    if staging.exists() {
        return Err(CoreError::precondition(
            "MIGRATE_STAGING_EXISTS",
            "staging directory already exists; resume or inspect it",
        ));
    }
    std::fs::create_dir(&staging)?;
    set_private_dir(&staging)?;
    let snapshot_path = staging.join(SOURCE_SNAPSHOT);
    snapshot_database(source, &snapshot_path)?;
    let store_path = staging.join(STAGING_STORE);
    let run_id = Uuid::new_v4().to_string();
    let store = crate::store::Store::open_migration_store(&store_path)?;
    store.begin_migration(
        &run_id,
        preview.schema_version,
        &preview.fingerprint,
        &source.display().to_string(),
        now_ms,
    )?;
    store.migration_import(&snapshot_path, &run_id, preview.schema_version, now_ms)?;
    let counts = store.migration_counts()?;
    let status = publish(
        destination,
        &staging,
        &run_id,
        preview.schema_version,
        &preview.fingerprint,
        source,
        now_ms,
        counts,
    )?;
    Ok(status)
}

#[allow(clippy::too_many_arguments)]
fn publish(
    destination: &Path,
    staging: &Path,
    run_id: &str,
    schema_version: i64,
    fingerprint: &str,
    source: &Path,
    now_ms: i64,
    counts: MigrateCounts,
) -> CoreResult<MigrateRunStatus> {
    let store_path = staging.join(STAGING_STORE);
    {
        let connection = Connection::open(&store_path)?;
        connection.execute(
            "UPDATE migration_manifest SET state = 'validated', finished_ms = ?2, counts_json = ?3 \
             WHERE run_id = ?1",
            params![run_id, now_ms, serde_json::to_string(&counts)?],
        )?;
        connection.pragma_update(None, "wal_checkpoint", "TRUNCATE")?;
    }
    let published = destination.join(STAGING_STORE);
    std::fs::rename(&store_path, &published)?;
    fsync_dir(destination)?;
    Ok(MigrateRunStatus {
        run_id: run_id.to_string(),
        state: "validated".to_string(),
        schema_version,
        source_fingerprint: fingerprint.to_string(),
        source_path: source.display().to_string(),
        destination: published.display().to_string(),
        started_ms: now_ms,
        finished_ms: Some(now_ms),
        counts,
    })
}

/// Resume a staged import from its immutable snapshot. The stored fingerprint
/// must still match the snapshot; a changed input requires a new preview.
pub fn resume(destination: &Path, run_id: &str, now_ms: i64) -> CoreResult<MigrateRunStatus> {
    let staging = destination.join(STAGING_DIR);
    let snapshot = staging.join(SOURCE_SNAPSHOT);
    let store_path = staging.join(STAGING_STORE);
    if !snapshot.is_file() || !store_path.is_file() {
        return Err(CoreError::precondition(
            "MIGRATE_RUN_UNKNOWN",
            "no staged run to resume",
        ));
    }
    let manifest = read_manifest(&store_path)?
        .ok_or_else(|| CoreError::precondition("MIGRATE_RUN_UNKNOWN", "manifest is missing"))?;
    if manifest.run_id != run_id {
        return Err(CoreError::precondition(
            "MIGRATE_RUN_UNKNOWN",
            "run id does not match the staged manifest",
        ));
    }
    let snapshot_inventory = inspect(&snapshot)?;
    if snapshot_inventory.fingerprint != manifest.source_fingerprint {
        return Err(CoreError::precondition(
            "MIGRATE_SNAPSHOT_CHANGED",
            "snapshot no longer matches the run fingerprint",
        ));
    }
    let store = crate::store::Store::open_migration_store(&store_path)?;
    store.migration_import(&snapshot, run_id, manifest.schema_version, now_ms)?;
    let counts = store.migration_counts()?;
    publish(
        destination,
        &staging,
        run_id,
        manifest.schema_version,
        &manifest.source_fingerprint,
        Path::new(&manifest.source_path),
        now_ms,
        counts,
    )
}

pub fn status(destination: &Path, run_id: &str) -> CoreResult<MigrateRunStatus> {
    let staging = destination.join(STAGING_DIR).join(STAGING_STORE);
    let published = destination.join(STAGING_STORE);
    for path in [published, staging] {
        if let Some(manifest) = read_manifest(&path)?
            && manifest.run_id == run_id
        {
            return Ok(manifest);
        }
    }
    Err(CoreError::precondition(
        "MIGRATE_RUN_UNKNOWN",
        "run id not found at this destination",
    ))
}

/// Consistent copy of a SQLite database using the online backup API.
pub fn snapshot_database(source: &Path, destination: &Path) -> CoreResult<()> {
    let source_connection = open_readonly(source)?;
    let mut target = Connection::open(destination)?;
    let backup = rusqlite::backup::Backup::new(&source_connection, &mut target)
        .map_err(|error| CoreError::internal("MIGRATE_SNAPSHOT_FAILED", format!("{error}")))?;
    backup
        .run_to_completion(256, std::time::Duration::from_millis(0), None)
        .map_err(|error| CoreError::internal("MIGRATE_SNAPSHOT_FAILED", format!("{error}")))?;
    drop(backup);
    target.pragma_update(None, "journal_mode", "DELETE")?;
    drop(target);
    set_private(destination)?;
    Ok(())
}

pub fn set_private(path: &Path) -> CoreResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    Ok(())
}

/// Directories need traverse permission; files get 0600.
pub fn set_private_dir(path: &Path) -> CoreResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn fsync_dir(path: &Path) -> CoreResult<()> {
    let directory = std::fs::File::open(path)?;
    directory.sync_all()?;
    Ok(())
}

/// Parse the ISO-8601 timestamps v1 stores into UTC epoch milliseconds.
/// Naive and ambiguous forms return `None` and are counted as unresolved.
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 {
        return None;
    }
    let date = &text[0..10];
    let separator = bytes.get(10)?;
    if !matches!(separator, b'T' | b' ') {
        return None;
    }
    let year: i64 = date.get(0..4)?.parse().ok()?;
    let month: i64 = date.get(5..7)?.parse().ok()?;
    let day: i64 = date.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let (second, fraction_ms, rest_start) = if bytes.get(16) == Some(&b':') {
        let second: i64 = text.get(17..19)?.parse().ok()?;
        let mut start = 19;
        let mut fraction = 0;
        if bytes.get(start) == Some(&b'.') {
            let mut digits = 0;
            let mut value = 0;
            while let Some(byte) = bytes.get(start + 1 + digits) {
                if !byte.is_ascii_digit() {
                    break;
                }
                if digits < 3 {
                    value = value * 10 + i64::from(byte - b'0');
                }
                digits += 1;
            }
            if digits == 0 {
                return None;
            }
            fraction = value * 10_i64.pow(3 - (digits.min(3) as u32));
            start += 1 + digits;
        }
        (second, fraction, start)
    } else {
        (0, 0, 16)
    };
    if !(0..=23).contains(&hour) || !(0..=59).contains(&minute) || !(0..=59).contains(&second) {
        return None;
    }
    let zone = text.get(rest_start..)?;
    let offset_minutes = match zone {
        "Z" | "z" | "+00:00" | "+0000" => 0,
        "" => return None,
        _ => {
            let sign = match zone.as_bytes().first()? {
                b'+' => 1,
                b'-' => -1,
                _ => return None,
            };
            let digits: String = zone
                .chars()
                .skip(1)
                .filter(|character| character.is_ascii_digit())
                .collect();
            if digits.len() != 4 {
                return None;
            }
            let hours: i64 = digits.get(0..2)?.parse().ok()?;
            let minutes: i64 = digits.get(2..4)?.parse().ok()?;
            sign * (hours * 60 + minutes)
        }
    };
    let days = days_from_civil(year, month, day);
    let ms = days * 86_400_000 + (hour * 3_600 + minute * 60 + second) * 1_000 + fraction_ms
        - offset_minutes * 60_000;
    Some(ms)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// Stable v2 id for a v1 row: valid ids are preserved, other ids are mapped
/// deterministically so references can be remapped.
pub fn map_id(id: &str) -> (String, bool) {
    let valid = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'));
    if valid {
        (id.to_string(), false)
    } else {
        let mut hasher = Sha256::new();
        hasher.update(id.as_bytes());
        (
            format!("mig_{}", &format!("{:x}", hasher.finalize())[..32]),
            true,
        )
    }
}

/// Which authoritative tables exist in this source version.
pub fn supported_present(inventory: &V1Inventory) -> BTreeSet<String> {
    inventory
        .tables
        .iter()
        .filter(|table| table.supported && table.rows > 0)
        .map(|table| table.name.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_timestamps_convert_with_offsets() {
        assert_eq!(
            parse_iso_ms("2026-01-01T00:00:00.000Z"),
            Some(1_767_225_600_000)
        );
        assert_eq!(
            parse_iso_ms("2026-01-01T01:00:00.000+01:00"),
            Some(1_767_225_600_000)
        );
        assert_eq!(
            parse_iso_ms("2026-01-01T00:00:00Z"),
            Some(1_767_225_600_000)
        );
        assert_eq!(parse_iso_ms("2026-01-01"), None);
        assert_eq!(parse_iso_ms("2026-01-01T00:00:00"), None);
        assert_eq!(parse_iso_ms("not a timestamp"), None);
    }

    #[test]
    fn ids_are_preserved_or_deterministically_mapped() {
        assert_eq!(map_id("abc-123"), ("abc-123".to_string(), false));
        let (first, remapped) = map_id("bad id/with chars");
        assert!(remapped);
        assert_eq!(first, map_id("bad id/with chars").0);
        assert!(first.starts_with("mig_"));
    }
}
