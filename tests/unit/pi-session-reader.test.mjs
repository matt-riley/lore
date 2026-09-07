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

test("bounded Pi header uses explicit environment identity and rejects relative sources", async () => {
  const { readPiSessionHeader } = await import("../../pi-session-reader.mjs");
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-pi-header-"));
  const previous = process.env.LORE_REPOSITORY;
  try {
    const file = path.join(home, "t.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session", id: "fixture", cwd: home }) + "\n");
    process.env.LORE_REPOSITORY = "explicit/repository";
    assert.equal((await readPiSessionHeader(file)).repository, "explicit/repository");
    await assert.rejects(readPiSessionHeader("relative.jsonl"), /absolute/);
  } finally {
    if (previous === undefined) delete process.env.LORE_REPOSITORY;
    else process.env.LORE_REPOSITORY = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("archived Pi headers can ignore the active workspace environment identity", async () => {
  const { readPiSessionHeader } = await import("../../pi-session-reader.mjs");
  const home = mkdtempSync(path.join(os.tmpdir(), "lore-pi-header-"));
  const previous = process.env.LORE_REPOSITORY;
  try {
    const file = path.join(home, "t.jsonl");
    writeFileSync(file, JSON.stringify({ type: "session", id: "archived", cwd: home }) + "\n");
    process.env.LORE_REPOSITORY = "active/repository";
    assert.equal((await readPiSessionHeader(file, { repository: "archived/repository", useEnvironmentRepository: false })).repository, "archived/repository");
  } finally {
    if (previous === undefined) delete process.env.LORE_REPOSITORY;
    else process.env.LORE_REPOSITORY = previous;
    rmSync(home, { recursive: true, force: true });
  }
});
