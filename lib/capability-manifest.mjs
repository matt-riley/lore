/**
 * lib/capability-manifest.mjs
 *
 * Canonical Lore capability manifest.
 *
 * Single source of truth for Lore tool metadata used by runtime registration,
 * capability inventory, and docs parity checks (including support-matrix
 * lifecycle/category/notes/rollout governance details). Runtime registration
 * (lib/memory-tools.mjs) attaches parameters and handlers here; capability
 * inventory (lib/capability-inventory.mjs) reads route hints directly from this
 * module instead of parsing source text.
 *
 * To add or rename a Lore tool, update LORE_CAPABILITY_SPECS here first, then
 * attach the handler in lib/memory-tools.mjs.
 */

const CAPABILITY_SPECS = [
  {
    name: "memory_status",
    description: "Show lore extension status, counts, repo scope, hook latency measurements, and optional recent trace-recorder output.",
    routeKindHints: ["direct"],
    support: {
      status: "supported",
      category: "Status and diagnostics",
      notes: "Overview of DB health, row counts, latency metrics, and maintenance state.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_intent_journal",
    description: "Write or inspect durable intent-journal entries for routing/rollout/reviewer/fallback choices and lightweight serendipity capture.",
    routeKindHints: [],
    support: {
      status: "experimental",
      category: "Improvement and evolution",
      notes: "Reads the intent and trajectory journal for recent sessions.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_portable_bundle",
    description: "Export a local, signed, review-gated portability bundle for approved improvement artifacts.",
    routeKindHints: [],
    support: {
      status: "experimental",
      category: "Replay and portability",
      notes: "Exports a portable bundle of memories and improvement artifacts. Import not yet implemented.",
      rolloutFlags: [],
    },
  },
  {
    name: "maintenance_schedule_run",
    description: "Dry-run, run, or inspect the bounded local maintenance scheduler that reuses deferred extraction, validation, replay, and trace-aware upkeep helpers.",
    routeKindHints: [],
    support: {
      status: "experimental",
      category: "Maintenance",
      notes: "Triggers a maintenance sweep (dry-run or live). Designed for scripted/scheduled use.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_improvement_backlog",
    description: "Inspect or update durable session/diagnostics/replay/signal improvement artifacts with provenance.",
    routeKindHints: [],
    support: {
      status: "experimental",
      category: "Improvement and evolution",
      notes: "Lists accumulated improvement artifacts and their status. Requires `evolutionLedger` rollout flag.",
      rolloutFlags: ["evolutionLedger"],
    },
  },
  {
    name: "memory_evolution_ledger",
    description: "Summarize the review-gated evolution ledger, capture router/maintenance signals, generate proposal artifacts, or verify generated-artifact integrity.",
    routeKindHints: [],
    support: {
      status: "experimental",
      category: "Improvement and evolution",
      notes: "Reads and writes the evolution ledger of memory-quality improvement goals. Requires `evolutionLedger` rollout flag.",
      rolloutFlags: ["evolutionLedger"],
    },
  },
  {
    name: "memory_capability_inventory",
    description: "Scan local skills, agents, and extension/lore tool surfaces, then inspect the manifest or run the local-first router core in recommendation-only mode.",
    routeKindHints: [],
    support: {
      status: "experimental",
      category: "Self-diagnostics and proposals",
      notes: "Enumerates all registered capabilities with rollout state.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_recall",
    description: "Recall prompt-time lore context through the explicit memory-operations boundary, including workstream overlays when relevant.",
    routeKindHints: ["retrieval"],
    support: {
      status: "supported",
      category: "Core memory verbs",
      notes: "Primary recall verb. Returns matched memories with provenance.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_onboard",
    description: "Capture the user's preferred name and Lore's assistant/style profile in one step.",
    routeKindHints: [],
    support: {
      status: "supported",
      category: "Core memory verbs",
      notes: "Captures the user name plus Lore's assistant/style profile in one step.",
      rolloutFlags: [],
    },
  },
  {
    name: "lore_retain",
    description: "Retain a semantic memory or structured workstream overlay through the explicit memory-operations boundary.",
    routeKindHints: [],
    support: {
      status: "supported",
      category: "Core memory verbs",
      notes: "Primary retain verb. Persists a memory with scope and category. Domain association is experimental behind `memoryDomains`.",
      rolloutFlags: ["memoryDomains"],
    },
  },
  {
    name: "lore_reflect",
    description: "Synthesize patterns, blockers, decisions, or next actions from richer recall evidence and active workstream overlays.",
    routeKindHints: ["retrieval"],
    support: {
      status: "experimental",
      category: "Synthesis and reflection",
      notes: "Synthesised reflection over recent memory clusters. Optional persisted observations require `refreshableObservations`.",
      rolloutFlags: ["refreshableObservations"],
    },
  },
  {
    name: "memory_search",
    description: "Search semantic and episodic memory. Global memories are always eligible; repository isolation for non-global items is preserved unless includeOtherRepositories is true.",
    routeKindHints: ["retrieval"],
    support: {
      status: "supported",
      category: "Core memory verbs",
      notes: "Keyword + semantic search across the derived store.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_explain",
    description: "Explain why lore would return specific context for a prompt, including matched rows, eligible scopes, and filtered/suppressed branches.",
    routeKindHints: ["retrieval"],
    support: {
      status: "supported",
      category: "Status and diagnostics",
      notes: "Explains what context would be injected for a given prompt and why.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_validate",
    description: "Run the built-in lore validation set and report pass/fail assertions plus current latency metrics.",
    routeKindHints: ["direct"],
    support: {
      status: "supported",
      category: "Status and diagnostics",
      notes: "Validates DB integrity and schema parity.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_replay",
    description: "Run the broader lore replay corpus, including must-pass invariants and ranking targets, and show which expected evidence ranked in or missed.",
    routeKindHints: ["direct"],
    support: {
      status: "experimental",
      category: "Replay and portability",
      notes: "Runs the replay corpus against current retrieval behavior and reports ranking hits/misses.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_scope_override",
    description: "Preview or apply manual scope overrides for semantic memory or episode digests. Manual overrides win until explicitly cleared.",
    routeKindHints: [],
    support: {
      status: "experimental",
      category: "Scope control",
      notes: "Override the active memory scope for a session. Interface may evolve.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_scope_audit",
    description: "Show scope override audit history for semantic memory or episode digests.",
    routeKindHints: [],
    support: {
      status: "experimental",
      category: "Scope control",
      notes: "Audit scope decisions across recent retrieval events.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_save",
    description: "Save a semantic memory item into lore.db. Omit repository to save globally, or provide an explicit scope override.",
    routeKindHints: [],
    support: {
      status: "supported",
      category: "Core memory verbs",
      notes: "Explicit save for freeform notes and decisions.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_forget",
    description: "Mark a semantic memory item as superseded.",
    routeKindHints: [],
    support: {
      status: "supported",
      category: "Core memory verbs",
      notes: "Soft-deletes a memory by ID.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_deferred_process",
    description: "Process queued deferred extraction jobs now, optionally across repositories.",
    routeKindHints: ["background_task"],
    support: {
      status: "experimental",
      category: "Backfill and deferred processing",
      notes: "Triggers processing of extractions deferred during session-start.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_backfill",
    description: "Backfill recent sessions from the raw session store into episodic memory. Supports legacy one-shot mode and controlled resumable runs with dry-run, snapshot, and restore.",
    routeKindHints: ["background_task"],
    support: {
      status: "experimental",
      category: "Backfill and deferred processing",
      notes: "Backfills memories from the raw session store. The public tool is bounded to 20 items per run; larger volumes use the same controlled backfill engine through direct module access or session-start archive import.",
      rolloutFlags: [],
    },
  },
  {
    name: "memory_doctor_report",
    description: "Run the observe-only Lore Doctor: classify incidents from maintenance task states, trajectory artifacts, latency metrics, and improvement backlog signals. Emits an additive doctor-report trajectory artifact (unless dryRun is set). No trusted-source mutation occurs.",
    routeKindHints: [],
    support: {
      status: "experimental",
      category: "Self-diagnostics and proposals",
      notes: "Generates a structured health report. Requires `loreDoctor` and `evolutionLedger` rollout flags.",
      rolloutFlags: ["loreDoctor", "evolutionLedger"],
    },
  },
  {
    name: "memory_review_gate",
    description: "Observe-only proposal-doc review gate. Checks the provided text for required sections (goal, acceptance, risk) using deterministic heading analysis and records an additive review_gate_report trajectory artifact. No enforcement, no blocking, no trusted-source mutation.",
    routeKindHints: [],
    support: {
      status: "experimental",
      category: "Self-diagnostics and proposals",
      notes: "Runs an observe-only proposal-doc gate and records review-gate trajectory artifacts. Requires `reviewGate` and `evolutionLedger` rollout flags.",
      rolloutFlags: ["reviewGate", "evolutionLedger"],
    },
  },
];

export const LORE_CAPABILITY_SPECS = Object.freeze(CAPABILITY_SPECS.map((spec) => Object.freeze({
  ...spec,
  routeKindHints: Object.freeze([...spec.routeKindHints]),
  support: Object.freeze({
    ...spec.support,
    rolloutFlags: Object.freeze([...spec.support.rolloutFlags]),
  }),
})));
