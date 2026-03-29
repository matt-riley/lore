/**
 * tests/unit/approval-policy.test.mjs
 *
 * Unit tests for lib/approval-policy.mjs.
 *
 * Covers:
 *   - APPROVAL_DECISION and APPROVAL_FAMILY constant shapes
 *   - recordApproval: persists a new row and returns an id
 *   - recordApproval: updates an existing non-durable row in-place
 *   - recordApproval: does NOT overwrite a durable row (inserts alongside)
 *   - resolveApproval: returns "ask" when no row exists
 *   - resolveApproval: returns the stored decision when a matching row exists
 *   - resolveApproval: target-identity scope beats repository scope
 *   - resolveApproval: repository scope beats global scope
 *   - resolveApproval: ignores expired rows and falls through to next tier
 *   - revokeApproval: removes row, subsequent resolution returns "ask"
 *   - revokeApproval: returns false for unknown id
 *   - listApprovals: returns all rows when no filters supplied
 *   - listApprovals: filters by actionFamily
 *   - listApprovals: filters by repository
 *   - purgeExpiredApprovals: removes expired rows, keeps live ones
 *
 * Tests that require a live database are skipped when the local Node SQLite
 * build lacks FTS5 support (same pattern used by domain-observation-db tests).
 * The Copilot CLI runtime always has FTS5.
 *
 * Run:
 *   node --test tests/unit/approval-policy.test.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { LoreDb } from "../../lib/db.mjs";
import { FTS5_AVAILABLE } from "../helpers/fixture-db.mjs";
import { createTempHome } from "../helpers/temp-home.mjs";
import { freshInstallConfig } from "../helpers/fixture-config.mjs";
import {
  APPROVAL_DECISION,
  APPROVAL_FAMILY,
  resolveApproval,
  recordApproval,
  revokeApproval,
  listApprovals,
  purgeExpiredApprovals,
} from "../../lib/approval-policy.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

let tempHome;
let db;

function setup() {
  tempHome = createTempHome();
  const config = freshInstallConfig(tempHome.home);
  db = new LoreDb(config);
  db.initialize();
}

function teardown() {
  db?.close();
  tempHome?.cleanup();
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("APPROVAL_DECISION constants", () => {
  test("has ASK, ALLOW, DENY values", () => {
    assert.strictEqual(APPROVAL_DECISION.ASK, "ask");
    assert.strictEqual(APPROVAL_DECISION.ALLOW, "allow");
    assert.strictEqual(APPROVAL_DECISION.DENY, "deny");
    assert.ok(Object.isFrozen(APPROVAL_DECISION));
  });
});

describe("APPROVAL_FAMILY constants", () => {
  test("has all expected family keys", () => {
    assert.ok(typeof APPROVAL_FAMILY.MEMORY_WRITE === "string");
    assert.ok(typeof APPROVAL_FAMILY.MEMORY_DELETE === "string");
    assert.ok(typeof APPROVAL_FAMILY.SCOPE_OVERRIDE === "string");
    assert.ok(typeof APPROVAL_FAMILY.PROPOSAL_APPLY === "string");
    assert.ok(typeof APPROVAL_FAMILY.IMPROVEMENT_RESOLVE === "string");
    assert.ok(Object.isFrozen(APPROVAL_FAMILY));
  });
});

// ---------------------------------------------------------------------------
// recordApproval
// ---------------------------------------------------------------------------

describe("recordApproval", { skip: SKIP_NO_FTS5 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  test("persists a new row and returns a UUID string", () => {
    const id = recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      decision: APPROVAL_DECISION.ALLOW,
    });
    assert.ok(typeof id === "string" && id.length > 0);

    const rows = db.db.prepare("SELECT * FROM action_approval WHERE id = ?").all(id);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].action_family, APPROVAL_FAMILY.MEMORY_WRITE);
    assert.strictEqual(rows[0].decision, APPROVAL_DECISION.ALLOW);
    assert.strictEqual(rows[0].durable, 0);
    assert.strictEqual(rows[0].repository, null);
    assert.strictEqual(rows[0].target_identity, null);
  });

  test("persists row with repository and target_identity", () => {
    const id = recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.SCOPE_OVERRIDE,
      repository: "owner/repo",
      targetIdentity: "mem-abc",
      decision: APPROVAL_DECISION.DENY,
      reason: "not safe",
      grantedBy: "policy",
    });
    const row = db.db.prepare("SELECT * FROM action_approval WHERE id = ?").get(id);
    assert.strictEqual(row.repository, "owner/repo");
    assert.strictEqual(row.target_identity, "mem-abc");
    assert.strictEqual(row.decision, APPROVAL_DECISION.DENY);
    assert.strictEqual(row.reason, "not safe");
    assert.strictEqual(row.granted_by, "policy");
  });

  test("updates an existing non-durable row rather than inserting a duplicate", () => {
    const id1 = recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      decision: APPROVAL_DECISION.ALLOW,
    });
    const id2 = recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      decision: APPROVAL_DECISION.DENY,
    });
    assert.strictEqual(id1, id2, "should reuse the existing row id");
    const row = db.db.prepare("SELECT decision FROM action_approval WHERE id = ?").get(id1);
    assert.strictEqual(row.decision, APPROVAL_DECISION.DENY);
  });

  test("inserts alongside a durable row rather than overwriting it", () => {
    const id1 = recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      decision: APPROVAL_DECISION.ALLOW,
      durable: true,
    });
    const id2 = recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      decision: APPROVAL_DECISION.DENY,
    });
    assert.notStrictEqual(id1, id2, "durable row must not be replaced");

    const rows = db.db.prepare(
      "SELECT id FROM action_approval WHERE action_family = ?",
    ).all(APPROVAL_FAMILY.MEMORY_WRITE);
    assert.strictEqual(rows.length, 2);
  });

  test("stores durable=true correctly", () => {
    const id = recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.PROPOSAL_APPLY,
      decision: APPROVAL_DECISION.ALLOW,
      durable: true,
    });
    const row = db.db.prepare("SELECT durable FROM action_approval WHERE id = ?").get(id);
    assert.strictEqual(row.durable, 1);
  });

  test("throws when actionFamily is missing or empty", () => {
    assert.throws(() => recordApproval(db, { decision: APPROVAL_DECISION.ALLOW }), /actionFamily/);
    assert.throws(() => recordApproval(db, { actionFamily: "", decision: APPROVAL_DECISION.ALLOW }), /actionFamily/);
  });

  test("normalises unknown decision values to 'ask'", () => {
    const id = recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      decision: "unknown_value",
    });
    const row = db.db.prepare("SELECT decision FROM action_approval WHERE id = ?").get(id);
    assert.strictEqual(row.decision, APPROVAL_DECISION.ASK);
  });
});

// ---------------------------------------------------------------------------
// resolveApproval
// ---------------------------------------------------------------------------

describe("resolveApproval", { skip: SKIP_NO_FTS5 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  test("returns 'ask' and null approval when no rows exist", () => {
    const result = resolveApproval(db, { actionFamily: APPROVAL_FAMILY.MEMORY_WRITE });
    assert.strictEqual(result.decision, APPROVAL_DECISION.ASK);
    assert.strictEqual(result.source, "default");
    assert.strictEqual(result.approval, null);
  });

  test("returns stored decision for a global allow", () => {
    recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      decision: APPROVAL_DECISION.ALLOW,
    });
    const result = resolveApproval(db, { actionFamily: APPROVAL_FAMILY.MEMORY_WRITE });
    assert.strictEqual(result.decision, APPROVAL_DECISION.ALLOW);
    assert.strictEqual(result.source, "global");
    assert.ok(result.approval != null);
  });

  test("repository-scoped row takes precedence over global row", () => {
    recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      decision: APPROVAL_DECISION.ALLOW,
    });
    recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      repository: "owner/repo",
      decision: APPROVAL_DECISION.DENY,
    });
    const result = resolveApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      repository: "owner/repo",
    });
    assert.strictEqual(result.decision, APPROVAL_DECISION.DENY);
    assert.strictEqual(result.source, "repository");
  });

  test("target-identity row takes precedence over repository row", () => {
    recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      repository: "owner/repo",
      decision: APPROVAL_DECISION.DENY,
    });
    recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      repository: "owner/repo",
      targetIdentity: "mem-xyz",
      decision: APPROVAL_DECISION.ALLOW,
    });
    const result = resolveApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      repository: "owner/repo",
      targetIdentity: "mem-xyz",
    });
    assert.strictEqual(result.decision, APPROVAL_DECISION.ALLOW);
    assert.strictEqual(result.source, "target");
  });

  test("ignores expired rows and falls through to next tier", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    // Expired repo-scoped row
    recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      repository: "owner/repo",
      decision: APPROVAL_DECISION.DENY,
      expiresAt: past,
    });
    // Live global row
    recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      decision: APPROVAL_DECISION.ALLOW,
    });
    const result = resolveApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      repository: "owner/repo",
    });
    assert.strictEqual(result.decision, APPROVAL_DECISION.ALLOW);
    assert.strictEqual(result.source, "global");
  });

  test("throws when actionFamily is missing", () => {
    assert.throws(() => resolveApproval(db, {}), /actionFamily/);
  });

  test("returned approval object has expected shape", () => {
    recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.PROPOSAL_APPLY,
      repository: "owner/repo",
      decision: APPROVAL_DECISION.ALLOW,
      durable: true,
      reason: "user approved",
      grantedBy: "user",
    });
    const { approval } = resolveApproval(db, {
      actionFamily: APPROVAL_FAMILY.PROPOSAL_APPLY,
      repository: "owner/repo",
    });
    assert.ok(typeof approval.id === "string");
    assert.strictEqual(approval.actionFamily, APPROVAL_FAMILY.PROPOSAL_APPLY);
    assert.strictEqual(approval.repository, "owner/repo");
    assert.strictEqual(approval.decision, APPROVAL_DECISION.ALLOW);
    assert.strictEqual(approval.durable, true);
    assert.strictEqual(approval.reason, "user approved");
    assert.strictEqual(approval.grantedBy, "user");
    assert.ok(typeof approval.createdAt === "string");
    assert.ok(typeof approval.updatedAt === "string");
  });
});

// ---------------------------------------------------------------------------
// revokeApproval
// ---------------------------------------------------------------------------

describe("revokeApproval", { skip: SKIP_NO_FTS5 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  test("removes the row so subsequent resolution returns 'ask'", () => {
    const id = recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      decision: APPROVAL_DECISION.ALLOW,
    });
    const removed = revokeApproval(db, id);
    assert.strictEqual(removed, true);

    const result = resolveApproval(db, { actionFamily: APPROVAL_FAMILY.MEMORY_WRITE });
    assert.strictEqual(result.decision, APPROVAL_DECISION.ASK);
  });

  test("returns false for unknown id", () => {
    assert.strictEqual(revokeApproval(db, "nonexistent-id"), false);
  });

  test("throws when id is empty", () => {
    assert.throws(() => revokeApproval(db, ""), /id/);
  });
});

// ---------------------------------------------------------------------------
// listApprovals
// ---------------------------------------------------------------------------

describe("listApprovals", { skip: SKIP_NO_FTS5 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  test("returns empty array when no rows exist", () => {
    assert.deepStrictEqual(listApprovals(db), []);
  });

  test("returns all rows when no filter is supplied", () => {
    recordApproval(db, { actionFamily: APPROVAL_FAMILY.MEMORY_WRITE, decision: APPROVAL_DECISION.ALLOW });
    recordApproval(db, { actionFamily: APPROVAL_FAMILY.SCOPE_OVERRIDE, decision: APPROVAL_DECISION.DENY });
    assert.strictEqual(listApprovals(db).length, 2);
  });

  test("filters by actionFamily", () => {
    recordApproval(db, { actionFamily: APPROVAL_FAMILY.MEMORY_WRITE, decision: APPROVAL_DECISION.ALLOW });
    recordApproval(db, { actionFamily: APPROVAL_FAMILY.SCOPE_OVERRIDE, decision: APPROVAL_DECISION.DENY });
    const results = listApprovals(db, { actionFamily: APPROVAL_FAMILY.MEMORY_WRITE });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].actionFamily, APPROVAL_FAMILY.MEMORY_WRITE);
  });

  test("filters by repository", () => {
    recordApproval(db, { actionFamily: APPROVAL_FAMILY.MEMORY_WRITE, decision: APPROVAL_DECISION.ALLOW });
    recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      repository: "owner/repo",
      decision: APPROVAL_DECISION.DENY,
    });
    const results = listApprovals(db, { repository: "owner/repo" });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].repository, "owner/repo");
  });

  test("each returned object has expected camelCase shape", () => {
    recordApproval(db, { actionFamily: APPROVAL_FAMILY.MEMORY_WRITE, decision: APPROVAL_DECISION.ALLOW });
    const [row] = listApprovals(db);
    assert.ok("id" in row);
    assert.ok("actionFamily" in row);
    assert.ok("repository" in row);
    assert.ok("targetIdentity" in row);
    assert.ok("decision" in row);
    assert.ok("durable" in row);
    assert.ok("grantedBy" in row);
    assert.ok("createdAt" in row);
    assert.ok("updatedAt" in row);
  });
});

// ---------------------------------------------------------------------------
// purgeExpiredApprovals
// ---------------------------------------------------------------------------

describe("purgeExpiredApprovals", { skip: SKIP_NO_FTS5 }, () => {
  beforeEach(setup);
  afterEach(teardown);

  test("removes expired rows and returns count", () => {
    const past = new Date(Date.now() - 5000).toISOString();
    recordApproval(db, { actionFamily: APPROVAL_FAMILY.MEMORY_WRITE, decision: APPROVAL_DECISION.ALLOW, expiresAt: past });
    recordApproval(db, { actionFamily: APPROVAL_FAMILY.SCOPE_OVERRIDE, decision: APPROVAL_DECISION.DENY, expiresAt: past });
    recordApproval(db, { actionFamily: APPROVAL_FAMILY.PROPOSAL_APPLY, decision: APPROVAL_DECISION.ALLOW });

    const removed = purgeExpiredApprovals(db);
    assert.strictEqual(removed, 2);
    assert.strictEqual(listApprovals(db).length, 1);
  });

  test("returns 0 when no expired rows exist", () => {
    recordApproval(db, { actionFamily: APPROVAL_FAMILY.MEMORY_WRITE, decision: APPROVAL_DECISION.ALLOW });
    assert.strictEqual(purgeExpiredApprovals(db), 0);
  });

  test("keeps non-null future expiresAt rows", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    recordApproval(db, {
      actionFamily: APPROVAL_FAMILY.MEMORY_WRITE,
      decision: APPROVAL_DECISION.ALLOW,
      expiresAt: future,
    });
    assert.strictEqual(purgeExpiredApprovals(db), 0);
    assert.strictEqual(listApprovals(db).length, 1);
  });
});
