import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REQUIRED_CHECKS, REQUIRED_CLIENTS, validateReleaseEvidence } from "../../scripts/check-release-evidence.mjs";

const CANDIDATE = "0123456789abcdef0123456789abcdef01234567";
const NOW = new Date("2026-09-09T12:00:00.000Z");

test("malformed client or simulated execution cannot report a completed soak", () => {
  for (const replacement of [null, { execution: { mode: "simulated", authenticated: false } }]) {
    const evidence = validEvidence();
    evidence.clients.copilot = replacement === null ? null : { ...evidence.clients.copilot, ...replacement };
    const result = validateReleaseEvidence(evidence, { now: NOW });
    assert.equal(result.ok, false);
    assert.equal(result.certification.ok, false);
    assert.equal(result.soak.ok, false);
  }
});

function validEvidence() {
  const soak = ["2026-08-20", "2026-08-21", "2026-08-22", "2026-08-23", "2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28", "2026-08-29"];
  const clients = Object.fromEntries(REQUIRED_CLIENTS.map((client) => [client, {
    platform: "macos",
    nodeVersion: "24.0.0",
    clientVersion: "1.2.3",
    execution: { mode: "real", authenticated: true },
    installation: { tagged: true, tag: "lore-v1.0.0-rc.1", commit: CANDIDATE, at: "2026-08-20T10:00:00.000Z", evidence: `evidence/${client}/install.json` },
    checks: Object.fromEntries(REQUIRED_CHECKS.map((check) => [check, {
      status: "pass",
      at: "2026-08-20T10:00:00.000Z",
      commit: CANDIDATE,
      mode: "real",
      authenticated: true,
      evidence: `evidence/${client}/${check}.json`,
    }])),
    soak: soak.map((date) => ({ date, at: `${date}T10:00:00.000Z`, commit: CANDIDATE, success: true, evidence: `evidence/${client}/soak-${date}.json` })),
  }]));
  return {
    schemaVersion: 1,
    candidateCommit: CANDIDATE,
    candidateTag: "lore-v1.0.0-rc.1",
    startedAt: "2026-08-20T09:00:00.000Z",
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
  evidence.clients.pi.checks.recovery.mode = "simulated";
  const result = validateReleaseEvidence(evidence, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.certification.ok, false);
  assert.equal(result.soak.ok, false);
  assert.match(result.blockers.join("\n"), /execution\.mode/);
  assert.match(result.blockers.join("\n"), /status/);
  assert.match(result.blockers.join("\n"), /does not match candidateCommit/);
  assert.match(result.blockers.join("\n"), /duplicate day/);
  assert.match(result.blockers.join("\n"), /future/);
  assert.match(result.blockers.join("\n"), /mode.*real/);
});

test("requires ten distinct successful days and a common fourteen-day window", () => {
  const evidence = validEvidence();
  evidence.clients.codex.soak = evidence.clients.codex.soak.slice(0, 9).map((entry) => ({ ...entry, success: true }));
  evidence.generatedAt = "2026-09-02T10:00:00.000Z";
  const result = validateReleaseEvidence(evidence, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.certification.ok, true);
  assert.equal(result.soak.ok, false);
  assert.match(result.blockers.join("\n"), /codex\.soak.*10 distinct/);
  assert.match(result.blockers.join("\n"), /candidate window.*14 elapsed/);
});

test("fails both gates when the candidate window is incomplete or malformed", () => {
  const evidence = validEvidence();
  delete evidence.clients.pi;
  evidence.generatedAt = "2026-02-30T10:00:00.000Z";
  const result = validateReleaseEvidence(evidence, { now: NOW });
  assert.equal(result.ok, false);
  assert.equal(result.certification.ok, false);
  assert.equal(result.soak.ok, false);
  assert.match(result.blockers.join("\n"), /generatedAt.*valid UTC/);
  assert.match(result.blockers.join("\n"), /all five actual clients/);
});

test("CLI rejects extra arguments and runs through a symlinked entrypoint", async () => {
  const script = fileURLToPath(new URL("../../scripts/check-release-evidence.mjs", import.meta.url));
  const directory = await mkdtemp(join(tmpdir(), "lore-release-evidence-"));
  const link = join(directory, basename(script));
  await symlink(script, link);
  try {
    const help = spawnSync(process.execPath, [link, "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0);
    const extra = spawnSync(process.execPath, [link, "--help", "unexpected"], { encoding: "utf8" });
    assert.equal(extra.status, 2);
    const ledger = join(directory, "evidence.json");
    await writeFile(ledger, JSON.stringify(validEvidence()), "utf8");
    const checked = spawnSync(process.execPath, [link, ledger], { encoding: "utf8" });
    assert.equal(checked.status, 1);
    const output = JSON.parse(checked.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.artifactBlockers.length > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
