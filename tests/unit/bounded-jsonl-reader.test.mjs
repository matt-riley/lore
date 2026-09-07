import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, appendFile, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readJsonlDelta } from "../../lib/clients/bounded-jsonl-reader.mjs";

async function fixture(callback) {
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-jsonl-delta-"));
  const file = path.join(home, "transcript.jsonl");
  try { await callback(file); } finally { await rm(home, { recursive: true, force: true }); }
}

test("bounded reads resume complete records across UTF-8 and JSON boundaries", async () => {
  await fixture(async (file) => {
    const records = [{ text: "hello 🥝" }, { text: "second record" }];
    await writeFile(file, records.map(JSON.stringify).join("\n") + "\n");
    let checkpoint = null;
    const output = [];
    do {
      const result = await readJsonlDelta(file, { checkpoint, maxBytes: 7 });
      assert.ok(result.bytesRead <= 7);
      output.push(...result.records.map((row) => row.value));
      checkpoint = result.checkpoint;
    } while (checkpoint.pendingBytes > 0);
    assert.deepEqual(output, records);
    assert.equal(checkpoint.partialRecord, "");
    assert.deepEqual((await readJsonlDelta(file, { checkpoint })).records, []);
  });
});

test("unfinished trailing records stay buffered until a later newline", async () => {
  await fixture(async (file) => {
    await writeFile(file, '{"text":"unfinished');
    const first = await readJsonlDelta(file);
    assert.equal(first.records.length, 0);
    assert.ok(first.checkpoint.partialRecord);
    await appendFile(file, '"}\n');
    const second = await readJsonlDelta(file, { checkpoint: first.checkpoint });
    assert.deepEqual(second.records.map((row) => row.value), [{ text: "unfinished" }]);
    assert.equal(second.records[0].offset, 0);
  });
});

test("oversized and malformed records are diagnosed without blocking later records", async () => {
  await fixture(async (file) => {
    await writeFile(file, 'x'.repeat(180) + '\n{bad}\n{"ok":true}\n');
    let checkpoint = null;
    const output = [], codes = [];
    do {
      const result = await readJsonlDelta(file, { checkpoint, maxBytes: 24, maxRecordBytes: 32 });
      output.push(...result.records.map((row) => row.value));
      codes.push(...result.diagnostics.map((row) => row.code));
      checkpoint = result.checkpoint;
      assert.ok(Buffer.from(checkpoint.partialRecord, "base64").length <= 32);
    } while (checkpoint.pendingBytes > 0);
    assert.deepEqual(output, [{ ok: true }]);
    assert.equal(codes.filter((code) => code === "record_too_large").length, 1);
    assert.ok(codes.includes("malformed_record"));
  });
});

test("truncation and same-size rewrites reset source generation", async () => {
  await fixture(async (file) => {
    await writeFile(file, '{"a":1}\n');
    const first = await readJsonlDelta(file);
    await writeFile(file, '{"a":2}\n');
    const s = await stat(file);
    await utimes(file, s.atime, new Date(s.mtimeMs + 1000));
    const rewritten = await readJsonlDelta(file, { checkpoint: first.checkpoint });
    assert.equal(rewritten.reset, true);
    assert.notEqual(rewritten.checkpoint.generation, first.checkpoint.generation);
    assert.deepEqual(rewritten.records.map((row) => row.value), [{ a: 2 }]);
    await writeFile(file, '{}\n');
    const truncated = await readJsonlDelta(file, { checkpoint: rewritten.checkpoint });
    assert.equal(truncated.reset, true);
    assert.deepEqual(truncated.records.map((row) => row.value), [{}]);
  });
});
