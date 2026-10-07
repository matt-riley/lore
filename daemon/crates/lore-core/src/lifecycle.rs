//! Store and endpoint ownership.
//!
//! Both locks are advisory, non-blocking, and held for the process lifetime.
//! A lock file is never deleted to break a lock.

use std::fs::{File, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

use crate::config::ensure_private_dir;
use crate::error::{CoreError, CoreResult};

/// A held advisory exclusive lock. Dropping it releases the lock.
pub struct HeldLock {
    _guard: fd_lock::RwLockWriteGuard<'static, File>,
}

/// Try to take an exclusive lock on `path` without blocking.
pub fn try_lock(path: &Path, reason: &str) -> CoreResult<HeldLock> {
    if let Some(parent) = path.parent() {
        ensure_private_dir(parent, "lock directory")?;
    }
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(CoreError::precondition(
                "UNSAFE_PATH",
                format!("refusing to lock a symlink: {}", path.display()),
            ));
        }
        _ => {}
    }
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .mode(0o600)
        .open(path)?;
    // The lock must outlive this function; leaking the tiny lock wrapper keeps
    // the guard `'static`, and the guard releases the OS lock on drop.
    let lock: &'static mut fd_lock::RwLock<File> = Box::leak(Box::new(fd_lock::RwLock::new(file)));
    match lock.try_write() {
        Ok(guard) => Ok(HeldLock { _guard: guard }),
        Err(_) => Err(CoreError::precondition(
            reason,
            format!("lock already held: {}", path.display()),
        )),
    }
}

/// Store lock path for a managed data directory.
pub fn store_lock_path(data_dir: &Path) -> std::path::PathBuf {
    data_dir.join("store.lock")
}
