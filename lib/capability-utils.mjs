/**
 * Shared capability inventory helpers for scanning and routing.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "their",
  "then",
  "these",
  "this",
  "to",
  "use",
  "using",
  "when",
  "with",
  "you",
  "your",
]);

const ROUTE_DEFINITIONS = Object.freeze([
  {
    id: "retrieval",
    label: "Plain retrieval",
    explanation:
      "Use Lore retrieval and explanation tools when local memory/context is enough and you mainly need recall, evidence, blockers, decisions, or synthesis.",
    recommendedWhen: [
      "recall prior work or recent sessions",
      "explain why local context was retrieved",
      "summarize blockers decisions patterns or next actions",
    ],
  },
  {
    id: "skill",
    label: "Skill",
    explanation:
      "Use a skill when the prompt matches a reusable local playbook with clear guardrails, workflow steps, and domain-specific instructions.",
    recommendedWhen: [
      "apply a reusable workflow or migration playbook",
      "follow local guardrails for a known task shape",
      "reuse a repo-shipped skill instead of reinventing instructions",
    ],
  },
  {
    id: "agent",
    label: "Agent",
    explanation:
      "Use a local custom agent when the work benefits from a specialized delegated role such as planning, orchestration, research, or focused test generation.",
    recommendedWhen: [
      "delegate planning research orchestration or focused generation",
      "match the task to a local specialist agent",
      "keep explanation local while preparing later delegated routing",
    ],
  },
  {
    id: "background_task",
    label: "Background task",
    explanation:
      "Use a background task path for long-running maintenance or resumable local work. This slice only inventories repo-local surfaces and does not auto-launch anything.",
    recommendedWhen: [
      "run deferred or resumable maintenance work",
      "process queued jobs without blocking the foreground flow",
      "prepare future router support for background execution",
    ],
  },
  {
    id: "direct",
    label: "Direct or no-op",
    explanation:
      "Use the direct path when no local capability clearly adds value or the prompt is simple enough to answer without delegation or retrieval.",
    recommendedWhen: [
      "answer a simple prompt directly",
      "no local capability matches strongly",
      "keep routing explainable without invoking another mechanism",
    ],
  },
]);

export const ROUTER_SIGNAL_PHRASES = Object.freeze({
  retrievalExplain: [
    "explain",
    "why",
    "reason",
    "trace",
    "context",
    "evidence",
  ],
  retrievalReflect: [
    "summary",
    "summarize",
    "reflect",
    "pattern",
    "patterns",
    "blocker",
    "blockers",
    "decision",
    "decisions",
    "next action",
    "next actions",
  ],
  retrievalSearch: [
    "search",
    "find",
    "lookup",
    "look up",
    "list",
    "show",
    "recall",
    "remember",
    "what did we do",
    "what happened",
  ],
  promptRewrite: [
    "sharpen this prompt",
    "sharpen the prompt",
    "sharpen my prompt",
    "sharpen this user request",
    "sharpen the user request",
    "sharpen my user request",
    "rewrite this prompt",
    "rewrite the prompt",
    "rewrite my prompt",
    "rewrite this user request",
    "rewrite the user request",
    "rewrite my user request",
    "reverse prompt",
    "repo grounded brief",
    "better prompt",
    "improve this prompt",
    "turn this into a brief",
    "turn the prompt into a brief",
  ],
  skill: [
    "skill",
    "playbook",
    "workflow",
    "migration",
    "migrate",
    "triage",
    "authoring",
    "hardening",
    "eliminator",
  ],
  agent: [
    "agent",
    "delegate",
    "delegated",
    "subagent",
    "plan",
    "planning",
    "steps first",
    "before we start editing",
    "before we edit",
    "before editing",
    "roadmap",
    "research",
    "orchestrate",
    "orchestration",
    "generator",
  ],
  background: [
    "background",
    "deferred",
    "queue",
    "queued",
    "process queue",
    "maintenance",
    "scheduler",
    "schedule",
    "backfill",
    "resume",
    "resumable",
    "long running",
    "async",
  ],
  direct: [
    "hi",
    "hello",
    "hey",
    "thanks",
    "thank you",
  ],
});

export const ROUTER_EVALUATION_CASES = Object.freeze([
  {
    id: "skill-typescript-any",
    prompt: "I have a function that takes any for a request body. Help me replace the any safely without breaking downstream type inference.",
    expectedRouteKind: "skill",
    expectedTargetName: "typescript-any-eliminator",
    expectedExecutionMode: "skill",
    minConfidence: 0.75,
    notes: "Type-safety workflow prompts should pick the dedicated TypeScript any elimination skill.",
  },
  {
    id: "agent-ci-migration-plan",
    prompt: "We need to migrate our CircleCI config to GitHub Actions. Can you plan the steps first — workflows, matrix strategy, caching, secrets — before we start editing?",
    expectedRouteKind: "agent",
    expectedTargetName: "ci-migration-orchestrator",
    expectedExecutionMode: "delegated_manual",
    minConfidence: 0.75,
    notes: "Plan-first CI migration prompts should prefer orchestration over jumping straight into the migration skill.",
  },
  {
    id: "retrieval-last-session-decisions",
    prompt: "What did we decide about error handling patterns in our last session? I want to remember the guardrails we settled on.",
    expectedRouteKind: "retrieval",
    expectedTargetName: "lore_reflect",
    expectedExecutionMode: "local_tool",
    minConfidence: 0.75,
    notes: "Continuity and decision recall should stay on local Lore retrieval paths.",
  },
  {
    id: "skill-reverse-prompt-brief",
    prompt: "Before you start, sharpen this prompt into a repo-grounded brief and then move into planning: add a new skill under ~/.copilot/skills.",
    expectedRouteKind: "skill",
    expectedTargetName: "reverse-prompt",
    expectedExecutionMode: "skill",
    minConfidence: 0.75,
    notes: "Explicit prompt-sharpening requests should prefer the reverse-prompt skill over broad workspace agents.",
  },
  {
    id: "skill-gha-failure-triage",
    prompt: "We have a failing GitHub Actions check on main. The matrix job timed out. Can you look at the logs and fix it?",
    expectedRouteKind: "skill",
    expectedTargetName: "github-actions-failure-triage",
    expectedExecutionMode: "skill",
    minConfidence: 0.75,
    notes: "Existing GitHub Actions failures should prefer the triage skill, not migration planning.",
  },
  {
    id: "background-maintenance",
    prompt: "Run deferred maintenance on the backlog in the background.",
    expectedRouteKind: "background_task",
    expectedTargetName: "memory_deferred_process",
    expectedExecutionMode: "local_background_candidate",
    minConfidence: 0.75,
    notes: "Explicit deferred-maintenance prompts should recommend the background maintenance surface.",
  },
  {
    id: "direct-typescript-reference",
    prompt: "What is TypeScript's never type used for?",
    expectedRouteKind: "direct",
    expectedTargetName: "direct_response",
    expectedExecutionMode: "direct",
    minConfidence: 0.45,
    notes: "General reference questions without a strong local workflow should stay direct.",
  },
]);

export function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeText(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function tokenize(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function addWeightedTokens(target, text, weight) {
  for (const token of tokenize(text)) {
    target[token] = (target[token] ?? 0) + weight;
  }
}

export function buildWeightedKeywordMap(parts) {
  const keywordWeights = {};
  for (const part of parts) {
    if (!part || typeof part.text !== "string") {
      continue;
    }
    addWeightedTokens(keywordWeights, part.text, part.weight ?? 1);
  }
  return keywordWeights;
}

export function keywordList(keywordWeights) {
  return Object.entries(keywordWeights)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([token]) => token);
}

export function dedupeStrings(values) {
  return [...new Set(
    values
      .filter((value) => typeof value === "string")
      .map((value) => normalizeWhitespace(value))
      .filter(Boolean),
  )];
}

export function buildRouteEntries(capabilities) {
  return ROUTE_DEFINITIONS.map((definition) => {
    const supportingCapabilities = capabilities.filter((capability) =>
      capability.routeKindHints.includes(definition.id)
        || capability.capabilityType === definition.id,
    );

    let supportLevel = "ready";
    const gaps = [];
    if (definition.id === "background_task" && supportingCapabilities.length === 0) {
      supportLevel = "placeholder";
      gaps.push("No repo-authored background-task capability surface was discovered.");
      gaps.push("Later routing can merge runtime-native background execution surfaces.");
    } else if (definition.id !== "direct" && supportingCapabilities.length === 0) {
      supportLevel = "missing";
      gaps.push("No local capability matched this route family.");
    }

    return {
      id: definition.id,
      label: definition.label,
      explanation: definition.explanation,
      recommendedWhen: definition.recommendedWhen,
      supportLevel,
      available: definition.id === "direct" || supportingCapabilities.length > 0,
      supportingCapabilityIds: supportingCapabilities.map((capability) => capability.id),
      gaps,
      keywordWeights: buildWeightedKeywordMap(
        definition.recommendedWhen.map((text) => ({ text, weight: 2 })),
      ),
    };
  });
}

export function buildRouterCorpusScaffold() {
  return {
    schemaVersion: 1,
    status: "implemented",
    explanationMode: "traceable_recommendation",
    caseTemplateFields: [
      "id",
      "prompt",
      "expectedRouteKind",
      "expectedTargetName",
      "expectedExecutionMode",
      "notes",
    ],
    routeFamilies: [
      {
        id: "skill-routing",
        expectedRouteKind: "skill",
        description: "Prompts that should recommend a local skill playbook.",
      },
      {
        id: "agent-routing",
        expectedRouteKind: "agent",
        description: "Prompts that should recommend a local custom agent.",
      },
      {
        id: "plain-retrieval",
        expectedRouteKind: "retrieval",
        description: "Prompts that should stay on Lore retrieval/explanation paths.",
      },
      {
        id: "background-task",
        expectedRouteKind: "background_task",
        description: "Prompts that should recommend deferred or background maintenance surfaces.",
      },
      {
        id: "direct-no-op",
        expectedRouteKind: "direct",
        description: "Prompts that should remain direct/no-op instead of invoking another surface.",
      },
    ],
    successBar: [
      "Every corpus case should produce a traceable route explanation.",
      "Recommendation output should name the matched local target when one exists.",
      "The corpus should cover retrieval, skill, agent, background, and direct route families.",
      "Automatic invocation stays disabled until a later evaluation slice approves it.",
    ],
    cases: ROUTER_EVALUATION_CASES.map((item) => ({
      id: item.id,
      prompt: item.prompt,
      expectedRouteKind: item.expectedRouteKind,
      expectedTargetName: item.expectedTargetName,
      expectedExecutionMode: item.expectedExecutionMode,
      notes: item.notes,
    })),
  };
}
