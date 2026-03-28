/**
 * review-gate.mjs — observe-only proposal-doc structural reviewer.
 *
 * Checks proposal docs for the three required sections (goal, acceptance,
 * risk) using deterministic ATX-heading scanning.  Records an additive
 * trajectory artifact when findings exist.  No enforcement, no blocking,
 * no trusted-source mutation.
 */

// ---------------------------------------------------------------------------
// Required section definitions (proposal-doc family only)
// ---------------------------------------------------------------------------

export const PROPOSAL_REQUIRED_SECTIONS = Object.freeze([
  { key: "goal", patterns: ["goal", "objective", "overview"] },
  { key: "acceptance", patterns: ["acceptance", "criteria", "done when", "success criteria"] },
  { key: "risk", patterns: ["risk", "constraint", "caveat", "limitation"] },
]);

// ---------------------------------------------------------------------------
// Core text checker (exported so the Doctor can reuse it without duplication)
// ---------------------------------------------------------------------------

/**
 * Scan proposal doc text for missing required sections.
 * Ignores content inside fenced code blocks.
 * Accepts both ATX headings and YAML/frontmatter key:value as signals.
 *
 * @param {string} text
 * @returns {string[]} Array of missing section keys — empty means all present.
 */
export function checkProposalSections(text) {
  const found = new Set();
  let inFence = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // ATX heading: ## heading or ## heading ##
    const m = trimmed.match(/^#{1,6}\s+(.+?)(?:\s+#+\s*)?$/);
    if (m) {
      const h = m[1].toLowerCase();
      for (const section of PROPOSAL_REQUIRED_SECTIONS) {
        if (section.patterns.some((p) => h.includes(p))) found.add(section.key);
      }
    }
  }
  // Also accept YAML/frontmatter key:value as a weak signal
  const lower = text.toLowerCase();
  for (const section of PROPOSAL_REQUIRED_SECTIONS) {
    if (section.patterns.some((p) => lower.includes(`${p}:`))) found.add(section.key);
  }

  return PROPOSAL_REQUIRED_SECTIONS
    .map((s) => s.key)
    .filter((key) => !found.has(key));
}

// ---------------------------------------------------------------------------
// On-demand gate (callable from the memory_review_gate tool)
// ---------------------------------------------------------------------------

function nowIso() {
  return new Date().toISOString();
}

/**
 * Run the observe-only review gate on the provided text.
 *
 * @param {object} options
 * @param {object} options.runtime     - Active Coherence runtime (db access)
 * @param {string} options.text        - Proposal-doc text to review
 * @param {string|null} [options.repository] - Current repository scope
 * @param {boolean} [options.dryRun=false]   - Skip trajectory artifact recording
 * @returns {{ generatedAt, wordCount, findingCount, findings, recordedArtifactId }}
 */
export function runReviewGate({
  runtime,
  text,
  repository = null,
  dryRun = false,
} = {}) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("text must be a non-empty string");
  }

  const generatedAt = nowIso();
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const missingSections = checkProposalSections(text);

  const findings = missingSections.map((key) => ({
    kind: "missing_section",
    section: key,
    severity: "info",
    detail: `Proposal doc is missing a '${key}' section (goal / acceptance / risk)`,
  }));

  let recordedArtifactId = null;
  if (!dryRun) {
    const summaryLine = findings.length === 0
      ? `Review gate: proposal-doc looks complete (${wordCount} words)`
      : `Review gate: proposal-doc missing section(s): ${missingSections.join(", ")}`;
    try {
      recordedArtifactId = runtime.db.insertTrajectoryArtifact({
        kind: "review_gate_report",
        repository: repository ?? null,
        sourceKind: "review_gate",
        summary: summaryLine,
        severity: findings.length > 0 ? "info" : "info",
        outcome: "observed",
        context: {
          wordCount,
          findingCount: findings.length,
          missingSections,
        },
      });
    } catch {
      // artifact recording is best-effort; never block review results
    }
  }

  return { generatedAt, wordCount, findingCount: findings.length, findings, recordedArtifactId };
}
