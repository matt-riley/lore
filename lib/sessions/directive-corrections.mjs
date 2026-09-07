import { normalizeText } from "../utils/text-normalizer.mjs";

export function collectRetiredDirectiveEvidenceKeys(memories, turns) {
  const retired = new Set();
  let previousUserTurn = null;
  for (const turn of turns) {
    const message = normalizeText(turn.user_message);
    if (!message) continue;
    // "No, I meant ..." explicitly replaces the immediately addressed request.
    // Resolve only a single prior preference; multiple topics or an intervening
    // user question require clarification rather than guessing the antecedent.
    if (/^(?:no,?\s+i\s+meant\b|actually,?\s+that(?:'s| is)\s+wrong\s*:)/i.test(message) && previousUserTurn) {
      const replacements = memories.filter((memory) => memory.type === "user_preference" && memory.sourceTurnIndex === turn.turn_index);
      const previous = memories.filter((memory) => memory.type === "user_preference" && memory.sourceTurnIndex === previousUserTurn.turn_index);
      if (replacements.length === 1 && previous.length === 1
        && replacements[0].scope === previous[0].scope && replacements[0].repository === previous[0].repository
        && replacements[0].content !== previous[0].content) {
        for (const memory of memories) {
          if (memory.type === previous[0].type && memory.scope === previous[0].scope
            && memory.repository === previous[0].repository && memory.sourceTurnIndex < turn.turn_index
            && normalizeText(memory.content).toLowerCase() === normalizeText(previous[0].content).toLowerCase()) {
            retired.add(memory.evidence.key);
          }
        }
      }
    }
    previousUserTurn = turn;
  }
  return [...retired];
}
