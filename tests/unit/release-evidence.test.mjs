import assert from "node:assert/strict";
import { test } from "node:test";

import { REQUIRED_CHECKS, REQUIRED_CLIENTS, validateReleaseEvidence } from "../../scripts/check-release-evidence.mjs";

const CANDIDATE = "0123456789abcdef0123456789abcdef01234567";
const NOW = new Date("2026-09-09T12:00:00.000Z");

function validEvidence() {
  const soak = ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-09-03"];
  const clients = Object.fromEntries(REQUIRED_CLIENTS.map((client) => [client, {
    platform: "macos",
    nodeVersion: "24.0.0",
    clientVersion: "1.2.3",
    execution: { mode: "real", authenticated: true },
    installation: { tagged: true, tag: "lore-v1.0.0-rc.1", commit: CANDIDATE, evidence: `evidence/${client}/install.json` },
    checks: Object.fromEntries(REQUIRED_CHECKS.map((check) => [check, {
      status: "pass",
      commit: CANDIDATE,
      mode: "real",
      authenticated: true,
      evidence: `evidence/${client}/${check}.json`,
    }])),
    soak: soak.map((date) => ({ date, commit: CANDIDATE, success: true, evidence: `evidence/${client}/soak-${date}.json` })),
  }]));
  return {
    schemaVersion: 1,
    candidateCommit: CANDIDATE,
    candidateTag: "lore-v1.0.0-rc.1",
    generatedAt: "2026-09-09T10:00:00.000Z",
    clients,
  };
}

test("accepts complete actual-client certification and a 14-day soak", () => {
  const result = validateReleaseEvidence(validEvidence(), { now: NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.certification.ok, true);
  assert.equal(result.soak.ok, true);
});

test("rejects simulated, partial, inconsistent, duplicate, and future evidence", () => {
  const evidence = validEvidence();
  evidence.clients.codex.execution.mode = "simulated";
  evidence.clients.pi.checks.reload.status = "pending";
  evidence.clients.claude.checks.update.commit = "fedcba9876543210fedcba9876543210fedcba98";
  evidence.clients.antigravity.soak[1].date = evidence.clients.antigravity.soak[0].date;
  evidence.clients.copilot.soak[0].date = "2026-09-10";
  evidence.clients.pi.soak[0].date = "2026-02-30";
  evidence.clients.pi.checks.recovery.evidence = "synthetic-fixture.json";
  const result = validateReleaseEvidence(evidence, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.certification.ok, false);
  assert.equal(result.soak.ok, false);
  assert.match(result.blockers.join("\n"), /execution\.mode/);
  assert.match(result.blockers.join("\n"), /status/);
  assert.match(result.blockers.join("\n"), /does not match candidateCommit/);
  assert.match(result.blockers.join("\n"), /duplicate day/);
  assert.match(result.blockers.join("\n"), /future/);
  assert.match(result.blockers.join("\n"), /actual, completed evidence/);
});

test("requires ten distinct successful days across at least fourteen elapsed days", () => {
  const evidence = validEvidence();
  evidence.clients.codex.soak = evidence.clients.codex.soak.slice(0, 9).map((entry) => ({ ...entry, success: true }));
  evidence.clients.pi.soak = evidence.clients.pi.soak.map((entry, index) => ({ ...entry, date: `2026-08-${String(20 + index).padStart(2, "0")}` }));
  const result = validateReleaseEvidence(evidence, { now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.blockers.join("\n"), /codex\.soak.*10 distinct/);
  assert.match(result.blockers.join("\n"), /pi\.soak.*14 elapsed/);
});
