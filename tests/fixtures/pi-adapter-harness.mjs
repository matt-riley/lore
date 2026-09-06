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
const clientUrl = pathToFileURL(path.join(root, "lib", "pi-server-client.mjs")).href;
const configUrl = pathToFileURL(path.join(root, "lib", "config.mjs")).href;
const source = readFileSync(sourcePath, "utf8")
  .replace('from "./lib/pi-server-client.mjs"', `from "${clientUrl}"`)
  .replace('import("./lib/config.mjs")', `import("${configUrl}")`)
  .replace(
    'const serverPath = fileURLToPath(new URL("./lore-server.mjs", import.meta.url));',
    `const serverPath = ${JSON.stringify(fixturePath)};`,
  );
writeFileSync(adapterPath, source);

const { default: registerLore } = await import(pathToFileURL(adapterPath));
const handlers = new Map();
const pi = {
  on(name, handler) {
    handlers.set(name, handler);
  },
  registerCommand() {},
  registerTool() {},
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
await handlers.get("session_shutdown")({}, ctx);

console.log(JSON.stringify({ ok: true }));
rmSync(tempDir, { recursive: true, force: true });
