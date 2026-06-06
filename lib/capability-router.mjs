/**
 * Prompt-to-capability routing, scoring, and evaluation helpers.
 */

import { detectPromptContextNeed } from "./capsule-assembler.mjs";
import { scanCapabilityInventory } from "./capability-scanner.mjs";
import {
  DEFAULT_REPO_ROOT,
  ROUTER_EVALUATION_CASES,
  ROUTER_SIGNAL_PHRASES,
  buildRouteEntries,
  normalizeText,
  tokenize,
} from "./capability-utils.mjs";

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
  const hasReversePromptSkill = Boolean(capabilityForName(capabilities, "reverse-prompt"));
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
  const promptRewriteIntent = countPhraseMatches(normalizedPrompt, ROUTER_SIGNAL_PHRASES.promptRewrite) > 0;
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
    hasReversePromptSkill,
    greeting,
    referenceQuestion,
    explainIntent,
    reflectIntent,
    searchIntent,
    promptRewriteIntent,
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
  let targetName = "lore_recall";
  let rationale = "Prompt asks for local recall or continuity context.";
  if (promptProfile.explainIntent) {
    targetName = "memory_explain";
    rationale = "Prompt asks for an explanation or trace of local context selection.";
  } else if (promptProfile.reflectIntent) {
    targetName = "lore_reflect";
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

function selectSkillRouteTarget(capabilities, promptProfile, supportingMatches, matchMap) {
  if (promptProfile.promptRewriteIntent) {
    const reversePrompt = capabilityForName(capabilities, "reverse-prompt");
    const reversePromptMatch = reversePrompt ? matchMap.get(reversePrompt.id) : null;
    if (reversePrompt && reversePromptMatch?.score > 0) {
      return buildTargetReference(
        reversePrompt,
        reversePromptMatch,
        "Prompt explicitly asks for prompt sharpening or rewrite work.",
      );
    }
  }
  const filteredMatches = promptProfile.promptRewriteIntent
    ? supportingMatches
    : supportingMatches.filter((match) => {
      const capability = capabilityForId(capabilities, match.capabilityId);
      return capability?.name !== "reverse-prompt";
    });
  return selectMatchedCapabilityTarget(capabilities, "skill", filteredMatches);
}

function buildDirectRouteTarget() {
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

function selectRouteTarget(capabilities, routeId, promptProfile, supportingMatches, matchMap) {
  const routeSelectors = {
    retrieval: () => selectRetrievalTarget(capabilities, promptProfile, matchMap),
    background_task: () => selectBackgroundTarget(capabilities, promptProfile, matchMap),
    skill: () => selectSkillRouteTarget(capabilities, promptProfile, supportingMatches, matchMap),
    agent: () => selectMatchedCapabilityTarget(capabilities, "agent", supportingMatches),
    direct: () => buildDirectRouteTarget(),
  };
  return routeSelectors[routeId]?.() ?? null;
}

function addHeuristicReason(state, scoreDelta, reason) {
  state.heuristicScore += scoreDelta;
  state.reasons.push(reason);
}

function addTargetRationale(state, selectedTarget) {
  if (selectedTarget?.rationale) {
    state.reasons.push(selectedTarget.rationale);
  }
}

function resolveExplicitIntentScore(routeId, promptProfile) {
  if (routeId === "skill") {
    return promptProfile.skillIntentScore ?? 0;
  }
  if (routeId === "agent") {
    return promptProfile.agentIntentScore ?? 0;
  }
  if (routeId === "background_task") {
    return promptProfile.backgroundIntentScore ?? 0;
  }
  return promptProfile.directIntentScore ?? 0;
}

function applySharedRouteHeuristics(routeCandidate, state) {
  if (routeCandidate.available !== true) {
    addHeuristicReason(state, -20, "No local capability currently supports this route family.");
  }
  if (routeCandidate.supportLevel === "placeholder") {
    addHeuristicReason(state, -4, "This route family is only partially represented in the current local slice.");
  }
}

function applyRetrievalRouteHeuristics({ promptProfile, selectedTarget, state }) {
  if (promptProfile.promptNeed.requiresLookup) {
    addHeuristicReason(state, 12, "Prompt needs remembered, temporal, or continuity-aware local context.");
  }
  if (promptProfile.promptNeed.wantsContinuity) {
    addHeuristicReason(state, 6, "Continuity language prefers retrieval before delegation.");
  }
  if (promptProfile.promptNeed.hasTemporalSignal) {
    addHeuristicReason(state, 8, "Temporal language is a strong retrieval signal.");
  }
  if (promptProfile.explainIntent) {
    addHeuristicReason(state, 5, "Explain/trace phrasing maps well to memory_explain.");
  }
  if (promptProfile.reflectIntent) {
    addHeuristicReason(state, 5, "Reflection phrasing maps well to lore_reflect.");
  }
  if (promptProfile.searchIntent) {
    addHeuristicReason(state, 4, "Search/list phrasing maps to a retrieval surface.");
  }
  addTargetRationale(state, selectedTarget);
}

function buildSkillRewriteHeuristicAdjustments(promptProfile, selectedTarget) {
  if (promptProfile.promptRewriteIntent && selectedTarget?.targetName === "reverse-prompt") {
    return [
      {
        scoreDelta: 18,
        reason: "Explicit prompt-sharpening requests should prefer the reverse-prompt skill.",
      },
    ];
  }

  return [];
}

function buildSkillExplicitIntentHeuristicAdjustments(explicitIntentScore) {
  if (explicitIntentScore <= 0) {
    return [];
  }

  return [
    {
      scoreDelta: 8 + explicitIntentScore,
      reason: "Prompt explicitly asks for a reusable workflow or skill-like playbook.",
    },
  ];
}

function buildSkillTargetMatchHeuristicAdjustments(selectedTarget, targetMatchScore) {
  if (targetMatchScore <= 0) {
    return [];
  }

  return [
    {
      scoreDelta: Math.min(8, targetMatchScore),
      reason: `Matched skill target ${selectedTarget.targetName}.`,
    },
  ];
}

function buildSkillConservativeHeuristicAdjustments(explicitIntentScore, targetMatchScore) {
  if (explicitIntentScore !== 0 || targetMatchScore >= 7) {
    return [];
  }

  return [
    {
      scoreDelta: -8,
      reason: "Skill routing stays conservative without a clear workflow or skill signal.",
    },
  ];
}

function buildSkillLookupHeuristicAdjustments(promptProfile, explicitIntentScore) {
  if (!promptProfile.promptNeed.requiresLookup || explicitIntentScore !== 0) {
    return [];
  }

  return [
    {
      scoreDelta: -6,
      reason: "Prompt looks more like recall/explanation than a skill workflow.",
    },
  ];
}

function buildSkillReferenceHeuristicAdjustments(promptProfile, explicitIntentScore, selectedTarget) {
  if (
    !promptProfile.referenceQuestion
    || promptProfile.promptNeed.requiresLookup === true
    || explicitIntentScore !== 0
    || selectedTarget?.nameMatched === true
  ) {
    return [];
  }

  return [
    {
      scoreDelta: -28,
      reason: "Generic reference questions should stay direct unless they clearly ask for a local workflow.",
    },
  ];
}

function buildSkillMigrationPlanningHeuristicAdjustments(promptProfile) {
  if (!promptProfile.planBeforeExecution || !promptProfile.ciMigrationIntent) {
    return [];
  }

  return [
    {
      scoreDelta: -16,
      reason: "Prompt asks for migration planning before editing, so orchestration should outrank a direct migration skill.",
    },
  ];
}

function buildSkillRouteHeuristicAdjustments({
  promptProfile,
  selectedTarget,
  explicitIntentScore,
  targetMatchScore,
}) {
  return [
    ...buildSkillRewriteHeuristicAdjustments(promptProfile, selectedTarget),
    ...buildSkillExplicitIntentHeuristicAdjustments(explicitIntentScore),
    ...buildSkillTargetMatchHeuristicAdjustments(selectedTarget, targetMatchScore),
    ...buildSkillConservativeHeuristicAdjustments(explicitIntentScore, targetMatchScore),
    ...buildSkillLookupHeuristicAdjustments(promptProfile, explicitIntentScore),
    ...buildSkillReferenceHeuristicAdjustments(promptProfile, explicitIntentScore, selectedTarget),
    ...buildSkillMigrationPlanningHeuristicAdjustments(promptProfile),
  ];
}

function applySkillRouteHeuristics({
  promptProfile,
  selectedTarget,
  explicitIntentScore,
  targetMatchScore,
  state,
}) {
  for (const adjustment of buildSkillRouteHeuristicAdjustments({
    promptProfile,
    selectedTarget,
    explicitIntentScore,
    targetMatchScore,
  })) {
    addHeuristicReason(state, adjustment.scoreDelta, adjustment.reason);
  }
}

function checkPromptResharpening(promptProfile) {
  return promptProfile.promptRewriteIntent && promptProfile.hasReversePromptSkill
    ? {
        scoreDelta: -18,
        reason: "Explicit prompt-sharpening requests should stay on the skill workflow path instead of agent delegation.",
      }
    : null;
}

function checkExplicitIntentScore(explicitIntentScore) {
  return explicitIntentScore > 0
    ? {
        scoreDelta: 8 + explicitIntentScore,
        reason: "Prompt asks for planning, research, delegation, or orchestration.",
      }
    : null;
}

function checkTargetMatch(targetMatchScore, selectedTarget) {
  return targetMatchScore > 0
    ? {
        scoreDelta: Math.min(8, targetMatchScore),
        reason: `Matched agent target ${selectedTarget.targetName}.`,
      }
    : null;
}

function checkManualOnlyAgent(selectedTarget, explicitIntentScore) {
  return selectedTarget?.manualOnly && explicitIntentScore === 0 && !selectedTarget.nameMatched
    ? {
        scoreDelta: -4,
        reason: "Manual-only agents need clearer delegation intent than this prompt provides.",
      }
    : null;
}

function checkConservativeRouting(explicitIntentScore, targetMatchScore) {
  return explicitIntentScore === 0 && targetMatchScore < 7
    ? {
        scoreDelta: -8,
        reason: "Agent routing stays conservative without clear delegation intent.",
      }
    : null;
}

function checkLookupIntent(promptProfile, explicitIntentScore) {
  return promptProfile.promptNeed.requiresLookup && explicitIntentScore === 0
    ? {
        scoreDelta: -8,
        reason: "Prompt looks like local recall/explanation instead of delegated work.",
      }
    : null;
}

function checkCiMigrationPlanFirst(promptProfile) {
  return promptProfile.planBeforeExecution && promptProfile.ciMigrationIntent
    ? {
        scoreDelta: 28,
        reason: "Plan-first CI migration prompts should prefer the migration orchestrator before execution.",
      }
    : null;
}

function buildAgentRouteHeuristicAdjustments({
  promptProfile,
  selectedTarget,
  explicitIntentScore,
  targetMatchScore,
}) {
  return [
    checkPromptResharpening(promptProfile),
    checkExplicitIntentScore(explicitIntentScore),
    checkTargetMatch(targetMatchScore, selectedTarget),
    checkManualOnlyAgent(selectedTarget, explicitIntentScore),
    checkConservativeRouting(explicitIntentScore, targetMatchScore),
    checkLookupIntent(promptProfile, explicitIntentScore),
    checkCiMigrationPlanFirst(promptProfile),
  ].filter((adjustment) => adjustment !== null);
}

function applyAgentRouteHeuristics({
  promptProfile,
  selectedTarget,
  explicitIntentScore,
  targetMatchScore,
  state,
}) {
  for (const adjustment of buildAgentRouteHeuristicAdjustments({
    promptProfile,
    selectedTarget,
    explicitIntentScore,
    targetMatchScore,
  })) {
    addHeuristicReason(state, adjustment.scoreDelta, adjustment.reason);
  }
}

function applyBackgroundTaskRouteHeuristics({
  selectedTarget,
  explicitIntentScore,
  targetMatchScore,
  state,
}) {
  if (explicitIntentScore > 0) {
    addHeuristicReason(state, 12 + explicitIntentScore, "Prompt explicitly mentions deferred, queued, or background work.");
  } else {
    addHeuristicReason(state, -10, "Background routing stays conservative without an explicit maintenance signal.");
  }
  if (targetMatchScore > 0) {
    addHeuristicReason(state, Math.min(6, targetMatchScore), `Matched background target ${selectedTarget.targetName}.`);
  }
  addTargetRationale(state, selectedTarget);
}

function buildDirectRouteHeuristicAdjustments(promptProfile) {
  const hasRoutingSignal = (
    promptProfile.skillIntentScore > 0
    || promptProfile.agentIntentScore > 0
    || promptProfile.backgroundIntentScore > 0
  );
  return [
    {
      applies: promptProfile.promptNeed.identityOnly,
      scoreDelta: 18,
      reason: "Identity-only or direct-address prompt does not need another local surface.",
    },
    {
      applies: promptProfile.greeting,
      scoreDelta: 6,
      reason: "Greeting-style prompt can be answered directly.",
    },
    {
      applies: (
        promptProfile.referenceQuestion
        && promptProfile.promptNeed.requiresLookup !== true
        && promptProfile.skillIntentScore === 0
        && promptProfile.agentIntentScore === 0
        && promptProfile.backgroundIntentScore === 0
      ),
      scoreDelta: 24,
      reason: "Generic reference question does not need a local workflow recommendation.",
    },
    {
      applies: !promptProfile.promptNeed.requiresLookup && promptProfile.simplePrompt,
      scoreDelta: 4,
      reason: "Short prompt with no recall/delegation signal fits a direct response.",
    },
    {
      applies: promptProfile.promptNeed.requiresLookup,
      scoreDelta: -8,
      reason: "Prompt needs local context, so direct/no-op is less appropriate.",
    },
    {
      applies: hasRoutingSignal,
      scoreDelta: -6,
      reason: "Prompt contains stronger routing signals than a direct/no-op response.",
    },
  ];
}

function applyDirectRouteHeuristics({ promptProfile, selectedTarget, state }) {
  for (const adjustment of buildDirectRouteHeuristicAdjustments(promptProfile)) {
    if (adjustment.applies) {
      addHeuristicReason(state, adjustment.scoreDelta, adjustment.reason);
    }
  }
  addTargetRationale(state, selectedTarget);
}

function buildRouteHeuristicAdjustment(routeCandidate, promptProfile, selectedTarget) {
  const state = {
    heuristicScore: 0,
    reasons: [],
  };
  const sharedContext = {
    promptProfile,
    selectedTarget,
    explicitIntentScore: resolveExplicitIntentScore(routeCandidate.route, promptProfile),
    targetMatchScore: selectedTarget?.matchScore ?? 0,
    state,
  };

  applySharedRouteHeuristics(routeCandidate, state);

  if (routeCandidate.route === "retrieval") {
    applyRetrievalRouteHeuristics(sharedContext);
  } else if (routeCandidate.route === "skill") {
    applySkillRouteHeuristics(sharedContext);
  } else if (routeCandidate.route === "agent") {
    applyAgentRouteHeuristics(sharedContext);
  } else if (routeCandidate.route === "background_task") {
    applyBackgroundTaskRouteHeuristics(sharedContext);
  } else if (routeCandidate.route === "direct") {
    applyDirectRouteHeuristics(sharedContext);
  }

  return state;
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

function rankCapabilityMatches(capabilities, promptTokens, normalizedPrompt) {
  return capabilities
    .map((capability) => scoreCapability(capability, promptTokens, normalizedPrompt))
    .filter((match) => match.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}

function rankRouteCandidates(capabilities, promptTokens, normalizedPrompt, promptProfile, capabilityMatches, capabilityMatchMap) {
  return buildRouteEntries(capabilities)
    .map((route) => {
      const scoredRoute = scoreRoute(route, promptTokens, normalizedPrompt, capabilityMatches);
      const selectedTarget = selectRouteTarget(
        capabilities,
        scoredRoute.route,
        promptProfile,
        scoredRoute.supportingMatches,
        capabilityMatchMap,
      );
      const { heuristicScore, reasons } = buildRouteHeuristicAdjustment(scoredRoute, promptProfile, selectedTarget);
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
}

function buildFallbackPrimaryRoute() {
  return {
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
}

function buildRecommendationResult(prompt, promptProfile, promptTokens, promptNeed, primaryRoute, confidence, routeCandidates, capabilityMatches, limit) {
  const sliceLimit = Math.max(1, limit);
  return {
    mode: "router_core_recommendation",
    prompt,
    promptTokens,
    promptNeed,
    promptProfile: {
      hasReversePromptSkill: promptProfile.hasReversePromptSkill,
      greeting: promptProfile.greeting,
      referenceQuestion: promptProfile.referenceQuestion,
      simplePrompt: promptProfile.simplePrompt,
      explainIntent: promptProfile.explainIntent,
      reflectIntent: promptProfile.reflectIntent,
      searchIntent: promptProfile.searchIntent,
      promptRewriteIntent: promptProfile.promptRewriteIntent,
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
    routeCandidates: routeCandidates.slice(0, sliceLimit),
    capabilityMatches: capabilityMatches.slice(0, sliceLimit),
    manifestMatches: capabilityMatches.slice(0, sliceLimit).map((match) => ({
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

function buildRouterAssertion(label, passed, details) {
  return { label, passed, details };
}

function buildExpectedValueAssertion(label, expected, actual) {
  return buildRouterAssertion(
    `${label} === ${expected}`,
    actual === expected,
    `actual=${actual ?? "unknown"}`,
  );
}

function buildCountAssertion(label, items) {
  const count = Array.isArray(items) ? items.length : 0;
  return buildRouterAssertion(
    `${label} are present`,
    count > 0,
    `actual=${count}`,
  );
}

function buildBaseRouterAssertions({
  definition,
  primaryRoute,
  recommendation,
  minConfidence,
  confidenceValue,
}) {
  return [
    buildExpectedValueAssertion("route", definition.expectedRouteKind, primaryRoute.route),
    buildExpectedValueAssertion("target", definition.expectedTargetName, primaryRoute.targetName),
    buildExpectedValueAssertion("executionMode", definition.expectedExecutionMode, primaryRoute.executionMode),
    buildRouterAssertion(
      `confidence >= ${minConfidence}`,
      confidenceValue >= minConfidence,
      `actual=${confidenceValue}`,
    ),
    buildCountAssertion("primary route reasons", primaryRoute.reasons),
    buildCountAssertion("route candidates", recommendation.routeCandidates),
  ];
}

function buildCapabilityPresenceAssertion(definition, recommendation) {
  if (definition.expectedRouteKind === "direct") {
    return null;
  }
  return buildRouterAssertion(
    "matched capabilities are present",
    Array.isArray(recommendation.capabilityMatches) && recommendation.capabilityMatches.length > 0,
    `actual=${recommendation.capabilityMatches?.length ?? 0}`,
  );
}

function evaluateRouterAssertions(definition, recommendation) {
  const primaryRoute = recommendation.primaryRoute ?? {};
  const minConfidence = Number(definition.minConfidence ?? 0.75);
  const confidenceValue = Number(recommendation.confidence?.value ?? 0);
  const assertions = buildBaseRouterAssertions({
    definition,
    primaryRoute,
    recommendation,
    minConfidence,
    confidenceValue,
  });
  const capabilityAssertion = buildCapabilityPresenceAssertion(definition, recommendation);
  if (capabilityAssertion) {
    assertions.push(capabilityAssertion);
  }

  return {
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
  };
}

/**
 * Recommend the best local capability route for a prompt against a scanned inventory.
 *
 * @param {{ prompt: string, inventory: object, limit?: number }} options
 * @returns {object}
 */
export function recommendCapabilityRoute({ prompt, inventory, limit = 5 }) {
  const promptProfile = buildPromptProfile(prompt, inventory.capabilities);
  const { normalizedPrompt, promptTokens, promptNeed } = promptProfile;
  const capabilityMatches = rankCapabilityMatches(inventory.capabilities, promptTokens, normalizedPrompt);
  const capabilityMatchMap = new Map(capabilityMatches.map((match) => [match.capabilityId, match]));
  const routeCandidates = rankRouteCandidates(
    inventory.capabilities, promptTokens, normalizedPrompt, promptProfile, capabilityMatches, capabilityMatchMap,
  );
  const primaryRoute = routeCandidates[0] ?? buildFallbackPrimaryRoute();
  const confidence = buildConfidence(primaryRoute, routeCandidates[1] ?? null);
  return buildRecommendationResult(prompt, promptProfile, promptTokens, promptNeed, primaryRoute, confidence, routeCandidates, capabilityMatches, limit);
}

/**
 * Evaluate router recommendations against the built-in routing corpus.
 *
 * @param {{ rootPath?: string, caseIds?: string[], limit?: number }} [options]
 * @returns {Promise<object>}
 */
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
