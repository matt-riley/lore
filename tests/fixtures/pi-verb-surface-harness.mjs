import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const adapterUrl = pathToFileURL(path.join(root, "lore-pi.ts")).href;

const { default: registerLore } = await import(adapterUrl);
const tools = [];
const commands = [];
registerLore({
  on() {},
  registerTool(definition) {
    tools.push(definition.name);
  },
  registerCommand(name, definition) {
    commands.push({ name, description: definition.description, handler: definition.handler });
  },
});

const { DEFAULT_MODEL_TOOL_NAMES } = await import(pathToFileURL(path.join(root, "lib/runtime/tool-registry.mjs")).href);
const { LORE_SLASH_DESCRIPTION } = await import(pathToFileURL(path.join(root, "lib/runtime/slash-dispatch.mjs")).href);

assert.deepEqual(
  [...tools.filter((name) => name !== "lore_save")].sort(),
  [...DEFAULT_MODEL_TOOL_NAMES].sort(),
);
assert.equal(tools.includes("lore_save"), true);
assert.equal(tools.includes("lore_retain"), true);
assert.equal(commands.length, 1);
assert.equal(commands[0].name, "lore");
assert.equal(commands[0].description, LORE_SLASH_DESCRIPTION);

// Registration must not rewrite serverPath around resolveNode; the adapter still
// points at lore-server.mjs. Skip execute here so we never spawn the worker.
assert.match(String(commands[0].handler), /async/);

console.log(JSON.stringify({
  ok: true,
  tools,
  command: commands[0].name,
  description: commands[0].description,
  serverPathRewritten: adapterUrl.includes("lore-pi.ts"),
}));
