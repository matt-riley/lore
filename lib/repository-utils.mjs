export function normalizeRepository(repository) {
  return typeof repository === "string" && repository.trim().length > 0
    ? repository.trim()
    : null;
}
