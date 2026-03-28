import { readWorkstreamOverlaysEnabled } from "./rollout-flags.mjs";
import { sanitizeRetainedList, sanitizeRetainedText } from "./retention-sanitizer.mjs";

export const WORKSTREAM_MEMORY_TYPE = "workstream_overlay";

const WORKSTREAM_STATUS = Object.freeze({
  ACTIVE: "active",
  BLOCKED: "blocked",
  PAUSED: "paused",
  DONE: "done",
});

const WORKSTREAM_SIGNAL_PATTERNS = [
  /\bworkstream\b/i,
  /\bblockers?\b/i,
  /\bnext actions?\b/i,
  /\bnext steps?\b/i,
  /\bwhat(?:'s| is)\s+(?:next|blocked|the plan)\b/i,
  /\bwhere are we\b/i,
  /\bstatus\b/i,
  /\bobjective\b/i,
  /\bmission\b/i,
  /\bconstraints?\b/i,
  /\bdecisions?\b/i,
];

function normalizeStatus(value) {
  const text = sanitizeRetainedText(value).toLowerCase();
  if (text === WORKSTREAM_STATUS.BLOCKED) {
    return WORKSTREAM_STATUS.BLOCKED;
  }
  if (text === WORKSTREAM_STATUS.PAUSED) {
    return WORKSTREAM_STATUS.PAUSED;
  }
  if (text === WORKSTREAM_STATUS.DONE) {
    return WORKSTREAM_STATUS.DONE;
  }
  return WORKSTREAM_STATUS.ACTIVE;
}

function normalizeTitle(value, fallback = "Current workstream") {
  const title = sanitizeRetainedText(value);
  return title || fallback;
}

function buildSummaryParts(overlay) {
  return [
    `Workstream ${JSON.stringify(overlay.title)} is ${overlay.status}.`,
    overlay.mission ? `Mission: ${overlay.mission}.` : "",
    overlay.objective ? `Objective: ${overlay.objective}.` : "",
    overlay.constraints.length > 0 ? `Constraints: ${overlay.constraints.join("; ")}.` : "",
    overlay.blockers.length > 0 ? `Blockers: ${overlay.blockers.join("; ")}.` : "",
    overlay.nextActions.length > 0 ? `Next actions: ${overlay.nextActions.join("; ")}.` : "",
    overlay.decisions.length > 0 ? `Key decisions: ${overlay.decisions.join("; ")}.` : "",
    overlay.retainPriorities.length > 0 ? `Retain priorities: ${overlay.retainPriorities.join("; ")}.` : "",
    overlay.reflectPriorities.length > 0 ? `Reflect priorities: ${overlay.reflectPriorities.join("; ")}.` : "",
  ].filter(Boolean);
}

function buildTags(overlay) {
  return sanitizeRetainedList([
    "workstream-overlay",
    overlay.status,
    overlay.overlayId,
    overlay.title,
    ...overlay.blockers.slice(0, 2),
    ...overlay.nextActions.slice(0, 2),
  ], 10);
}

function buildTraceRow(row, currentRepository = null) {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    repository: row.repository,
    currentRepository,
    status: row.metadata?.status ?? WORKSTREAM_STATUS.ACTIVE,
    title: row.metadata?.title ?? null,
  };
}

export function shouldRecallWorkstreamOverlay(prompt, promptNeed = null) {
  if (promptNeed?.wantsContinuity === true) {
    return true;
  }
  const text = String(prompt || "");
  return WORKSTREAM_SIGNAL_PATTERNS.some((pattern) => pattern.test(text));
}

export function buildWorkstreamOverlayMemory({
  repository,
  scope,
  confidence = 0.94,
  overlayId,
  title,
  mission,
  objective,
  constraints = [],
  blockers = [],
  nextActions = [],
  decisions = [],
  retainPriorities = [],
  reflectPriorities = [],
  status = WORKSTREAM_STATUS.ACTIVE,
  sourceSessionId,
  metadata = {},
}) {
  const normalized = {
    overlayId: sanitizeRetainedText(overlayId),
    title: normalizeTitle(title || mission || objective),
    mission: sanitizeRetainedText(mission),
    objective: sanitizeRetainedText(objective),
    constraints: sanitizeRetainedList(constraints),
    blockers: sanitizeRetainedList(blockers),
    nextActions: sanitizeRetainedList(nextActions),
    decisions: sanitizeRetainedList(decisions),
    retainPriorities: sanitizeRetainedList(retainPriorities),
    reflectPriorities: sanitizeRetainedList(reflectPriorities),
    status: normalizeStatus(status),
  };

  return {
    type: WORKSTREAM_MEMORY_TYPE,
    content: buildSummaryParts(normalized).join(" "),
    repository,
    scope,
    confidence,
    sourceSessionId,
    tags: buildTags(normalized),
    metadata: {
      source: "coherence_retain",
      overlayId: normalized.overlayId || normalized.title,
      title: normalized.title,
      mission: normalized.mission,
      objective: normalized.objective,
      constraints: normalized.constraints,
      blockers: normalized.blockers,
      nextActions: normalized.nextActions,
      decisions: normalized.decisions,
      retainPriorities: normalized.retainPriorities,
      reflectPriorities: normalized.reflectPriorities,
      status: normalized.status,
      ...metadata,
    },
  };
}

export function parseWorkstreamOverlayMemory(row) {
  const metadata = row?.metadata ?? {};
  return {
    id: row?.id ?? null,
    repository: row?.repository ?? null,
    scope: row?.scope ?? null,
    status: normalizeStatus(metadata.status),
    overlayId: sanitizeRetainedText(metadata.overlayId),
    title: normalizeTitle(metadata.title || row?.content),
    mission: sanitizeRetainedText(metadata.mission),
    objective: sanitizeRetainedText(metadata.objective),
    constraints: sanitizeRetainedList(metadata.constraints),
    blockers: sanitizeRetainedList(metadata.blockers),
    nextActions: sanitizeRetainedList(metadata.nextActions),
    decisions: sanitizeRetainedList(metadata.decisions),
    retainPriorities: sanitizeRetainedList(metadata.retainPriorities),
    reflectPriorities: sanitizeRetainedList(metadata.reflectPriorities),
    updatedAt: row?.updated_at ?? null,
    content: row?.content ?? "",
  };
}

function compareWorkstreamRows(left, right) {
  const leftOverlay = parseWorkstreamOverlayMemory(left);
  const rightOverlay = parseWorkstreamOverlayMemory(right);
  const leftActive = leftOverlay.status !== WORKSTREAM_STATUS.DONE;
  const rightActive = rightOverlay.status !== WORKSTREAM_STATUS.DONE;
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }
  return String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? ""));
}

export function findRelevantWorkstreamOverlays({
  db,
  prompt,
  repository,
  includeOtherRepositories = false,
  promptNeed = null,
  config = null,
  limit = 2,
}) {
  if (!readWorkstreamOverlaysEnabled(config)) {
    return {
      overlays: [],
      text: "",
      trace: {
        enabled: false,
        query: prompt,
        rows: [],
        includedRows: [],
        reason: "workstream_overlays_disabled",
      },
    };
  }

  const enabled = shouldRecallWorkstreamOverlay(prompt, promptNeed);
  if (!enabled) {
    return {
      overlays: [],
      text: "",
      trace: {
        enabled: false,
        query: prompt,
        rows: [],
        includedRows: [],
        reason: "prompt_not_workstream_or_continuity",
      },
    };
  }

  const matchedRows = db.searchSemantic({
    query: prompt,
    repository,
    includeOtherRepositories,
    types: [WORKSTREAM_MEMORY_TYPE],
    limit: Math.max(limit * 3, 6),
  });

  const rankedRows = [...matchedRows].sort(compareWorkstreamRows);
  const fallbackRows = rankedRows.length === 0
    ? db.searchSemantic({
        query: "",
        repository,
        includeOtherRepositories: false,
        types: [WORKSTREAM_MEMORY_TYPE],
        limit,
      }).sort(compareWorkstreamRows)
    : [];

  const selectedRows = (rankedRows.length > 0 ? rankedRows : fallbackRows).slice(0, limit);
  const overlays = selectedRows.map(parseWorkstreamOverlayMemory);

  return {
    overlays,
    text: formatWorkstreamOverlaySection(overlays),
    trace: {
      enabled: true,
      query: prompt,
      rows: matchedRows.map((row) => buildTraceRow(row, repository)),
      includedRows: selectedRows.map((row) => buildTraceRow(row, repository)),
      reason: overlays.length > 0
        ? matchedRows.length > 0
          ? "matched_workstream_overlay"
          : "fallback_latest_overlay"
        : "no_matching_workstream_overlay",
    },
  };
}

export function formatWorkstreamOverlaySection(overlays) {
  if (!Array.isArray(overlays) || overlays.length === 0) {
    return "";
  }

  const lines = ["## Active Workstream", ""];
  for (const overlay of overlays) {
    lines.push(`- ${overlay.title} [${overlay.status}]`);
    if (overlay.mission) {
      lines.push(`  mission: ${overlay.mission}`);
    }
    if (overlay.objective) {
      lines.push(`  objective: ${overlay.objective}`);
    }
    if (overlay.constraints.length > 0) {
      lines.push(`  constraints: ${overlay.constraints.join(" | ")}`);
    }
    if (overlay.blockers.length > 0) {
      lines.push(`  blockers: ${overlay.blockers.join(" | ")}`);
    }
    if (overlay.nextActions.length > 0) {
      lines.push(`  nextActions: ${overlay.nextActions.join(" | ")}`);
    }
    if (overlay.decisions.length > 0) {
      lines.push(`  decisions: ${overlay.decisions.join(" | ")}`);
    }
    if (overlay.retainPriorities.length > 0) {
      lines.push(`  retainPriorities: ${overlay.retainPriorities.join(" | ")}`);
    }
    if (overlay.reflectPriorities.length > 0) {
      lines.push(`  reflectPriorities: ${overlay.reflectPriorities.join(" | ")}`);
    }
  }
  return lines.join("\n");
}
