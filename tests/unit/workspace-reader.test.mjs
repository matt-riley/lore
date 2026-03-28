/**
 * tests/unit/workspace-reader.test.mjs
 *
 * Unit tests for lib/workspace-reader.mjs.
 *
 * Covers:
 *   - resolveWorkspacePath: with/without an explicit path, with/without
 *     copilotHome override, fallback to os.homedir()/.copilot
 *   - readWorkspaceContext: no workspace.yaml → null, minimal key:value yaml
 *     parsed correctly, multi-colon values preserved, blank lines/comments
 *     skipped gracefully.
 *
 * Run:
 *   node --test tests/unit/workspace-reader.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

import {
  resolveWorkspacePath,
  readWorkspaceContext,
} from "../../lib/workspace-reader.mjs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "lore-wsr-test-"));
}

// ---------------------------------------------------------------------------
// resolveWorkspacePath
// ---------------------------------------------------------------------------

describe("resolveWorkspacePath — explicit path provided", () => {
  test("returns the supplied path unchanged", () => {
    const result = resolveWorkspacePath("/explicit/path", "sess-abc", "/some/home");
    assert.strictEqual(result, "/explicit/path");
  });

  test("returns the supplied path even when copilotHome is undefined", () => {
    const result = resolveWorkspacePath("/explicit/path", "sess-abc", undefined);
    assert.strictEqual(result, "/explicit/path");
  });
});

describe("resolveWorkspacePath — no explicit path, copilotHome provided", () => {
  test("constructs session-state path under copilotHome", () => {
    const result = resolveWorkspacePath("", "sess-123", "/custom/home");
    assert.strictEqual(result, path.join("/custom/home", "session-state", "sess-123"));
  });

  test("null workspacePath also falls back to copilotHome", () => {
    const result = resolveWorkspacePath(null, "sess-456", "/custom/home");
    assert.strictEqual(result, path.join("/custom/home", "session-state", "sess-456"));
  });

  test("undefined workspacePath also falls back to copilotHome", () => {
    const result = resolveWorkspacePath(undefined, "sess-789", "/custom/home");
    assert.strictEqual(result, path.join("/custom/home", "session-state", "sess-789"));
  });
});

describe("resolveWorkspacePath — no explicit path, no copilotHome", () => {
  test("falls back to os.homedir()/.copilot/session-state/<sessionId>", () => {
    const expected = path.join(os.homedir(), ".copilot", "session-state", "sess-fallback");
    const result = resolveWorkspacePath("", "sess-fallback", undefined);
    assert.strictEqual(result, expected);
  });

  test("null copilotHome also uses homedir fallback", () => {
    const expected = path.join(os.homedir(), ".copilot", "session-state", "sess-null");
    const result = resolveWorkspacePath(null, "sess-null", null);
    assert.strictEqual(result, expected);
  });
});

// ---------------------------------------------------------------------------
// readWorkspaceContext
// ---------------------------------------------------------------------------

describe("readWorkspaceContext — no workspace.yaml", () => {
  test("returns null workspace when workspace.yaml does not exist", async () => {
    const dir = makeTempDir();
    try {
      const { workspace } = await readWorkspaceContext(dir);
      assert.strictEqual(workspace, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("readWorkspaceContext — with workspace.yaml", () => {
  test("parses simple key:value pairs", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        path.join(dir, "workspace.yaml"),
        "repository: owner/repo\nbranch: main\n",
        "utf8",
      );
      const { workspace } = await readWorkspaceContext(dir);
      assert.ok(workspace !== null, "workspace should not be null");
      assert.strictEqual(workspace.repository, "owner/repo");
      assert.strictEqual(workspace.branch, "main");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves values that contain colons", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        path.join(dir, "workspace.yaml"),
        "url: https://github.com/owner/repo\n",
        "utf8",
      );
      const { workspace } = await readWorkspaceContext(dir);
      assert.strictEqual(workspace.url, "https://github.com/owner/repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("skips lines without a colon", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        path.join(dir, "workspace.yaml"),
        "---\nrepository: owner/repo\n",
        "utf8",
      );
      const { workspace } = await readWorkspaceContext(dir);
      // "---" line has no colon → ignored; should not appear in result
      assert.ok(!("---" in workspace), "'---' should not be a key");
      assert.strictEqual(workspace.repository, "owner/repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("handles empty workspace.yaml as null workspace", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(path.join(dir, "workspace.yaml"), "", "utf8");
      const { workspace } = await readWorkspaceContext(dir);
      // Empty content → no lines parsed → falsy result treated as null
      assert.strictEqual(workspace, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("trims whitespace around keys and values", async () => {
    const dir = makeTempDir();
    try {
      writeFileSync(
        path.join(dir, "workspace.yaml"),
        "  repository  :   owner/repo  \n",
        "utf8",
      );
      const { workspace } = await readWorkspaceContext(dir);
      assert.strictEqual(workspace.repository, "owner/repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("works inside a nested sub-directory", async () => {
    const dir = makeTempDir();
    const sub = path.join(dir, "session-state", "sess-xyz");
    mkdirSync(sub, { recursive: true });
    try {
      writeFileSync(
        path.join(sub, "workspace.yaml"),
        "repository: acme/api\n",
        "utf8",
      );
      const { workspace } = await readWorkspaceContext(sub);
      assert.strictEqual(workspace.repository, "acme/api");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
