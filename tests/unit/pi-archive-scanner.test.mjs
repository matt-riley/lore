import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { PiArchiveScanner, parseBackfillSettings } from "../../lib/pi-archive-scanner.mjs";

function session(id) {
  return `${JSON.stringify({ type: "session", id, cwd: "/tmp/project", timestamp: "2026-01-01T00:00:00.000Z" })}\n`;
}

test("archive scanning inspects at most the configured number of entries per batch", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lore-pi-archive-"));
  try {
    mkdirSync(path.join(root, "nested"));
    for (let i = 0; i < 8; i += 1) {
      writeFileSync(path.join(root, "nested", `session-${i}.jsonl`), session(`session-${i}`));
    }
    const scanner = new PiArchiveScanner({
      rootDir: root,
      scanCap: 2,
      minAgeMs: 0,
      maxFileBytes: 1024,
    });
    const batch = await scanner.scan({ maxCandidates: 8 });
    assert.ok(batch.scanned <= 2, `expected <=2 inspected entries, got ${batch.scanned}`);
    assert.equal(batch.exhausted, false);
    await scanner.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default scanner keeps progress in memory without writing a cursor sidecar", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lore-pi-archive-"));
  const parentCursor = path.join(path.dirname(root), ".lore-archive-cursor.json");
  const before = existsSync(parentCursor) ? readFileSync(parentCursor, "utf8") : null;
  try {
    writeFileSync(path.join(root, "session.jsonl"), session("memory-only"));
    const scanner = new PiArchiveScanner({ rootDir: root, scanCap: 1, minAgeMs: 0, maxFileBytes: 1024 });
    await scanner.scan({ maxCandidates: 1 });
    await scanner.close();
    const after = existsSync(parentCursor) ? readFileSync(parentCursor, "utf8") : null;
    assert.equal(after, before);
    assert.equal(existsSync(path.join(root, ".lore-archive-cursor.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("incremental scanning reaches valid sessions after skipped entries consume earlier caps", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lore-pi-archive-"));
  try {
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(path.join(root, `00-invalid-${i}.jsonl`), "not json\n");
    }
    const validPath = path.join(root, "99-valid.jsonl");
    writeFileSync(validPath, session("valid-session"));
    const scanner = new PiArchiveScanner({
      rootDir: root,
      scanCap: 2,
      minAgeMs: 0,
      maxFileBytes: 1024,
    });
    const seen = [];
    for (let i = 0; i < 5 && seen.length === 0; i += 1) {
      const result = await scanner.scan({ maxCandidates: 1 });
      seen.push(...result.candidates.map((candidate) => candidate.sessionId));
    }
    assert.deepEqual(seen, ["valid-session"]);
    await scanner.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persists scan progress for a replacement worker", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lore-pi-archive-"));
  try {
    for (let i = 0; i < 4; i += 1) {
      writeFileSync(path.join(root, `00-invalid-${i}.jsonl`), "not json\n");
    }
    writeFileSync(path.join(root, "99-valid.jsonl"), session("survives-restart"));
    const cursorPath = path.join(root, "cursor.json");
    const first = new PiArchiveScanner({ rootDir: root, cursorPath, scanCap: 2, minAgeMs: 0, maxFileBytes: 1024 });
    const firstScan = await first.scan({ maxCandidates: 1 });
    assert.equal(existsSync(cursorPath), true);
    const savedPath = JSON.parse(readFileSync(cursorPath, "utf8")).path;
    assert.ok(savedPath.startsWith(`${root}${path.sep}`));
    assert.ok(firstScan.scanned <= 2);
    await first.close();

    const replacement = new PiArchiveScanner({ rootDir: root, cursorPath, scanCap: 2, minAgeMs: 0, maxFileBytes: 1024 });
    const seen = [];
    for (let i = 0; i < 5 && seen.length === 0; i += 1) {
      const result = await replacement.scan({ maxCandidates: 1 });
      seen.push(...result.candidates.map((candidate) => candidate.sessionId));
    }
    assert.deepEqual(seen, ["survives-restart"]);
    await replacement.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("normalizes non-string header timestamps before candidate ordering", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lore-pi-archive-"));
  try {
    writeFileSync(path.join(root, "numeric.jsonl"), `${JSON.stringify({ type: "session", id: "numeric-time", cwd: "/tmp", timestamp: 1704067200000 })}\n`);
    writeFileSync(path.join(root, "object.jsonl"), `${JSON.stringify({ type: "session", id: "object-time", cwd: "/tmp", timestamp: { bad: true } })}\n`);
    // A zero minimum disables age filtering even when filesystem timestamps
    // are ahead of the clock (including sub-millisecond mtime precision).
    const scanner = new PiArchiveScanner({ rootDir: root, scanCap: 10, minAgeMs: 0, maxFileBytes: 1024, now: () => 0 });
    const result = await scanner.scan({ maxCandidates: 2 });
    assert.equal(result.candidates.length, 2);
    assert.ok(result.candidates.every((candidate) => typeof candidate.timestamp === "string"));
    await scanner.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replacement worker descends to a nested cursor after a prefix longer than the cap", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "lore-pi-archive-"));
  try {
    const nested = path.join(root, "nested", "deep");
    mkdirSync(nested, { recursive: true });
    for (let i = 0; i < 7; i += 1) {
      writeFileSync(path.join(nested, `00-invalid-${i}.jsonl`), "not json\n");
    }
    writeFileSync(path.join(nested, "99-valid.jsonl"), session("nested-survives-restart"));
    const cursorPath = path.join(path.dirname(root), `${path.basename(root)}-cursor.json`);
    const first = new PiArchiveScanner({
      rootDir: root,
      cursorPath,
      scanCap: 2,
      minAgeMs: 0,
      maxFileBytes: 1024,
    });
    await first.scan({ maxCandidates: 1 });
    await first.close();

    const replacement = new PiArchiveScanner({
      rootDir: root,
      cursorPath,
      scanCap: 2,
      minAgeMs: 0,
      maxFileBytes: 1024,
    });
    const seen = [];
    for (let i = 0; i < 12 && seen.length === 0; i += 1) {
      const result = await replacement.scan({ maxCandidates: 1 });
      seen.push(...result.candidates.map((candidate) => candidate.sessionId));
    }
    assert.deepEqual(seen, ["nested-survives-restart"]);
    await replacement.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("backfill environment values reject malformed and unsafe values", () => {
  assert.deepEqual(
    parseBackfillSettings({
      LORE_PI_BACKFILL_MAX: "nope",
      LORE_PI_BACKFILL_MIN_AGE_MS: "-1",
      LORE_PI_BACKFILL_MAX_FILE_BYTES: "Infinity",
      LORE_PI_BACKFILL_SCAN_CAP: "0",
    }),
    {
      max: 5,
      minAgeMs: 0,
      maxFileBytes: 10 * 1024 * 1024,
      scanCap: 1,
    },
  );
});
