import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRuntime, formatRuntimeDiagnostics } from "../../lib/runtime.mjs";

test("runtime accepts Node 24 with node:sqlite and FTS5", async () => {
  const result = await checkRuntime({
    version: "v24.0.0",
    loadSqlite: async () => ({
      DatabaseSync: class {
        exec(sql) {
          assert.match(sql, /fts5/iu);
        }

        close() {}
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.diagnostics, []);
});

test("runtime rejects Node versions below the supported minimum without probing SQLite", async () => {
  let probed = false;
  const result = await checkRuntime({
    version: "v23.11.1",
    loadSqlite: async () => {
      probed = true;
      throw new Error("must not probe unsupported Node");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(probed, false);
  assert.match(formatRuntimeDiagnostics(result), /Node\.js 24\.0\.0 or newer/);
});

test("runtime reports unavailable node:sqlite", async () => {
  const result = await checkRuntime({
    version: "v24.0.0",
    loadSqlite: async () => {
      throw new Error("Cannot find module 'node:sqlite'");
    },
  });

  assert.equal(result.ok, false);
  assert.match(formatRuntimeDiagnostics(result), /node:sqlite is unavailable/);
  assert.match(formatRuntimeDiagnostics(result), /Node\.js 24\.0\.0 or newer/);
});

test("runtime reports an SQLite build without FTS5", async () => {
  const result = await checkRuntime({
    version: "v24.0.0",
    loadSqlite: async () => ({
      DatabaseSync: class {
        exec() {
          throw new Error("no such module: fts5");
        }

        close() {}
      },
    }),
  });

  assert.equal(result.ok, false);
  assert.match(formatRuntimeDiagnostics(result), /FTS5 is unavailable/);
});
