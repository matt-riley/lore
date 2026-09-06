export async function resolve(specifier, context, nextResolve) {
  if (specifier === "node:sqlite") {
    throw new Error("blocked node:sqlite for runtime preflight test");
  }
  return nextResolve(specifier, context);
}
