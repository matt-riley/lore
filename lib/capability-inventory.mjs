import path from "node:path";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { detectPromptContextNeed } from "./capsule-assembler.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(__dirname, "../../..");

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
      "Use Coherence retrieval and explanation tools when local memory/context is enough and you mainly need recall, evidence, blockers, decisions, or synthesis.",
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

const TOOL_ROUTE_HINTS = Object.freeze({
  coherence_recall: ["retrieval"],
  coherence_reflect: ["retrieval"],
  memory_search: ["retrieval"],
  memory_explain: ["retrieval"],
  memory_backfill: ["background_task"],
  memory_deferred_process: ["background_task"],
});

const ROUTER_SIGNAL_PHRASES = Object.freeze({
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

const ROUTER_EVALUATION_CASES = Object.freeze([
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
    expectedTargetName: "coherence_reflect",
    expectedExecutionMode: "local_tool",
    minConfidence: 0.75,
    notes: "Continuity and decision recall should stay on local Coherence retrieval paths.",
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

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value) {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

function addWeightedTokens(target, text, weight) {
  for (const token of tokenize(text)) {
    target[token] = (target[token] ?? 0) + weight;
  }
}

function quotedParts(line) {
  const matches = [
    ...line.matchAll(/"([^"]*)"/g),
    ...line.matchAll(/`([^`]*)`/g),
  ];
  return matches.map((match) => normalizeWhitespace(match[1])).filter(Boolean);
}

function readDescription(lines, startIndex) {
  const directParts = quotedParts(lines[startIndex] ?? "");
  if (directParts.length > 0) {
    return directParts.join(" ");
  }

  const parts = [];
  for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 8); index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) {
      if (parts.length > 0) {
        break;
      }
      continue;
    }
    if (/[a-zA-Z0-9_]+:\s/.test(trimmed) && !trimmed.startsWith("\"") && !trimmed.startsWith("`")) {
      break;
    }
    const lineParts = quotedParts(trimmed);
    if (lineParts.length === 0) {
      if (parts.length > 0) {
        break;
      }
      continue;
    }
    parts.push(...lineParts);
    if (trimmed.endsWith(",")) {
      break;
    }
  }
  return parts.join(" ");
}

function stripYamlScalar(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return "";
  }
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return trimmed;
}

function parseFrontmatter(markdown) {
  const lines = String(markdown || "").split("\n");
  if (lines[0]?.trim() !== "---") {
    return { attributes: {}, body: markdown };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) {
    return { attributes: {}, body: markdown };
  }

  const attributes = {};
  let nestedKey = null;
  for (const line of lines.slice(1, endIndex)) {
    if (!line.trim()) {
      continue;
    }
    const nestedMatch = nestedKey
      ? line.match(/^\s{2}([a-zA-Z0-9_-]+):\s*(.*)$/)
      : null;
    if (nestedMatch) {
      attributes[nestedKey][nestedMatch[1]] = stripYamlScalar(nestedMatch[2]);
      continue;
    }

    const topLevelMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!topLevelMatch) {
      nestedKey = null;
      continue;
    }

    const [, key, rawValue] = topLevelMatch;
    if (rawValue.trim().length === 0) {
      attributes[key] = {};
      nestedKey = key;
      continue;
    }

    attributes[key] = stripYamlScalar(rawValue);
    nestedKey = null;
  }

  return {
    attributes,
    body: lines.slice(endIndex + 1).join("\n").trim(),
  };
}

function sectionHeadingEquals(line, heading) {
  return normalizeText(line.replace(/^#+\s*/, "")) === normalizeText(heading);
}

function extractBulletSection(markdown, heading) {
  const lines = String(markdown || "").split("\n");
  const items = [];
  let active = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed)) {
      if (active) {
        break;
      }
      active = sectionHeadingEquals(trimmed, heading);
      continue;
    }
    if (!active) {
      continue;
    }

    const bulletMatch = line.match(/^\s*-\s+(.*)$/);
    if (bulletMatch) {
      items.push(normalizeWhitespace(bulletMatch[1]));
      continue;
    }

    if (items.length > 0 && /^\s{2,}\S/.test(line)) {
      items[items.length - 1] = normalizeWhitespace(`${items.at(-1)} ${trimmed}`);
    }
  }

  return items;
}

function extractLeadParagraph(markdown) {
  const lines = String(markdown || "").split("\n");
  const parts = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (started) {
        break;
      }
      continue;
    }
    if (/^#/.test(trimmed)) {
      if (started) {
        break;
      }
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      if (started) {
        break;
      }
      continue;
    }
    parts.push(trimmed);
    started = true;
  }
  return normalizeWhitespace(parts.join(" "));
}

async function safeReadFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function safeReadDir(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function relativePath(rootPath, filePath) {
  return path.relative(rootPath, filePath).replace(/\\/g, "/");
}

function buildWeightedKeywordMap(parts) {
  const keywordWeights = {};
  for (const part of parts) {
    if (!part || typeof part.text !== "string") {
      continue;
    }
    addWeightedTokens(keywordWeights, part.text, part.weight ?? 1);
  }
  return keywordWeights;
}

function keywordList(keywordWeights) {
  return Object.entries(keywordWeights)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([token]) => token);
}

function dedupeStrings(values) {
  return [...new Set(
    values
      .filter((value) => typeof value === "string")
      .map((value) => normalizeWhitespace(value))
      .filter(Boolean),
  )];
}

function buildTriggerTerms(keywordWeights, limit = 12) {
  return keywordList(keywordWeights).slice(0, Math.max(1, limit));
}

function inferExecutionMode({ capabilityType, routeKindHints, manualOnly }) {
  if (routeKindHints.includes("background_task")) {
    return "local_background_candidate";
  }
  if (capabilityType === "skill") {
    return "skill";
  }
  if (capabilityType === "agent") {
    return manualOnly ? "delegated_manual" : "delegated";
  }
  if (capabilityType === "tool") {
    return "local_tool";
  }
  return "direct";
}

function buildCapabilityBase({
  id,
  name,
  description,
  sourcePath,
  capabilityType,
  routeKindHints,
  summary,
  manualOnly = false,
  keywordParts,
  triggerCapabilities = [],
  executionMode,
  metadata = {},
}) {
  const keywordWeights = buildWeightedKeywordMap(keywordParts);
  const normalizedRouteKindHints = [...new Set(routeKindHints)];
  const explanationMetadata = {
    summary: normalizeWhitespace(summary),
    description: normalizeWhitespace(description),
    sourceKind: metadata.sourceKind ?? capabilityType,
    manualOnly,
    routeKindHints: normalizedRouteKindHints,
    explanationMode: "recommendation_only",
  };
  return {
    id,
    name,
    targetName: name,
    targetType: capabilityType,
    capabilityType,
    description: normalizeWhitespace(description),
    summary: explanationMetadata.summary,
    sourcePath,
    routeKindHints: normalizedRouteKindHints,
    routeKind: normalizedRouteKindHints[0] ?? "direct",
    manualOnly,
    triggerTerms: buildTriggerTerms(keywordWeights),
    triggerCapabilities: dedupeStrings(triggerCapabilities),
    executionMode: executionMode ?? inferExecutionMode({
      capabilityType,
      routeKindHints: normalizedRouteKindHints,
      manualOnly,
    }),
    explanationMetadata,
    metadata,
    keywordWeights,
    keywords: keywordList(keywordWeights),
  };
}

function buildToolRouteHints(name, extensionName) {
  const explicit = TOOL_ROUTE_HINTS[name];
  if (explicit) {
    return explicit;
  }
  if (extensionName === "coherence" && /^memory_(status|validate|replay)$/.test(name)) {
    return ["direct"];
  }
  return [];
}

function scoreCapability(capability, promptTokens, normalizedPrompt) {
  const matchedTokens = [];
  let score = 0;
  for (const token of promptTokens) {
    const weight = capability.keywordWeights[token];
    if (!weight) {
      continue;
    }
    score += weight;
    matchedTokens.push(token);
  }

  const normalizedCapabilityName = normalizeText(capability.name);
  const nameMatched = normalizedCapabilityName.length > 0
    && normalizedPrompt.includes(normalizedCapabilityName);
  if (nameMatched) {
    score += 5;
  }

  return {
    capabilityId: capability.id,
    capabilityType: capability.capabilityType,
    name: capability.name,
    targetName: capability.targetName,
    targetType: capability.targetType,
    description: capability.description,
    routeKind: capability.routeKind,
    routeKindHints: capability.routeKindHints,
    sourcePath: capability.sourcePath,
    manualOnly: capability.manualOnly,
    nameMatched,
    executionMode: capability.executionMode,
    triggerTerms: capability.triggerTerms,
    triggerCapabilities: capability.triggerCapabilities,
    explanationMetadata: capability.explanationMetadata,
    score,
    matchedTokens: [...new Set(matchedTokens)],
  };
}

function buildRouteEntries(capabilities) {
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

function scoreRoute(route, promptTokens, normalizedPrompt, capabilityMatches) {
  let score = 0;
  const matchedTokens = [];
  for (const token of promptTokens) {
    const weight = route.keywordWeights[token];
    if (!weight) {
      continue;
    }
    score += weight;
    matchedTokens.push(token);
  }

  const supportingMatches = capabilityMatches
    .filter((match) => route.supportingCapabilityIds.includes(match.capabilityId))
    .sort((left, right) => right.score - left.score);
  if (supportingMatches.length > 0) {
    score += supportingMatches[0].score;
  }
  if (supportingMatches.length > 1) {
    score += Math.min(6, Math.round(supportingMatches[1].score * 0.2));
  }
  if (supportingMatches.length > 2) {
    score += Math.min(4, Math.round(supportingMatches[2].score * 0.1));
  }

  if (route.id === "direct") {
    score += 1;
    if (/^(hi|hello|hey)\b/.test(normalizedPrompt)) {
      score += 3;
      matchedTokens.push("greeting");
    }
  }

  return {
    route: route.id,
    label: route.label,
    supportLevel: route.supportLevel,
    available: route.available,
    explanation: route.explanation,
    score,
    matchedTokens: [...new Set(matchedTokens)],
    supportingCapabilityIds: route.supportingCapabilityIds,
    supportingMatches: supportingMatches.slice(0, 3),
    gaps: route.gaps,
  };
}

function buildManifestEntry(capability) {
  return {
    id: capability.id,
    routeKind: capability.routeKind,
    routeKindHints: capability.routeKindHints,
    targetName: capability.targetName,
    targetType: capability.targetType,
    sourcePath: capability.sourcePath,
    triggerTerms: capability.triggerTerms,
    triggerCapabilities: capability.triggerCapabilities,
    executionMode: capability.executionMode,
    explanation: capability.explanationMetadata,
  };
}

function buildRouterCorpusScaffold() {
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
        description: "Prompts that should stay on Coherence retrieval/explanation paths.",
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

function countPhraseMatches(normalizedPrompt, phrases) {
  return phrases.reduce((count, phrase) => (
    normalizedPrompt.includes(normalizeText(phrase)) ? count + 1 : count
  ), 0);
}

function countCapabilityMentions(capabilities, normalizedPrompt, predicate) {
  const names = capabilities
    .filter(predicate)
    .map((capability) => normalizeText(capability.name))
    .filter(Boolean);
  return [...new Set(names)].reduce((count, name) => (
    normalizedPrompt.includes(name) ? count + 1 : count
  ), 0);
}

function buildPromptProfile(prompt, capabilities) {
  const normalizedPrompt = normalizeText(prompt);
  const promptTokens = [...new Set(tokenize(prompt))];
  const promptNeed = detectPromptContextNeed(prompt);
  const greeting = /^(hi|hello|hey|thanks|thank you)\b/.test(String(prompt || "").trim().toLowerCase());
  const referenceQuestion = /^(what|why|how|when|where|who)\b/.test(String(prompt || "").trim().toLowerCase());
  const planBeforeExecution = [
    "plan the steps first",
    "steps first",
    "before we start editing",
    "before we edit",
    "before editing",
  ].some((phrase) => normalizedPrompt.includes(normalizeText(phrase)));
  const migrationIntent = normalizedPrompt.includes("migrate")
    || normalizedPrompt.includes("migration");
  const ciMigrationIntent = (
    normalizedPrompt.includes("circleci")
    && normalizedPrompt.includes(normalizeText("github actions"))
  ) || (
    normalizedPrompt.includes(".circleci")
    && normalizedPrompt.includes("github")
    && normalizedPrompt.includes("actions")
  );
  const explainIntent = countPhraseMatches(normalizedPrompt, ROUTER_SIGNAL_PHRASES.retrievalExplain) > 0;
  const reflectIntent = countPhraseMatches(normalizedPrompt, ROUTER_SIGNAL_PHRASES.retrievalReflect) > 0;
  const searchIntent = countPhraseMatches(normalizedPrompt, ROUTER_SIGNAL_PHRASES.retrievalSearch) > 0;
  const skillIntentScore = countPhraseMatches(normalizedPrompt, ROUTER_SIGNAL_PHRASES.skill)
    + (countCapabilityMentions(capabilities, normalizedPrompt, (capability) =>
      capability.capabilityType === "skill"
    ) * 2);
  const agentIntentScore = countPhraseMatches(normalizedPrompt, ROUTER_SIGNAL_PHRASES.agent)
    + (countCapabilityMentions(capabilities, normalizedPrompt, (capability) =>
      capability.capabilityType === "agent"
    ) * 2);
  const backgroundIntentScore = countPhraseMatches(normalizedPrompt, ROUTER_SIGNAL_PHRASES.background)
    + (countCapabilityMentions(capabilities, normalizedPrompt, (capability) =>
      capability.routeKindHints.includes("background_task")
    ) * 2);
  const directIntentScore = countPhraseMatches(normalizedPrompt, ROUTER_SIGNAL_PHRASES.direct);
  const simplePrompt = promptTokens.length <= 6;

  return {
    normalizedPrompt,
    promptTokens,
    promptNeed,
    greeting,
    referenceQuestion,
    explainIntent,
    reflectIntent,
    searchIntent,
    planBeforeExecution,
    migrationIntent,
    ciMigrationIntent,
    skillIntentScore,
    agentIntentScore,
    backgroundIntentScore,
    directIntentScore,
    simplePrompt,
  };
}

function capabilityForId(capabilities, capabilityId) {
  return capabilities.find((capability) => capability.id === capabilityId) ?? null;
}

function capabilityForName(capabilities, name) {
  return capabilities.find((capability) => capability.name === name) ?? null;
}

function buildTargetReference(capability, match, rationale) {
  if (!capability) {
    return null;
  }
  return {
    capabilityId: capability.id,
    targetName: capability.targetName,
    targetType: capability.targetType,
    executionMode: capability.executionMode,
    sourcePath: capability.sourcePath,
    description: capability.description,
    manualOnly: capability.manualOnly,
    matchScore: match?.score ?? 0,
    nameMatched: match?.nameMatched === true,
    rationale,
  };
}

function selectRetrievalTarget(capabilities, promptProfile, matchMap) {
  let targetName = "coherence_recall";
  let rationale = "Prompt asks for local recall or continuity context.";
  if (promptProfile.explainIntent) {
    targetName = "memory_explain";
    rationale = "Prompt asks for an explanation or trace of local context selection.";
  } else if (promptProfile.reflectIntent) {
    targetName = "coherence_reflect";
    rationale = "Prompt asks for synthesis such as patterns, blockers, decisions, or next actions.";
  } else if (promptProfile.searchIntent && promptProfile.promptNeed.requiresLookup !== true) {
    targetName = "memory_search";
    rationale = "Prompt reads like a direct memory search or listing request.";
  }
  const capability = capabilityForName(capabilities, targetName);
  return buildTargetReference(capability, capability ? matchMap.get(capability.id) : null, rationale);
}

function selectBackgroundTarget(capabilities, promptProfile, matchMap) {
  const wantsBackfill = promptProfile.normalizedPrompt.includes("backfill")
    || promptProfile.normalizedPrompt.includes("archive")
    || promptProfile.normalizedPrompt.includes("import");
  const targetName = wantsBackfill ? "memory_backfill" : "memory_deferred_process";
  const rationale = wantsBackfill
    ? "Prompt mentions backfill-style maintenance work."
    : "Prompt mentions deferred, queued, or resumable maintenance work.";
  const capability = capabilityForName(capabilities, targetName);
  return buildTargetReference(capability, capability ? matchMap.get(capability.id) : null, rationale);
}

function selectMatchedCapabilityTarget(capabilities, routeId, supportingMatches) {
  const topMatch = [...supportingMatches].sort((left, right) =>
    Number(right.nameMatched === true) - Number(left.nameMatched === true)
      || right.score - left.score
      || left.name.localeCompare(right.name)
  )[0];
  if (!topMatch) {
    return null;
  }
  const capability = capabilityForId(capabilities, topMatch.capabilityId);
  if (!capability) {
    return null;
  }
  const routeLabel = routeId === "skill" ? "skill" : "agent";
  return buildTargetReference(
    capability,
    topMatch,
    `Top-scoring local ${routeLabel} match for this prompt.`,
  );
}

function selectRouteTarget(capabilities, routeId, promptProfile, supportingMatches, matchMap) {
  if (routeId === "retrieval") {
    return selectRetrievalTarget(capabilities, promptProfile, matchMap);
  }
  if (routeId === "background_task") {
    return selectBackgroundTarget(capabilities, promptProfile, matchMap);
  }
  if (routeId === "skill" || routeId === "agent") {
    return selectMatchedCapabilityTarget(capabilities, routeId, supportingMatches);
  }
  if (routeId === "direct") {
    return {
      capabilityId: null,
      targetName: "direct_response",
      targetType: "direct",
      executionMode: "direct",
      sourcePath: null,
      description: "Respond directly without invoking another local surface.",
      manualOnly: false,
      matchScore: 0,
      nameMatched: false,
      rationale: "No stronger local capability needs to be recommended.",
    };
  }
  return null;
}

function buildRouteHeuristicAdjustment(routeCandidate, promptProfile, selectedTarget) {
  let heuristicScore = 0;
  const reasons = [];
  const targetMatchScore = selectedTarget?.matchScore ?? 0;
  const explicitIntentScore = routeCandidate.route === "skill"
    ? promptProfile.skillIntentScore
    : routeCandidate.route === "agent"
      ? promptProfile.agentIntentScore
      : routeCandidate.route === "background_task"
        ? promptProfile.backgroundIntentScore
        : promptProfile.directIntentScore;

  if (routeCandidate.available !== true) {
    heuristicScore -= 20;
    reasons.push("No local capability currently supports this route family.");
  }
  if (routeCandidate.supportLevel === "placeholder") {
    heuristicScore -= 4;
    reasons.push("This route family is only partially represented in the current local slice.");
  }

  switch (routeCandidate.route) {
    case "retrieval":
      if (promptProfile.promptNeed.requiresLookup) {
        heuristicScore += 12;
        reasons.push("Prompt needs remembered, temporal, or continuity-aware local context.");
      }
      if (promptProfile.promptNeed.wantsContinuity) {
        heuristicScore += 6;
        reasons.push("Continuity language prefers retrieval before delegation.");
      }
      if (promptProfile.promptNeed.hasTemporalSignal) {
        heuristicScore += 8;
        reasons.push("Temporal language is a strong retrieval signal.");
      }
      if (promptProfile.explainIntent) {
        heuristicScore += 5;
        reasons.push("Explain/trace phrasing maps well to memory_explain.");
      }
      if (promptProfile.reflectIntent) {
        heuristicScore += 5;
        reasons.push("Reflection phrasing maps well to coherence_reflect.");
      }
      if (promptProfile.searchIntent) {
        heuristicScore += 4;
        reasons.push("Search/list phrasing maps to a retrieval surface.");
      }
      if (selectedTarget?.rationale) {
        reasons.push(selectedTarget.rationale);
      }
      break;
    case "skill":
      if (explicitIntentScore > 0) {
        heuristicScore += 8 + explicitIntentScore;
        reasons.push("Prompt explicitly asks for a reusable workflow or skill-like playbook.");
      }
      if (targetMatchScore > 0) {
        heuristicScore += Math.min(8, targetMatchScore);
        reasons.push(`Matched skill target ${selectedTarget.targetName}.`);
      }
      if (explicitIntentScore === 0 && targetMatchScore < 7) {
        heuristicScore -= 8;
        reasons.push("Skill routing stays conservative without a clear workflow or skill signal.");
      }
      if (promptProfile.promptNeed.requiresLookup && explicitIntentScore === 0) {
        heuristicScore -= 6;
        reasons.push("Prompt looks more like recall/explanation than a skill workflow.");
      }
      if (
        promptProfile.referenceQuestion
        && promptProfile.promptNeed.requiresLookup !== true
        && explicitIntentScore === 0
        && selectedTarget?.nameMatched !== true
      ) {
        heuristicScore -= 28;
        reasons.push("Generic reference questions should stay direct unless they clearly ask for a local workflow.");
      }
      if (promptProfile.planBeforeExecution && promptProfile.ciMigrationIntent) {
        heuristicScore -= 16;
        reasons.push("Prompt asks for migration planning before editing, so orchestration should outrank a direct migration skill.");
      }
      break;
    case "agent":
      if (explicitIntentScore > 0) {
        heuristicScore += 8 + explicitIntentScore;
        reasons.push("Prompt asks for planning, research, delegation, or orchestration.");
      }
      if (targetMatchScore > 0) {
        heuristicScore += Math.min(8, targetMatchScore);
        reasons.push(`Matched agent target ${selectedTarget.targetName}.`);
      }
      if (selectedTarget?.manualOnly && explicitIntentScore === 0 && !selectedTarget.nameMatched) {
        heuristicScore -= 4;
        reasons.push("Manual-only agents need clearer delegation intent than this prompt provides.");
      }
      if (explicitIntentScore === 0 && targetMatchScore < 7) {
        heuristicScore -= 8;
        reasons.push("Agent routing stays conservative without clear delegation intent.");
      }
      if (promptProfile.promptNeed.requiresLookup && explicitIntentScore === 0) {
        heuristicScore -= 8;
        reasons.push("Prompt looks like local recall/explanation instead of delegated work.");
      }
      if (promptProfile.planBeforeExecution && promptProfile.ciMigrationIntent) {
        heuristicScore += 28;
        reasons.push("Plan-first CI migration prompts should prefer the migration orchestrator before execution.");
      }
      break;
    case "background_task":
      if (explicitIntentScore > 0) {
        heuristicScore += 12 + explicitIntentScore;
        reasons.push("Prompt explicitly mentions deferred, queued, or background work.");
      } else {
        heuristicScore -= 10;
        reasons.push("Background routing stays conservative without an explicit maintenance signal.");
      }
      if (targetMatchScore > 0) {
        heuristicScore += Math.min(6, targetMatchScore);
        reasons.push(`Matched background target ${selectedTarget.targetName}.`);
      }
      if (selectedTarget?.rationale) {
        reasons.push(selectedTarget.rationale);
      }
      break;
    case "direct":
      if (promptProfile.promptNeed.identityOnly) {
        heuristicScore += 18;
        reasons.push("Identity-only or direct-address prompt does not need another local surface.");
      }
      if (promptProfile.greeting) {
        heuristicScore += 6;
        reasons.push("Greeting-style prompt can be answered directly.");
      }
      if (
        promptProfile.referenceQuestion
        && promptProfile.promptNeed.requiresLookup !== true
        && promptProfile.skillIntentScore === 0
        && promptProfile.agentIntentScore === 0
        && promptProfile.backgroundIntentScore === 0
      ) {
        heuristicScore += 24;
        reasons.push("Generic reference question does not need a local workflow recommendation.");
      }
      if (!promptProfile.promptNeed.requiresLookup && promptProfile.simplePrompt) {
        heuristicScore += 4;
        reasons.push("Short prompt with no recall/delegation signal fits a direct response.");
      }
      if (promptProfile.promptNeed.requiresLookup) {
        heuristicScore -= 8;
        reasons.push("Prompt needs local context, so direct/no-op is less appropriate.");
      }
      if (
        promptProfile.skillIntentScore > 0
        || promptProfile.agentIntentScore > 0
        || promptProfile.backgroundIntentScore > 0
      ) {
        heuristicScore -= 6;
        reasons.push("Prompt contains stronger routing signals than a direct/no-op response.");
      }
      if (selectedTarget?.rationale) {
        reasons.push(selectedTarget.rationale);
      }
      break;
    default:
      break;
  }

  return { heuristicScore, reasons };
}

function buildConfidence(primaryRoute, secondaryRoute) {
  const margin = primaryRoute.score - (secondaryRoute?.score ?? 0);
  const rawValue = Math.max(0, Math.min(1, (primaryRoute.score + margin) / 24));
  const value = Number(rawValue.toFixed(2));
  const label = value >= 0.75 ? "high" : value >= 0.45 ? "medium" : "low";
  return {
    value,
    label,
    margin,
  };
}

function extractToolSpecs(sourceText) {
  const lines = String(sourceText || "").split("\n");
  const tools = [];
  for (let index = 0; index < lines.length; index += 1) {
    const nameMatch = lines[index].match(/name:\s*"([^"]+)"/);
    if (!nameMatch) {
      continue;
    }
    let description = "";
    for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 8); lookahead += 1) {
      if (!lines[lookahead].includes("description:")) {
        continue;
      }
      description = readDescription(lines, lookahead);
      break;
    }
    tools.push({
      name: nameMatch[1],
      description,
    });
  }
  return tools.filter((tool, index, array) =>
    array.findIndex((candidate) => candidate.name === tool.name) === index
  );
}

function extractHookNames(sourceText) {
  const matches = [
    ...String(sourceText || "").matchAll(/\b(on[A-Z][A-Za-z0-9]+)\s*:/g),
  ];
  return [...new Set(matches.map((match) => match[1]))].sort();
}

async function scanSkills(rootPath) {
  const skillsDir = path.join(rootPath, "skills");
  const entries = await safeReadDir(skillsDir);
  const skills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
    const content = await safeReadFile(skillFile);
    if (!content) {
      continue;
    }

    const { attributes, body } = parseFrontmatter(content);
    const name = typeof attributes.name === "string" && attributes.name
      ? attributes.name
      : entry.name;
    const description = typeof attributes.description === "string" ? attributes.description : "";
    const useWhen = extractBulletSection(body, "Use this skill when");
    const avoidWhen = extractBulletSection(body, "Do not use this skill when");
    const summary = extractLeadParagraph(body);
    const sourcePath = relativePath(rootPath, skillFile);

    skills.push(buildCapabilityBase({
      id: `skill:${name}`,
      name,
      description,
      sourcePath,
      capabilityType: "skill",
      routeKindHints: ["skill"],
      summary,
      keywordParts: [
        { text: name, weight: 4 },
        { text: description, weight: 3 },
        { text: summary, weight: 2 },
        ...useWhen.map((text) => ({ text, weight: 2 })),
        ...avoidWhen.map((text) => ({ text, weight: 1 })),
        ...Object.values(attributes.metadata ?? {}).map((text) => ({ text: String(text), weight: 1 })),
      ],
      triggerCapabilities: [
        ...useWhen,
        ...Object.entries(attributes.metadata ?? {}).map(([key, value]) => `${key}:${value}`),
      ],
      metadata: {
        sourceKind: "skill",
        useWhen,
        avoidWhen,
        frontmatter: attributes,
      },
    }));
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

async function scanAgents(rootPath) {
  const agentsDir = path.join(rootPath, "agents");
  const entries = await safeReadDir(agentsDir);
  const agents = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".agent.md")) {
      continue;
    }
    const agentFile = path.join(agentsDir, entry.name);
    const content = await safeReadFile(agentFile);
    if (!content) {
      continue;
    }

    const { attributes, body } = parseFrontmatter(content);
    const name = typeof attributes.name === "string" && attributes.name
      ? attributes.name
      : entry.name.replace(/\.agent\.md$/, "");
    const description = typeof attributes.description === "string" ? attributes.description : "";
    const summary = extractLeadParagraph(body);
    const sourcePath = relativePath(rootPath, agentFile);
    const manualOnly = /manual-only/i.test(description) || /manual-only/i.test(summary);

    agents.push(buildCapabilityBase({
      id: `agent:${name}`,
      name,
      description,
      sourcePath,
      capabilityType: "agent",
      routeKindHints: ["agent"],
      summary,
      manualOnly,
      keywordParts: [
        { text: name, weight: 4 },
        { text: description, weight: 3 },
        { text: summary, weight: 2 },
        { text: body, weight: 1 },
      ],
      triggerCapabilities: [
        summary,
        manualOnly ? "manual-only" : "delegated",
      ],
      metadata: {
        sourceKind: "agent",
        frontmatter: attributes,
      },
    }));
  }

  return agents.sort((left, right) => left.name.localeCompare(right.name));
}

function extensionSummary(rootPath, extensionName, extensionFile, sourceText, toolNames) {
  return {
    name: extensionName,
    sourcePath: relativePath(rootPath, extensionFile),
    hookNames: extractHookNames(sourceText),
    toolNames: [...toolNames].sort(),
  };
}

async function scanExtensionSurfaces(rootPath) {
  const extensionsDir = path.join(rootPath, "extensions");
  const entries = await safeReadDir(extensionsDir);
  const extensions = [];
  const tools = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const extensionFile = path.join(extensionsDir, entry.name, "extension.mjs");
    const sourceText = await safeReadFile(extensionFile);
    if (!sourceText) {
      continue;
    }

    const toolSpecs = entry.name === "coherence" ? [] : extractToolSpecs(sourceText);
    const sourcePath = relativePath(rootPath, extensionFile);
    for (const tool of toolSpecs) {
      tools.push(buildCapabilityBase({
        id: `tool:${tool.name}`,
        name: tool.name,
        description: tool.description || `${entry.name} tool`,
        sourcePath,
        capabilityType: "tool",
        routeKindHints: buildToolRouteHints(tool.name, entry.name),
        summary: `${entry.name} extension tool`,
        keywordParts: [
          { text: tool.name, weight: 4 },
          { text: tool.description, weight: 3 },
          { text: entry.name, weight: 1 },
        ],
        triggerCapabilities: [
          entry.name,
          ...buildToolRouteHints(tool.name, entry.name),
        ],
        metadata: {
          sourceKind: "extension_tool",
          extensionName: entry.name,
        },
      }));
    }

    extensions.push(extensionSummary(
      rootPath,
      entry.name,
      extensionFile,
      sourceText,
      toolSpecs.map((tool) => tool.name),
    ));
  }

  const coherenceToolsFile = path.join(rootPath, "extensions", "coherence", "lib", "memory-tools.mjs");
  const coherenceToolsText = await safeReadFile(coherenceToolsFile);
  if (coherenceToolsText) {
    const coherenceTools = extractToolSpecs(coherenceToolsText);
    for (const tool of coherenceTools) {
      tools.push(buildCapabilityBase({
        id: `tool:${tool.name}`,
        name: tool.name,
        description: tool.description || "coherence tool",
        sourcePath: relativePath(rootPath, coherenceToolsFile),
        capabilityType: "tool",
        routeKindHints: buildToolRouteHints(tool.name, "coherence"),
        summary: "coherence extension tool",
        keywordParts: [
          { text: tool.name, weight: 4 },
          { text: tool.description, weight: 3 },
          { text: "coherence memory retrieval diagnostics backfill", weight: 1 },
        ],
        triggerCapabilities: [
          "coherence",
          ...buildToolRouteHints(tool.name, "coherence"),
        ],
        metadata: {
          sourceKind: "coherence_tool",
          extensionName: "coherence",
        },
      }));
    }

    const coherenceEntry = extensions.find((extension) => extension.name === "coherence");
    if (coherenceEntry) {
      coherenceEntry.toolNames = [...new Set([...coherenceEntry.toolNames, ...coherenceTools.map((tool) => tool.name)])]
        .sort();
      coherenceEntry.toolSourcePaths = [
        coherenceEntry.sourcePath,
        relativePath(rootPath, coherenceToolsFile),
      ];
    }
  }

  const dedupedTools = tools.filter((tool, index, array) =>
    array.findIndex((candidate) => candidate.id === tool.id) === index
  );

  return {
    extensions: extensions.sort((left, right) => left.name.localeCompare(right.name)),
    tools: dedupedTools.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function scanCapabilityInventory({ rootPath = DEFAULT_REPO_ROOT } = {}) {
  const [skills, agents, extensionScan] = await Promise.all([
    scanSkills(rootPath),
    scanAgents(rootPath),
    scanExtensionSurfaces(rootPath),
  ]);

  const capabilities = [...skills, ...agents, ...extensionScan.tools];
  const routes = buildRouteEntries(capabilities);
  const manifest = capabilities.map(buildManifestEntry);
  const routerCorpus = buildRouterCorpusScaffold();

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "local_first_inventory",
    manifestVersion: 1,
    rootPath,
    counts: {
      skills: skills.length,
      agents: agents.length,
      extensions: extensionScan.extensions.length,
      tools: extensionScan.tools.length,
      capabilities: capabilities.length,
      manifestEntries: manifest.length,
      routes: routes.length,
    },
    routes: routes.map((route) => ({
      id: route.id,
      label: route.label,
      explanation: route.explanation,
      supportLevel: route.supportLevel,
      available: route.available,
      recommendedWhen: route.recommendedWhen,
      supportingCapabilityIds: route.supportingCapabilityIds,
      gaps: route.gaps,
    })),
    skills,
    agents,
    extensions: extensionScan.extensions.map((extension) => ({
      ...extension,
      toolCount: extension.toolNames.length,
    })),
    tools: extensionScan.tools,
    capabilities,
    manifest,
    routerCorpus,
  };
}

export function recommendCapabilityRoute({ prompt, inventory, limit = 5 }) {
  const promptProfile = buildPromptProfile(prompt, inventory.capabilities);
  const { normalizedPrompt, promptTokens, promptNeed } = promptProfile;
  const capabilityMatches = inventory.capabilities
    .map((capability) => scoreCapability(capability, promptTokens, normalizedPrompt))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
  const capabilityMatchMap = new Map(capabilityMatches.map((match) => [match.capabilityId, match]));

  const routeEntries = buildRouteEntries(inventory.capabilities);
  const routeCandidates = routeEntries
    .map((route) => {
      const scoredRoute = scoreRoute(route, promptTokens, normalizedPrompt, capabilityMatches);
      const selectedTarget = selectRouteTarget(
        inventory.capabilities,
        scoredRoute.route,
        promptProfile,
        scoredRoute.supportingMatches,
        capabilityMatchMap,
      );
      const { heuristicScore, reasons } = buildRouteHeuristicAdjustment(
        scoredRoute,
        promptProfile,
        selectedTarget,
      );
      return {
        ...scoredRoute,
        baseScore: scoredRoute.score,
        heuristicScore,
        score: scoredRoute.score + heuristicScore,
        selectedTarget,
        targetName: selectedTarget?.targetName ?? null,
        targetType: selectedTarget?.targetType ?? null,
        executionMode: selectedTarget?.executionMode ?? null,
        reasons,
      };
    })
    .sort((left, right) => right.score - left.score || left.label.localeCompare(right.label));

  const primaryRoute = routeCandidates[0] ?? {
    route: "direct",
    label: "Direct or no-op",
    score: 0,
    matchedTokens: [],
    supportingMatches: [],
    supportLevel: "ready",
    available: true,
    gaps: [],
    selectedTarget: {
      capabilityId: null,
      targetName: "direct_response",
      targetType: "direct",
      executionMode: "direct",
      sourcePath: null,
      description: "Respond directly without invoking another local surface.",
      manualOnly: false,
      matchScore: 0,
      nameMatched: false,
      rationale: "No stronger local capability needs to be recommended.",
    },
    targetName: "direct_response",
    targetType: "direct",
    executionMode: "direct",
    reasons: ["No stronger local route signal was detected."],
  };
  const confidence = buildConfidence(primaryRoute, routeCandidates[1] ?? null);

  return {
    mode: "router_core_recommendation",
    prompt,
    promptTokens,
    promptNeed,
    promptProfile: {
      greeting: promptProfile.greeting,
      referenceQuestion: promptProfile.referenceQuestion,
      simplePrompt: promptProfile.simplePrompt,
      explainIntent: promptProfile.explainIntent,
      reflectIntent: promptProfile.reflectIntent,
      searchIntent: promptProfile.searchIntent,
      planBeforeExecution: promptProfile.planBeforeExecution,
      migrationIntent: promptProfile.migrationIntent,
      ciMigrationIntent: promptProfile.ciMigrationIntent,
      skillIntentScore: promptProfile.skillIntentScore,
      agentIntentScore: promptProfile.agentIntentScore,
      backgroundIntentScore: promptProfile.backgroundIntentScore,
      directIntentScore: promptProfile.directIntentScore,
    },
    primaryRoute,
    confidence,
    routeCandidates: routeCandidates.slice(0, Math.max(1, limit)),
    capabilityMatches: capabilityMatches.slice(0, Math.max(1, limit)),
    manifestMatches: capabilityMatches.slice(0, Math.max(1, limit)).map((match) => ({
      id: match.capabilityId,
      routeKind: match.routeKind,
      targetName: match.targetName,
      targetType: match.targetType,
      sourcePath: match.sourcePath,
      executionMode: match.executionMode,
      triggerTerms: match.triggerTerms,
      triggerCapabilities: match.triggerCapabilities,
      explanation: match.explanationMetadata,
      score: match.score,
      matchedTokens: match.matchedTokens,
      nameMatched: match.nameMatched,
    })),
  };
}

function evaluateRouterAssertions(definition, recommendation) {
  const assertions = [];
  const record = (label, passed, details) => {
    assertions.push({ label, passed, details });
  };

  record(
    `route === ${definition.expectedRouteKind}`,
    recommendation.primaryRoute?.route === definition.expectedRouteKind,
    `actual=${recommendation.primaryRoute?.route ?? "unknown"}`,
  );
  record(
    `target === ${definition.expectedTargetName}`,
    recommendation.primaryRoute?.targetName === definition.expectedTargetName,
    `actual=${recommendation.primaryRoute?.targetName ?? "unknown"}`,
  );
  record(
    `executionMode === ${definition.expectedExecutionMode}`,
    recommendation.primaryRoute?.executionMode === definition.expectedExecutionMode,
    `actual=${recommendation.primaryRoute?.executionMode ?? "unknown"}`,
  );
  record(
    `confidence >= ${definition.minConfidence ?? 0.75}`,
    Number(recommendation.confidence?.value ?? 0) >= Number(definition.minConfidence ?? 0.75),
    `actual=${recommendation.confidence?.value ?? 0}`,
  );
  record(
    "primary route has reasons",
    Array.isArray(recommendation.primaryRoute?.reasons) && recommendation.primaryRoute.reasons.length > 0,
    `actual=${recommendation.primaryRoute?.reasons?.length ?? 0}`,
  );
  record(
    "route candidates are present",
    Array.isArray(recommendation.routeCandidates) && recommendation.routeCandidates.length > 0,
    `actual=${recommendation.routeCandidates?.length ?? 0}`,
  );
  if (definition.expectedRouteKind !== "direct") {
    record(
      "matched capabilities are present",
      Array.isArray(recommendation.capabilityMatches) && recommendation.capabilityMatches.length > 0,
      `actual=${recommendation.capabilityMatches?.length ?? 0}`,
    );
  }

  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
  };
}

export async function evaluateCapabilityRouter({
  rootPath = DEFAULT_REPO_ROOT,
  caseIds = [],
  limit = 5,
} = {}) {
  const inventory = await scanCapabilityInventory({ rootPath });
  const selectedCases = caseIds.length > 0
    ? ROUTER_EVALUATION_CASES.filter((item) => caseIds.includes(item.id))
    : ROUTER_EVALUATION_CASES;

  const cases = selectedCases.map((definition) => {
    const recommendation = recommendCapabilityRoute({
      prompt: definition.prompt,
      inventory,
      limit,
    });
    const evaluation = evaluateRouterAssertions(definition, recommendation);
    return {
      id: definition.id,
      title: definition.notes,
      prompt: definition.prompt,
      expectedRouteKind: definition.expectedRouteKind,
      expectedTargetName: definition.expectedTargetName,
      expectedExecutionMode: definition.expectedExecutionMode,
      minConfidence: definition.minConfidence ?? 0.75,
      passed: evaluation.passed,
      assertions: evaluation.assertions,
      recommendation: {
        primaryRoute: recommendation.primaryRoute,
        confidence: recommendation.confidence,
        promptProfile: recommendation.promptProfile,
      },
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    schemaVersion: 1,
    mode: "router_corpus_evaluation",
    total: cases.length,
    passed: cases.filter((item) => item.passed).length,
    failed: cases.filter((item) => !item.passed).length,
    routeCoverage: [...new Set(cases.map((item) => item.expectedRouteKind))].sort(),
    successBar: [
      "Every corpus case should produce a traceable route explanation.",
      "Recommendation output should name the matched local target when one exists.",
      "The corpus should cover retrieval, skill, agent, background, and direct route families.",
      "Automatic invocation stays disabled until a later evaluation slice approves it.",
    ],
    cases,
  };
}

export function renderCapabilityEvaluationReport(result) {
  const lines = [
    "## Capability Router Evaluation",
    "",
    `mode: ${result.mode}`,
    `generatedAt: ${result.generatedAt}`,
    `cases: ${result.total}`,
    `passed: ${result.passed}`,
    `failed: ${result.failed}`,
    `routeCoverage: ${result.routeCoverage.join(", ") || "none"}`,
    "",
    "## Success Bar",
    "",
    ...result.successBar.map((item) => `- ${item}`),
    "",
    "## Cases",
    "",
  ];

  for (const item of result.cases) {
    lines.push(
      `- ${item.passed ? "PASS" : "FAIL"} ${item.id}`,
      `  expected: ${item.expectedRouteKind} -> ${item.expectedTargetName} (${item.expectedExecutionMode})`,
      `  actual: ${item.recommendation.primaryRoute?.route ?? "unknown"} -> ${item.recommendation.primaryRoute?.targetName ?? "unknown"} (${item.recommendation.primaryRoute?.executionMode ?? "unknown"})`,
      `  confidence: ${item.recommendation.confidence?.label ?? "unknown"} (${item.recommendation.confidence?.value ?? 0})`,
      `  prompt: ${item.prompt}`,
    );
    const failedAssertions = item.assertions.filter((assertion) => assertion.passed === false);
    if (failedAssertions.length > 0) {
      lines.push(`  failedAssertions: ${failedAssertions.map((assertion) => `${assertion.label} [${assertion.details}]`).join(" | ")}`);
    }
  }

  return lines.join("\n");
}

function formatCapability(capability) {
  return [
    `- [${capability.capabilityType}] ${capability.name}`,
    `routeKind=${capability.routeKind}`,
    capability.manualOnly ? "manualOnly=true" : null,
    `executionMode=${capability.executionMode}`,
    capability.routeKindHints.length > 0 ? `routeHints=${capability.routeKindHints.join(",")}` : null,
    capability.triggerCapabilities.length > 0 ? `triggerCapabilities=${capability.triggerCapabilities.slice(0, 4).join(",")}` : null,
    capability.description ? `description=${capability.description}` : null,
    capability.sourcePath ? `source=${capability.sourcePath}` : null,
  ].filter(Boolean).join(" ");
}

function formatRoute(route) {
  return [
    `- ${route.id}`,
    `available=${route.available}`,
    `support=${route.supportLevel}`,
    `supportingCapabilities=${route.supportingCapabilityIds.length}`,
    route.gaps.length > 0 ? `gaps=${route.gaps.join(" | ")}` : null,
  ].filter(Boolean).join(" ");
}

function takeLimited(list, limit) {
  return list.slice(0, Math.max(1, limit));
}

export function renderCapabilityInventoryReport(inventory, { detailLevel = "summary", limit = 6 } = {}) {
  const lines = [
    "## Capability Inventory",
    "",
    `mode: ${inventory.mode}`,
    `generatedAt: ${inventory.generatedAt}`,
    `rootPath: ${inventory.rootPath}`,
    `skills: ${inventory.counts.skills}`,
    `agents: ${inventory.counts.agents}`,
    `extensions: ${inventory.counts.extensions}`,
    `tools: ${inventory.counts.tools}`,
    `capabilities: ${inventory.counts.capabilities}`,
    `manifestEntries: ${inventory.counts.manifestEntries}`,
    "",
    "## Route Families",
    "",
    ...inventory.routes.map(formatRoute),
  ];

  if (detailLevel === "full") {
    lines.push(
      "",
      "## Skills",
      "",
      ...(inventory.skills.length > 0 ? inventory.skills.map(formatCapability) : ["- none"]),
      "",
      "## Agents",
      "",
      ...(inventory.agents.length > 0 ? inventory.agents.map(formatCapability) : ["- none"]),
      "",
      "## Tools",
      "",
      ...(inventory.tools.length > 0 ? inventory.tools.map(formatCapability) : ["- none"]),
      "",
      "## Manifest Entries",
      "",
      ...(inventory.manifest.length > 0
        ? inventory.manifest.map((entry) =>
          `- ${entry.id} routeKind=${entry.routeKind} target=${entry.targetName} executionMode=${entry.executionMode} source=${entry.sourcePath} triggerTerms=${entry.triggerTerms.slice(0, 6).join(",") || "none"}`,
        )
        : ["- none"]),
      "",
      "## Extensions",
      "",
      ...(inventory.extensions.length > 0
        ? inventory.extensions.map((extension) =>
          `- ${extension.name} hooks=${extension.hookNames.join(",") || "none"} tools=${extension.toolNames.join(",") || "none"} source=${extension.sourcePath}`,
        )
        : ["- none"]),
      "",
      "## Router Corpus Scaffold",
      "",
      `- status=${inventory.routerCorpus.status} explanationMode=${inventory.routerCorpus.explanationMode}`,
      ...inventory.routerCorpus.routeFamilies.map((family) =>
        `- ${family.id} expectedRouteKind=${family.expectedRouteKind} description=${family.description}`,
      ),
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    "## Representative Capabilities",
    "",
    ...(takeLimited(inventory.capabilities, limit).map(formatCapability)),
  );
  return lines.join("\n");
}

export function renderCapabilityRecommendationReport(recommendation, { limit = 5 } = {}) {
  const lines = [
    "## Capability Routing Recommendation",
    "",
    `mode: ${recommendation.mode}`,
    `prompt: ${recommendation.prompt}`,
    `primaryRoute: ${recommendation.primaryRoute.route}`,
    `primaryLabel: ${recommendation.primaryRoute.label}`,
    `primaryTarget: ${recommendation.primaryRoute.targetName ?? "none"}`,
    `primaryTargetType: ${recommendation.primaryRoute.targetType ?? "none"}`,
    `primaryExecutionMode: ${recommendation.primaryRoute.executionMode ?? "none"}`,
    `primaryScore: ${recommendation.primaryRoute.score}`,
    `confidence: ${recommendation.confidence?.label ?? "unknown"}${recommendation.confidence?.value != null ? ` (${recommendation.confidence.value})` : ""}`,
    `supportLevel: ${recommendation.primaryRoute.supportLevel}`,
    `matchedPromptTokens: ${recommendation.promptTokens.join(", ") || "none"}`,
    `requiresLookup: ${recommendation.promptNeed?.requiresLookup === true}`,
    `hasTemporalSignal: ${recommendation.promptNeed?.hasTemporalSignal === true}`,
    `wantsContinuity: ${recommendation.promptNeed?.wantsContinuity === true}`,
    `greeting: ${recommendation.promptProfile?.greeting === true}`,
    "",
    "## Why This Route",
    "",
    ...(recommendation.primaryRoute.reasons?.length > 0
      ? recommendation.primaryRoute.reasons.map((reason) => `- ${reason}`)
      : ["- No explicit rationale recorded."]),
    "",
    "## Ranked Route Candidates",
    "",
  ];

  for (const candidate of takeLimited(recommendation.routeCandidates, limit)) {
    lines.push(
      `- ${candidate.route} score=${candidate.score} base=${candidate.baseScore ?? candidate.score} heuristic=${candidate.heuristicScore ?? 0} support=${candidate.supportLevel} available=${candidate.available}`,
      `  target: ${candidate.targetName ?? "none"} (${candidate.targetType ?? "none"}, ${candidate.executionMode ?? "none"})`,
      `  matchedTokens: ${candidate.matchedTokens.join(", ") || "none"}`,
      `  supportingMatches: ${candidate.supportingMatches.map((match) => match.name).join(", ") || "none"}`,
    );
    if (candidate.reasons?.length > 0) {
      lines.push(`  reasons: ${candidate.reasons.join(" | ")}`);
    }
    if (candidate.gaps.length > 0) {
      lines.push(`  gaps: ${candidate.gaps.join(" | ")}`);
    }
  }

  lines.push("", "## Matched Local Capabilities", "");
  const capabilityMatches = takeLimited(recommendation.capabilityMatches, limit);
  if (capabilityMatches.length === 0) {
    lines.push("- none");
  } else {
    for (const match of capabilityMatches) {
      lines.push(
        `- [${match.capabilityType}] ${match.name} score=${match.score} routeHints=${match.routeKindHints.join(",") || "none"}${match.nameMatched ? " nameMatched=true" : ""}`,
        `  routeKind: ${match.routeKind}`,
        `  executionMode: ${match.executionMode}`,
        `  matchedTokens: ${match.matchedTokens.join(", ") || "none"}`,
        `  triggerTerms: ${match.triggerTerms.join(", ") || "none"}`,
        `  triggerCapabilities: ${match.triggerCapabilities.join(", ") || "none"}`,
        `  source: ${match.sourcePath}`,
        `  description: ${match.description}`,
      );
    }
  }

  lines.push(
    "",
    "## Recommendation Notes",
    "",
    "- This router core is recommendation-only; it does not invoke skills, agents, or background work automatically.",
    "- The inventory is local-first and scans repo-authored skills, agents, and extension/coherence tool surfaces.",
    "- Retrieval targets are selected explicitly among coherence_recall, coherence_reflect, memory_search, and memory_explain.",
  );

  return lines.join("\n");
}
