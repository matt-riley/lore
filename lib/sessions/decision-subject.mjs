import { normalizeText } from "../utils/text-normalizer.mjs";

function normalizeSubject(value) {
  return normalizeText(value).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+(?:instead|rather)$/, "")
    .replace(/^(?:a|an|the|this|our)\s+/, "")
    .split(/\s+/)
    .map((word) => word.replace(/ies$/, "y").replace(/(?<![siu])s$/, ""))
    .join(" ");
}

function decisionParts(memory) {
  const [contentChoice, ...contentRationale] = memory.content.replace(/^Decision:\s*/i, "").split(/\s+because\s+/i);
  const choice = memory.metadata?.decisionChoice ?? contentChoice;
  const rationale = memory.metadata?.decisionRationale ?? contentRationale.join(" because ");
  // Purpose/subject belongs to the choice. Reasons such as reliability and
  // performance describe why it was chosen, and cannot establish its subject.
  const topic = choice.match(/\b(?:for|about|regarding)\s+(.+)$/i)?.[1];
  return {
    choice: normalizeSubject(choice),
    topic: topic ? normalizeSubject(topic) : null,
    rationale,
  };
}

function affectedObjects(rationale) {
  // An explicitly affected object can refer back to a known subject: e.g.
  // "for catalog invalidation" / "because losing invalidations is unacceptable".
  // This is deliberately narrower than matching arbitrary rationale words.
  return [...rationale.matchAll(/\b(?:losing|dropping|duplicating|corrupting|loss\s+of)\s+(.+?)(?=\s+(?:is|are|was|were|would|will)\b|[.,;]|$)/gi)]
    .map((match) => normalizeSubject(match[1]));
}

function containsSubject(phrase, subject) {
  return ` ${phrase} `.includes(` ${subject} `);
}

function referencedSubject(prior, current, objects) {
  if (!prior.topic) {
    return false;
  }
  if (current.topic) {
    // Distinct explicit subjects are never joined by a shared head noun,
    // selected technology, or rationale.
    return prior.topic === current.topic;
  }
  if (containsSubject(current.choice, prior.topic)) {
    return true;
  }
  return objects.some((object) => object === prior.topic
    || (object.split(" ").length === 1 && prior.topic.split(" ").at(-1) === object));
}

export function collectRetiredDecisionEvidenceKeys(memories) {
  const decisions = memories
    .filter((memory) => memory.type === "decision" && memory.evidence?.key)
    .sort((left, right) => (left.sourceTurnIndex ?? 0) - (right.sourceTurnIndex ?? 0));
  const parts = decisions.map(decisionParts);
  const retired = new Set();
  for (let index = 0; index < decisions.length; index += 1) {
    const current = decisions[index];
    if (current.metadata?.decisionStatus !== "reversal") {
      continue;
    }
    const references = affectedObjects(parts[index].rationale);
    const candidates = [];
    for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
      const prior = decisions[priorIndex];
      if (prior.scope === current.scope && prior.repository === current.repository
        && parts[priorIndex].choice !== parts[index].choice
        && referencedSubject(parts[priorIndex], parts[index], references)) {
        candidates.push(priorIndex);
      }
    }
    // A partial reference such as "invalidations" cannot disambiguate catalog
    // invalidation from inventory invalidation. Preserve both until clarified.
    const subjects = new Set(candidates.map((priorIndex) => parts[priorIndex].topic));
    if (subjects.size === 1) {
      for (const priorIndex of candidates) {
        retired.add(decisions[priorIndex].evidence.key);
      }
    }
  }
  return [...retired];
}
