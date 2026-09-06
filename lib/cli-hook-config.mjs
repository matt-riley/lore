import { LORE_CLIENT_HOOKS } from "./capability-manifest.mjs";

export const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

export function buildCliHookConfig(client, { nodePath, entryPath }) {
  if (!Object.hasOwn(LORE_CLIENT_HOOKS, client)) throw new Error("Client must be codex, claude, or antigravity");
  const events = Object.fromEntries(LORE_CLIENT_HOOKS[client].map((event) => {
    const handler = {
      type: "command",
      command: `${shellQuote(nodePath)} ${shellQuote(entryPath)} hook ${client} ${event}`,
      timeout: event === "SessionEnd" && client === "codex" ? 3 : 10,
    };
    return [event, client === "antigravity" && event !== "PostToolUse"
      ? [handler] : [{ hooks: [handler] }]];
  }));
  return client === "antigravity" ? { lore: events } : { hooks: events };
}

export function mergeCliHookConfig(existing, fragment, client, { remove = false } = {}) {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) throw new Error("Existing hook config must be an object");
  const result = structuredClone(existing);
  if (client === "antigravity") {
    if (result.lore && JSON.stringify(result.lore) !== JSON.stringify(fragment.lore)) {
      throw new Error("An unrelated or modified 'lore' hook group already exists; review it before replacing");
    }
    if (remove) delete result.lore;
    else result.lore = fragment.lore;
    return result;
  }
  if (result.hooks !== undefined && (!result.hooks || typeof result.hooks !== "object" || Array.isArray(result.hooks))) {
    throw new Error("Existing hooks must be an object");
  }
  result.hooks ??= {};
  for (const [event, groups] of Object.entries(fragment.hooks)) {
    const command = groups[0].hooks[0].command;
    const current = result.hooks[event] ?? [];
    if (!Array.isArray(current) || current.some((group) => !Array.isArray(group.hooks))) throw new Error(`Invalid hook groups for ${event}`);
    result.hooks[event] = current.map((group) => ({ ...group, hooks: group.hooks.filter((hook) => hook.command !== command) }))
      .filter((group) => group.hooks.length);
    if (!remove) result.hooks[event].push(...groups);
    if (!result.hooks[event].length) delete result.hooks[event];
  }
  return result;
}
