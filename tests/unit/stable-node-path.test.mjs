import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { resolveStableNodePath, detectVersionManager, detectPinnedVersionManager } from "../../lib/clients/stable-node-path.mjs";

function fakeFs({ executable = new Set(), files = {}, dirs = {} } = {}) {
  return {
    accessSync(candidate) {
      if (!executable.has(candidate)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    constants: { X_OK: 1 },
    readFileSync(target) {
      if (!(target in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[target];
    },
    readdirSync(target) {
      if (!(target in dirs)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return dirs[target];
    },
  };
}

const okVersion = () => 24;
const oldVersion = () => 18;

test("LORE_NODE override wins over everything else", () => {
  const execPath = "/home/u/.local/share/mise/installs/node/26.8.2/bin/node";
  const result = resolveStableNodePath({ execPath, env: { LORE_NODE: " /custom/node " }, fs: fakeFs() });
  assert.deepEqual(result, { path: "/custom/node", source: "LORE_NODE override", versionManager: null, pinned: false });
});

test("a plain, non-version-managed node path is used as-is", () => {
  const result = resolveStableNodePath({ execPath: "/usr/local/bin/node", env: {}, fs: fakeFs() });
  assert.deepEqual(result, { path: "/usr/local/bin/node", source: "current node binary", versionManager: null, pinned: false });
});

test("detectVersionManager recognizes each manager's pinned path shape", () => {
  assert.equal(detectVersionManager("/h/.local/share/mise/installs/node/26.8.2/bin/node"), "mise");
  assert.equal(detectVersionManager("/h/.asdf/installs/nodejs/22.9.0/bin/node"), "asdf");
  assert.equal(detectVersionManager("/h/.local/share/fnm/node-versions/v22.9.0/installation/bin/node"), "fnm");
  assert.equal(detectVersionManager("/h/.volta/tools/image/node/22.9.0/bin/node"), "volta");
  assert.equal(detectVersionManager("/h/.nvm/versions/node/v22.9.0/bin/node"), "nvm");
  assert.equal(detectVersionManager("/usr/bin/node"), null);
});

test("mise: prefers the major-version symlink when it exists and is new enough", () => {
  const execPath = "/home/u/.local/share/mise/installs/node/26.8.2/bin/node";
  const majorPath = "/home/u/.local/share/mise/installs/node/26/bin/node";
  const fs = fakeFs({ executable: new Set([majorPath]) });
  const result = resolveStableNodePath({ execPath, env: {}, fs, getMajorVersion: okVersion });
  assert.equal(result.path, majorPath);
  assert.equal(result.source, "mise node@26 symlink");
  assert.equal(result.versionManager, "mise");
  assert.equal(result.pinned, false);
});

test("mise: falls back to the latest symlink when the major symlink is missing", () => {
  const execPath = "/home/u/.local/share/mise/installs/node/26.8.2/bin/node";
  const latestPath = "/home/u/.local/share/mise/installs/node/latest/bin/node";
  const fs = fakeFs({ executable: new Set([latestPath]) });
  const result = resolveStableNodePath({ execPath, env: {}, fs, getMajorVersion: okVersion });
  assert.equal(result.path, latestPath);
  assert.equal(result.source, "mise node@latest symlink");
});

test("mise: falls back to the shim when no install-dir symlink exists", () => {
  const execPath = "/home/u/.local/share/mise/installs/node/26.8.2/bin/node";
  const shimPath = "/home/u/.local/share/mise/shims/node";
  const fs = fakeFs({ executable: new Set([shimPath]) });
  const result = resolveStableNodePath({ execPath, env: {}, fs, getMajorVersion: okVersion });
  assert.equal(result.path, shimPath);
  assert.equal(result.source, "mise shim");
});

test("mise: falls back to execPath, flagged pinned, when nothing stable exists", () => {
  const execPath = "/home/u/.local/share/mise/installs/node/26.8.2/bin/node";
  const result = resolveStableNodePath({ execPath, env: {}, fs: fakeFs(), getMajorVersion: okVersion });
  assert.deepEqual(result, {
    path: execPath,
    source: "mise-managed install (no stable alternative found)",
    versionManager: "mise",
    pinned: true,
  });
});

test("mise: skips a stable candidate that is too old and falls back to execPath", () => {
  const execPath = "/home/u/.local/share/mise/installs/node/26.8.2/bin/node";
  const majorPath = "/home/u/.local/share/mise/installs/node/26/bin/node";
  const fs = fakeFs({ executable: new Set([majorPath]) });
  const result = resolveStableNodePath({ execPath, env: {}, fs, getMajorVersion: oldVersion });
  assert.equal(result.path, execPath);
  assert.equal(result.pinned, true);
});

test("asdf: prefers the shim", () => {
  const execPath = "/home/u/.asdf/installs/nodejs/22.9.0/bin/node";
  const shimPath = "/home/u/.asdf/shims/node";
  const fs = fakeFs({ executable: new Set([shimPath]) });
  const result = resolveStableNodePath({ execPath, env: {}, fs, getMajorVersion: okVersion });
  assert.equal(result.path, shimPath);
  assert.equal(result.versionManager, "asdf");
});

test("fnm: prefers the default alias", () => {
  const execPath = "/home/u/.local/share/fnm/node-versions/v22.9.0/installation/bin/node";
  const aliasPath = "/home/u/.local/share/fnm/aliases/default/installation/bin/node";
  const fs = fakeFs({ executable: new Set([aliasPath]) });
  const result = resolveStableNodePath({ execPath, env: {}, fs, getMajorVersion: okVersion });
  assert.equal(result.path, aliasPath);
  assert.equal(result.versionManager, "fnm");
});

test("volta: prefers the volta shim binary", () => {
  const execPath = "/home/u/.volta/tools/image/node/22.9.0/bin/node";
  const shimPath = "/home/u/.volta/bin/node";
  const fs = fakeFs({ executable: new Set([shimPath]) });
  const result = resolveStableNodePath({ execPath, env: {}, fs, getMajorVersion: okVersion });
  assert.equal(result.path, shimPath);
  assert.equal(result.versionManager, "volta");
});

test("nvm: does not resolve the default selector to a prunable version directory", () => {
  const execPath = "/home/u/.nvm/versions/node/v22.9.0/bin/node";
  const aliasFile = "/home/u/.nvm/alias/default";
  const versionsDir = "/home/u/.nvm/versions/node";
  const resolvedPath = path.join(versionsDir, "v20.18.1", "bin", "node");
  const fs = fakeFs({
    executable: new Set([resolvedPath]),
    files: { [aliasFile]: "20\n" },
    dirs: { [versionsDir]: ["v20.18.1", "v22.9.0"] },
  });
  const result = resolveStableNodePath({ execPath, env: {}, fs, getMajorVersion: okVersion });
  assert.equal(result.path, execPath);
  assert.equal(result.versionManager, "nvm");
  assert.equal(result.pinned, true);
});

test("nvm: gives up cleanly when there is no default alias", () => {
  const execPath = "/home/u/.nvm/versions/node/v22.9.0/bin/node";
  const fs = fakeFs();
  const result = resolveStableNodePath({ execPath, env: {}, fs, getMajorVersion: okVersion });
  assert.equal(result.path, execPath);
  assert.equal(result.pinned, true);
});

test("detectPinnedVersionManager treats mise floating aliases as stable", () => {
  const root = path.join("/home/u", ".local", "share", "mise", "installs", "node");
  for (const alias of ["26", "latest", "lts-iron"]) {
    assert.equal(detectPinnedVersionManager(path.join(root, alias, "bin", "node")), null, alias);
  }
  assert.equal(detectPinnedVersionManager(path.join(root, "26.8.2", "bin", "node")), "mise");
  assert.equal(detectPinnedVersionManager("/usr/local/bin/node"), null);
});
