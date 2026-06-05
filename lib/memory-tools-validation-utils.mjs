function normalizeImprovementStatus(value) {
  if (value === "resolved") {
    return "resolved";
  }
  if (value === "superseded") {
    return "superseded";
  }
  return "active";
}

function ensureString(value, fieldName) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function ensureLimit(value, fallback, max = 50) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.min(max, Math.floor(value));
  }
  return fallback;
}

function ensureIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("ids must be a non-empty array");
  }
  const ids = [...new Set(
    value
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean),
  )];
  if (ids.length === 0) {
    throw new Error("ids must contain at least one non-empty string");
  }
  return ids;
}

function ensureObject(value, fieldName) {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
  return value;
}

export {
  ensureIds,
  ensureLimit,
  ensureObject,
  ensureString,
  normalizeImprovementStatus,
};
