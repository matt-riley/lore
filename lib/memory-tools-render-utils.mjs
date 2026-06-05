function formatRows(rows, render) {
  if (!rows || rows.length === 0) {
    return "No results.";
  }
  return rows.map(render).join("\n");
}

function formatImprovementArtifactRows(rows) {
  return formatRows(rows, (row) => {
    const evidenceKeys = Object.keys(row.evidence ?? {});
    return [
      `- [${row.id}] ${row.source_kind}:${row.source_case_id}`,
      `status=${row.status}`,
      `title=${row.title}`,
      `summary=${row.summary}`,
      `linkedMemory=${row.linked_memory_id ?? "none"}`,
      `created=${row.created_at}`,
      `updated=${row.updated_at}`,
      row.resolved_at ? `resolved=${row.resolved_at}` : null,
      row.superseded_by ? `supersededBy=${row.superseded_by}` : null,
      row.proposal_path ? `proposal=${row.proposal_path}` : null,
      row.review_state && row.review_state !== "none" ? `reviewState=${row.review_state}` : null,
      evidenceKeys.length > 0 ? `evidenceKeys=${evidenceKeys.join(",")}` : null,
    ].filter(Boolean).join(" ");
  });
}

export {
  formatImprovementArtifactRows,
  formatRows,
};
