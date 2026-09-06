function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export {
  ensureArray,
  ensureStringArray,
};
