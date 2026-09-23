import { normalizeAdministrationRequest } from "../memory/memory-administration.mjs";
import { resolveLoreToolName } from "../capabilities/capability-manifest.mjs";

const ADMINISTRATION_OPERATIONS = Object.freeze({
  lore_correct: "correct",
  lore_repair: "repair",
  lore_purge: "purge",
});

// Non-administration operations that never write to storage. lore_validate is
// deliberately excluded: it persists an improvement-backlog artifact when a
// case fails, so it needs a writable store like lore_status and the rest.
const READ_ONLY_OPERATIONS = Object.freeze(new Set([
  "lore_explain",
]));

/**
 * Classify an invocation without opening storage: administration previews must
 * open read-only, and invalid administration requests must fail before a store
 * can be created or migrated. Throws on invalid administration arguments.
 */
export function classifyOperation(name, args = {}) {
  const resolved = resolveLoreToolName(name) ?? name;
  const operation = ADMINISTRATION_OPERATIONS[resolved];
  if (!operation) {
    return { resolved, administration: false, readOnly: READ_ONLY_OPERATIONS.has(resolved) };
  }
  const request = normalizeAdministrationRequest({ ...args, operation });
  return { resolved, administration: true, readOnly: request.action === "preview" };
}

/**
 * The single validated operation dispatch path. Canonicalizes the requested
 * name through the manifest aliases, resolves exactly one registered tool, and
 * reports a structured outcome instead of throwing. Every surface (human CLI,
 * protocol `lore tool`, `/lore` slash, Pi worker, host adapters) maps this
 * outcome to its own transport contract rather than re-implementing lookup,
 * argument validation, or error handling.
 */
export async function dispatchOperation({
  tools,
  name,
  args = {},
  invocation = {},
  unavailable = null,
}) {
  const resolved = resolveLoreToolName(name) ?? name;
  if (unavailable) {
    return { ok: false, code: "unavailable", resolved, error: unavailable };
  }
  const tool = tools.find((candidate) => candidate.name === name)
    ?? tools.find((candidate) => candidate.name === resolved);
  if (!tool) {
    return { ok: false, code: "unknown_tool", resolved, error: `unknown tool ${name}` };
  }
  try {
    const text = await tool.handler(args ?? {}, invocation);
    return { ok: true, resolved, text };
  } catch (error) {
    return {
      ok: false,
      code: "tool_error",
      resolved,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Compatibility adapter for surfaces that return strings and throw on tool
 * errors (session.dispatchTool, the Pi worker's `tool` method): unknown tools
 * keep the historical "lore unavailable: unknown tool …" text, unavailable
 * sessions return the pre-formatted unavailability message, and handler
 * failures surface as real errors for the protocol error channel.
 */
export function requireDispatchOutcome(result, { name = null } = {}) {
  if (result.ok) {
    return result.text;
  }
  if (result.code === "unknown_tool") {
    return `lore unavailable: unknown tool ${name ?? result.resolved}`;
  }
  if (result.code === "unavailable") {
    return result.error;
  }
  throw new Error(result.error);
}
