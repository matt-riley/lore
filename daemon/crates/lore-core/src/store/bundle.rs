//! Portable bundles: signed JSON export and OKF v0.1 directory export/import.
//!
//! Exports cover approved improvement artifacts (accepted/done backlog
//! items). Imports are limited to OKF directories staged under the data
//! directory, are idempotent by checksum, and follow first-content-wins by
//! repository/concept identity.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::params;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::error::{CoreError, CoreResult};
use crate::store::Store;

const MAX_BUNDLE_FILES: usize = 200;
const MAX_BUNDLE_FILE_BYTES: u64 = 256 * 1024;
const MAX_ARTIFACTS: i64 = 500;

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

/// Data directory that contains the store file.
fn data_dir(store: &Store) -> CoreResult<PathBuf> {
    store
        .store_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| CoreError::internal("BUNDLE_PATH_INVALID", "store has no parent directory"))
}

/// Resolve an operator-supplied path and require it to live under
/// `<dataDir>/bundles`, rejecting traversal and symlinked roots.
fn approved_path(root: &Path, candidate: Option<&str>) -> CoreResult<PathBuf> {
    let bundles = root.join("bundles");
    let resolved = match candidate {
        Some(candidate) => {
            let path = Path::new(candidate);
            if path.is_absolute() {
                path.to_path_buf()
            } else {
                root.join(path)
            }
        }
        None => bundles.clone(),
    };
    if resolved
        .components()
        .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(CoreError::invalid(
            "BUNDLE_PATH_INVALID",
            "bundle paths may not contain ..",
        ));
    }
    let canonical_root = fs::canonicalize(root)
        .map_err(|_| CoreError::invalid("BUNDLE_PATH_INVALID", "data directory is not readable"))?;
    // The path may not exist yet; canonicalize its nearest existing ancestor.
    let mut existing = resolved.clone();
    while !existing.exists() {
        existing = existing
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| CoreError::invalid("BUNDLE_PATH_INVALID", "bundle path escapes root"))?;
    }
    let canonical_existing = fs::canonicalize(&existing)
        .map_err(|_| CoreError::invalid("BUNDLE_PATH_INVALID", "bundle path is not readable"))?;
    if !canonical_existing.starts_with(&canonical_root) {
        return Err(CoreError::invalid(
            "BUNDLE_PATH_INVALID",
            "bundle paths must stay inside the data directory",
        ));
    }
    Ok(resolved)
}

struct Artifact {
    id: String,
    kind: String,
    title: String,
    detail: String,
    state: String,
    updated_ms: i64,
}

fn approved_artifacts(connection: &rusqlite::Connection) -> CoreResult<Vec<Artifact>> {
    let mut statement = connection.prepare(
        "SELECT id, kind, title, detail, state, updated_ms FROM improvement_backlog \
         WHERE state IN ('accepted', 'done') ORDER BY updated_ms DESC, id ASC LIMIT ?1",
    )?;
    let artifacts = statement
        .query_map(params![MAX_ARTIFACTS], |row| {
            Ok(Artifact {
                id: row.get(0)?,
                kind: row.get(1)?,
                title: row.get(2)?,
                detail: row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                state: row.get(4)?,
                updated_ms: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(artifacts)
}

fn artifact_json(artifact: &Artifact) -> Value {
    json!({
        "id": artifact.id,
        "kind": artifact.kind,
        "title": artifact.title,
        "detail": artifact.detail,
        "state": artifact.state,
        "updatedMs": artifact.updated_ms,
    })
}

fn slug(value: &str) -> String {
    let mut out = String::new();
    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            out.push(character.to_ascii_lowercase());
        } else if (character == '-' || character == '_' || character == ' ') && !out.ends_with('-')
        {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "artifact".to_string()
    } else {
        trimmed
    }
}

fn write_private(path: &Path, bytes: &[u8]) -> CoreResult<()> {
    fs::write(path, bytes)?;
    crate::migration::set_private(path)?;
    Ok(())
}

impl Store {
    /// Export approved improvement artifacts as a signed JSON file or an
    /// OKF v0.1 directory.
    pub fn bundle_export(
        &self,
        format: &str,
        path: Option<&str>,
        now_ms: i64,
    ) -> CoreResult<Value> {
        let format = if format.is_empty() { "json" } else { format };
        let root = data_dir(self)?;
        let default_name = if format == "json" {
            format!("export-{now_ms}.json")
        } else {
            format!("export-{now_ms}")
        };
        let resolved = approved_path(&root, path)?;
        let artifacts = {
            let connection = self.reader().lock().expect("reader lock");
            approved_artifacts(&connection)?
        };
        let payload: Vec<Value> = artifacts.iter().map(artifact_json).collect();
        let canonical = serde_json::to_string(&payload)?;
        let checksum = sha256_hex(canonical.as_bytes());

        match format {
            "json" => {
                let target = if resolved.is_dir() || path.is_none() {
                    resolved.join(&default_name)
                } else {
                    resolved.clone()
                };
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent)?;
                    crate::migration::set_private_dir(parent)?;
                }
                let body = serde_json::to_vec_pretty(&json!({
                    "formatVersion": 1,
                    "exportedMs": now_ms,
                    "storeId": self.store_path.display().to_string(),
                    "artifacts": payload,
                    "checksum": checksum,
                }))?;
                let temp = target.with_extension("json.tmp");
                write_private(&temp, &body)?;
                fs::rename(&temp, &target)?;
                Ok(json!({
                    "format": "json",
                    "path": target.display().to_string(),
                    "artifacts": artifacts.len(),
                    "checksum": checksum,
                }))
            }
            "okf" => {
                let target = if path.is_some() {
                    resolved.clone()
                } else {
                    resolved.join(&default_name)
                };
                let stage = target.with_extension(format!("tmp-{now_ms}"));
                if stage.exists() {
                    fs::remove_dir_all(&stage)?;
                }
                fs::create_dir_all(&stage)?;
                crate::migration::set_private_dir(&stage)?;
                let mut index = String::from("# Portable improvement bundle\n\n");
                index.push_str(&format!("- exported: {now_ms}\n- checksum: {checksum}\n\n"));
                index.push_str("## Concepts\n\n");
                for (position, artifact) in artifacts.iter().enumerate() {
                    let file_name = format!("{position:03}-{}.md", slug(&artifact.id));
                    index.push_str(&format!(
                        "- [{title}]({file_name}) — {kind} ({state})\n",
                        title = artifact.title,
                        kind = artifact.kind,
                        state = artifact.state
                    ));
                    let body = format!(
                        "---\nname: {name}\ndescription: {description}\nconceptId: {id}\nkind: {kind}\nstate: {state}\n---\n\n{detail}\n",
                        name = artifact.title.replace('\n', " "),
                        description = artifact
                            .detail
                            .lines()
                            .next()
                            .unwrap_or_default()
                            .replace('\n', " "),
                        id = artifact.id,
                        kind = artifact.kind,
                        state = artifact.state,
                        detail = if artifact.detail.is_empty() {
                            artifact.title.clone()
                        } else {
                            artifact.detail.clone()
                        }
                    );
                    write_private(&stage.join(&file_name), body.as_bytes())?;
                }
                write_private(&stage.join("index.md"), index.as_bytes())?;
                write_private(
                    &stage.join("manifest.json"),
                    serde_json::to_vec_pretty(&json!({
                        "formatVersion": 1,
                        "format": "okf",
                        "exportedMs": now_ms,
                        "artifacts": artifacts.len(),
                        "checksum": checksum,
                    }))?
                    .as_slice(),
                )?;
                if target.exists() {
                    fs::remove_dir_all(&target)?;
                }
                fs::rename(&stage, &target)?;
                Ok(json!({
                    "format": "okf",
                    "path": target.display().to_string(),
                    "artifacts": artifacts.len(),
                    "checksum": checksum,
                }))
            }
            other => Err(CoreError::invalid(
                "ADMIN_ARGUMENT_INVALID",
                format!("unsupported bundle format: {other}"),
            )),
        }
    }

    /// Import an OKF v0.1 bundle directory staged under the data directory.
    pub fn bundle_import_okf(&self, path: &str, now_ms: i64) -> CoreResult<Value> {
        let root = data_dir(self)?;
        let resolved = approved_path(&root, Some(path))?;
        let metadata = fs::symlink_metadata(&resolved).map_err(|error| {
            CoreError::invalid(
                "BUNDLE_PATH_INVALID",
                format!("bundle not readable: {error}"),
            )
        })?;
        if metadata.file_type().is_symlink() {
            return Err(CoreError::invalid(
                "BUNDLE_PATH_INVALID",
                "bundle directories may not be symlinks",
            ));
        }
        if !metadata.is_dir() {
            return Err(CoreError::invalid(
                "BUNDLE_PATH_INVALID",
                "OKF import expects a directory",
            ));
        }

        let mut files: Vec<(String, String)> = Vec::new();
        for entry in fs::read_dir(&resolved)?.take(MAX_BUNDLE_FILES + 1) {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() || !file_type.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") || name == "index.md" {
                continue;
            }
            if files.len() >= MAX_BUNDLE_FILES {
                return Err(CoreError::invalid(
                    "BUNDLE_LIMIT",
                    "OKF bundle exceeds the file limit",
                ));
            }
            let bytes = fs::read(entry.path())?;
            if bytes.len() as u64 > MAX_BUNDLE_FILE_BYTES {
                return Err(CoreError::invalid(
                    "BUNDLE_LIMIT",
                    "OKF concept exceeds the size limit",
                ));
            }
            files.push((name, String::from_utf8_lossy(&bytes).to_string()));
        }
        if files.is_empty() {
            return Err(CoreError::invalid(
                "BUNDLE_EMPTY",
                "OKF bundle contains no concept files",
            ));
        }
        files.sort_by(|left, right| left.0.cmp(&right.0));

        let canonical = files
            .iter()
            .map(|(name, body)| format!("{name}\u{0}{body}"))
            .collect::<Vec<_>>()
            .join("\u{1}");
        let checksum = sha256_hex(canonical.as_bytes());

        let mut connection = self.writer.lock().expect("writer lock");
        let transaction =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let known: Option<i64> = transaction
            .query_row(
                "SELECT concepts FROM bundle_imports WHERE checksum = ?1",
                params![checksum],
                |row| row.get(0),
            )
            .ok();
        if let Some(concepts) = known {
            return Ok(json!({
                "alreadyImported": true,
                "concepts": concepts,
                "checksum": checksum,
            }));
        }

        let mut revision: i64 = transaction.query_row(
            "SELECT memory_revision FROM store_metadata WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        let mut imported = 0i64;
        let mut skipped = 0i64;
        let mut counts = BTreeMap::new();
        for (file_name, body) in &files {
            let (frontmatter, content) = split_frontmatter(body);
            let concept_id = frontmatter
                .get("conceptid")
                .cloned()
                .unwrap_or_else(|| file_name.trim_end_matches(".md").to_string());
            let repository = frontmatter.get("repository").cloned();
            let topic_key = format!(
                "okf::{}::{}",
                repository.clone().unwrap_or_else(|| "global".to_string()),
                slug(&concept_id)
            );
            let exists: Option<String> = transaction
                .query_row(
                    "SELECT id FROM memories WHERE topic_key = ?1 AND forgotten = 0 AND superseded_by IS NULL",
                    params![topic_key],
                    |row| row.get(0),
                )
                .ok();
            if exists.is_some() {
                skipped += 1;
                continue;
            }
            let trimmed = content.trim();
            if trimmed.is_empty() {
                skipped += 1;
                continue;
            }
            let title = frontmatter
                .get("name")
                .cloned()
                .unwrap_or_else(|| concept_id.clone());
            let text = format!("# {title}\n\n{trimmed}");
            let content_hash = crate::policy::sha256_hex(text.as_bytes());
            revision += 1;
            let memory_id = uuid::Uuid::new_v4().to_string();
            let (scope, repository_value) = match &repository {
                Some(repository) => ("repo", Some(repository.clone())),
                None => ("global", None),
            };
            transaction.execute(
                "INSERT INTO memories (id, kind, content, content_hash, scope, repository, authority, \
                 confidence, tags_json, source_session_id, created_ms, updated_ms, expires_at_ms, \
                 revision, forgotten, topic_key) \
                 VALUES (?1, 'okf_concept', ?2, ?3, ?4, ?5, 'imported', 0.7, ?6, NULL, ?7, ?7, NULL, ?8, 0, ?9)",
                params![
                    memory_id,
                    text,
                    content_hash,
                    scope,
                    repository_value,
                    serde_json::to_string(&vec!["okf_concept", "imported"])?,
                    now_ms,
                    revision,
                    topic_key
                ],
            )?;
            transaction.execute(
                "INSERT INTO memory_fts (content, kind, tags, memory_id) VALUES (?1, 'okf_concept', 'okf_concept imported', ?2)",
                params![text, memory_id],
            )?;
            let state = if self.embedding_enabled {
                "pending"
            } else {
                "disabled"
            };
            transaction.execute(
                "INSERT INTO embedding_intents (memory_id, desired_revision, state, attempts, next_attempt_ms, terminal_reason, content_hash, model_identity, updated_ms) \
                 VALUES (?1, ?2, ?3, 0, NULL, NULL, ?4, ?5, ?6)",
                params![
                    memory_id,
                    revision,
                    state,
                    content_hash,
                    self.embedding_identity.as_deref().unwrap_or(""),
                    now_ms
                ],
            )?;
            imported += 1;
        }
        if imported > 0 {
            transaction.execute(
                "UPDATE store_metadata SET memory_revision = ?1, active_memories = \
                 (SELECT COUNT(*) FROM memories WHERE forgotten = 0 AND superseded_by IS NULL) WHERE id = 1",
                params![revision],
            )?;
        }
        transaction.execute(
            "INSERT INTO bundle_imports (checksum, path, concepts, created_ms) VALUES (?1, ?2, ?3, ?4)",
            params![checksum, resolved.display().to_string(), imported, now_ms],
        )?;
        super::governance::ledger_insert(
            &transaction,
            "import",
            None,
            Some(&format!(
                "okf import: {imported} concepts, {skipped} skipped"
            )),
            None,
            Some(revision),
            now_ms,
        )?;
        transaction.commit()?;
        counts.insert("imported".to_string(), imported);
        counts.insert("skipped".to_string(), skipped);
        Ok(json!({
            "alreadyImported": false,
            "concepts": imported,
            "skipped": skipped,
            "checksum": checksum,
            "committedRevision": revision,
        }))
    }
}

fn split_frontmatter(body: &str) -> (BTreeMap<String, String>, String) {
    let mut fields = BTreeMap::new();
    let mut content = body;
    if let Some(rest) = body.strip_prefix("---")
        && let Some(end) = rest.find("\n---")
    {
        let header = &rest[..end];
        for line in header.lines() {
            if let Some((key, value)) = line.split_once(':') {
                fields.insert(
                    key.trim().to_lowercase(),
                    value.trim().trim_matches('"').to_string(),
                );
            }
        }
        let after = &rest[end + 4..];
        content = after.trim_start_matches(['\n', '\r']);
    }
    (fields, content.to_string())
}
