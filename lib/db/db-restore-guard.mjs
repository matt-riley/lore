/**
 * lib/db/db-restore-guard.mjs
 *
 * Cross-process safety guard for swapping a live Lore database's files
 * (lore.db, lore.db-wal, lore.db-shm) out from under any other process that
 * might have it open. Many agent sessions (separate OS processes) can share
 * one lore.db concurrently; a plain rename-over-the-top restore can corrupt
 * the store or silently lose writes if another process is mid-transaction
 * (or simply has the file open) when the swap happens.
 *
 * Two layers combine to make a restore safe:
 *
 *  1. A sidecar lock file (`<dbPath>.restore.lock`) that `LoreDb.openDatabase()`
 *     and `LoreDb.openReadOnly()` check before opening. Once created, it
 *     makes *new* connections started after this point refuse (after a
 *     brief backoff) rather than race the in-flight restore.
 *
 *  2. `assertExclusiveDatabaseAccess`, which proves no connection that was
 *     *already* open before the sidecar lock existed is mid-transaction (or
 *     even just holding a read snapshot). It does this by requesting an
 *     OS-level EXCLUSIVE lock via `PRAGMA locking_mode = EXCLUSIVE` and then
 *     fully truncating the WAL with `PRAGMA wal_checkpoint(TRUNCATE)`. A
 *     plain `BEGIN IMMEDIATE` probe (the previous approach) cannot detect a
 *     connection with an open *read* transaction, because WAL readers never
 *     block writers by design; wal_checkpoint(TRUNCATE) can, because it
 *     cannot fully truncate the WAL while any connection might still need
 *     to read the frames being truncated. The connection returned on
 *     success keeps holding that exclusive lock (verified empirically: it
 *     blocks even a brand-new read-only connection) until closed, so the
 *     caller can safely perform its renames before releasing it.
 *
 * Residual window: a process that already passed the sidecar-lock check in
 * openDatabase() (because it read the directory a moment before the lock
 * file was created) but had not yet opened its actual connection could
 * still slip in between step 2's check and the caller's renames. Fully
 * closing that window would need a kernel-level distributed lock across
 * processes and hosts, which is out of scope here; every restore entry
 * point already requires the caller to have stopped other agent sessions,
 * and this guard's job is to catch the common case (and to fail loudly
 * instead of corrupting data) rather than to provide a perfect distributed
 * lock.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

export const RESTORE_IN_USE_MESSAGE = "Lore store is in use by another process; close other agent sessions and retry.";

const RESTORE_LOCK_SUFFIX = ".restore.lock";

export function restoreLockPath(dbPath) {
  return `${dbPath}${RESTORE_LOCK_SUFFIX}`;
}

function readRestoreLockOwner(lockPath) {
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8"));
    if (owner?.version !== 1
      || !Number.isSafeInteger(owner.pid)
      || owner.pid <= 0
      || typeof owner.hostname !== "string"
      || typeof owner.token !== "string") {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user. Unknown
    // errors also fail closed; only ESRCH proves that the owner has exited.
    return error.code !== "ESRCH";
  }
}

function removeStaleSidecarLock(dbPath) {
  const lockPath = restoreLockPath(dbPath);
  const owner = readRestoreLockOwner(lockPath);
  if (!owner || owner.hostname !== hostname() || isProcessAlive(owner.pid)) {
    return false;
  }

  // Recheck the token so a lock replaced after the first read is not removed.
  const currentOwner = readRestoreLockOwner(lockPath);
  if (currentOwner?.token !== owner.token) {
    return false;
  }
  rmSync(lockPath, { force: true });
  return true;
}

export function isRestoreLockActive(dbPath) {
  const lockPath = restoreLockPath(dbPath);
  if (!existsSync(lockPath)) {
    return false;
  }
  if (removeStaleSidecarLock(dbPath)) {
    return false;
  }
  return existsSync(lockPath);
}

function createSidecarLock(dbPath) {
  const lockPath = restoreLockPath(dbPath);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID();
    const ownerPath = `${lockPath}.owner-${token}`;
    let retry = false;
    try {
      const descriptor = openSync(ownerPath, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify({ version: 1, pid: process.pid, hostname: hostname(), token }));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      // Publish a complete owner record atomically. If the process crashes
      // before linkSync, no restore lock is left behind; after it succeeds,
      // the lock always contains enough information to detect a dead owner.
      linkSync(ownerPath, lockPath);
      return;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (attempt === 0 && removeStaleSidecarLock(dbPath)) {
        retry = true;
      } else {
        throw new Error("A Lore restore is already in progress for this store; retry once it finishes.");
      }
    } finally {
      try { rmSync(ownerPath, { force: true }); } catch { /* best effort */ }
    }
    if (!retry) break;
  }
  throw new Error("A Lore restore is already in progress for this store; retry once it finishes.");
}

function removeSidecarLock(dbPath) {
  rmSync(restoreLockPath(dbPath), { force: true });
}

function isLockError(error) {
  return /locked|busy/i.test(String(error?.message ?? ""));
}

/**
 * Briefly waits for an in-flight restore's sidecar lock to clear before a
 * normal open proceeds, then throws a clear error if it is still present.
 * The restore itself only holds this lock across a handful of renames, so a
 * short bounded backoff (well under the existing 5s busy_timeout used
 * elsewhere) is enough to avoid spurious failures for a hook call that
 * happens to race a restore, without ever blocking indefinitely.
 */
export function waitForRestoreLockClear(dbPath, { retries = 10, intervalMs = 50 } = {}) {
  if (!isRestoreLockActive(dbPath)) {
    return;
  }
  for (let attempt = 0; attempt < retries; attempt += 1) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, intervalMs);
    if (!isRestoreLockActive(dbPath)) {
      return;
    }
  }
  throw new Error("Lore store is being restored by another process; retry shortly.");
}

/**
 * Proves no other connection currently holds dbPath open by requesting an
 * OS-level EXCLUSIVE lock and fully truncating the WAL. See the module
 * comment for why this catches cases a plain BEGIN IMMEDIATE probe misses.
 *
 * Returns `{ connection }` (still open, holding the exclusive lock) on
 * success. Returns `{ warning }` when dbPath cannot even be opened for a
 * reason unrelated to locking (for example a corrupt file) — restoring is
 * exactly how you would fix that, so this degrades to "can't prove
 * exclusivity" instead of blocking the restore outright. Throws
 * RESTORE_IN_USE_MESSAGE when another connection is genuinely active.
 */
export function assertExclusiveDatabaseAccess(dbPath, { busyTimeoutMs = 250 } = {}) {
  if (!existsSync(dbPath)) {
    return { connection: null, warning: null };
  }
  // A cheap read-only sanity probe first. wal_checkpoint(TRUNCATE) below can
  // only be run safely once we know dbPath is at least openable: running it
  // against a target that is not a valid SQLite database (or whose main
  // file is corrupt) has been observed to destructively delete or rewrite
  // its stray -wal/-shm sidecars as part of SQLite's own error handling, and
  // a "can we restore over this?" probe must never do that.
  try {
    const probe = new DatabaseSync(dbPath, { readOnly: true });
    try { probe.prepare("PRAGMA schema_version").get(); } finally { probe.close(); }
  } catch (error) {
    return { connection: null, warning: `SQLite lock preflight unavailable for target (${error.message}); stop other Lore sessions manually before restoring` };
  }
  let guard;
  try {
    guard = new DatabaseSync(dbPath);
  } catch (error) {
    return { connection: null, warning: `SQLite lock preflight unavailable for target (${error.message}); stop other Lore sessions manually before restoring` };
  }
  try {
    guard.exec(`PRAGMA busy_timeout = ${Math.max(0, Number(busyTimeoutMs) | 0)};`);
    guard.exec("PRAGMA locking_mode = EXCLUSIVE;");
    const checkpoint = guard.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (checkpoint?.busy) {
      throw new Error("wal_checkpoint(TRUNCATE) reported a busy result; another connection holds a lock or read snapshot");
    }
    return { connection: guard, warning: null };
  } catch (error) {
    try { guard.close(); } catch { /* best effort */ }
    if (isLockError(error)) {
      throw new Error(RESTORE_IN_USE_MESSAGE, { cause: error });
    }
    return { connection: null, warning: `SQLite lock preflight unavailable for target (${error.message}); stop other Lore sessions manually before restoring` };
  }
}

/**
 * Acquires the full restore guard (sidecar lock + exclusive-access proof)
 * for dbPath. Callers must call `release()` once their file swap is
 * complete (success or failure) to drop the exclusive lock and remove the
 * sidecar lock file; `release()` is safe to call more than once.
 * `beforeExclusive` runs after the sidecar is created and before the SQLite
 * probe opens its own connection, for caller-specific open-handle checks.
 *
 * Returns `{ release, warnings }`. Throws RESTORE_IN_USE_MESSAGE (and
 * leaves no sidecar lock behind) if another connection is active.
 */
export function acquireRestoreGuard(dbPath, { beforeExclusive, ...options } = {}) {
  createSidecarLock(dbPath);
  try {
    beforeExclusive?.(dbPath);
    const { connection, warning } = assertExclusiveDatabaseAccess(dbPath, options);
    let released = false;
    return {
      warnings: warning ? [warning] : [],
      release() {
        if (released) return;
        released = true;
        if (connection) {
          try { connection.close(); } catch { /* best effort */ }
        }
        removeSidecarLock(dbPath);
      },
    };
  } catch (error) {
    removeSidecarLock(dbPath);
    throw error;
  }
}
