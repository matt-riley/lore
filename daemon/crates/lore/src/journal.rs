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

/// One uncertain write, in the journal format the Rust CLI and the host
/// adapters share. The CLI's older snake_case spelling and its `state` string
/// are accepted on read and folded into this shape, which is what every write
/// emits.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalEntry {
    pub key: String,
    pub operation: String,
    /// Route the write was dispatched on, so any reader can replay it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub route: Option<String>,
    #[serde(default, alias = "store_id", skip_serializing_if = "Option::is_none")]
    pub store_id: Option<String>,
    #[serde(default, alias = "client_id")]
    pub client_id: String,
    #[serde(default, alias = "created_ms")]
    pub created_at: i64,
    #[serde(default)]
    pub resolved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    /// Exact payload of the pending write, dropped once the entry is resolved.
    #[serde(default, alias = "payload", skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
    /// Legacy `state` spelling: folded into `resolved` on read, never written.
    #[serde(default, rename = "state", skip_serializing)]
    pub legacy_state: Option<String>,
}

impl JournalEntry {
    /// A write that has not been acknowledged yet.
    pub fn uncertain(
        key: String,
        operation: String,
        route: Option<String>,
        store_id: Option<String>,
        client_id: String,
        created_at: i64,
        params: serde_json::Value,
    ) -> Self {
        Self {
            key,
            operation,
            route,
            store_id,
            client_id,
            created_at,
            resolved: false,
            resolved_at: None,
            outcome: None,
            params: Some(params),
            legacy_state: None,
        }
    }

    /// Fold the legacy `state` spelling into `resolved`/`outcome`.
    fn normalize(&mut self) {
        if let Some(state) = self.legacy_state.take() {
            if state != "uncertain" {
                self.resolved = true;
            }
            if state == "discarded" {
                self.outcome.get_or_insert(state);
            }
        }
    }
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
        let mut file = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("uncertain-write journal is corrupt: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => JournalFile {
                version: 1,
                entries: BTreeMap::new(),
            },
            Err(error) => return Err(format!("cannot read journal: {error}")),
        };
        for entry in file.entries.values_mut() {
            entry.normalize();
        }
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
                .is_some_and(|existing| !existing.resolved)
            {
                return Err(
                    "an unresolved uncertain write already uses this idempotency key".to_string(),
                );
            }
            if !file.entries.contains_key(&key)
                && file.entries.values().filter(|item| !item.resolved).count() >= CAPACITY
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
            entry.resolved = true;
            entry.params = None;
            entry.resolved_at = Some(lore_core::now_ms());
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
        let _guard = LockGuard::acquire(&lock, &self.path)?;
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

/// Holds the journal lock for one update. A live holder is waited out for as
/// long as the journal it guards keeps moving, and a lock older than
/// `STALE_LOCK` is treated as left by a process that died.
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
    fn acquire(lock: &Path, journal: &Path) -> Result<Self, String> {
        // The wait is renewed whenever the journal moves, so a sibling working
        // through its own updates never looks like a stuck holder.
        let mut progress = std::fs::metadata(journal).and_then(|m| m.modified()).ok();
        let mut deadline = std::time::Instant::now() + LOCK_WAIT;
        loop {
            match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(lock)
            {
                Ok(file) => {
                    return Ok(Self {
                        path: lock.to_path_buf(),
                        #[cfg(unix)]
                        ino: file
                            .metadata()
                            .map(|m| std::os::unix::fs::MetadataExt::ino(&m))
                            .unwrap_or(0),
                    });
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    let stale = std::fs::metadata(lock)
                        .and_then(|metadata| metadata.modified())
                        .ok()
                        .and_then(|modified| modified.elapsed().ok())
                        .is_some_and(|age| age > STALE_LOCK);
                    if stale {
                        take_over_stale_lock(lock);
                        continue;
                    }
                    // A held lock is not a stuck lock: every completed update
                    // moves the journal, and each move renews the wait. Only a
                    // holder that leaves it still for the whole wait is busy.
                    let updated = std::fs::metadata(journal).and_then(|m| m.modified()).ok();
                    if updated != progress {
                        progress = updated;
                        deadline = std::time::Instant::now() + LOCK_WAIT;
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
        JournalEntry::uncertain(
            key.to_string(),
            "lore_retain".to_string(),
            Some("/v2/retain".to_string()),
            Some("store-1".to_string()),
            "cli".to_string(),
            1_000,
            serde_json::json!({"content": "secret"}),
        )
    }

    #[test]
    fn entries_persist_resolve_and_drop_payloads() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut journal = Journal::open(dir.path()).expect("open");
        journal.record(entry("key-1")).expect("record");
        let reopened = Journal::open(dir.path()).expect("reopen");
        assert_eq!(reopened.entries().count(), 1);
        assert!(reopened.entries().next().unwrap().params.is_some());

        let mut journal = Journal::open(dir.path()).expect("reopen");
        assert!(journal.resolve("key-1").expect("resolve"));
        let reopened = Journal::open(dir.path()).expect("reopen");
        let stored = reopened.entries().next().expect("entry");
        assert!(stored.resolved);
        assert!(stored.params.is_none(), "resolved payloads are dropped");
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
        other.params = Some(serde_json::json!({"content": "different"}));
        assert!(
            journal.record(other.clone()).is_err(),
            "unresolved payload is kept"
        );
        let stored = Journal::open(dir.path()).expect("reopen");
        assert_eq!(
            stored.entries().next().expect("entry").params,
            Some(serde_json::json!({"content": "secret"})),
            "the original payload survives the refused reuse"
        );
        journal.resolve("reused").expect("resolve");
        journal.record(other).expect("a resolved key may be reused");
    }

    #[test]
    fn an_adapter_written_entry_is_read_and_rewritten_canonically() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("uncertain-writes.json");
        // Exactly what a host adapter writes.
        std::fs::write(
            &path,
            r#"{"version":1,"entries":{"adapter-1":{"key":"adapter-1","clientId":"pi","operation":"lore_retain","route":"/v2/retain","params":{"content":"shared"},"storeId":"store-1","createdAt":1,"resolved":false}}}"#,
        )
        .expect("adapter journal");

        let mut journal = Journal::open(dir.path()).expect("open");
        let stored = journal.entries().next().expect("entry");
        assert_eq!(stored.client_id, "pi");
        assert_eq!(
            stored.params,
            Some(serde_json::json!({"content": "shared"}))
        );
        assert!(!stored.resolved);

        assert!(journal.resolve("adapter-1").expect("resolve"));
        let rewritten = std::fs::read_to_string(&path).expect("rewritten");
        assert!(rewritten.contains("\"clientId\""), "{rewritten}");
        assert!(rewritten.contains("\"resolved\": true"), "{rewritten}");
        assert!(!rewritten.contains("client_id"), "{rewritten}");
        let reopened = Journal::open(dir.path()).expect("reopen");
        assert!(reopened.entries().next().expect("entry").resolved);
    }

    #[test]
    fn a_legacy_state_entry_is_folded_into_resolved() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("uncertain-writes.json");
        // Exactly what an older CLI build wrote.
        std::fs::write(
            &path,
            r#"{"version":1,"entries":{"old":{"key":"old","operation":"lore_retain","store_id":null,"client_id":"cli","created_ms":5,"state":"resolved","payload":null}}}"#,
        )
        .expect("legacy journal");

        let journal = Journal::open(dir.path()).expect("open");
        let stored = journal.entries().next().expect("entry");
        assert!(stored.resolved, "the legacy state is folded in");
        assert_eq!(stored.created_at, 5);
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

    #[test]
    fn a_wait_outlasts_a_holder_that_keeps_updating() {
        let dir = tempfile::tempdir().expect("tempdir");
        let journal_file = dir.path().join("uncertain-writes.json");
        let lock = dir.path().join("uncertain-writes.json.lock");
        let mut journal = Journal::open(dir.path()).expect("open");

        // A sibling holds the lock while it works through its own updates. Each
        // one moves the journal, so the wait renews instead of expiring on a
        // lock that is making progress.
        std::fs::write(&journal_file, "{\"version\":1,\"entries\":{}}").expect("journal");
        std::fs::write(&lock, "held").expect("live lock");
        let holder = std::thread::spawn({
            let journal_file = journal_file.clone();
            let lock = lock.clone();
            move || {
                for _ in 0..130 {
                    std::fs::write(&journal_file, "{\"version\":1,\"entries\":{}}")
                        .expect("update");
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
                std::fs::remove_file(&lock).expect("release");
            }
        });

        journal
            .record(entry("waited"))
            .expect("the wait outlasts a progressing hold");
        holder.join().expect("holder");
        let reopened = Journal::open(dir.path()).expect("reopen");
        assert!(
            reopened.entries().any(|item| item.key == "waited"),
            "the waited write landed"
        );
        assert!(!lock.exists(), "no lock is left behind");
    }
}
