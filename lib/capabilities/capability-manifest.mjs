/**
 * Canonical Lore capability manifest.
 *
 * Single source of truth for Lore tool metadata used by runtime registration,
 * capability inventory, and docs parity checks (including support-matrix
 * lifecycle/category/notes/rollout governance details). Each spec owns the
 * canonical name, aliases, JSON Schema parameters, and surfaces.model|cli|slash
 * flags. Runtime registration attaches handlers here; the capability inventory
 * barrel and scanner modules read route hints directly from this module.
 *
 * Canonical verbs are lore_*. memory_* and Pi lore_save are aliases for one
 * deprecation cycle on CLI, /lore, and lore tool JSON — not extra default
 * model-list entries after the Copilot shrink (PR 4).
 *
 * To add or rename a Lore tool, update LORE_CAPABILITY_SPECS here first, then
 * attach the handler in lib/tools/memory-tools-builders.mjs.
 */

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export const LORE_CLIENT_HOOKS = Object.freeze({
  codex: Object.freeze(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "PreCompact", "PostToolUse"]),
  claude: Object.freeze(["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd", "PreCompact", "PostToolUse", "PostToolUseFailure"]),
  antigravity: Object.freeze(["PreInvocation", "PostInvocation", "Stop", "PostToolUse"]),
});

const LORE_CLI_CANONICAL_TOOL_NAMES = Object.freeze([
  "lore_recall",
  "lore_retain",
  "lore_onboard",
  "lore_search",
  "lore_forget",
  "lore_status",
  "lore_correct",
  "lore_repair",
  "lore_purge",
]);

const CAPABILITY_SPECS = [
  {
    name: "lore_status",
    aliases: ["memory_status"],
    description: "Show lore extension status, counts, repo scope, hook latency measurements, and optional recent trace-recorder output.",
    routeKindHints: ["direct"],
    surfaces: {
      model: true,
      cli: true,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        includeRecentTraces: {
          type: "boolean",
          description: "When true, append recent bounded trace-recorder entries",
        },
        recentTraceLimit: {
          type: "number",
          description: "Maximum recent trace entries to render when includeRecentTraces is true",
        },
        includeRecentTrajectoryArtifacts: {
          type: "boolean",
          description: "When true, append recent sampled durable trajectory artifacts",
        },
        recentTrajectoryLimit: {
          type: "number",
          description: "Maximum recent trajectory artifacts to render when includeRecentTrajectoryArtifacts is true",
        },
      },
    },
    support: {
      status: "supported",
      category: "Status and diagnostics",
      notes: "Overview of DB health, row counts, latency metrics, and maintenance state. CLI / `lore tool` aliases for one deprecation cycle: `memory_status`.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_intent_journal",
    aliases: [],
    description: "Write or inspect durable intent-journal entries for routing/rollout/reviewer/fallback choices and lightweight serendipity capture.",
    routeKindHints: [],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "record"],
          description: "List recent entries or record a new entry",
        },
        kind: {
          type: "string",
          enum: ["journal", "routing", "rollout", "reviewer", "fallback", "serendipity"],
          description: "Intent kind for record/list filtering",
        },
        summary: {
          type: "string",
          description: "Short decision/discovery summary for record",
        },
        rationale: {
          type: "string",
          description: "Optional rationale for the decision or discovery",
        },
        turnHint: {
          type: "string",
          description: "Optional free-form turn marker such as 'after-memory_replay'",
        },
        sessionId: {
          type: "string",
          description: "Optional session id override for record/list",
        },
        context: {
          type: "object",
          description: "Optional structured metadata for record",
        },
        repository: {
          type: "string",
          description: "Optional repository override for record/list",
        },
        limit: {
          type: "number",
          description: "Maximum rows to return for list",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Improvement and evolution",
      notes: "Reads the intent and trajectory journal for recent sessions.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_portable_bundle",
    aliases: [],
    description: "Export a local, review-gated portability bundle for approved improvement artifacts, as a signed JSON file or an Open Knowledge Format (OKF v0.1) markdown bundle.",
    routeKindHints: [],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["export", "import"],
          description: "Export a portable bundle, or import (format=okf only) an OKF bundle directory into semantic memory",
        },
        repository: {
          type: "string",
          description: "Optional repository override",
        },
        bundlePath: {
          type: "string",
          description: "Optional repository-relative or absolute path for reading/writing bundles. For format=okf this is a directory root; for format=json (default) this is a single file path. Required for action=import.",
        },
        limit: {
          type: "number",
          description: "Maximum records to export/import per dataset",
        },
        format: {
          type: "string",
          enum: ["json", "okf"],
          description: "Bundle output format. \"json\" (default) writes a single signed JSON file. \"okf\" writes an Open Knowledge Format v0.1 markdown+frontmatter bundle directory (one concept file per artifact plus an index.md) for human/agent-readable, git-diffable exchange. action=import currently supports format=okf only.",
        },
        confidence: {
          type: "number",
          description: "Optional confidence override for action=import (default 0.7 -- lower than self-authored memory_save's 0.9, since imported content is externally sourced)",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Replay and portability",
      notes: "Exports a portable bundle of approved improvement artifacts, not a raw database dump. format=json (default) writes a single signed JSON file; format=okf writes an OKF v0.1 markdown+frontmatter bundle directory for human/agent-readable, git-diffable exchange. action=import (format=okf only) reads an OKF bundle directory from disk and retains each concept as a `type=okf_concept` semantic memory row, retrievable via `memory_search(query=\"okf_import\", type=\"okf_concept\")` — imported content defaults to a lower confidence (0.7) than self-authored memory and is always manually invoked, never automatic. Re-importing the same bundle reinforces existing rows (by a stable `repository::conceptId` canonical key) instead of duplicating them, but stored content is not overwritten by a later import — the first import's content wins. json format import is not yet implemented.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_maintenance",
    aliases: ["maintenance_schedule_run"],
    description: "Dry-run, run, inspect, or roll back bounded local maintenance, including automated memory hygiene.",
    routeKindHints: [],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "run", "rollback_hygiene"],
          description: "Show scheduler status, run a maintenance sweep, or roll back one automated hygiene marker",
        },
        dryRun: {
          type: "boolean",
          description: "When true, preview the sweep without mutating maintenance state",
        },
        force: {
          type: "boolean",
          description: "Ignore per-task cadence and force currently enabled tasks to be due",
        },
        includeRecentRuns: {
          type: "boolean",
          description: "When true, include recent maintenance runs in the report",
        },
        tasks: {
          type: "array",
          items: {
            type: "string",
            enum: ["memoryHygiene", "deferredExtraction", "validationCorpus", "replayCorpus", "backlogReview", "traceCompaction", "indexUpkeep", "doctorSnapshot"],
          },
          description: "Optional subset of maintenance tasks to evaluate or run",
        },
        marker: {
          type: "string",
          description: "Exact auto-hygiene marker required for rollback_hygiene",
        },
        actor: {
          type: "string",
          description: "Operator identity recorded in a hygiene rollback audit",
        },
        reason: {
          type: "string",
          description: "Human-readable reason recorded in a hygiene rollback audit",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Maintenance",
      notes: "Triggers a maintenance sweep (dry-run or live), reports automated memory hygiene, or rolls back one exact `auto-hygiene:*` marker with an audit artifact. Alias: `maintenance_schedule_run`.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_improvement_backlog",
    aliases: [],
    description: "Inspect or update durable session/diagnostics/replay/signal improvement artifacts with provenance.",
    routeKindHints: [],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "resolve", "supersede"],
          description: "List artifacts or update artifact lifecycle state",
        },
        id: {
          type: "string",
          description: "Artifact id for resolve or supersede",
        },
        supersededBy: {
          type: "string",
          description: "Required for supersede action",
        },
        sourceKind: {
          type: "string",
          enum: ["session", "validation", "replay", "signal"],
          description: "Optional source kind filter for list",
        },
        sourceCaseId: {
          type: "string",
          description: "Optional source case id filter for list",
        },
        status: {
          type: "string",
          enum: ["active", "resolved", "superseded"],
          description: "Optional status filter for list",
        },
        limit: {
          type: "number",
          description: "Maximum items to return",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Improvement and evolution",
      notes: "Lists accumulated improvement artifacts and their status. Requires `evolutionLedger` rollout flag.",
      rolloutFlags: ["evolutionLedger"],
    },
  },
  {
    name: "memory_evolution_ledger",
    aliases: [],
    description: "Summarize the review-gated evolution ledger, capture router/maintenance signals, generate proposal artifacts, or verify generated-artifact integrity.",
    routeKindHints: [],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["summary", "capture_signal", "generate_proposals", "verify_integrity"],
          description: "Inspect the ledger, capture a manual signal, generate proposals, or verify generated proposal artifacts",
        },
        limit: {
          type: "number",
          description: "Maximum items to inspect or generate",
        },
        ids: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional backlog ids to target for proposal generation",
        },
        force: {
          type: "boolean",
          description: "When true, allow proposal generation to overwrite existing generated proposal artifacts",
        },
        dryRun: {
          type: "boolean",
          description: "When true, preview proposal or integrity work without writing files or DB updates",
        },
        repair: {
          type: "boolean",
          description: "When true, repair generated proposal artifacts that fail integrity verification",
        },
        sourceCaseId: {
          type: "string",
          description: "Optional explicit source case id for capture_signal",
        },
        signalType: {
          type: "string",
          enum: ["router", "maintenance", "trace"],
          description: "Signal family when capturing a manual ledger entry",
        },
        title: {
          type: "string",
          description: "Signal title for capture_signal",
        },
        summary: {
          type: "string",
          description: "Signal summary for capture_signal",
        },
        linkedMemoryId: {
          type: "string",
          description: "Optional related semantic memory id for capture_signal",
        },
        evidence: {
          type: "object",
          description: "Optional provenance/evidence object for capture_signal",
        },
        trace: {
          type: "object",
          description: "Optional trace metadata object for capture_signal",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Improvement and evolution",
      notes: "Reads and writes the evolution ledger of memory-quality improvement goals. Requires `evolutionLedger` rollout flag.",
      rolloutFlags: ["evolutionLedger"],
    },
  },
  {
    name: "memory_capability_inventory",
    aliases: [],
    description: "Scan local skills, agents, and extension/lore tool surfaces, then inspect the manifest or run the local-first router core in recommendation-only mode.",
    routeKindHints: [],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["summary", "recommend", "route", "evaluate", "json"],
          description: "Show the local inventory, run the recommendation-only router core, evaluate the router corpus, or return raw JSON",
        },
        prompt: {
          type: "string",
          description: "Prompt to score through the local-first router core when action is recommend or route",
        },
        caseIds: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional router evaluation case IDs to run when action is evaluate",
        },
        detailLevel: {
          type: "string",
          enum: ["summary", "full"],
          description: "How much inventory detail to render for summary mode",
        },
        limit: {
          type: "number",
          description: "Maximum route candidates or capabilities to show",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Self-diagnostics and proposals",
      notes: "Enumerates all registered capabilities with rollout state.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_recall",
    aliases: [],
    description: "Recall prompt-time lore context through the explicit memory-operations boundary, including workstream overlays when relevant.",
    routeKindHints: ["retrieval"],
    surfaces: {
      model: true,
      cli: true,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Prompt or question to recall context for",
        },
        includeOtherRepositories: {
          type: "boolean",
          description: "When true, allow transferable cross-repository fallback where applicable",
        },
        limit: {
          type: "number",
          description: "Optional result budget",
        },
        includeTrace: {
          type: "boolean",
          description: "When true, include a compact lookup summary",
        },
        detailLevel: {
          type: "string",
          enum: ["context", "evidence", "full"],
          description: "How much supporting retrieval evidence to render",
        },
      },
      required: ["prompt"],
    },
    support: {
      status: "supported",
      category: "Core memory verbs",
      notes: "Primary recall verb. Returns matched memories with provenance. Optional local query expansion changes retrieval terms only and retries deterministic retrieval when expansion finds no evidence. When `localInference.embeddings` is configured, appends embedding-ranked `Semantic Matches` (cosine similarity) cached in `memory_embedding`; fails open to lexical-only on endpoint errors.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_onboard",
    aliases: [],
    description: "Capture the user's preferred name and Lore's assistant/style profile in one step.",
    routeKindHints: [],
    surfaces: {
      model: true,
      cli: true,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        userName: {
          type: "string",
          description: "The user's preferred name. Optional when Lore already knows it.",
        },
        assistantName: {
          type: "string",
          description: "Optional assistant self-name override; omitted means Lore chooses one during onboarding",
        },
        voice: {
          type: "string",
          enum: ["colleague", "collaborative", "friendly"],
          description: "Preferred assistant voice",
        },
        warmth: {
          type: "string",
          enum: ["warm", "balanced"],
          description: "Preferred assistant warmth",
        },
        humor: {
          type: "string",
          enum: ["light", "none"],
          description: "Whether Lore should use humor by default",
        },
        humorFrequency: {
          type: "string",
          enum: ["frequent", "occasional", "never"],
          description: "How often humor is welcome when humor is enabled",
        },
        collaborative: {
          type: "boolean",
          description: "Whether Lore should default to a collaborative teammate posture",
        },
        useNameNaturally: {
          type: "boolean",
          description: "Whether Lore should use the user's preferred name naturally when helpful",
        },
      },
    },
    support: {
      status: "supported",
      category: "Core memory verbs",
      notes: "Captures the user name plus Lore's assistant/style profile in one step.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_retain",
    aliases: ["lore_save", "memory_save"],
    description: "Retain a semantic memory or structured workstream overlay through the explicit memory-operations boundary.",
    routeKindHints: [],
    surfaces: {
      model: true,
      cli: true,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["semantic", "workstream"],
          description: "Whether to save a normal semantic memory or a workstream overlay",
        },
        type: {
          type: "string",
          description: "Semantic memory type when kind is semantic",
        },
        content: {
          type: "string",
          description: "Semantic memory content when kind is semantic",
        },
        repository: {
          type: "string",
          description: "Optional repository override",
        },
        scope: {
          type: "string",
          enum: ["global", "transferable", "repo"],
          description: "Optional explicit scope override",
        },
        confidence: {
          type: "number",
          description: "Optional confidence score",
        },
        tags: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional semantic memory tags",
        },
        domainKey: {
          type: "string",
          description: "Optional memory domain key for the retained semantic memory",
        },
        domainKind: {
          type: "string",
          enum: ["assistant", "user", "repo", "workstream", "person", "topic", "custom"],
          description: "Optional domain kind when creating/updating a domain alongside retain",
        },
        domainTitle: {
          type: "string",
          description: "Optional domain title when creating/updating a domain alongside retain",
        },
        domainMission: {
          type: "string",
          description: "Optional domain mission when creating/updating a domain alongside retain",
        },
        domainDirectives: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional domain directives when creating/updating a domain alongside retain",
        },
        metadata: {
          type: "object",
          description: "Optional semantic memory metadata object",
        },
        workstreamId: {
          type: "string",
          description: "Stable identifier for the workstream overlay",
        },
        title: {
          type: "string",
          description: "Workstream title",
        },
        mission: {
          type: "string",
          description: "Workstream mission",
        },
        objective: {
          type: "string",
          description: "Current objective",
        },
        status: {
          type: "string",
          enum: ["active", "blocked", "paused", "done"],
          description: "Workstream status",
        },
        constraints: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Active workstream constraints",
        },
        blockers: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Current blockers",
        },
        nextActions: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Next actions",
        },
        decisions: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Retained high-salience decisions",
        },
        retainPriorities: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Extraction steering priorities",
        },
        reflectPriorities: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Synthesis steering priorities",
        },
      },
    },
    support: {
      status: "supported",
      category: "Core memory verbs",
      notes: "Primary retain verb. Persists a memory with scope, category, and optional domain association. CLI / `lore tool` aliases for one deprecation cycle: `lore_save`, `memory_save`.",
      rolloutFlags: ["memoryDomains"],
    },
  },
  {
    name: "lore_reflect",
    aliases: [],
    description: "Synthesize patterns, blockers, decisions, or next actions from richer recall evidence and active workstream overlays.",
    routeKindHints: ["retrieval"],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Question or reflection prompt to analyze",
        },
        focus: {
          type: "string",
          enum: ["summary", "patterns", "blockers", "decisions", "next_actions"],
          description: "Optional reflection focus override",
        },
        includeOtherRepositories: {
          type: "boolean",
          description: "When true, allow transferable cross-repository fallback where applicable",
        },
        limit: {
          type: "number",
          description: "Optional result budget",
        },
        lookbackHours: {
          type: "number",
          description: "Optional explicit time window (in hours) to directly pull real session activity from across repositories, bypassing free-text date detection. E.g. 24 for \"last day\".",
        },
        detailLevel: {
          type: "string",
          enum: ["summary", "evidence", "full"],
          description: "How much supporting reflection evidence to render",
        },
        persistObservation: {
          type: "boolean",
          description: "When true, save the reflection result as a refreshable observation",
        },
        observationKey: {
          type: "string",
          description: "Optional stable key for the saved observation",
        },
        domainKey: {
          type: "string",
          description: "Optional memory domain key for a saved observation",
        },
        freshnessHours: {
          type: "number",
          description: "Optional freshness window for a saved observation",
        },
        useLocalInference: {
          type: "boolean",
          description: "Override the configured default for synthesis with the local inference provider",
        },
      },
      required: ["prompt"],
    },
    support: {
      status: "experimental",
      category: "Synthesis and reflection",
      notes: "Synthesised reflection over recent memory clusters. Optional persisted observations are supported via `refreshableObservations`. Local model synthesis is default-off but supports persistent config plus per-call overrides, advisory consolidation/contradiction/trend findings, optional quality evaluation, and embedding-grounded claims.",
      rolloutFlags: ["refreshableObservations"],
    },
  },
  {
    name: "lore_search",
    aliases: ["memory_search"],
    description: "Search semantic and episodic memory. Global memories are always eligible; repository isolation for non-global items is preserved unless includeOtherRepositories is true.",
    routeKindHints: ["retrieval"],
    surfaces: {
      model: true,
      cli: true,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query",
        },
        type: {
          type: "string",
          description: "Optional semantic memory type filter",
        },
        limit: {
          type: "number",
          description: "Optional result limit",
        },
        includeOtherRepositories: {
          type: "boolean",
          description: "When true, search beyond the current repository scope",
        },
      },
      required: ["query"],
    },
    support: {
      status: "supported",
      category: "Core memory verbs",
      notes: "Keyword search over the derived semantic-memory store. Meaning-based (vector) search is available via `lore_recall` when embeddings are configured. CLI / `lore tool` aliases for one deprecation cycle: `memory_search`.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_explain",
    aliases: ["memory_explain"],
    description: "Explain why lore would return specific context for a prompt, including matched rows, eligible scopes, and filtered/suppressed branches.",
    routeKindHints: ["retrieval"],
    surfaces: {
      model: true,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Prompt to explain",
        },
        mode: {
          type: "string",
          description: "Explain prompt-time retrieval or the session-start capsule",
          enum: ["prompt", "session_start"],
        },
      },
      required: ["prompt"],
    },
    support: {
      status: "supported",
      category: "Status and diagnostics",
      notes: "Explains what context would be injected for a given prompt and why. Copilot alias for one deprecation cycle: `memory_explain`.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_validate",
    aliases: ["memory_validate"],
    description: "Run the built-in lore validation set and report pass/fail assertions plus current latency metrics.",
    routeKindHints: ["direct"],
    surfaces: {
      model: true,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        caseIds: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional subset of validation case IDs to run",
        },
        verbose: {
          type: "boolean",
          description: "When true, show all assertions instead of only failed ones",
        },
      },
    },
    support: {
      status: "supported",
      category: "Status and diagnostics",
      notes: "Validates DB integrity and schema parity. Copilot alias for one deprecation cycle: `memory_validate`.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_replay",
    aliases: [],
    description: "Run the broader lore replay corpus, including must-pass invariants and ranking targets, and show which expected evidence ranked in or missed.",
    routeKindHints: ["direct"],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        caseIds: {
          type: "array",
          items: {
            type: "string",
          },
          description: "Optional subset of replay case IDs to run",
        },
        verbose: {
          type: "boolean",
          description: "When true, show all replay cases with evidence samples and lookup sources",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Replay and portability",
      notes: "Runs the replay corpus against current retrieval behavior and reports ranking hits/misses.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_scope_override",
    aliases: [],
    description: "Preview or apply manual scope overrides for semantic memory or episode digests. Manual overrides win until explicitly cleared.",
    routeKindHints: [],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        targetType: {
          type: "string",
          enum: ["semantic", "episode"],
          description: "Which memory table to modify",
        },
        ids: {
          type: "array",
          items: {
            type: "string",
          },
          description: "One or more target row ids from memory_search output",
        },
        action: {
          type: "string",
          enum: ["set", "clear"],
          description: "Set a manual scope override or clear it back to auto classification",
        },
        scope: {
          type: "string",
          enum: ["global", "transferable", "repo"],
          description: "Required when action is set",
        },
        repository: {
          type: "string",
          description: "Optional repository fallback when assigning a non-global scope to a global row",
        },
        dryRun: {
          type: "boolean",
          description: "When true, preview the scope change without writing",
        },
        actor: {
          type: "string",
          description: "Optional actor label for audit history",
        },
        reason: {
          type: "string",
          description: "Reason for the override or clear action",
        },
        source: {
          type: "string",
          description: "Optional audit source label",
        },
      },
      required: ["targetType", "ids"],
    },
    support: {
      status: "experimental",
      category: "Scope control",
      notes: "Override the active memory scope for a session. Interface may evolve.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_scope_audit",
    aliases: [],
    description: "Show scope override audit history for semantic memory or episode digests.",
    routeKindHints: [],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        targetType: {
          type: "string",
          enum: ["semantic", "episode"],
          description: "Optional audit filter by target type",
        },
        targetId: {
          type: "string",
          description: "Optional specific row id to inspect",
        },
        limit: {
          type: "number",
          description: "Maximum audit rows to show",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Scope control",
      notes: "Audit scope decisions across recent retrieval events.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_forget",
    aliases: ["memory_forget"],
    description: "Mark a semantic memory item as superseded.",
    routeKindHints: [],
    surfaces: {
      model: true,
      cli: true,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Semantic memory id",
        },
        supersededBy: {
          type: "string",
          description: "Optional replacement id or note",
        },
      },
      required: ["id"],
    },
    support: {
      status: "supported",
      category: "Core memory verbs",
      notes: "Soft-deletes a memory by ID. Superseded rows and related residual data may remain for provenance and recovery; this is not secure erasure. CLI / `lore tool` aliases for one deprecation cycle: `memory_forget`.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_correct",
    aliases: ["memory_correct"],
    description: "Preview or explicitly correct one semantic memory with a manual replacement and correction provenance.",
    routeKindHints: ["direct"],
    surfaces: {
      model: true,
      cli: true,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["preview", "apply"],
        },
        memoryId: {
          type: "string",
        },
        content: {
          type: "string",
        },
        type: {
          type: "string",
        },
        scope: {
          type: "string",
          enum: ["global", "transferable", "repo"],
        },
        repository: {
          type: ["string", "null"],
        },
        reason: {
          type: "string",
        },
        expiresAt: {
          type: ["string", "null"],
        },
        planFingerprint: {
          type: "string",
        },
      },
      required: ["memoryId"],
    },
    support: {
      status: "supported",
      category: "Memory administration",
      notes: "Defaults to a read-only preview. Repository selects the manual replacement destination. Apply requires planFingerprint, preserves expiry unless changed, and creates a validated snapshot. CLI / `lore tool` aliases for one deprecation cycle: `memory_correct`.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_repair",
    aliases: ["memory_repair"],
    description: "Preview or apply explicit repair of derived memory provenance, repository identity mappings, and unresolved candidates.",
    routeKindHints: ["direct"],
    surfaces: {
      model: false,
      cli: true,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["preview", "apply"],
        },
        memoryIds: {
          type: "array",
          items: {
            type: "string",
          },
        },
        sessionIds: {
          type: "array",
          items: {
            type: "string",
          },
        },
        repository: {
          type: "string",
        },
        repositoryMappings: {
          type: "array",
          items: {
            type: "object",
          },
        },
        selectedCandidateIds: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 200,
          uniqueItems: true,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
        },
        planFingerprint: {
          type: "string",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Memory administration",
      notes: "Deterministic complete-source repair, bounded to 32 MiB per source and the preview candidate limit. Missing, incomplete, or ambiguous sources remain unresolved. Apply requires planFingerprint and actionable selectedCandidateIds. CLI / `lore tool` aliases for one deprecation cycle: `memory_repair`.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_purge",
    aliases: ["memory_purge"],
    description: "Preview or explicitly purge selected derived memory records while retaining raw sources, backups, snapshots, and non-plaintext suppression.",
    routeKindHints: ["direct"],
    surfaces: {
      model: false,
      cli: true,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["preview", "apply"],
        },
        memoryIds: {
          type: "array",
          items: {
            type: "string",
          },
        },
        repository: {
          type: "string",
        },
        scope: {
          type: "string",
          enum: ["global"],
        },
        includeDependentAggregates: {
          type: "boolean",
        },
        selectedCandidateIds: {
          type: "array",
          items: {
            type: "string",
          },
          maxItems: 200,
          uniqueItems: true,
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
        },
        planFingerprint: {
          type: "string",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Memory administration",
      notes: "Requires explicit memoryIds, repository, or global scope selection. Shared derived copies require includeDependentAggregates and all typed preview candidate IDs. Apply validates planFingerprint and a snapshot; raw sources, backups, and suppression remain. CLI / `lore tool` aliases for one deprecation cycle: `memory_purge`.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_deferred_process",
    aliases: [],
    description: "Process queued deferred extraction jobs now, optionally across repositories.",
    routeKindHints: ["background_task"],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum queued jobs to process",
        },
        includeOtherRepositories: {
          type: "boolean",
          description: "When true, process queued jobs across repositories",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Backfill and deferred processing",
      notes: "Triggers processing of extractions deferred during session-start. Optional local model enrichment is default-off, requires provider plus deferred-extraction opt-in, and preserves deterministic extraction on failure.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_backfill",
    aliases: ["memory_backfill"],
    description: "Backfill recent sessions from the raw session store into episodic memory. Supports legacy one-shot mode and controlled resumable runs with dry-run, snapshot, and restore.",
    routeKindHints: ["background_task"],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["legacy", "controlled"],
          description: "Legacy one-shot mode or controlled resumable mode",
        },
        action: {
          type: "string",
          enum: ["preview", "start", "resume", "status", "restore"],
          description: "Controlled-mode action",
        },
        limit: {
          type: "number",
          description: "Maximum recent sessions to inspect",
        },
        batchSize: {
          type: "number",
          description: "Maximum items to process per controlled batch",
        },
        includeOtherRepositories: {
          type: "boolean",
          description: "When true, backfill across repositories rather than current repo only",
        },
        refreshExisting: {
          type: "boolean",
          description: "When true, reprocess existing digests so improved extraction logic can refresh older summaries",
        },
        runId: {
          type: "string",
          description: "Controlled backfill run id for resume, status, or restore",
        },
        retryFailed: {
          type: "boolean",
          description: "When true, resume retries failed items as well as pending ones",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Backfill and deferred processing",
      notes: "Backfills memories from the raw session store. The public tool is bounded to 20 items per run; manual controlled runs still create restorable snapshots, while session-start archive import uses the same engine without creating snapshots. Alias: `memory_backfill`.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_doctor",
    aliases: ["memory_doctor_report"],
    description: "Run the observe-only Lore Doctor: classify incidents from maintenance task states, trajectory artifacts, latency metrics, and improvement backlog signals. Emits an additive doctor-report trajectory artifact (unless dryRun is set). No trusted-source mutation occurs.",
    routeKindHints: [],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        dryRun: {
          type: "boolean",
          description: "When true, classify incidents but do not record a trajectory artifact",
        },
        trajectoryLimit: {
          type: "number",
          description: "Maximum recent trajectory artifacts to scan (default 20, max 50)",
        },
        plannedActions: {
          type: "array",
          description: "Optional hypothetical future tool actions for observe-only safety classification",
          items: {
            type: "object",
            properties: {
              id: {
                type: "string",
              },
              toolName: {
                type: "string",
              },
              operation: {
                type: "string",
              },
              target: {
                type: "string",
              },
              mutability: {
                type: "string",
                enum: ["read_only", "append_only", "metadata_update", "destructive_write"],
              },
              reversibility: {
                type: "string",
                enum: ["reversible", "operator_reversible", "difficult", "irreversible"],
              },
              scope: {
                type: "string",
                enum: ["isolated", "repository", "workspace", "multi_workspace", "external_system"],
              },
              notes: {
                type: "string",
              },
            },
          },
        },
      },
    },
    support: {
      status: "experimental",
      category: "Self-diagnostics and proposals",
      notes: "Generates a structured health report. Requires `loreDoctor` and `evolutionLedger` rollout flags. Alias: `memory_doctor_report`.",
      rolloutFlags: ["loreDoctor", "evolutionLedger"],
    },
  },
  {
    name: "memory_review_gate",
    aliases: [],
    description: "Observe-only proposal-doc review gate. Checks the provided text for required sections (goal, acceptance, risk) using deterministic heading analysis and records an additive review_gate_report trajectory artifact. No enforcement, no blocking, no trusted-source mutation.",
    routeKindHints: [],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      required: ["text"],
      properties: {
        text: {
          type: "string",
          description: "Proposal-doc text to review",
        },
        dryRun: {
          type: "boolean",
          description: "When true, run checks but skip recording a trajectory artifact",
        },
      },
    },
    support: {
      status: "experimental",
      category: "Self-diagnostics and proposals",
      notes: "Runs an observe-only proposal-doc gate and records review-gate trajectory artifacts. Requires `reviewGate` and `evolutionLedger` rollout flags.",
      rolloutFlags: ["reviewGate", "evolutionLedger"],
    },
  },
  {
    name: "memory_skill_validate",
    aliases: [],
    description: "Scan and validate all skills in the repository. Reports any configuration issues with remediation steps.",
    routeKindHints: [],
    surfaces: {
      model: false,
      cli: false,
      slash: true,
    },
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["summary", "detailed"],
          description: "Output format: 'summary' (default) or 'detailed'",
        },
      },
    },
    support: {
      status: "supported",
      category: "Skill management and diagnostics",
      notes: "Validates SKILL.md files and frontmatter. Useful for skill authors and maintainers.",
      rolloutFlags: [],
    },
  },
];

export const LORE_CAPABILITY_SPECS = Object.freeze(CAPABILITY_SPECS.map((spec) => Object.freeze({
  ...spec,
  aliases: Object.freeze([...(spec.aliases ?? [])]),
  routeKindHints: Object.freeze([...spec.routeKindHints]),
  surfaces: Object.freeze({
    model: spec.surfaces.model === true,
    cli: LORE_CLI_CANONICAL_TOOL_NAMES.includes(spec.name),
    slash: spec.surfaces.slash === true,
  }),
  parameters: deepFreeze(structuredClone(spec.parameters)),
  support: Object.freeze({
    ...spec.support,
    rolloutFlags: Object.freeze([...spec.support.rolloutFlags]),
  }),
})));

const SPEC_BY_NAME = new Map(LORE_CAPABILITY_SPECS.map((spec) => [spec.name, spec]));
const SPEC_BY_ALIAS = new Map();
for (const spec of LORE_CAPABILITY_SPECS) {
  for (const alias of spec.aliases) {
    SPEC_BY_ALIAS.set(alias, spec);
  }
}

export function getLoreCapabilitySpec(name) {
  if (typeof name !== "string") return undefined;
  const trimmed = name.trim();
  return SPEC_BY_NAME.get(trimmed) ?? SPEC_BY_ALIAS.get(trimmed);
}

export function resolveLoreToolName(name) {
  return getLoreCapabilitySpec(name)?.name ?? null;
}

export function listCoreAliasToolNames(spec) {
  if (!spec || spec.support.status === "experimental") return [];
  return spec.aliases.filter((alias) => alias.startsWith("memory_"));
}

export const LORE_CLI_TOOL_NAMES = Object.freeze([
  ...LORE_CLI_CANONICAL_TOOL_NAMES,
  ...LORE_CLI_CANONICAL_TOOL_NAMES.flatMap((name) => getLoreCapabilitySpec(name)?.aliases ?? []),
]);
