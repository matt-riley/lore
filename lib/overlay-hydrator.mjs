import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import { buildWorkstreamOverlayMemory } from "./workstream-overlays.mjs";
import { readWorkstreamOverlaysEnabled } from "./rollout-flags.mjs";
import { sanitizeRetainedList, sanitizeRetainedText } from "./retention-sanitizer.mjs";

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parseFrontmatter(text) {
  const match = String(text).match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!match) {
    return {};
  }
  const result = {};
  for (const line of match[1].split("\n")) {
    const colonAt = line.indexOf(":");
    if (colonAt < 1) {
      continue;
    }
    const key = line.slice(0, colonAt).trim();
    const value = line.slice(colonAt + 1).trim();
    if (key) {
      result[key] = value;
    }
  }
  return result;
}

function extractSection(text, heading) {
  const headingPattern = new RegExp(
    `^#{1,3}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
    "im",
  );
  const match = text.match(headingPattern);
  if (!match) {
    return "";
  }
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const nextHeading = rest.match(/^#{1,3}\s+/m);
  const end = nextHeading ? nextHeading.index : rest.length;
  return rest.slice(0, end).replace(/\s+/g, " ").trim();
}

export function parsePlanFile(text) {
  if (!text) {
    return null;
  }
  const frontmatter = parseFrontmatter(text);
  const taskId = sanitizeRetainedText(frontmatter.task_id ?? "");
  const status = sanitizeRetainedText(frontmatter.status ?? "");
  const goalSection = extractSection(text, "goal");
  const currentStateSection = extractSection(text, "current_state");
  return {
    taskId,
    status,
    goal: normalizeText(goalSection).slice(0, 300),
    currentState: normalizeText(currentStateSection).slice(0, 300),
  };
}

export function readSessionTodos(sessionDbPath) {
  if (!sessionDbPath || !existsSync(sessionDbPath)) {
    return { inProgress: [], blocked: [], pending: [] };
  }
  try {
    const db = new DatabaseSync(sessionDbPath, { readonly: true });
    const rows = db.prepare(
      "SELECT id, title, status FROM todos WHERE status IN ('in_progress','blocked','pending') ORDER BY status, id",
    ).all();
    db.close();
    return {
      inProgress: rows.filter((r) => r.status === "in_progress").map((r) => normalizeText(r.title || r.id)),
      blocked: rows.filter((r) => r.status === "blocked").map((r) => normalizeText(r.title || r.id)),
      pending: rows.filter((r) => r.status === "pending").map((r) => normalizeText(r.title || r.id)),
    };
  } catch {
    return { inProgress: [], blocked: [], pending: [] };
  }
}

export function readMaintenanceBlockers(db) {
  const blockers = [];
  try {
    const rows = db.db.prepare(`
      SELECT task_name, last_status, total_failures, consecutive_failures
      FROM maintenance_task_state
      WHERE last_status IN ('needs_attention', 'failed')
         OR (consecutive_failures IS NOT NULL AND consecutive_failures >= 2)
    `).all();
    for (const row of rows) {
      if (row.consecutive_failures >= 2 || row.last_status === "failed") {
        blockers.push(`maintenance/${row.task_name}: ${row.last_status} (${row.total_failures ?? 0} total failures)`);
      } else if (row.last_status === "needs_attention") {
        blockers.push(`maintenance/${row.task_name}: needs attention`);
      }
    }
  } catch {
    // maintenance_task_state may not have consecutive_failures column — fall back
    try {
      const rows = db.db.prepare(`
        SELECT task_name, last_status, total_failures
        FROM maintenance_task_state
        WHERE last_status IN ('needs_attention', 'failed')
      `).all();
      for (const row of rows) {
        blockers.push(`maintenance/${row.task_name}: ${row.last_status}`);
      }
    } catch {
      // table absent or empty — no blockers to surface
    }
  }
  return blockers;
}

export async function hydrateWorkstreamOverlay({
  db,
  workspacePath,
  repository,
  sessionId,
}) {
  if (!readWorkstreamOverlaysEnabled(db?.config)) {
    return { skipped: true, reason: "workstream_overlays_disabled" };
  }
  if (!db || !workspacePath) {
    return { skipped: true, reason: "missing_db_or_workspace" };
  }

  // Read plan.md if present
  const planPath = path.join(workspacePath, "plan.md");
  const planText = existsSync(planPath)
    ? await readFile(planPath, "utf8").catch(() => null)
    : null;
  const plan = planText ? parsePlanFile(planText) : null;

  // Read session todos
  const sessionDbPath = path.join(workspacePath, "session.db");
  const todos = readSessionTodos(sessionDbPath);

  // Read maintenance blockers from coherence db
  const maintenanceBlockers = readMaintenanceBlockers(db);

  const hasArtifacts = plan != null || todos.inProgress.length > 0 || todos.blocked.length > 0;
  if (!hasArtifacts) {
    return { skipped: true, reason: "no_local_artifacts" };
  }

  // Derive overlay fields from available artifacts
  const overlayId = sanitizeRetainedText(plan?.taskId || "current-workstream");

  const title = plan?.taskId
    ? plan.taskId.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "Current Workstream";

  const mission = plan?.goal || "";
  const objective = plan?.currentState || "";

  const blockers = sanitizeRetainedList([
    ...todos.blocked,
    ...maintenanceBlockers,
  ]);

  const nextActions = sanitizeRetainedList([
    ...todos.inProgress,
    ...todos.pending.slice(0, 3),
  ]);

  const overlayStatus = blockers.length > 0 ? "blocked" : "active";

  const overlayMemory = buildWorkstreamOverlayMemory({
    repository,
    scope: "repo",
    confidence: 0.92,
    overlayId,
    title,
    mission,
    objective,
    blockers,
    nextActions,
    status: overlayStatus,
    sourceSessionId: sessionId,
    metadata: {
      source: "overlay_hydrator",
      hydratedAt: new Date().toISOString(),
      hasPlan: plan != null,
      todoInProgressCount: todos.inProgress.length,
      todoBlockedCount: todos.blocked.length,
      todoPendingCount: todos.pending.length,
      maintenanceBlockerCount: maintenanceBlockers.length,
    },
  });

  const id = db.insertSemanticMemory(overlayMemory);
  return {
    skipped: false,
    id,
    overlayId,
    title,
    status: overlayStatus,
    blockerCount: blockers.length,
    nextActionCount: nextActions.length,
  };
}
