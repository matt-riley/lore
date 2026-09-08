import {
  getLoreCapabilitySpec,
  resolveLoreToolName,
} from "../capabilities/capability-manifest.mjs";

const LORE_SLASH_PROMPT_PATTERN = /^\/lore\b/u;

export const LORE_SLASH_DESCRIPTION = "Lore memory: status | recall | retain | forget | search | explain | validate | correct | onboard | doctor | …";

export const LORE_SLASH_ADVERTISEMENT = "You can also run Lore via /lore <tool> (for example /lore doctor or /lore retain --type decision \"…\"). Extra model tools remain registered until the Copilot /lore TUI gate.";

export const LORE_SLASH_USAGE = "usage: /lore <verb> [args] — status | recall | retain | forget | search | explain | validate | correct <memoryId> | onboard | doctor | … (repair/purge/admin need --json)";

const POSITIONAL_ARG_BY_TOOL = Object.freeze({
  lore_forget: "id",
  lore_recall: "prompt",
  lore_search: "query",
  lore_explain: "prompt",
  lore_retain: "content",
  lore_reflect: "prompt",
  lore_onboard: "userName",
  lore_correct: "memoryId",
});

const JSON_REQUIRED_TOOLS = new Set([
  "lore_repair",
  "lore_purge",
  "lore_backfill",
  "memory_scope_override",
  "memory_portable_bundle",
  "memory_evolution_ledger",
  "memory_capability_inventory",
  "memory_review_gate",
  "memory_deferred_process",
  "memory_replay",
  "memory_skill_validate",
  "memory_intent_journal",
  "memory_improvement_backlog",
  "lore_maintenance",
]);

const VERB_ALIASES = Object.freeze({
  save: "lore_retain",
  doctor: "lore_doctor",
});

const SLASH_DEDUP_MS = 5000;
const recentSlashDispatches = new Map();

export function matchLoreSlashPrompt(prompt) {
  const text = String(prompt ?? "").trim();
  if (!LORE_SLASH_PROMPT_PATTERN.test(text)) {
    return null;
  }
  return text.replace(LORE_SLASH_PROMPT_PATTERN, "").trim();
}

export function tokenizeLoreArgv(input) {
  if (Array.isArray(input)) {
    return input.map((part) => String(part));
  }
  const text = String(input ?? "");
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;
  for (const char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) {
    return { error: "lore: unterminated quote in arguments" };
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function kebabToCamel(value) {
  return String(value).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

function unwrapQuoted(value) {
  const text = String(value ?? "").trim();
  if (
    text.length >= 2
    && ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith("\"") && text.endsWith("\"")))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function jsonLooksLikeObject(value) {
  const text = String(value ?? "").trim();
  return text.startsWith("{") || text.startsWith("[");
}

function extractJsonFlagFromTokens(tokens) {
  const index = tokens.findIndex((token) => token === "--json" || token.startsWith("--json="));
  if (index === -1) {
    return { tokens, jsonRaw: undefined };
  }
  let jsonRaw;
  let removeCount;
  if (tokens[index].startsWith("--json=")) {
    jsonRaw = unwrapQuoted(tokens[index].slice("--json=".length));
    removeCount = 1;
  } else if (tokens[index + 1] === undefined) {
    jsonRaw = undefined;
    removeCount = 1;
  } else {
    jsonRaw = unwrapQuoted(tokens[index + 1]);
    removeCount = 2;
  }
  // Quoted retain/recall text can contain the substring " --json "; only treat
  // a following {…}/{[…]} token as a payload so positional content is not stolen.
  if (!jsonLooksLikeObject(jsonRaw)) {
    return { tokens, jsonRaw: undefined };
  }
  const next = tokens.slice();
  next.splice(index, removeCount);
  return { tokens: next, jsonRaw };
}

function extractJsonFlag(input) {
  const tokenized = tokenizeLoreArgv(input);
  if (!Array.isArray(tokenized)) {
    return { tokens: tokenized, jsonRaw: undefined };
  }
  return extractJsonFlagFromTokens(tokenized);
}

export function loreSlashPromptHookOutput() {
  return {
    modifiedPrompt: "",
    suppressOutput: true,
  };
}

export function resetLoreSlashDispatchClaims() {
  recentSlashDispatches.clear();
}

function claimLoreSlashDispatch(sessionId, argsText) {
  const key = `${String(sessionId ?? "")}\0${String(argsText ?? "").trim()}`;
  const now = Date.now();
  for (const [entry, at] of recentSlashDispatches) {
    if (now - at > SLASH_DEDUP_MS) {
      recentSlashDispatches.delete(entry);
    }
  }
  const previous = recentSlashDispatches.get(key);
  if (previous !== undefined && now - previous < SLASH_DEDUP_MS) {
    return false;
  }
  recentSlashDispatches.set(key, now);
  return true;
}

function resolveSlashVerb(token) {
  const trimmed = String(token ?? "").trim().replace(/^\//u, "");
  if (!trimmed) {
    return null;
  }
  if (VERB_ALIASES[trimmed]) {
    return VERB_ALIASES[trimmed];
  }
  return resolveLoreToolName(trimmed)
    ?? resolveLoreToolName(`lore_${trimmed}`)
    ?? resolveLoreToolName(`memory_${trimmed}`)
    ?? null;
}

function coerceFlagValue(raw, schema) {
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  if (type === "boolean") {
    if (raw === true || raw === false) {
      return raw;
    }
    if (raw === undefined || raw === null || raw === "") {
      return true;
    }
    const text = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) {
      return true;
    }
    if (["0", "false", "no", "off"].includes(text)) {
      return false;
    }
    return true;
  }
  if (type === "number" || type === "integer") {
    const numeric = Number(raw);
    return Number.isFinite(numeric) ? numeric : raw;
  }
  if (type === "array") {
    if (Array.isArray(raw)) {
      return raw;
    }
    return String(raw)
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  return raw;
}

function lookupPropertySchema(properties, key) {
  if (Object.hasOwn(properties, key)) {
    return { name: key, schema: properties[key] };
  }
  const camel = kebabToCamel(key);
  if (Object.hasOwn(properties, camel)) {
    return { name: camel, schema: properties[camel] };
  }
  return null;
}

function assignPositionalArgs(args, positional, spec) {
  if (positional.length === 0) {
    return args;
  }
  const field = POSITIONAL_ARG_BY_TOOL[spec?.name]
    ?? (spec?.parameters?.required ?? []).find((name) => {
      const schema = spec?.parameters?.properties?.[name];
      const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
      return type === "string" && args[name] === undefined;
    });
  if (!field || args[field] !== undefined) {
    return args;
  }
  return { ...args, [field]: positional.join(" ") };
}

export function parseLoreArgv(input) {
  const extracted = extractJsonFlag(input);
  if (!Array.isArray(extracted.tokens)) {
    return extracted.tokens;
  }
  const tokens = [...extracted.tokens];
  let jsonRaw = extracted.jsonRaw;
  if (tokens[0] === "lore" || tokens[0] === "/lore") {
    tokens.shift();
  }
  if (tokens.length === 0 || tokens[0] === "help" || tokens[0] === "--help" || tokens[0] === "-h") {
    return { error: LORE_SLASH_USAGE };
  }

  const verbToken = tokens.shift();
  const name = resolveSlashVerb(verbToken);
  if (!name) {
    return { error: `lore: unknown verb ${verbToken}. ${LORE_SLASH_USAGE}` };
  }

  const spec = getLoreCapabilitySpec(name);
  const properties = spec?.parameters?.properties ?? {};
  const args = {};
  const positional = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--help" || token === "-h") {
      return { error: LORE_SLASH_USAGE };
    }
    if (token === "--json" || token.startsWith("--json=")) {
      positional.push(token);
      if (token === "--json" && tokens[index + 1] !== undefined && !String(tokens[index + 1]).startsWith("--")) {
        positional.push(tokens[index + 1]);
        index += 1;
      }
      continue;
    }
    if (token.startsWith("--")) {
      const inlineIndex = token.indexOf("=");
      const rawKey = inlineIndex === -1 ? token.slice(2) : token.slice(2, inlineIndex);
      const negated = rawKey.startsWith("no-") ? rawKey.slice(3) : null;
      const lookup = lookupPropertySchema(properties, negated ?? rawKey);
      if (!lookup) {
        return { error: `lore: unknown flag --${rawKey}. ${LORE_SLASH_USAGE}` };
      }
      if (negated) {
        args[lookup.name] = false;
        continue;
      }
      let value = inlineIndex === -1 ? undefined : token.slice(inlineIndex + 1);
      const type = Array.isArray(lookup.schema?.type) ? lookup.schema.type[0] : lookup.schema?.type;
      if (value === undefined && type !== "boolean") {
        value = tokens[++index];
        if (value === undefined || String(value).startsWith("--")) {
          return { error: `lore: flag --${rawKey} requires a value` };
        }
      }
      args[lookup.name] = coerceFlagValue(value, lookup.schema);
      continue;
    }
    positional.push(token);
  }

  if (JSON_REQUIRED_TOOLS.has(name) && jsonRaw === undefined) {
    return { error: `lore: ${verbToken} requires --json '<object>'` };
  }

  if (jsonRaw !== undefined) {
    let parsedJson;
    try {
      parsedJson = JSON.parse(jsonRaw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { error: `lore: invalid --json: ${message}` };
    }
    if (!parsedJson || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
      return { error: "lore: --json must be a JSON object" };
    }
    Object.assign(args, parsedJson);
  } else {
    Object.assign(args, assignPositionalArgs(args, positional, spec));
  }

  return { name, args, verb: verbToken };
}

export async function dispatchSlash(argsText, dispatchTool, extra = {}) {
  const parsed = parseLoreArgv(argsText);
  if (parsed.error) {
    return parsed.error;
  }
  if (typeof dispatchTool !== "function") {
    return "lore unavailable: dispatchTool is required";
  }
  try {
    return await dispatchTool(parsed.name, parsed.args, {
      ...extra,
      surface: extra.surface ?? "slash",
    });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function buildLoreSlashCommand({ dispatchSlash: dispatch, log } = {}) {
  return {
    name: "lore",
    description: LORE_SLASH_DESCRIPTION,
    handler: async ({ args, sessionId } = {}) => {
      const argsText = String(args ?? "");
      if (!claimLoreSlashDispatch(sessionId, argsText)) {
        return "";
      }
      const text = typeof dispatch === "function"
        ? await dispatch(argsText, { sessionId, surface: "slash" })
        : "lore unavailable: not initialized";
      if (typeof log === "function") {
        await log(text, { ephemeral: true });
      }
      return text;
    },
  };
}

export async function interceptLoreSlashPrompt({
  prompt,
  dispatchSlash: dispatch,
  sessionId,
  log,
} = {}) {
  const argsText = matchLoreSlashPrompt(prompt);
  if (argsText === null) {
    return null;
  }
  const claimed = claimLoreSlashDispatch(sessionId, argsText);
  let text = "";
  if (claimed) {
    text = typeof dispatch === "function"
      ? await dispatch(argsText, { sessionId, surface: "slash" })
      : "lore unavailable: not initialized";
    if (typeof log === "function") {
      await log(text, { ephemeral: true });
    }
  }
  return {
    handled: true,
    dispatched: claimed,
    text,
    hookOutput: loreSlashPromptHookOutput(),
  };
}
