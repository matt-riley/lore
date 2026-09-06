import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { readPiSessionFile } from "../../pi-session-reader.mjs";

test("resolves relative file tool paths against the session cwd", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-pi-reader-"));
  const sessionPath = path.join(home, "session.jsonl");
  const sessionCwd = path.join(home, "project");
  try {
    writeFileSync(
      sessionPath,
      [
        JSON.stringify({ type: "session", id: "session-relative-path", cwd: sessionCwd, timestamp: "2026-01-01T00:00:00.000Z" }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-01-01T00:00:01.000Z",
          message: { role: "user", content: "Update the config" },
        }),
        JSON.stringify({
          type: "message",
          timestamp: "2026-01-01T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", name: "edit", arguments: { path: "config/settings.json" } }],
          },
        }),
      ].join("\n") + "\n",
    );

    const parsed = readPiSessionFile(sessionPath, { repository: "example/project" });
    assert.deepEqual(parsed.sessionArtifacts.files.map((file) => file.file_path), [
      path.join(sessionCwd, "config/settings.json"),
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
