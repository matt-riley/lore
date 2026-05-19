export function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

export function normalizeRepository(repository) {
  return typeof repository === "string" && repository.trim().length > 0
    ? repository.trim()
    : null;
}

export function parseJsonObject(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

export function parseJsonArray(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function jsonText(value) {
  return JSON.stringify(value ?? []);
}

export function addStringFilter(where, params, col, value, transform = (v) => v) {
  if (typeof value === "string" && value.trim().length > 0) {
    where.push(`${col} = ?`);
    params.push(transform(value.trim()));
  }
}

export function validateRequiredStringField(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }
  return normalized;
}
