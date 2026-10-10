//! Durable uncertain-write journal.
//!
//! Before a mutation is dispatched the exact payload and idempotency key are
//! persisted (atomic write + fsync). A committed acknowledgement resolves the
//! entry and drops its payload; failures keep it uncertain for an explicit
//! retry. The journal contains no ambient recall queries.

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const CAPACITY: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    pub key: String,
    pub operation: String,
    pub store_id: Option<String>,
    pub client_id: String,
    pub created_ms: i64,
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Value>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct JournalFile {
    pub version: u32,
    pub entries: BTreeMap<String, JournalEntry>,
}

pub struct Journal {
    path: PathBuf,
    file: JournalFile,
}

impl Journal {
    /// Open (or create) the journal inside an owned data directory.
    pub fn open(data_dir: &Path) -> Result<Self, String> {
        let path = data_dir.join("uncertain-writes.json");
        let file = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("uncertain-write journal is corrupt: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => JournalFile {
                version: 1,
                entries: BTreeMap::new(),
            },
            Err(error) => return Err(format!("cannot read journal: {error}")),
        };
        Ok(Self { path, file })
    }

    pub fn entries(&self) -> impl Iterator<Item = &JournalEntry> {
        self.file.entries.values()
    }

    /// Persist an entry before dispatch. Capacity or persistence failure must
    /// reject the write rather than dispatching it.
    pub fn record(&mut self, entry: JournalEntry) -> Result<(), String> {
        if !self.file.entries.contains_key(&entry.key) && self.file.entries.len() >= CAPACITY {
            return Err(
                "uncertain-write journal is full; resolve entries with `lore retries resolve`"
                    .to_string(),
            );
        }
        self.file.entries.insert(entry.key.clone(), entry);
        self.flush()
    }

    /// Mark a key resolved and drop its payload.
    pub fn resolve(&mut self, key: &str) -> Result<bool, String> {
        let Some(entry) = self.file.entries.get_mut(key) else {
            return Ok(false);
        };
        entry.state = "resolved".to_string();
        entry.payload = None;
        self.flush()?;
        Ok(true)
    }

    fn flush(&self) -> Result<(), String> {
        let temporary = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&self.file).map_err(|error| error.to_string())?;
        {
            let mut file =
                std::fs::File::create(&temporary).map_err(|error| format!("journal: {error}"))?;
            file.write_all(&bytes)
                .map_err(|error| format!("journal: {error}"))?;
            file.sync_all()
                .map_err(|error| format!("journal: {error}"))?;
        }
        std::fs::rename(&temporary, &self.path).map_err(|error| format!("journal: {error}"))?;
        if let Some(directory) = self.path.parent()
            && let Ok(handle) = std::fs::File::open(directory)
        {
            let _ = handle.sync_all();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str) -> JournalEntry {
        JournalEntry {
            key: key.to_string(),
            operation: "lore_retain".to_string(),
            store_id: Some("store-1".to_string()),
            client_id: "cli".to_string(),
            created_ms: 1_000,
            state: "uncertain".to_string(),
            payload: Some(serde_json::json!({"content": "secret"})),
        }
    }

    #[test]
    fn entries_persist_resolve_and_drop_payloads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut journal = Journal::open(dir.path()).expect("open");
        journal.record(entry("key-1")).expect("record");
        let reopened = Journal::open(dir.path()).expect("reopen");
        assert_eq!(reopened.entries().count(), 1);
        assert!(reopened.entries().next().unwrap().payload.is_some());

        let mut journal = Journal::open(dir.path()).expect("reopen");
        assert!(journal.resolve("key-1").expect("resolve"));
        let reopened = Journal::open(dir.path()).expect("reopen");
        let stored = reopened.entries().next().expect("entry");
        assert_eq!(stored.state, "resolved");
        assert!(stored.payload.is_none(), "resolved payloads are dropped");
        assert!(!journal.resolve("missing").expect("missing"));
    }

    #[test]
    fn capacity_is_enforced_before_dispatch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut journal = Journal::open(dir.path()).expect("open");
        for index in 0..CAPACITY {
            journal
                .record(entry(&format!("key-{index}")))
                .expect("record");
        }
        let error = journal.record(entry("overflow")).expect_err("capacity");
        assert!(error.contains("full"), "{error}");
    }
}
