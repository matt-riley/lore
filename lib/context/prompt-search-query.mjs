// Prompt-only fallback. Explicit memory_search keeps its strict FTS semantics.
const SCAFFOLD = new Set("a an and are as at be but by for from had has have how i if in is it its just of on or our so that the they this to was we what when where which who why will with would you your about can could did do does me remind remember tell please decided decide decision decisions handled handle used use project repo again".split(" "));

export function promptSearchQuery(prompt) {
  return [...new Set(String(prompt ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [])]
    .filter(term => term.length > 2 && !SCAFFOLD.has(term))
    .slice(0, 16)
    .join(" ");
}
