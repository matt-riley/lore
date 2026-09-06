import { formatRows } from "./memory-tools-render-utils.mjs";

export function formatAuditRows(rows) {
  return formatRows(rows, (row) => [
    `- [${row.action}] ${row.target_type}:${row.target_id}`,
    `prev=${row.previous_scope ?? "none"}(${row.previous_repository ?? "global"})`,
    `next=${row.next_scope ?? "none"}(${row.next_repository ?? "global"})`,
    `actor=${row.actor}`,
    `source=${row.source}`,
    `reason=${row.reason}`,
    `at=${row.created_at}`,
  ].join(" "));
}

export function formatScopePreview(preview) {
  const lines = [
    `action: ${preview.action}`,
    `targetType: ${preview.targetType}`,
    `requestedCount: ${preview.requestedCount}`,
    `matchedCount: ${preview.matchedCount}`,
    `missingIds: ${preview.missingIds.length > 0 ? preview.missingIds.join(", ") : "none"}`,
    "",
    "## Rows",
    "",
  ];
  lines.push(formatRows(preview.rows, (row) => [
    `- ${row.id}`,
    `current=${row.current.scope}/${row.current.scopeSource}`,
    `(${row.current.repository ?? "global"})`,
    `-> next=${row.next.scope}/${row.next.scopeSource}`,
    `(${row.next.repository ?? "global"})`,
    `changed=${row.changed}`,
  ].join(" ")));
  return lines.join("\n");
}
