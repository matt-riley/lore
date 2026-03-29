import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LORE_CAPABILITY_SPECS } from "../../lib/capability-manifest.mjs";
import { createMemoryTools } from "../../lib/memory-tools.mjs";

const EXPECTED_TOOL_NAMES = [
  "memory_status",
  "memory_intent_journal",
  "memory_portable_bundle",
  "maintenance_schedule_run",
  "memory_improvement_backlog",
  "memory_evolution_ledger",
  "memory_capability_inventory",
  "lore_recall",
  "lore_onboard",
  "lore_retain",
  "lore_reflect",
  "memory_search",
  "memory_explain",
  "memory_validate",
  "memory_replay",
  "memory_scope_override",
  "memory_scope_audit",
  "memory_save",
  "memory_forget",
  "memory_deferred_process",
  "memory_backfill",
  "memory_doctor_report",
  "memory_review_gate",
];

const VALID_ROUTE_HINTS = new Set(["retrieval", "direct", "background_task"]);
const VALID_SUPPORT_STATUS = new Set(["supported", "experimental"]);
const SUPPORT_MATRIX_STATUS_LABELS = {
  supported: "🟢 Supported",
  experimental: "🟡 Experimental",
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SUPPORT_MATRIX_PATH = path.resolve(__dirname, "../../docs/support-matrix.md");

function stripFencedCodeBlocks(markdown) {
  const lines = markdown.split(/\r?\n/u);
  const stripped = [];
  let openFence = null;

  for (const line of lines) {
    const fenceMatch = line.match(/^ {0,3}(```+|~~~+)/u);
    if (!fenceMatch) {
      if (openFence === null) {
        stripped.push(line);
      }
      continue;
    }

    const fenceChar = fenceMatch[1][0];
    const fenceLength = fenceMatch[1].length;
    if (openFence === null) {
      openFence = { char: fenceChar, length: fenceLength };
      continue;
    }

    if (openFence.char === fenceChar && fenceLength >= openFence.length) {
      openFence = null;
    }
  }

  return stripped;
}

function parseAtxHeading(line) {
  if (/^ {4,}/u.test(line)) {
    return null;
  }
  const match = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/u);
  if (!match) {
    return null;
  }
  return {
    level: match[1].length,
    text: match[2].trim(),
  };
}

function parseMarkdownTableRows(lines, startIndex) {
  const rows = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim().startsWith("|")) {
      break;
    }
    rows.push(line);
    index += 1;
  }

  if (rows.length < 3) {
    return { nextIndex: startIndex, entries: [] };
  }

  const entries = [];
  for (const row of rows.slice(2)) {
    const cols = row.split("|").slice(1, -1).map((col) => col.trim());
    if (cols.length < 3) {
      continue;
    }
    const toolMatch = cols[0].match(/^`([^`]+)`$/u);
    if (!toolMatch) {
      continue;
    }
    entries.push({
      tool: toolMatch[1],
      statusLabel: cols[1],
      notes: cols[2],
    });
  }

  return { nextIndex: index, entries };
}

function parseMemoryToolsSupportMatrix(markdown) {
  const lines = stripFencedCodeBlocks(markdown);
  let memoryToolsStart = -1;
  let memoryToolsEnd = lines.length;

  for (let i = 0; i < lines.length; i += 1) {
    const heading = parseAtxHeading(lines[i]);
    if (!heading) {
      continue;
    }
    if (heading.level === 2 && heading.text === "Memory tools") {
      memoryToolsStart = i + 1;
      continue;
    }
    if (memoryToolsStart !== -1 && heading.level === 2) {
      memoryToolsEnd = i;
      break;
    }
  }

  assert.notStrictEqual(memoryToolsStart, -1, "Missing '## Memory tools' section in docs/support-matrix.md");

  const categoryByTool = new Map();
  let currentCategory = null;

  for (let i = memoryToolsStart; i < memoryToolsEnd; i += 1) {
    const heading = parseAtxHeading(lines[i]);
    if (heading?.level === 3) {
      currentCategory = heading.text;
      continue;
    }

    if (!currentCategory || !lines[i].trim().startsWith("|")) {
      continue;
    }

    const { nextIndex, entries } = parseMarkdownTableRows(lines, i);
    if (nextIndex === i) {
      continue;
    }

    for (const entry of entries) {
      assert.ok(!categoryByTool.has(entry.tool), `Duplicate support-matrix entry for tool: ${entry.tool}`);
      categoryByTool.set(entry.tool, {
        category: currentCategory,
        statusLabel: entry.statusLabel,
        notes: entry.notes,
      });
    }

    i = nextIndex - 1;
  }

  return categoryByTool;
}

describe("LORE_CAPABILITY_SPECS", () => {
  it("is a frozen array", () => {
    assert.ok(Array.isArray(LORE_CAPABILITY_SPECS));
    assert.ok(Object.isFrozen(LORE_CAPABILITY_SPECS));
  });

  it("contains all 23 expected tool names", () => {
    const manifestNames = LORE_CAPABILITY_SPECS.map((s) => s.name);
    for (const name of EXPECTED_TOOL_NAMES) {
      assert.ok(manifestNames.includes(name), `Missing expected tool: ${name}`);
    }
    assert.strictEqual(manifestNames.length, EXPECTED_TOOL_NAMES.length);
  });

  it("has no duplicate names", () => {
    const names = LORE_CAPABILITY_SPECS.map((s) => s.name);
    const unique = new Set(names);
    assert.strictEqual(unique.size, names.length, "Duplicate tool names found");
  });

  it("every spec has a non-empty string name", () => {
    for (const spec of LORE_CAPABILITY_SPECS) {
      assert.strictEqual(typeof spec.name, "string");
      assert.ok(spec.name.length > 0, `Empty name on spec: ${JSON.stringify(spec)}`);
    }
  });

  it("every spec has a non-empty string description", () => {
    for (const spec of LORE_CAPABILITY_SPECS) {
      assert.strictEqual(typeof spec.description, "string", `description missing on: ${spec.name}`);
      assert.ok(spec.description.length > 0, `Empty description on: ${spec.name}`);
    }
  });

  it("every spec has valid route kind hints", () => {
    for (const spec of LORE_CAPABILITY_SPECS) {
      assert.ok(Array.isArray(spec.routeKindHints), `routeKindHints not array on: ${spec.name}`);
      for (const hint of spec.routeKindHints) {
        assert.strictEqual(typeof hint, "string");
        assert.ok(VALID_ROUTE_HINTS.has(hint), `Unknown routeKindHint '${hint}' on: ${spec.name}`);
      }
    }
  });

  it("every spec has support metadata for docs parity", () => {
    for (const spec of LORE_CAPABILITY_SPECS) {
      assert.ok(spec.support && typeof spec.support === "object", `support metadata missing on: ${spec.name}`);
      assert.ok(Object.isFrozen(spec), `Spec should be frozen: ${spec.name}`);
      assert.ok(Object.isFrozen(spec.support), `support should be frozen: ${spec.name}`);
      assert.ok(Array.isArray(spec.support.rolloutFlags), `support.rolloutFlags must be array on: ${spec.name}`);
      assert.ok(Object.isFrozen(spec.support.rolloutFlags), `support.rolloutFlags should be frozen: ${spec.name}`);
      assert.ok(VALID_SUPPORT_STATUS.has(spec.support.status), `Invalid support.status on: ${spec.name}`);
      assert.strictEqual(typeof spec.support.category, "string", `support.category missing on: ${spec.name}`);
      assert.ok(spec.support.category.length > 0, `Empty support.category on: ${spec.name}`);
      assert.strictEqual(typeof spec.support.notes, "string", `support.notes missing on: ${spec.name}`);
      assert.ok(spec.support.notes.length > 0, `Empty support.notes on: ${spec.name}`);
      for (const flag of spec.support.rolloutFlags) {
        assert.strictEqual(typeof flag, "string", `Non-string rollout flag on: ${spec.name}`);
        assert.ok(flag.length > 0, `Empty rollout flag on: ${spec.name}`);
      }
    }
  });

  it("retrieval tools include retrieval route hint", () => {
    const retrievalTools = ["lore_recall", "lore_reflect", "memory_search", "memory_explain"];
    for (const name of retrievalTools) {
      const spec = LORE_CAPABILITY_SPECS.find((s) => s.name === name);
      assert.ok(spec, `Spec not found: ${name}`);
      assert.ok(spec.routeKindHints.includes("retrieval"), `${name} should have retrieval hint`);
    }
  });

  it("direct tools include direct route hint", () => {
    const directTools = ["memory_status", "memory_validate", "memory_replay"];
    for (const name of directTools) {
      const spec = LORE_CAPABILITY_SPECS.find((s) => s.name === name);
      assert.ok(spec, `Spec not found: ${name}`);
      assert.ok(spec.routeKindHints.includes("direct"), `${name} should have direct hint`);
    }
  });

  it("background tools include background_task route hint", () => {
    const bgTools = ["memory_deferred_process", "memory_backfill"];
    for (const name of bgTools) {
      const spec = LORE_CAPABILITY_SPECS.find((s) => s.name === name);
      assert.ok(spec, `Spec not found: ${name}`);
      assert.ok(spec.routeKindHints.includes("background_task"), `${name} should have background_task hint`);
    }
  });
});

describe("createMemoryTools ↔ LORE_CAPABILITY_SPECS contract", () => {
  it("createMemoryTools returns exactly the tools named in the manifest", () => {
    const tools = createMemoryTools({ getRuntime: async () => ({}) });
    const toolNames = tools.map((t) => t.name).sort();
    const manifestNames = LORE_CAPABILITY_SPECS.map((s) => s.name).sort();
    assert.deepStrictEqual(toolNames, manifestNames);
  });

  it("each registered tool description matches its manifest spec", () => {
    const tools = createMemoryTools({ getRuntime: async () => ({}) });
    for (const tool of tools) {
      const spec = LORE_CAPABILITY_SPECS.find((s) => s.name === tool.name);
      assert.ok(spec, `No manifest spec for registered tool: ${tool.name}`);
      assert.strictEqual(
        tool.description,
        spec.description,
        `Description mismatch for ${tool.name}`,
      );
    }
  });

  it("each registered tool has a parameters object", () => {
    const tools = createMemoryTools({ getRuntime: async () => ({}) });
    for (const tool of tools) {
      assert.ok(tool.parameters && typeof tool.parameters === "object", `Missing parameters on: ${tool.name}`);
    }
  });

  it("each registered tool has a handler function", () => {
    const tools = createMemoryTools({ getRuntime: async () => ({}) });
    for (const tool of tools) {
      assert.strictEqual(typeof tool.handler, "function", `Missing handler on: ${tool.name}`);
    }
  });
});

describe("manifest ↔ docs/support-matrix parity", () => {
  it("every manifest tool has a support-matrix entry with matching status/category/notes", () => {
    const supportMatrix = readFileSync(SUPPORT_MATRIX_PATH, "utf8");
    const supportByTool = parseMemoryToolsSupportMatrix(supportMatrix);

    for (const spec of LORE_CAPABILITY_SPECS) {
      const row = supportByTool.get(spec.name);
      assert.ok(row, `Missing support-matrix row for tool: ${spec.name}`);
      assert.strictEqual(
        row.statusLabel,
        SUPPORT_MATRIX_STATUS_LABELS[spec.support.status],
        `Status mismatch for ${spec.name}`,
      );
      assert.strictEqual(row.category, spec.support.category, `Category mismatch for ${spec.name}`);
      assert.strictEqual(row.notes, spec.support.notes, `Notes mismatch for ${spec.name}`);
    }

    const manifestNames = new Set(LORE_CAPABILITY_SPECS.map((spec) => spec.name));
    for (const toolName of supportByTool.keys()) {
      assert.ok(manifestNames.has(toolName), `Support matrix lists tool not present in manifest: ${toolName}`);
    }
  });
});
