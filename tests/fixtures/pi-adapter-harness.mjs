import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sourcePath = path.join(root, "lore-pi.ts");
const fixturePath = path.join(root, "tests", "fixtures", "pi-transport-server.mjs");
const tempDir = mkdtempSync(path.join(os.tmpdir(), "lore-pi-adapter-"));
const adapterPath = path.join(tempDir, "lore-pi.ts");
const clientUrl = pathToFileURL(path.join(root, "lib", "clients", "pi-server-client.mjs")).href;
const configUrl = pathToFileURL(path.join(root, "lib", "core", "config.mjs")).href;
const source = readFileSync(sourcePath, "utf8")
  .replaceAll(/from "(\.\/lib\/[^"]+)"/g, (_match, rel) => `from "${pathToFileURL(path.join(root, rel)).href}"`)
  .replace('import("./lib/core/config.mjs")', `import("${configUrl}")`)
  .replace(
    'const serverPath = fileURLToPath(new URL("./lore-server.mjs", import.meta.url));',
    `const serverPath = ${JSON.stringify(fixturePath)};`,
  );
writeFileSync(adapterPath, source);

const { default: registerLore } = await import(pathToFileURL(adapterPath));
const handlers = new Map();
const tools = new Map();
const pi = {
  on(name, handler) {
    handlers.set(name, handler);
  },
  registerCommand() {},
  registerTool(definition) {
    tools.set(definition.name, definition);
  },
};
registerLore(pi);

const ctx = {
  cwd: root,
  hasUI: false,
  sessionManager: {
    getSessionId: () => "adapter-lifecycle",
    getSessionFile: () => undefined,
  },
  ui: { notify() {} },
};

assert.equal(handlers.has("session_start"), true);
assert.equal(handlers.has("before_agent_start"), true);

// Two simultaneous hooks must share one initialization handshake.
await Promise.all([
  handlers.get("session_start")({}, ctx),
  handlers.get("session_start")({}, ctx),
]);

// The first fixture exits on its first non-status request. This hook must
// observe the dead client and initialize a fresh child before recalling.
await handlers.get("before_agent_start")({ prompt: "remember the adapter lifecycle" }, ctx);
await new Promise((resolve) => setTimeout(resolve, 50));
await handlers.get("before_agent_start")({ prompt: "remember the adapter lifecycle" }, ctx);
const recoveredRecall = await tools.get("lore_recall").execute(
  "test-call",
  { prompt: "unmatched typed lookup" },
  undefined,
  undefined,
  ctx,
);
assert.match(recoveredRecall?.content?.[0]?.text ?? "", /tool:lore_recall/);
await handlers.get("session_shutdown")({}, ctx);

console.log(JSON.stringify({ ok: true }));
rmSync(tempDir, { recursive: true, force: true });
