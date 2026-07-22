import {
  parseWorkstreamOverlayMemory,
  WORKSTREAM_MEMORY_TYPE,
} from "./workstream-overlays.mjs";

function compareOverlayState(left, right) {
  const leftActive = left.status !== "done";
  const rightActive = right.status !== "done";
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }
  return String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""));
}

export function formatWorkstreamOverlayStatus(runtime) {
  const rows = runtime.db.searchSemantic({
    query: "",
    repository: runtime.repository,
    includeOtherRepositories: false,
    types: [WORKSTREAM_MEMORY_TYPE],
    limit: 5,
  });
  const overlays = rows
    .map(parseWorkstreamOverlayMemory)
    .sort(compareOverlayState)
    .slice(0, 3);
  if (overlays.length === 0) {
    return ["activeWorkstreams: none"];
  }
  return overlays.map((overlay, index) => [
    `activeWorkstream${index + 1}: ${overlay.title}`,
    `[${overlay.status}]`,
    overlay.blockers.length > 0 ? `blockers=${overlay.blockers.length}` : null,
    overlay.nextActions.length > 0 ? `nextActions=${overlay.nextActions.length}` : null,
  ].filter(Boolean).join(" "));
}
