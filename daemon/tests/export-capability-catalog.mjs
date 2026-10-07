#!/usr/bin/env node
// Export the checked-in v2 capability catalog from the v1 manifest. The
// manifest stays the baseline until retirement; this file records which
// canonical operations the v2 daemon actually implements and where.
//
//   node daemon/tests/export-capability-catalog.mjs

import { writeFileSync } from "node:fs";

import { LORE_CAPABILITY_SPECS } from "../../lib/capabilities/capability-manifest.mjs";

/** Canonical operations implemented by the v2 daemon today. */
const IMPLEMENTED = {
  lore_status: { route: "/v2/status", mutability: "read" },
  lore_retain: { route: "/v2/retain", mutability: "write" },
  lore_forget: { route: "/v2/forget", mutability: "write" },
  lore_recall: { route: "/v2/recall", mutability: "read" },
  lore_search: { route: "/v2/admin/search", mutability: "read" },
  lore_explain: { route: "/v2/admin/explain", mutability: "read" },
  lore_validate: { route: "/v2/admin/validate", mutability: "read" },
  lore_doctor: { route: "/v2/admin/doctor", mutability: "read" },
  lore_audit_extractions: { route: "/v2/admin/audit/extractions", mutability: "read" },
  memory_capability_inventory: { route: "local:capabilities", mutability: "read" },
  lore_correct: { route: "/v2/admin/correct", mutability: "write" },
  lore_purge: { route: "/v2/admin/purge", mutability: "write" },
  memory_scope_override: { route: "/v2/admin/scope-override", mutability: "write" },
  memory_scope_audit: { route: "/v2/admin/scope-audit", mutability: "read" },
};

/** Daemon capabilities with no v1 canonical row. */
const DAEMON_CAPABILITIES = [
  "status.basic",
  "memory.retain.manual",
  "memory.forget",
  "recall.lexical",
  "recall.semantic.bounded",
  "embedding.status",
  "embedding.retry",
  "config.reload",
  "sources.register",
  "sources.hint",
  "sources.status",
  "extraction.retry",
  "views.read",
];

const rows = LORE_CAPABILITY_SPECS.map((spec) => {
  const implemented = IMPLEMENTED[spec.name];
  return {
    name: spec.name,
    aliases: spec.aliases ?? [],
    surfaces: spec.surfaces ?? {},
    support: implemented ? "implemented" : "planned",
    mutability: implemented?.mutability ?? inferMutability(spec.name),
    route: implemented?.route ?? null,
  };
});

function inferMutability(name) {
  return /retain|forget|correct|repair|purge|override|import|process|maintenance|backfill|reflect|replay|bundle|journal|backlog|ledger/.test(
    name,
  )
    ? "write"
    : "read";
}

const catalog = {
  version: 2,
  generatedFrom: "lib/capabilities/capability-manifest.mjs",
  rows,
  daemonCapabilities: DAEMON_CAPABILITIES,
};
const serialized = `${JSON.stringify(catalog, null, 2)}\n`;
writeFileSync(new URL("../clients/capability-catalog.json", import.meta.url), serialized);
console.log(
  `rows=${rows.length} implemented=${rows.filter((row) => row.support === "implemented").length}`,
);
