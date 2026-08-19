/**
 * tests/unit/db-lease-recovery.test.mjs
 *
 * Validates the deferred-extraction lease mechanism:
 *   - claimDeferredExtraction atomically claims pending/failed jobs
 *   - heartbeatDeferredExtraction renews the lease while the job runs
 *   - reclaimStaleDeferredExtractions returns expired running jobs to failed
 *   - completeDeferredExtraction and failDeferredExtraction guard by ownerToken
 *     so stale workers cannot clobber a live worker's state
 *
 * All tests run against isolated temp-home databases; the real
 * ~/.copilot/lore.db is never opened.
 */

import assert from "node:assert/strict";
import { describe, test, beforeEach, afterEach } from "node:test";

import { withFixtureDb } from "../helpers/fixture-db.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build"
  : false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Insert a pending deferred_extraction row directly so tests can control
 * the initial state without going through enqueueDeferredExtraction.
 */
function seedDeferredJob(db, { sessionId, status = "pending", leaseExpiresAt = null, ownerToken = null } = {}) {
  const now = new Date().toISOString();
  db.db.prepare(`
    INSERT INTO deferred_extraction (
      session_id, repository, status, priority, reason,
      queued_at, available_at, attempts, owner_token, lease_expires_at, heartbeat_at,
      metadata_json
    ) VALUES (?, ?, ?, 0, 'test', ?, ?, 0, ?, ?, ?, '{}')
    ON CONFLICT(session_id) DO UPDATE SET
      status = excluded.status,
      owner_token = excluded.owner_token,
      lease_expires_at = excluded.lease_expires_at
  `).run(
    sessionId,
    "fixture-repo",
    status,
    now,
    now, // available_at = now so it's immediately due
    ownerToken,
    leaseExpiresAt,
    leaseExpiresAt ? now : null, // heartbeat_at
  );
}

function readJob(db, sessionId) {
  return db.db.prepare(`
    SELECT session_id, status, owner_token, lease_expires_at, heartbeat_at, attempts, last_error
    FROM deferred_extraction WHERE session_id = ?
  `).get(sessionId);
}

// ---------------------------------------------------------------------------
// claimDeferredExtraction
// ---------------------------------------------------------------------------

describe("claimDeferredExtraction", { skip: SKIP_NO_FTS5 }, () => {
  let fixture;

  beforeEach(async () => {
    fixture = await withFixtureDb({ seed: false });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("claims a pending job and sets running state with owner token and lease", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-claim-1" });

    const token = "worker-token-1";
    const claimed = db.claimDeferredExtraction("sess-claim-1", token);

    assert.equal(claimed, true);
    const row = readJob(db, "sess-claim-1");
    assert.equal(row.status, "running");
    assert.equal(row.owner_token, token);
    assert.ok(row.lease_expires_at, "lease_expires_at should be set");
    assert.ok(row.heartbeat_at, "heartbeat_at should be set");
    assert.equal(row.attempts, 1);
    assert.equal(row.last_error, null);
  });

  test("claims a failed job and increments attempts", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-claim-2", status: "failed" });

    const claimed = db.claimDeferredExtraction("sess-claim-2", "worker-2");
    assert.equal(claimed, true);

    const row = readJob(db, "sess-claim-2");
    assert.equal(row.status, "running");
    assert.equal(row.attempts, 1);
  });

  test("returns false when the job is already running", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-claim-3" });

    // First claim succeeds
    assert.equal(db.claimDeferredExtraction("sess-claim-3", "worker-A"), true);

    // Second claim on the same job fails
    const secondClaim = db.claimDeferredExtraction("sess-claim-3", "worker-B");
    assert.equal(secondClaim, false);

    // Original owner is unchanged
    const row = readJob(db, "sess-claim-3");
    assert.equal(row.owner_token, "worker-A");
  });

  test("returns false when the job is already completed", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-claim-4", status: "completed" });

    const claimed = db.claimDeferredExtraction("sess-claim-4", "late-worker");
    assert.equal(claimed, false);
  });

  test("sets lease_expires_at approximately leaseDurationMs in the future", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-claim-5" });

    const before = Date.now();
    db.claimDeferredExtraction("sess-claim-5", "worker-5", 10 * 60 * 1000);
    const after = Date.now();

    const row = readJob(db, "sess-claim-5");
    const expiresMs = new Date(row.lease_expires_at).getTime();
    // lease should be ~10 min ahead with some tolerance for test timing
    assert.ok(expiresMs >= before + 9 * 60 * 1000, "lease should be at least 9 min ahead");
    assert.ok(expiresMs <= after + 11 * 60 * 1000, "lease should be at most 11 min ahead");
  });
});

// ---------------------------------------------------------------------------
// heartbeatDeferredExtraction
// ---------------------------------------------------------------------------

describe("heartbeatDeferredExtraction", { skip: SKIP_NO_FTS5 }, () => {
  let fixture;

  beforeEach(async () => {
    fixture = await withFixtureDb({ seed: false });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("renews lease when caller owns the job", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-hb-1" });
    db.claimDeferredExtraction("sess-hb-1", "owner-X");

    const beforeHeartbeat = readJob(db, "sess-hb-1");
    // Advance the system clock perception by using a slightly different duration
    const renewed = db.heartbeatDeferredExtraction("sess-hb-1", "owner-X", 10 * 60 * 1000);

    assert.equal(renewed, true);
    const afterHeartbeat = readJob(db, "sess-hb-1");
    assert.ok(afterHeartbeat.heartbeat_at, "heartbeat_at should be set");
    // lease_expires_at should still be a future timestamp
    assert.ok(
      new Date(afterHeartbeat.lease_expires_at).getTime() > Date.now() + 9 * 60 * 1000,
      "renewed lease should be at least 9 min in the future",
    );
    assert.equal(beforeHeartbeat.owner_token, afterHeartbeat.owner_token);
  });

  test("returns false when called with the wrong owner token", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-hb-2" });
    db.claimDeferredExtraction("sess-hb-2", "correct-owner");

    const renewed = db.heartbeatDeferredExtraction("sess-hb-2", "wrong-owner");
    assert.equal(renewed, false);
  });

  test("returns false when the job is not in running state", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-hb-3", status: "pending" });

    const renewed = db.heartbeatDeferredExtraction("sess-hb-3", "any-token");
    assert.equal(renewed, false);
  });
});

// ---------------------------------------------------------------------------
// reclaimStaleDeferredExtractions
// ---------------------------------------------------------------------------

describe("reclaimStaleDeferredExtractions", { skip: SKIP_NO_FTS5 }, () => {
  let fixture;

  beforeEach(async () => {
    fixture = await withFixtureDb({ seed: false });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("resets running jobs with expired leases to failed", () => {
    const { db } = fixture;
    const expiredLease = new Date(Date.now() - 1000).toISOString(); // 1 sec ago = expired
    seedDeferredJob(db, {
      sessionId: "sess-stale-1",
      status: "running",
      leaseExpiresAt: expiredLease,
      ownerToken: "dead-worker",
    });

    const reclaimed = db.reclaimStaleDeferredExtractions();
    assert.equal(reclaimed, 1);

    const row = readJob(db, "sess-stale-1");
    assert.equal(row.status, "failed");
    assert.equal(row.last_error, "lease expired");
    assert.equal(row.owner_token, null);
    assert.equal(row.lease_expires_at, null);
  });

  test("does not touch running jobs whose leases have not expired", () => {
    const { db } = fixture;
    const futureLease = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    seedDeferredJob(db, {
      sessionId: "sess-stale-2",
      status: "running",
      leaseExpiresAt: futureLease,
      ownerToken: "active-worker",
    });

    const reclaimed = db.reclaimStaleDeferredExtractions();
    assert.equal(reclaimed, 0);

    const row = readJob(db, "sess-stale-2");
    assert.equal(row.status, "running");
    assert.equal(row.owner_token, "active-worker");
  });

  test("reclaims stale legacy running jobs without lease metadata", () => {
    const { db } = fixture;
    const staleAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.db.prepare(`
      INSERT INTO deferred_extraction (
        session_id, repository, status, priority, reason, queued_at, available_at,
        started_at, metadata_json
      ) VALUES ('sess-legacy-stale', 'repo', 'running', 0, 'manual', ?, ?, ?, '{}')
    `).run(staleAt, staleAt, staleAt);

    const reclaimed = db.reclaimStaleDeferredExtractions({
      staleAfterMs: 30 * 60 * 1000,
    });
    assert.equal(reclaimed, 1);

    const row = readJob(db, "sess-legacy-stale");
    assert.equal(row.status, "failed");
    assert.equal(row.last_error, "stale running job reclaimed");
    assert.equal(row.owner_token, null);
    assert.equal(row.lease_expires_at, null);
  });

  test("does not touch fresh legacy running jobs without lease metadata", () => {
    const { db } = fixture;
    const startedAt = new Date(Date.now() - 1000).toISOString();
    db.db.prepare(`
      INSERT INTO deferred_extraction (
        session_id, repository, status, priority, reason, queued_at, available_at,
        started_at, metadata_json
      ) VALUES ('sess-legacy-fresh', 'repo', 'running', 0, 'manual', ?, ?, ?, '{}')
    `).run(startedAt, startedAt, startedAt);

    const reclaimed = db.reclaimStaleDeferredExtractions({
      staleAfterMs: 30 * 60 * 1000,
    });
    assert.equal(reclaimed, 0);

    const row = readJob(db, "sess-legacy-fresh");
    assert.equal(row.status, "running");
  });

  test("reclaims multiple expired jobs in one call", () => {
    const { db } = fixture;
    const expiredLease = new Date(Date.now() - 500).toISOString();
    for (const id of ["a", "b", "c"]) {
      seedDeferredJob(db, {
        sessionId: `sess-multi-${id}`,
        status: "running",
        leaseExpiresAt: expiredLease,
        ownerToken: "old-worker",
      });
    }

    const reclaimed = db.reclaimStaleDeferredExtractions();
    assert.equal(reclaimed, 3);
  });
});

// ---------------------------------------------------------------------------
// completeDeferredExtraction with owner token (idempotency guard)
// ---------------------------------------------------------------------------

describe("completeDeferredExtraction owner token guard", { skip: SKIP_NO_FTS5 }, () => {
  let fixture;

  beforeEach(async () => {
    fixture = await withFixtureDb({ seed: false });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("completes the job when the owner token matches", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-comp-1" });
    db.claimDeferredExtraction("sess-comp-1", "worker-ok");

    db.completeDeferredExtraction("sess-comp-1", "worker-ok");

    const row = readJob(db, "sess-comp-1");
    assert.equal(row.status, "completed");
  });

  test("does not overwrite a reclaimed job when a stale worker tries to complete", () => {
    const { db } = fixture;
    const expiredLease = new Date(Date.now() - 1000).toISOString();
    seedDeferredJob(db, {
      sessionId: "sess-comp-2",
      status: "running",
      leaseExpiresAt: expiredLease,
      ownerToken: "old-worker",
    });

    // Reaper resets it to failed
    db.reclaimStaleDeferredExtractions();
    assert.equal(readJob(db, "sess-comp-2").status, "failed");

    // New worker claims it
    db.claimDeferredExtraction("sess-comp-2", "new-worker");
    assert.equal(readJob(db, "sess-comp-2").status, "running");

    // Old worker tries to complete — should be a no-op
    db.completeDeferredExtraction("sess-comp-2", "old-worker");
    const row = readJob(db, "sess-comp-2");
    assert.equal(row.status, "running", "stale complete must not overwrite live job");
    assert.equal(row.owner_token, "new-worker");
  });

  test("backward-compat: completing without a token updates status unconditionally", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-comp-3", status: "running", ownerToken: "some-token" });

    // Legacy call without ownerToken
    db.completeDeferredExtraction("sess-comp-3");
    assert.equal(readJob(db, "sess-comp-3").status, "completed");
  });
});

// ---------------------------------------------------------------------------
// failDeferredExtraction with owner token
// ---------------------------------------------------------------------------

describe("failDeferredExtraction owner token guard", { skip: SKIP_NO_FTS5 }, () => {
  let fixture;

  beforeEach(async () => {
    fixture = await withFixtureDb({ seed: false });
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("fails the job and clears lease fields when owner token matches", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-fail-1" });
    db.claimDeferredExtraction("sess-fail-1", "worker-f");

    db.failDeferredExtraction("sess-fail-1", {
      errorMessage: "something went wrong",
      retryDelayMinutes: 15,
      ownerToken: "worker-f",
    });

    const row = readJob(db, "sess-fail-1");
    assert.equal(row.status, "failed");
    assert.equal(row.last_error, "something went wrong");
    assert.equal(row.owner_token, null);
    assert.equal(row.lease_expires_at, null);
  });

  test("does not overwrite when a stale worker tries to fail a reclaimed job", () => {
    const { db } = fixture;
    seedDeferredJob(db, { sessionId: "sess-fail-2" });
    // New worker owns the job
    db.claimDeferredExtraction("sess-fail-2", "new-worker");

    // Old worker tries to fail using its stale token
    db.failDeferredExtraction("sess-fail-2", {
      errorMessage: "stale error",
      retryDelayMinutes: 1,
      ownerToken: "old-worker",
    });

    const row = readJob(db, "sess-fail-2");
    assert.equal(row.status, "running", "stale fail must not overwrite live job");
    assert.equal(row.owner_token, "new-worker");
  });
});
