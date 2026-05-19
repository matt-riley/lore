import assert from "node:assert/strict";

function findBalancedIndex(source, start, openChar, closeChar) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === openChar) {
      depth += 1;
      continue;
    }
    if (char !== closeChar) {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return index;
    }
  }

  throw new Error(`could not find closing ${closeChar} for ${openChar} at ${start}`);
}

export function makeSourceExtractor(source) {
  return function extractFunctionSource(name) {
    const markers = [`async function ${name}`, `function ${name}`];
    const start = markers
      .map((marker) => source.indexOf(marker))
      .find((index) => index !== -1);
    assert.notEqual(start, undefined, `expected ${name} to exist in source`);
    const paramsStart = source.indexOf("(", start);
    const paramsEnd = findBalancedIndex(source, paramsStart, "(", ")");
    const braceStart = source.indexOf("{", paramsEnd);
    assert.notEqual(braceStart, -1, `expected ${name} to have a function body`);
    const bodyEnd = findBalancedIndex(source, braceStart, "{", "}");
    return source.slice(start, bodyEnd + 1);
  };
}
