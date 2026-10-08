// model-tools.mjs — the nine canonical host tools and their daemon mapping.
//
// The table is shared by the Pi and Copilot adapters. It contains no storage
// logic: every entry names one daemon route and how to shape its parameters.

export const MODEL_TOOL_NAMES = [
  "lore_recall",
  "lore_retain",
  "lore_onboard",
  "lore_search",
  "lore_forget",
  "lore_status",
  "lore_explain",
  "lore_validate",
  "lore_correct",
];

const str = { type: "string" };
const num = { type: "number" };

export const MODEL_TOOLS = [
  {
    name: "lore_recall",
    label: "Lore recall",
    description: "Recall relevant memories for a query before answering.",
    kind: "read",
    route: "/v2/recall",
    parameters: {
      type: "object",
      properties: {
        query: { ...str, description: "The user prompt or question to recall for." },
        repository: { ...str, description: "Optional repository override." },
        limit: { ...num, description: "Maximum memories to consider." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    buildParams: (args) => ({
      query: args.query,
      repository: args.repository,
      limit: args.limit,
      includeOtherRepositories: args.includeOtherRepositories === true,
    }),
    present: (result) => result.context ?? "",
  },
  {
    name: "lore_retain",
    label: "Lore retain",
    description: "Persist one explicit memory the user asked to keep.",
    kind: "write",
    route: "/v2/retain",
    parameters: {
      type: "object",
      properties: {
        content: { ...str, description: "The memory text to store." },
        kind: { ...str, description: "Memory kind, for example user_preference." },
        scope: { ...str, description: "global or repo." },
        repository: { ...str, description: "Repository for repo-scoped memories." },
        tags: { type: "array", items: str },
      },
      required: ["content"],
      additionalProperties: false,
    },
    buildParams: (args) => ({
      type: args.kind ?? "note",
      content: args.content,
      scope: args.scope ?? "global",
      repository: args.repository,
      confidence: args.confidence,
      tags: args.tags ?? [],
    }),
    present: (result) => `Saved memory ${result.memoryId}.`,
  },
  {
    name: "lore_onboard",
    label: "Lore onboard",
    description: "Capture the user's preferred name and assistant style profile.",
    kind: "write",
    route: "/v2/admin/onboard",
    capability: "memory.onboard",
    parameters: {
      type: "object",
      properties: {
        userName: str,
        assistantName: str,
        voice: str,
        warmth: str,
        humor: str,
        humorFrequency: str,
        collaborative: { type: "boolean" },
        useNameNaturally: { type: "boolean" },
      },
      additionalProperties: false,
    },
    buildParams: (args) => ({ ...args }),
    present: (result) => `Onboarded ${result.user ? "user" : ""}${result.assistant ? " assistant" : ""}`.trim(),
  },
  {
    name: "lore_search",
    label: "Lore search",
    description: "Browse stored memories by query with paging.",
    kind: "read",
    route: "/v2/admin/search",
    capability: "search.browse",
    parameters: {
      type: "object",
      properties: {
        query: str,
        repository: str,
        cursor: str,
        limit: num,
      },
      required: ["query"],
      additionalProperties: false,
    },
    buildParams: (args) => ({
      query: args.query,
      repository: args.repository,
      includeOtherRepositories: args.includeOtherRepositories === true,
      cursor: args.cursor,
      limit: args.limit,
    }),
    present: (result) =>
      (result.items ?? [])
        .map((item) => `- ${item.content}`)
        .join("\n") || "No memories matched.",
  },
  {
    name: "lore_forget",
    label: "Lore forget",
    description: "Forget one memory by id.",
    kind: "write",
    route: "/v2/forget",
    parameters: {
      type: "object",
      properties: {
        memoryId: str,
        reason: str,
      },
      required: ["memoryId"],
      additionalProperties: false,
    },
    buildParams: (args) => ({ memoryId: args.memoryId, reason: args.reason }),
    present: (result) => `Forgot memory ${result.memoryId ?? ""}`.trim(),
  },
  {
    name: "lore_status",
    label: "Lore status",
    description: "Report daemon readiness, counts and capabilities.",
    kind: "read",
    route: "/v2/status",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    buildParams: () => ({}),
    present: (result) =>
      `lore ${result.readiness ?? "unknown"}: ${result.counts?.activeMemories ?? 0} active memories`,
  },
  {
    name: "lore_explain",
    label: "Lore explain",
    description: "Explain which memories recall would use and why.",
    kind: "read",
    route: "/v2/admin/explain",
    capability: "explain.context",
    parameters: {
      type: "object",
      properties: {
        query: str,
        repository: str,
        contextBytes: num,
      },
      required: ["query"],
      additionalProperties: false,
    },
    buildParams: (args) => ({
      query: args.query,
      repository: args.repository,
      contextBytes: args.contextBytes,
    }),
    present: (result) =>
      `${(result.representedIds ?? []).length} memories represented; ${result.diagnostics?.length ?? 0} diagnostics`,
  },
  {
    name: "lore_validate",
    label: "Lore validate",
    description: "Run store integrity validation.",
    kind: "read",
    route: "/v2/admin/validate",
    capability: "validate.read",
    parameters: {
      type: "object",
      properties: { deep: { type: "boolean" } },
      additionalProperties: false,
    },
    buildParams: (args) => ({ deep: args.deep === true }),
    present: (result) => `Validation ${result.ok === false ? "found problems" : "passed"}.`,
  },
  {
    name: "lore_correct",
    label: "Lore correct",
    description: "Preview or apply a manual correction to one memory.",
    kind: "write",
    route: "/v2/admin/correct",
    capability: "memory.correct",
    parameters: {
      type: "object",
      properties: {
        id: str,
        content: str,
        kind: str,
        scope: str,
        repository: str,
        action: { type: "string", enum: ["preview", "apply"] },
        planFingerprint: str,
      },
      required: ["id"],
      additionalProperties: false,
    },
    buildParams: (args) => ({
      id: args.id,
      content: args.content,
      kind: args.kind,
      scope: args.scope,
      repository: args.repository,
      action: args.action ?? "preview",
      planFingerprint: args.planFingerprint,
    }),
    present: (result) =>
      result.fingerprint
        ? `Preview fingerprint ${result.fingerprint}`
        : `Replaced memory ${result.replacedId ?? ""}`.trim(),
  },
];

const BY_NAME = new Map(MODEL_TOOLS.map((tool) => [tool.name, tool]));

export function toolByName(name) {
  return BY_NAME.get(name) ?? null;
}
