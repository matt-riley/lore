function readOptionalTrimmedString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readOptionalLowercaseString(value) {
  const normalized = readOptionalTrimmedString(value);
  return normalized ? normalized.toLowerCase() : undefined;
}

function resolveRepositoryArg(value, runtimeRepository) {
  return readOptionalTrimmedString(value) ?? runtimeRepository;
}

export {
  readOptionalLowercaseString,
  readOptionalTrimmedString,
  resolveRepositoryArg,
};
