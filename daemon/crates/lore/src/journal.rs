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
        let key = entry.key.clone();
        self.update(move |file| {
            // An unresolved payload may be the only copy of a write that committed,
            // so reusing its key for a different request is refused.
            if file
                .entries
                .get(&key)
                .is_some_and(|existing| existing.state != "resolved")
            {
                return Err(
                    "an unresolved uncertain write already uses this idempotency key".to_string(),
                );
            }
            if !file.entries.contains_key(&key)
                && file
                    .entries
                    .values()
                    .filter(|item| item.state != "resolved")
                    .count()
                    >= CAPACITY
            {
                return Err(
                    "uncertain-write journal is full; resolve entries with `lore retries resolve`"
                        .to_string(),
                );
            }
            file.entries.insert(key, entry);
            Ok(())
        })
    }

    /// Mark a key resolved and drop its payload.
    pub fn resolve(&mut self, key: &str) -> Result<bool, String> {
        let key = key.to_string();
        self.update(move |file| {
            let Some(entry) = file.entries.get_mut(&key) else {
                return Ok(false);
            };
            entry.state = "resolved".to_string();
            entry.payload = None;
            Ok(true)
        })
    }

    /// Apply one change to the latest journal contents, under a cross-process
    /// lock. Another `lore` process may have written since this one opened the
    /// journal, so the change is made on a fresh read, never on a stale snapshot.
    fn update<T>(
        &mut self,
        change: impl FnOnce(&mut JournalFile) -> Result<T, String>,
    ) -> Result<T, String> {
        let lock = self.path.with_extension("json.lock");
        let _guard = LockGuard::acquire(&lock)?;
        let latest = match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("uncertain-write journal is corrupt: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => JournalFile {
                version: 1,
                entries: BTreeMap::new(),
            },
            Err(error) => return Err(format!("cannot read journal: {error}")),
        };
        self.file = latest;
        let outcome = change(&mut self.file)?;
        self.flush()?;
        Ok(outcome)
    }

    fn flush(&self) -> Result<(), String> {
        let temporary = self.path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&self.file).map_err(|error| error.to_string())?;
        // The journal holds exact payloads of pending writes, so it is created
        // owner-only rather than with the umask's default mode. Removing a stale
        // temporary first matters: truncating it would keep its old mode.
        let _ = std::fs::remove_file(&temporary);
        {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options
                .open(&temporary)
                .map_err(|error| format!("journal: {error}"))?;
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

/// Holds the journal lock for one update. Waits briefly for a live holder and
/// treats a lock older than `STALE_LOCK` as left by a process that died.
struct LockGuard {
    path: PathBuf,
    /// Inode of the lock file this guard created. Release removes the path only
    /// while it still names this file, so a lock taken over by someone else is left alone.
    #[cfg(unix)]
    ino: u64,
}

const LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(2);
const STALE_LOCK: std::time::Duration = std::time::Duration::from_secs(10);

impl LockGuard {
    fn acquire(path: &Path) -> Result<Self, String> {
        let deadline = std::time::Instant::now() + LOCK_WAIT;
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
            {
                Ok(file) => {
                    return Ok(Self {
                        path: path.to_path_buf(),
                        #[cfg(unix)]
                        ino: file
                            .metadata()
                            .map(|m| std::os::unix::fs::MetadataExt::ino(&m))
                            .unwrap_or(0),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(path)
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age > STALE_LOCK);
                    if stale {
                        take_over_stale_lock(path);
                        continue;
                    }
                    if std::time::Instant::now() >= deadline {
                        return Err(
                            "uncertain-write journal is locked by another process; retry"
                                .to_string(),
                        );
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Err(error) => return Err(format!("journal lock: {error}")),
            }
        }
    }
}

/// Remove a lock left by a dead process. The stale file is moved aside under a
/// unique name, then checked by inode: if it is still the file that was judged stale
/// it is deleted; if a live holder's lock was moved by mistake it is put back.
fn take_over_stale_lock(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let Ok(observed) = std::fs::metadata(path) else {
            return;
        };
        let aside = PathBuf::from(format!(
            "{}.stale-{}-{}",
            path.display(),
            std::process::id(),
            lore_core::now_nanos()
        ));
        if std::fs::rename(path, &aside).is_err() {
            return;
        }
        let moved_ino = std::fs::metadata(&aside).map(|m| m.ino()).ok();
        if moved_ino != Some(observed.ino()) {
            // A live lock was moved aside: restore it if nothing has taken the path.
            let _ = std::fs::hard_link(&aside, path);
        }
        let _ = std::fs::remove_file(&aside);
    }
    #[cfg(not(unix))]
    {
        let _ = std::fs::remove_file(path);
    }
}

impl Drop for LockGuard {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            // Remove the path only while it is still this guard's lock file.
            let ours = std::fs::metadata(&self.path)
                .map(|metadata| metadata.ino() == self.ino)
                .unwrap_or(false);
            if ours {
                let _ = std::fs::remove_file(&self.path);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = std::fs::remove_file(&self.path);
        }
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

    #[cfg(unix)]
    #[test]
    fn journal_file_is_owner_only_under_a_permissive_umask() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let mut journal = Journal::open(dir.path()).expect("open");
        journal.record(entry("key-1")).expect("record");
        let mode = std::fs::metadata(dir.path().join("uncertain-writes.json"))
            .expect("journal exists")
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
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

    #[test]
    fn resolved_entries_do_not_consume_capacity() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut journal = Journal::open(dir.path()).expect("open");
        for index in 0..super::CAPACITY {
            journal
                .record(entry(&format!("key-{index}")))
                .expect("record");
            journal.resolve(&format!("key-{index}")).expect("resolve");
        }
        journal
            .record(entry("after-resolved"))
            .expect("resolved history does not fill the journal");
    }

    #[test]
    fn a_stale_snapshot_does_not_drop_another_process_entry() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut first = Journal::open(dir.path()).expect("first");
        let mut second = Journal::open(dir.path()).expect("second");
        first.record(entry("from-first")).expect("first record");
        // `second` opened before `first` wrote; its update must keep that entry.
        second.record(entry("from-second")).expect("second record");
        let reopened = Journal::open(dir.path()).expect("reopen");
        let keys: Vec<&str> = reopened.entries().map(|item| item.key.as_str()).collect();
        assert!(
            keys.contains(&"from-first") && keys.contains(&"from-second"),
            "{keys:?}"
        );
    }

    #[test]
    fn an_unresolved_key_cannot_be_overwritten_but_a_resolved_one_can_be_reused() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut journal = Journal::open(dir.path()).expect("open");
        journal.record(entry("reused")).expect("first record");
        let mut other = entry("reused");
        other.payload = Some(serde_json::json!({"content": "different"}));
        assert!(
            journal.record(other.clone()).is_err(),
            "unresolved payload is kept"
        );
        let stored = Journal::open(dir.path()).expect("reopen");
        assert_eq!(
            stored.entries().next().expect("entry").payload,
            Some(serde_json::json!({"content": "secret"})),
            "the original payload survives the refused reuse"
        );
        journal.resolve("reused").expect("resolve");
        journal.record(other).expect("a resolved key may be reused");
    }

    #[test]
    fn a_stale_lock_is_taken_over_and_a_fresh_one_is_respected() {
        let dir = tempfile::tempdir().expect("tempdir");
        let lock = dir.path().join("uncertain-writes.json.lock");
        let mut journal = Journal::open(dir.path()).expect("open");

        // A lock from a dead process is old: the update proceeds.
        std::fs::write(&lock, "dead").expect("stale lock");
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(60);
        std::fs::File::options()
            .write(true)
            .open(&lock)
            .expect("open lock")
            .set_modified(old)
            .expect("age lock");
        journal
            .record(entry("after-stale"))
            .expect("stale lock is taken over");
        assert!(!lock.exists(), "no lock is left behind");

        // A live holder's lock is respected: the update is refused.
        std::fs::write(&lock, "live").expect("live lock");
        assert!(journal.record(entry("blocked")).is_err());
        std::fs::remove_file(&lock).expect("release live lock");
    }
}
