import {
  evaluateCapabilityRouter,
  recommendCapabilityRoute,
  renderCapabilityEvaluationReport,
  renderCapabilityInventoryReport,
  renderCapabilityRecommendationReport,
  scanCapabilityInventory,
} from "./capability-inventory.mjs";
import {
  ensureArray,
} from "./memory-tools-array-utils.mjs";
import {
  ensureString,
} from "./memory-tools-validation-utils.mjs";

const CAPABILITY_INVENTORY_ACTIONS = new Set(["summary", "recommend", "route", "evaluate", "json"]);

export function normalizeCapabilityInventoryAction(value) {
  return CAPABILITY_INVENTORY_ACTIONS.has(value) ? value : "summary";
}

function formatValidationErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return "";
  }
  return [
    "## Validation Errors",
    "",
    ...errors.map((error) => `- ${error}`),
  ].join("\n");
}

export async function renderCapabilityInventoryAction(args, limit, action) {
  if (action === "evaluate") {
    const result = await evaluateCapabilityRouter({
      caseIds: ensureArray(args.caseIds).map((item) => String(item)),
      limit,
    });
    return renderCapabilityEvaluationReport(result);
  }

  const inventory = await scanCapabilityInventory();
  if (action === "json") {
    return JSON.stringify(inventory, null, 2);
  }
  if (action === "recommend" || action === "route") {
    const prompt = ensureString(args.prompt, "prompt");
    const recommendation = recommendCapabilityRoute({
      prompt,
      inventory,
      limit,
    });
    return renderCapabilityRecommendationReport(recommendation, { limit });
  }

  const report = renderCapabilityInventoryReport(inventory, {
    detailLevel: args.detailLevel === "full" ? "full" : "summary",
    limit,
  });
  const validationSection = formatValidationErrors(inventory.validation?.errors);
  return validationSection ? `${report}\n\n${validationSection}` : report;
}
