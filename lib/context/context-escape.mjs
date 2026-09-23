/**
 * Neutralizes prompt-injection markup in recalled text so it can't break out
 * of wrapper tags and masquerade as top-level context to the model.
 *
 * Replaces `<` with fullwidth `＜` (U+FF1C) in opening/closing tags for
 * these wrapper names, making them unparseable while keeping text readable:
 * - lore_context
 * - hindsight_memories
 * - relevant_memories
 * - system-reminder
 * - system
 * - INSTRUCTIONS
 * - user_instructions
 * - environment_context
 *
 * Other angle brackets like `Array<string>` or `a < b` pass through unchanged.
 */

const CONTEXT_TAGS = [
  "lore_context",
  "hindsight_memories",
  "relevant_memories",
  "system-reminder",
  "system",
  "INSTRUCTIONS",
  "user_instructions",
  "environment_context",
];

// Build a pattern that matches opening or closing tags for any of these names,
// case-insensitive, with optional whitespace around the tag name and attributes.
// Pattern: </*whitespace*tagname*whitespace*...> (case-insensitive)
const TAG_ESCAPE_PATTERN = new RegExp(
  `<\\s*/?\\s*(?:${CONTEXT_TAGS.join("|")})(?:\\s|>|/|$)`,
  "gi"
);

export function neutralizeContextMarkup(text) {
  if (typeof text !== "string") {
    return text;
  }
  // Replace the opening < of any context tag with fullwidth ＜ (U+FF1C).
  // The pattern only matches the `<` in context tags, so other brackets survive.
  return text.replace(TAG_ESCAPE_PATTERN, (match) => "＜" + match.slice(1));
}
