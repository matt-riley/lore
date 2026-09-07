import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, readFileSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { withFixtureDb } from "../helpers/fixture-db.mjs";
import { memoryCorrect, memoryRepair, memoryPurge } from "../../lib/memory/memory-administration.mjs";
import { parseAdministrationTranscript } from "../../lib/memory/administration-source.mjs";
import { extractSessionMemories } from "../../lib/sessions/rule-extractor.mjs";

const repo = "github.com/example/repo";
const save = (db, id, content, extra = {}) => db.insertSemanticMemory({ id, type: "user_preference", content, repository: repo, scope: "repo", ...extra });
const apply = (fn, db, request, plan = fn(db, request)) => fn(db, { ...request, action: "apply", planFingerprint: plan.planFingerprint, selectedCandidateIds: plan.candidateIds });
function transcript(db, config, sessionId, lines, client = "codex") {
  const sourcePath = path.join(path.dirname(config.paths.derivedStorePath), `${sessionId}.jsonl`);
  writeFileSync(sourcePath, lines.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const stat = statSync(sourcePath);
  db.saveIngestionCheckpoint(client, sessionId, { sourceIdentity: `${stat.dev}:${stat.ino}`, repository: repo, adapterState: { sourcePath, sourceCwd: path.dirname(sourcePath) }, health: {} });
  return sourcePath;
}
const user = (text) => ({ type: "response_item", payload: { type: "message", role: "user", content: text } });

test("purge selected plaintext requires exact shared aggregates and preserves unrelated memories", async () => {
  const f = await withFixtureDb();
  try {
    save(f.db, "remove", "quartzsecret preference", { sourceSessionId: "shared" });
    save(f.db, "keep", "unrelated survivor", { sourceSessionId: "shared" });
    save(f.db, "foreign", "foreign survivor", { repository: "foreign/repo" });
    save(f.db, "global", "global survivor", { scope: "global", repository: null });
    f.db.saveIngestionCheckpoint("codex", "shared", { repository: repo, adapterState: { turns: [{ user_message: "quartzsecret preference and unrelated survivor" }] }, health: {} });
    const defaultPlan = memoryPurge(f.db, { memoryIds: ["remove"] });
    assert.ok(defaultPlan.unresolvedCandidates.some((row) => row.code === "DEPENDENT_AGGREGATES_REQUIRE_SELECTION"));
    assert.throws(() => apply(memoryPurge, f.db, { memoryIds: ["remove"] }, defaultPlan), /unresolved/);
    const request = { memoryIds: ["remove"], includeDependentAggregates: true };
    const plan = memoryPurge(f.db, request);
    assert.ok(plan.candidateIds.every((id) => id.startsWith("aggregate:")));
    assert.throws(() => memoryPurge(f.db, { ...request, action: "apply", planFingerprint: plan.planFingerprint, selectedCandidateIds: ["shared"] }), /actionable/);
    const result = apply(memoryPurge, f.db, request, plan);
    assert.equal(result.applied, true);
    for (const table of ["semantic_memory", "ingestion_checkpoint", "session_evidence", "memory_suppression"]) assert.equal(JSON.stringify(f.db.db.prepare(`SELECT * FROM ${table}`).all()).includes("quartzsecret"), false, table);
    assert.deepEqual(f.db.db.prepare("SELECT id FROM semantic_memory ORDER BY id").all().map((row) => row.id), ["foreign", "global", "keep"]);
    assert.ok(readFileSync(result.backup.path ?? result.backup.snapshotPath ?? result.backup.filePath));
  } finally { f.cleanup(); }
});

test("trace references use exact structured IDs and domain selection preserves foreign scope", async () => {
  const f = await withFixtureDb();
  try {
    save(f.db, "%", "selected", { domainKey: "shared-domain" });
    f.db.db.prepare("INSERT INTO memory_domain(domain_key,kind,title,repository,scope,created_at,updated_at) VALUES('shared-domain','project','foreign','foreign/repo','repo','x','x')").run();
    const insert = f.db.db.prepare("INSERT INTO trajectory_artifact(id,kind,summary,context_json,repository,created_at) VALUES(?, 'test','safe',?,?,'x')");
    insert.run("unrelated", JSON.stringify({ memoryId: "other" }), repo);
    insert.run("text-only", JSON.stringify({ text: "%" }), repo);
    insert.run("related", JSON.stringify({ memoryId: "%" }), repo);
    const request = { memoryIds: ["%"], includeDependentAggregates: true };
    const plan = memoryPurge(f.db, request);
    assert.deepEqual(plan.affected.trajectory_artifact, [{ id: "related" }]);
    apply(memoryPurge, f.db, request, plan);
    assert.ok(f.db.db.prepare("SELECT 1 FROM memory_domain WHERE domain_key='shared-domain'").get());
    assert.deepEqual(f.db.db.prepare("SELECT id FROM trajectory_artifact ORDER BY id").all().map((row) => row.id), ["text-only", "unrelated"]);
  } finally { f.cleanup(); }
});

test("correction wrappers deduplicate manual destination and preserve transferable repository and expiry", async () => {
  const f = await withFixtureDb();
  try {
    save(f.db, "old", "Prefer old names.", { expiresAt: "2030-01-01T00:00:00Z" });
    save(f.db, "destination", "Prefer clear names.", { scope: "transferable", repository: "other/repo", metadata: { source: "memory_save" } });
    const result = apply(memoryCorrect, f.db, { memoryId: "old", content: "Prefer clear names.", scope: "transferable", repository: "other/repo" });
    assert.equal(result.replacementId, "destination");
    assert.equal(result.replacement.repository, "other/repo");
    assert.equal(result.replacement.expires_at, "2030-01-01T00:00:00.000Z");
    assert.equal(result.replacement.scope_source, "manual");
    assert.equal(f.db.isMemorySuppressed("old"), true);
  } finally { f.cleanup(); }
});

test("mapping fingerprints full same-count content and carries suppressions", async () => {
  const f = await withFixtureDb();
  try {
    save(f.db, "mapped", "Prefer quartz names.", { repository: "old/repo" });
    f.db.forgetMemory({ id: "mapped" });
    const request = { repositoryMappings: [{ legacy: "old/repo", canonical: repo }] };
    const old = memoryRepair(f.db, request);
    f.db.db.prepare("UPDATE semantic_memory SET content='Changed same-count content' WHERE id='mapped'").run();
    assert.throws(() => apply(memoryRepair, f.db, request, old), /stale/);
    const fresh = memoryRepair(f.db, request);
    apply(memoryRepair, f.db, request, fresh);
    assert.equal(f.db.db.prepare("SELECT repository FROM semantic_memory WHERE id='mapped'").get().repository, repo);
    assert.equal(f.db.db.prepare("SELECT repository FROM memory_suppression WHERE memory_id='mapped'").get().repository, repo);
  } finally { f.cleanup(); }
});

test("mapping never mutates an unpreviewed 201-row set", async () => {
  const f = await withFixtureDb();
  try {
    for (let i = 0; i < 201; i++) save(f.db, `row-${i}`, `Preference ${i}`, { repository: "old/repo" });
    const request = { repositoryMappings: [{ legacy: "old/repo", canonical: repo }], limit: 200 };
    const plan = memoryRepair(f.db, request);
    assert.ok(plan.unresolvedCandidates.some((item) => item.code === "BOUND_REACHED"));
    assert.throws(() => apply(memoryRepair, f.db, request, plan), /unresolved/);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) count FROM semantic_memory WHERE repository='old/repo'").get().count, 201);
  } finally { f.cleanup(); }
});

test("complete repair retires old false global output and preserves early supported evidence", async () => {
  const f = await withFixtureDb();
  try {
    const lines = [user("For this repository, I prefer descriptive variable names."), ...Array.from({ length: 35 }, () => user("What time is the meeting?"))];
    transcript(f.db, f.config, "complete", lines);
    save(f.db, "early", "For this repository, I prefer descriptive variable names.", { sourceSessionId: "complete" });
    save(f.db, "false-global", "What time is the meeting?", { sourceSessionId: "complete", scope: "global", repository: null });
    save(f.db, "manual", "Manual authority", { sourceSessionId: "complete", metadata: { source: "memory_save" } });
    const request = { sessionIds: ["complete"] };
    const plan = memoryRepair(f.db, request);
    assert.equal(plan.unresolvedCandidates.length, 0, JSON.stringify(plan.unresolvedCandidates));
    assert.ok(plan.repairCandidates.some((item) => item.retireMemoryIds.includes("false-global")));
    assert.ok(!plan.candidateIds.includes("false-global"));
    const result = apply(memoryRepair, f.db, request, plan);
    assert.equal(result.applied, true);
    assert.ok(result.repairedMemoryIds.length > 0);
    assert.ok(result.repairedMemoryIds.every((id) => f.db.db.prepare("SELECT 1 FROM semantic_memory WHERE id=?").get(id)));
    assert.ok(f.db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id='false-global'").get().superseded_by);
    assert.equal(f.db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id='manual'").get().superseded_by, null);
    assert.ok(f.db.db.prepare("SELECT 1 FROM semantic_memory WHERE content LIKE '%descriptive variable%' AND superseded_by IS NULL").get());
  } finally { f.cleanup(); }
});

test("Pi and repository selectors produce real actionable source repairs with stable byte evidence", async () => {
  const f = await withFixtureDb();
  try {
    const source = transcript(f.db, f.config, "pi-session", [{ type: "session", id: "pi-session" }, { type: "message", message: { role: "user", content: "For this repository, I prefer small pure functions." } }], "pi");
    save(f.db, "legacy", "For this repository, I prefer small pure functions.", { sourceSessionId: "pi-session" });
    const request = { repository: repo };
    const plan = memoryRepair(f.db, request);
    assert.equal(plan.unresolvedCandidates.length, 0, JSON.stringify(plan));
    assert.ok(plan.candidateIds.length);
    const offset = readFileSync(source).indexOf(10) + 1;
    apply(memoryRepair, f.db, request, plan);
    assert.ok(f.db.db.prepare("SELECT 1 FROM session_evidence WHERE source_record_id=?").get(String(offset)));
  } finally { f.cleanup(); }
});

test("repair memory selectors intersect repository scope without broadening source sessions", async () => {
  const f = await withFixtureDb();
  try {
    transcript(f.db, f.config, "selected-session", [user("For this repository, I prefer small pure functions.")]);
    transcript(f.db, f.config, "other-session", [user("For this repository, I prefer descriptive names.")]);
    save(f.db, "selected", "Old false output", { sourceSessionId: "selected-session" });
    const plan = memoryRepair(f.db, { memoryIds: ["selected"], repository: repo });
    assert.equal(plan.unresolvedCandidates.length, 0, JSON.stringify(plan.unresolvedCandidates));
    assert.deepEqual(plan.repairCandidates.map((candidate) => candidate.sessionId), ["selected-session"]);
  } finally { f.cleanup(); }
});

test("repair rejects a selected session whose checkpoint belongs to another repository", async () => {
  const f = await withFixtureDb();
  try {
    transcript(f.db, f.config, "foreign-session", [user("For this repository, I prefer descriptive names.")]);
    f.db.db.prepare("UPDATE ingestion_checkpoint SET repository='foreign/repo' WHERE session_id='foreign-session'").run();
    const plan = memoryRepair(f.db, { sessionIds: ["foreign-session"], repository: repo });
    assert.ok(plan.unresolvedCandidates.some((item) => item.code === "FOREIGN_TARGET"), JSON.stringify(plan.unresolvedCandidates));
  } finally { f.cleanup(); }
});

test("repair rejects a memory selector whose source checkpoint belongs to another repository", async () => {
  const f = await withFixtureDb();
  try {
    transcript(f.db, f.config, "selected-source", [user("For this repository, I prefer descriptive names.")]);
    save(f.db, "selected-source-memory", "Old false output", { sourceSessionId: "selected-source" });
    f.db.db.prepare("UPDATE ingestion_checkpoint SET repository='foreign/repo' WHERE session_id='selected-source'").run();
    const plan = memoryRepair(f.db, { memoryIds: ["selected-source-memory"], repository: repo });
    assert.ok(plan.unresolvedCandidates.some((item) => item.code === "FOREIGN_TARGET"), JSON.stringify(plan.unresolvedCandidates));
  } finally { f.cleanup(); }
});

test("source changes and incomplete records block repair without snapshot mutation", async () => {
  const f = await withFixtureDb();
  try {
    const source = transcript(f.db, f.config, "changed", [user("For this repository, I prefer small pure functions.")]);
    save(f.db, "legacy", "Old false output", { sourceSessionId: "changed" });
    const request = { memoryIds: ["legacy"] };
    const plan = memoryRepair(f.db, request);
    writeFileSync(source, JSON.stringify(user("For this repository, I prefer descriptive names.")) + "\n");
    assert.throws(() => apply(memoryRepair, f.db, request, plan), /stale/);
    writeFileSync(source, '{"unfinished":');
    const malformed = memoryRepair(f.db, request);
    assert.ok(malformed.unresolvedCandidates.length);
    assert.throws(() => apply(memoryRepair, f.db, request, malformed), /unresolved|selectedCandidateIds/);
  } finally { f.cleanup(); }
});

test("safe source reader rejects FIFO promptly in a timed child", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lore-fifo-"));
  try {
    const fifo = path.join(dir, "source");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    const module = new URL("../../lib/memory/administration-source.mjs", import.meta.url).href;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `import {readAdministrationSource} from ${JSON.stringify(module)}; try { readAdministrationSource(process.argv[1]); process.exit(2); } catch { process.exit(0); }`, fifo], { timeout: 2000 });
    assert.equal(child.status, 0, String(child.error));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("full repair role descriptors generate the native per-record evidence contract", () => {
  const bytes = Buffer.from([user("Which database?"), { type: "response_item", payload: { type: "message", role: "assistant", content: "We decided to use PostgreSQL because we need concurrent writers." } }].map(JSON.stringify).join("\n") + "\n");
  const artifacts = parseAdministrationTranscript(bytes, { client: "codex", sessionId: "native", repository: repo, timestamp: "2026-01-01T00:00:00Z" });
  const result = extractSessionMemories({ sessionId: "native", repository: repo, sessionArtifacts: artifacts, workspace: { workspace: { repository: repo } } });
  const decision = result.semanticMemories.find((row) => row.evidence?.sourceKind === "decision");
  assert.ok(decision, JSON.stringify(result.semanticMemories));
  assert.equal(decision.evidence.sourceRecordId, String(bytes.indexOf(10) + 1));
});

test("available Copilot raw session store is repaired read-only", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await withFixtureDb();
  try {
    const raw = new DatabaseSync(f.config.paths.rawStorePath);
    raw.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,repository TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE turns(session_id TEXT,turn_index INTEGER,user_message TEXT,assistant_response TEXT,timestamp TEXT)");
    raw.prepare("INSERT INTO sessions VALUES('copilot',NULL,?,'2026-01-01','2026-01-01')").run(repo);
    raw.prepare("INSERT INTO turns VALUES('copilot',1,?,'','2026-01-01')").run("For this repository, I prefer explicit error handling.");
    raw.close();
    const before = readFileSync(f.config.paths.rawStorePath);
    save(f.db, "copilot-old", "Old false output", { sourceSessionId: "copilot" });
    const plan = memoryRepair(f.db, { repository: repo });
    assert.equal(plan.unresolvedCandidates.length, 0, JSON.stringify(plan.unresolvedCandidates));
    apply(memoryRepair, f.db, { repository: repo }, plan);
    assert.ok(f.db.db.prepare("SELECT 1 FROM semantic_memory WHERE content LIKE '%explicit error handling%' AND superseded_by IS NULL").get());
    assert.deepEqual(readFileSync(f.config.paths.rawStorePath), before);
  } finally { f.cleanup(); }
});

test("repair honors suppression and does not retire unrelated session memory", async () => {
  const f = await withFixtureDb();
  try {
    transcript(f.db, f.config, "limited", [user("For this repository, I prefer small pure functions.")]);
    save(f.db, "selected", "Old false output", { sourceSessionId: "limited" });
    save(f.db, "unrelated", "Unselected unrelated output", { sourceSessionId: "limited" });
    const suppressed = save(f.db, "forgotten", "For this repository, I prefer small pure functions.", { sourceSessionId: "limited" });
    f.db.forgetMemory({ id: suppressed });
    const request = { memoryIds: ["selected"] };
    const plan = memoryRepair(f.db, request);
    assert.ok(plan.repairCandidates.every((row) => !row.retireMemoryIds.includes("unrelated")));
    apply(memoryRepair, f.db, request, plan);
    assert.equal(f.db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id='unrelated'").get().superseded_by, null);
    assert.equal(f.db.db.prepare("SELECT COUNT(*) count FROM semantic_memory WHERE content LIKE '%small pure functions%' AND superseded_by IS NULL").get().count, 0);
  } finally { f.cleanup(); }
});

test("purge enumerates provenance-free literal copies and retains foreign/global aggregates", async () => {
  const f = await withFixtureDb();
  try {
    save(f.db, "literal", "quartzsecret literal copy");
    const insert = f.db.db.prepare("INSERT INTO trajectory_artifact(id,kind,summary,repository,created_at) VALUES(?,'test',?,?, 'x')");
    insert.run("local-copy", "quartzsecret literal copy", repo);
    insert.run("foreign-copy", "quartzsecret literal copy", "foreign/repo");
    insert.run("global-copy", "quartzsecret literal copy", null);
    const request = { memoryIds: ["literal"], includeDependentAggregates: true };
    const plan = memoryPurge(f.db, request);
    assert.deepEqual(plan.affected.trajectory_artifact, [{ id: "local-copy" }]);
    apply(memoryPurge, f.db, request, plan);
    assert.deepEqual(f.db.db.prepare("SELECT id FROM trajectory_artifact ORDER BY id").all().map((row) => row.id), ["foreign-copy", "global-copy"]);
  } finally { f.cleanup(); }
});

test("post-snapshot affected-state race and transactional correction failure preserve old memory", async () => {
  const f = await withFixtureDb();
  try {
    save(f.db, "race", "Prefer old names.");
    const request = { memoryId: "race", content: "Prefer clearer names." };
    const plan = memoryCorrect(f.db, request);
    const transaction = f.db.withSemanticMemoryTransaction.bind(f.db);
    f.db.withSemanticMemoryTransaction = (callback) => {
      f.db.db.prepare("UPDATE semantic_memory SET content='Changed after snapshot' WHERE id='race'").run();
      return transaction(callback);
    };
    assert.throws(() => apply(memoryCorrect, f.db, request, plan), /changed after snapshot/);
    assert.equal(f.db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id='race'").get().superseded_by, null);
    f.db.withSemanticMemoryTransaction = transaction;
    const fresh = memoryCorrect(f.db, request);
    f.db.insertSemanticMemory = () => { throw new Error("injected write failure"); };
    assert.throws(() => apply(memoryCorrect, f.db, request, fresh), /injected write failure/);
    assert.equal(f.db.isMemorySuppressed("race"), false);
    assert.equal(f.db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id='race'").get().superseded_by, null);
  } finally { f.cleanup(); }
});

test("complete repair retains only the corrected outcome across distant windows", async () => {
  const f = await withFixtureDb();
  try {
    const assistant = (content) => ({ type: "response_item", payload: { type: "message", role: "assistant", content } });
    const lines = [user("Choose a database."), assistant("We decided to use PostgreSQL for the analytics database because it supports concurrent writers."), ...Array.from({ length: 25 }, () => user("What time is the meeting?")), user("Change the analytics database."), assistant("We switched to SQLite for the analytics database because we need simpler deployment.")];
    transcript(f.db, f.config, "outcomes", lines);
    save(f.db, "legacy-outcome", "outdated outcome", { sourceSessionId: "outcomes" });
    const request = { sessionIds: ["outcomes"] };
    const plan = memoryRepair(f.db, request);
    assert.equal(plan.unresolvedCandidates.length, 0);
    const decisions = plan.repairCandidates.flatMap((row) => row.memories).filter((row) => row.type === "decision");
    assert.ok(decisions.some((row) => row.content.includes("SQLite")));
    assert.ok(!decisions.some((row) => row.content.includes("PostgreSQL")), JSON.stringify(decisions));
  } finally { f.cleanup(); }
});

test("Copilot repair fingerprints committed WAL-visible changes", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const f = await withFixtureDb();
  let raw;
  try {
    raw = new DatabaseSync(f.config.paths.rawStorePath);
    raw.exec("PRAGMA journal_mode=WAL; CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,repository TEXT,created_at TEXT,updated_at TEXT); CREATE TABLE turns(session_id TEXT,turn_index INTEGER,user_message TEXT,assistant_response TEXT,timestamp TEXT)");
    raw.prepare("INSERT INTO sessions VALUES('wal',NULL,?,'2026-01-01','2026-01-01')").run(repo);
    raw.prepare("INSERT INTO turns VALUES('wal',1,?,'','2026-01-01')").run("For this repository, I prefer explicit error handling.");
    save(f.db, "wal-old", "Old false output", { sourceSessionId: "wal" });
    const request = { memoryIds: ["wal-old"] };
    const plan = memoryRepair(f.db, request);
    assert.equal(plan.unresolvedCandidates.length, 0, JSON.stringify(plan.unresolvedCandidates));
    raw.prepare("UPDATE turns SET user_message=? WHERE session_id='wal'").run("For this repository, I prefer clear variable names.");
    assert.throws(() => apply(memoryRepair, f.db, request, plan), /stale/);
  } finally { raw?.close(); f.cleanup(); }
});

test("snapshot failure makes no correction or suppression writes", async () => {
  const f = await withFixtureDb();
  try {
    save(f.db, "backup-old", "Prefer old names.");
    const badPath = path.join(path.dirname(f.config.paths.derivedStorePath), "not-a-directory");
    writeFileSync(badPath, "fixture");
    f.db.config.paths.backupDir = badPath;
    const request = { memoryId: "backup-old", content: "Prefer new names." };
    const plan = memoryCorrect(f.db, request);
    assert.throws(() => apply(memoryCorrect, f.db, request, plan), /snapshot failed/);
    assert.equal(f.db.isMemorySuppressed("backup-old"), false);
    assert.equal(f.db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id='backup-old'").get().superseded_by, null);
  } finally { f.cleanup(); }
});

test("repair re-scopes a legacy false global with the same source evidence key", async () => {
  const f = await withFixtureDb();
  try {
    const source = transcript(f.db, f.config, "rescope", [user("For this repository, I prefer descriptive variable names.")]);
    const artifacts = parseAdministrationTranscript(readFileSync(source), { client: "codex", sessionId: "rescope", repository: repo, timestamp: "2026-01-01" });
    const generated = extractSessionMemories({ sessionId: "rescope", repository: repo, sessionArtifacts: artifacts, workspace: { workspace: { repository: repo } } }).semanticMemories[0];
    f.db.reconcileGeneratedMemories({ sessionId: "rescope", repository: repo, memories: [generated] });
    const old = f.db.db.prepare("SELECT id FROM semantic_memory WHERE source_session_id='rescope'").get().id;
    f.db.db.prepare("UPDATE semantic_memory SET scope='global', repository=NULL WHERE id=?").run(old);
    const request = { memoryIds: [old] };
    const plan = memoryRepair(f.db, request);
    assert.ok(plan.repairCandidates[0].retiredLinks.some((link) => link.memoryId === old));
    apply(memoryRepair, f.db, request, plan);
    assert.ok(f.db.db.prepare("SELECT superseded_by FROM semantic_memory WHERE id=?").get(old).superseded_by);
    const replacement = f.db.db.prepare("SELECT id,scope,repository FROM semantic_memory WHERE superseded_by IS NULL AND source_session_id='rescope'").get();
    assert.equal(replacement.scope, "repo");
    assert.equal(replacement.repository, repo);
    const evidence = f.db.listSemanticEvidence(replacement.id);
    assert.equal(evidence[0].key, generated.evidence.key);
    assert.equal(evidence[0].retiredAt, null);
    assert.equal(evidence[0].linkRetiredAt, null);
  } finally { f.cleanup(); }
});

test("unrelated suppression history cannot exhaust a single-memory correction preview", async () => {
  const f = await withFixtureDb();
  try {
    for (let index = 0; index < 55; index++) {
      const id = save(f.db, `unrelated-${index}`, `Unrelated preference ${index}`);
      f.db.forgetMemory({ id });
    }
    save(f.db, "target", "Prefer old names.");
    const request = { memoryId: "target", content: "Prefer clear names." };
    const plan = memoryCorrect(f.db, request);
    assert.equal(plan.unresolvedCandidates.length, 0);
    assert.equal(apply(memoryCorrect, f.db, request, plan).applied, true);
  } finally { f.cleanup(); }
});

test("purge previews cross-session checkpoint plaintext copies without evidence links", async () => {
  const f = await withFixtureDb();
  try {
    save(f.db, "secret", "quartzsecret across checkpoints");
    f.db.saveIngestionCheckpoint("codex", "unlinked", { repository: repo, adapterState: { turns: [{ user_message: "quartzsecret across checkpoints" }] }, health: {} });
    const before = memoryPurge(f.db, { memoryIds: ["secret"] });
    assert.ok(before.unresolvedCandidates.some((row) => row.code === "DEPENDENT_AGGREGATES_REQUIRE_SELECTION"));
    const request = { memoryIds: ["secret"], includeDependentAggregates: true };
    const plan = memoryPurge(f.db, request);
    assert.ok(plan.aggregateCandidates.some((row) => row.table === "ingestion_checkpoint" && row.key.session_id === "unlinked"));
    apply(memoryPurge, f.db, request, plan);
    assert.equal(JSON.stringify(f.db.db.prepare("SELECT * FROM ingestion_checkpoint").all()).includes("quartzsecret"), false);
  } finally { f.cleanup(); }
});

test("repair rejects a newly introduced canonical manual destination after preview", async () => {
  const f = await withFixtureDb();
  try {
    transcript(f.db, f.config, "destination-race", [user("For this repository, I prefer clear variable names.")]);
    save(f.db, "legacy-race", "Outdated output", { sourceSessionId: "destination-race" });
    const request = { memoryIds: ["legacy-race"] };
    const plan = memoryRepair(f.db, request);
    const proposed = plan.repairCandidates[0].memories[0];
    const manual = f.db.insertSemanticMemory({ ...proposed, sourceSessionId: "other-session", metadata: { source: "memory_save" } });
    assert.throws(() => apply(memoryRepair, f.db, request, plan), /stale/);
    const fresh = memoryRepair(f.db, request);
    assert.ok(fresh.affected.repairDestinationMemoryIds.includes(manual));
    const before = f.db.db.prepare("SELECT content,scope,repository,metadata_json FROM semantic_memory WHERE id=?").get(manual);
    apply(memoryRepair, f.db, request, fresh);
    assert.deepEqual(f.db.db.prepare("SELECT content,scope,repository,metadata_json FROM semantic_memory WHERE id=?").get(manual), before);
  } finally { f.cleanup(); }
});

test("complete Claude repair follows the last physical revision and ancestry order", () => {
  const node = (uuid, parentUuid, role, content) => ({ uuid, parentUuid, type: role, message: { role, content } });
  const records = [node("u", null, "user", "Choose a database."), node("a", "u", "assistant", "Old a."), node("b", "u", "assistant", "Branch b."), node("a", "u", "assistant", "Revised a.")];
  const parse = (values) => parseAdministrationTranscript(Buffer.from(values.map(JSON.stringify).join("\n") + "\n"), { client: "claude", sessionId: "branch", repository: repo, timestamp: "2026-01-01" });
  const first = parse(records);
  assert.equal(first.turns[0].assistant_response, "Revised a.");
  // Parent and leaf UUIDs may both have later physical revisions.
  const revised = parse([...records, node("u", null, "user", "Revised parent."), node("a", "u", "assistant", "Latest a.")]);
  assert.equal(revised.turns.length, 1);
  assert.equal(revised.turns[0].user_message, "Revised parent.");
  assert.equal(revised.turns[0].assistant_response, "Latest a.");
});

test("complete repair rejects a replaced source with another known native session identity", () => {
  const parse = (client, values) => parseAdministrationTranscript(Buffer.from(values.map(JSON.stringify).join("\n") + "\n"), { client, sessionId: `${client}:expected`, repository: repo, timestamp: "2026-01-01" });
  assert.throws(() => parse("codex", [{ type: "session_meta", payload: { id: "other" } }, user("For this repository, prefer clear names.")]), /SOURCE_SESSION_MISMATCH/);
  assert.doesNotThrow(() => parse("codex", [{ type: "session_meta", payload: { id: "expected" } }]));
  assert.throws(() => parse("claude", [{ type: "user", uuid: "u", sessionId: "other", message: { role: "user", content: "Hello" } }]), /SOURCE_SESSION_MISMATCH/);
  assert.doesNotThrow(() => parse("antigravity", [{ step_index: 0, status: "DONE", type: "USER_INPUT", source: "USER_EXPLICIT", content: "Hello" }]));
});

test("missing repository or global targets cannot report a successful no-op purge", async () => {
  const f = await withFixtureDb();
  try {
    for (const request of [{ repository: "missing/repo" }, { scope: "global" }]) {
      const plan = memoryPurge(f.db, request);
      assert.ok(plan.unresolvedCandidates.some((row) => row.code === "TARGET_NOT_FOUND"));
      assert.throws(() => apply(memoryPurge, f.db, request, plan), /unresolved/);
    }
  } finally { f.cleanup(); }
});
