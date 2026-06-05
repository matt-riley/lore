import { normalizeText } from "./session-text-normalizer.mjs";

function isCrossRepoRow(row, repository) {
  return !!(
    row
    && row.repository
    && (!repository || row.repository !== repository)
  );
}

function serializeSessionTraceRow(session, currentRepository = null) {
  return {
    sessionId: session.session_id ?? null,
    sourceType: session.source_type ?? null,
    repository: session.repository ?? null,
    updatedAt: session.updated_at ?? null,
    crossRepo: isCrossRepoRow(session, currentRepository),
    excerpt: normalizeText(session.excerpt || session.workspaceSummary || session.summary),
  };
}

function pushPromptContextSection(lines, title) {
  if (lines.length > 0) {
    lines.push("");
  }
  lines.push(`## ${title}`, "");
}

export {
  isCrossRepoRow,
  pushPromptContextSection,
  serializeSessionTraceRow,
};
