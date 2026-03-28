/**
 * external-safety-gates.mjs — observe-only risk classification for future
 * external MCP mutation flows.
 *
 * This module intentionally does not enforce or intercept tool execution.
 * It only classifies hypothetical/planned actions and emits typed summaries
 * that can be reported via existing Coherence tooling surfaces.
 */

export const SAFETY_GATE_MUTABILITY = Object.freeze({
  READ_ONLY: "read_only",
  APPEND_ONLY: "append_only",
  METADATA_UPDATE: "metadata_update",
  DESTRUCTIVE_WRITE: "destructive_write",
});

export const SAFETY_GATE_REVERSIBILITY = Object.freeze({
  REVERSIBLE: "reversible",
  OPERATOR_REVERSIBLE: "operator_reversible",
  DIFFICULT: "difficult",
  IRREVERSIBLE: "irreversible",
});

export const SAFETY_GATE_SCOPE = Object.freeze({
  ISOLATED: "isolated",
  REPOSITORY: "repository",
  WORKSPACE: "workspace",
  MULTI_WORKSPACE: "multi_workspace",
  EXTERNAL_SYSTEM: "external_system",
});

export const SAFETY_GATE_SERVICE_TRUST = Object.freeze({
  TRUSTED: "trusted",
  CONSTRAINED: "constrained",
  UNKNOWN: "unknown",
  UNTRUSTED: "untrusted",
});

const MUTABILITY_SCORE = Object.freeze({
  [SAFETY_GATE_MUTABILITY.READ_ONLY]: 0,
  [SAFETY_GATE_MUTABILITY.APPEND_ONLY]: 1,
  [SAFETY_GATE_MUTABILITY.METADATA_UPDATE]: 2,
  [SAFETY_GATE_MUTABILITY.DESTRUCTIVE_WRITE]: 4,
});

const REVERSIBILITY_SCORE = Object.freeze({
  [SAFETY_GATE_REVERSIBILITY.REVERSIBLE]: 0,
  [SAFETY_GATE_REVERSIBILITY.OPERATOR_REVERSIBLE]: 1,
  [SAFETY_GATE_REVERSIBILITY.DIFFICULT]: 2,
  [SAFETY_GATE_REVERSIBILITY.IRREVERSIBLE]: 4,
});

const SCOPE_SCORE = Object.freeze({
  [SAFETY_GATE_SCOPE.ISOLATED]: 0,
  [SAFETY_GATE_SCOPE.REPOSITORY]: 1,
  [SAFETY_GATE_SCOPE.WORKSPACE]: 2,
  [SAFETY_GATE_SCOPE.MULTI_WORKSPACE]: 3,
  [SAFETY_GATE_SCOPE.EXTERNAL_SYSTEM]: 4,
});

const TRUST_SCORE = Object.freeze({
  [SAFETY_GATE_SERVICE_TRUST.TRUSTED]: 0,
  [SAFETY_GATE_SERVICE_TRUST.CONSTRAINED]: 1,
  [SAFETY_GATE_SERVICE_TRUST.UNKNOWN]: 2,
  [SAFETY_GATE_SERVICE_TRUST.UNTRUSTED]: 3,
});

function nowIso() {
  return new Date().toISOString();
}

function normalizeString(value, fallback = null) {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function normalizeEnum(value, allowedValues, fallback) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallback;
  }
  return allowedValues.includes(normalized) ? normalized : fallback;
}

function deriveRiskTier(score) {
  if (score >= 12) {
    return "critical";
  }
  if (score >= 8) {
    return "high";
  }
  if (score >= 4) {
    return "moderate";
  }
  return "low";
}

function buildRiskReasons({ mutability, reversibility, scope, serviceTrust }) {
  const reasons = [];
  if (mutability === SAFETY_GATE_MUTABILITY.DESTRUCTIVE_WRITE) {
    reasons.push("destructive-write");
  } else if (mutability === SAFETY_GATE_MUTABILITY.METADATA_UPDATE) {
    reasons.push("metadata-mutation");
  } else if (mutability === SAFETY_GATE_MUTABILITY.APPEND_ONLY) {
    reasons.push("append-mutation");
  }

  if (reversibility === SAFETY_GATE_REVERSIBILITY.IRREVERSIBLE) {
    reasons.push("irreversible");
  } else if (reversibility === SAFETY_GATE_REVERSIBILITY.DIFFICULT) {
    reasons.push("hard-to-reverse");
  }

  if (scope === SAFETY_GATE_SCOPE.MULTI_WORKSPACE || scope === SAFETY_GATE_SCOPE.EXTERNAL_SYSTEM) {
    reasons.push("broad-scope");
  }

  if (serviceTrust === SAFETY_GATE_SERVICE_TRUST.UNKNOWN || serviceTrust === SAFETY_GATE_SERVICE_TRUST.UNTRUSTED) {
    reasons.push("low-service-trust");
  }
  return reasons;
}

/**
 * Classify a single hypothetical/planned tool action.
 * @param {object} action
 * @param {number} [index=0]
 * @returns {object}
 */
export function classifySafetyGateAction(action = {}, index = 0) {
  const mutability = normalizeEnum(
    action.mutability,
    Object.values(SAFETY_GATE_MUTABILITY),
    SAFETY_GATE_MUTABILITY.READ_ONLY,
  );
  const reversibility = normalizeEnum(
    action.reversibility,
    Object.values(SAFETY_GATE_REVERSIBILITY),
    SAFETY_GATE_REVERSIBILITY.REVERSIBLE,
  );
  const scope = normalizeEnum(
    action.scope,
    Object.values(SAFETY_GATE_SCOPE),
    SAFETY_GATE_SCOPE.ISOLATED,
  );
  const serviceTrust = normalizeEnum(
    action.serviceTrust,
    Object.values(SAFETY_GATE_SERVICE_TRUST),
    SAFETY_GATE_SERVICE_TRUST.UNKNOWN,
  );

  const riskScore = (MUTABILITY_SCORE[mutability] ?? 0)
    + (REVERSIBILITY_SCORE[reversibility] ?? 0)
    + (SCOPE_SCORE[scope] ?? 0)
    + (TRUST_SCORE[serviceTrust] ?? 0);

  const riskTier = deriveRiskTier(riskScore);
  const id = normalizeString(action.id, null) ?? `action-${index + 1}`;

  return {
    id,
    toolName: normalizeString(action.toolName, "unknown-tool"),
    operation: normalizeString(action.operation, "unknown-operation"),
    target: normalizeString(action.target, null),
    service: normalizeString(action.service, null),
    mutability,
    reversibility,
    scope,
    serviceTrust,
    notes: normalizeString(action.notes, null),
    riskScore,
    riskTier,
    riskReasons: buildRiskReasons({ mutability, reversibility, scope, serviceTrust }),
  };
}

/**
 * Observe-only batch classifier for future external action safety gates.
 * @param {object} options
 * @param {Array<object>} options.actions
 * @param {string|null} [options.repository=null]
 * @param {string|null} [options.actionSource=null]
 * @returns {object}
 */
export function observeSafetyGateActions({
  actions = [],
  repository = null,
  actionSource = null,
} = {}) {
  const normalizedActions = Array.isArray(actions) ? actions : [];
  const classifiedActions = normalizedActions.map((action, index) => classifySafetyGateAction(action, index));

  const riskCounts = { low: 0, moderate: 0, high: 0, critical: 0 };
  let highestRisk = "low";
  for (const action of classifiedActions) {
    riskCounts[action.riskTier] += 1;
    if (action.riskTier === "critical") {
      highestRisk = "critical";
    } else if (action.riskTier === "high" && highestRisk !== "critical") {
      highestRisk = "high";
    } else if (action.riskTier === "moderate" && highestRisk === "low") {
      highestRisk = "moderate";
    }
  }

  return {
    generatedAt: nowIso(),
    repository,
    actionSource: normalizeString(actionSource, "manual"),
    actionCount: classifiedActions.length,
    highestRisk,
    riskCounts,
    actions: classifiedActions,
  };
}
