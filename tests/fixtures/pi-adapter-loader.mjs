const typeboxStub = `data:text/javascript,${encodeURIComponent(`
  export const Type = {
    Boolean: () => ({}),
    Literal: () => ({}),
    Number: () => ({}),
    Object: () => ({}),
    Optional: (value) => value,
    String: () => ({}),
    Union: () => ({}),
  };
`)};`;

export function resolve(specifier, context, nextResolve) {
  if (specifier === "typebox") {
    return { url: typeboxStub, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
