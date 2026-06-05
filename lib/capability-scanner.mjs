/**
 * Filesystem scanning and metadata extraction for the capability inventory.
 */

import path from "node:path";

import { LORE_CAPABILITY_SPECS } from "./capability-manifest.mjs";
import {
  collectSkillManifests,
  parseFrontmatter,
  safeReadDir,
  safeReadFile,
  validateSkillFrontmatter,
} from "./skill-validator.mjs";
import {
  DEFAULT_REPO_ROOT,
  buildRouteEntries,
  buildRouterCorpusScaffold,
  buildWeightedKeywordMap,
  dedupeStrings,
  keywordList,
  normalizeText,
  normalizeWhitespace,
} from "./capability-utils.mjs";

const TOOL_ROUTE_HINTS = Object.freeze({});

function quotedParts(line) {
  const matches = [
    ...line.matchAll(/"([^"]*)"/g),
    ...line.matchAll(/`([^`]*)`/g),
  ];
  return matches.map((match) => normalizeWhitespace(match[1])).filter(Boolean);
}

function shouldStopDescriptionScan(trimmed, hasParts) {
  if (!trimmed) {
    return hasParts;
  }
  return /[a-zA-Z0-9_]+:\s/.test(trimmed)
    && !trimmed.startsWith("\"")
    && !trimmed.startsWith("`");
}

function readDescription(lines, startIndex) {
  const directParts = quotedParts(lines[startIndex] ?? "");
  if (directParts.length > 0) {
    return directParts.join(" ");
  }

  const parts = [];
  for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 8); index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (shouldStopDescriptionScan(trimmed, parts.length > 0)) {
      break;
    }
    const lineParts = quotedParts(trimmed);
    if (lineParts.length === 0) {
      if (parts.length > 0) {
        break;
      }
      continue;
    }
    parts.push(...lineParts);
    if (trimmed.endsWith(",")) {
      break;
    }
  }
  return parts.join(" ");
}

function sectionHeadingEquals(line, heading) {
  return normalizeText(line.replace(/^#+\s*/, "")) === normalizeText(heading);
}

function extractBulletSection(markdown, heading) {
  const lines = String(markdown || "").split("\n");
  const items = [];
  let active = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (/^##\s+/.test(trimmed)) {
      if (active) {
        break;
      }
      active = sectionHeadingEquals(trimmed, heading);
      continue;
    }
    if (!active) {
      continue;
    }

    const bulletMatch = line.match(/^\s*-\s+(.*)$/);
    if (bulletMatch) {
      items.push(normalizeWhitespace(bulletMatch[1]));
      continue;
    }

    if (items.length > 0 && /^\s{2,}\S/.test(line)) {
      items[items.length - 1] = normalizeWhitespace(`${items.at(-1)} ${trimmed}`);
    }
  }

  return items;
}

function isLeadTerminator(trimmed) {
  return !trimmed || trimmed.startsWith("#") || /^[-*]\s+/.test(trimmed);
}

function extractLeadParagraph(markdown) {
  const lines = String(markdown || "").split("\n");
  const parts = [];
  let started = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (isLeadTerminator(trimmed)) {
      if (started) break;
      continue;
    }
    parts.push(trimmed);
    started = true;
  }
  return normalizeWhitespace(parts.join(" "));
}

function relativePath(rootPath, filePath) {
  return path.relative(rootPath, filePath).replace(/\\/g, "/");
}

function buildTriggerTerms(keywordWeights, limit = 12) {
  return keywordList(keywordWeights).slice(0, Math.max(1, limit));
}

function inferExecutionMode({ capabilityType, routeKindHints, manualOnly }) {
  if (routeKindHints.includes("background_task")) {
    return "local_background_candidate";
  }
  if (capabilityType === "skill") {
    return "skill";
  }
  if (capabilityType === "agent") {
    return manualOnly ? "delegated_manual" : "delegated";
  }
  if (capabilityType === "tool") {
    return "local_tool";
  }
  return "direct";
}

function buildCapabilityBase({
  id,
  name,
  description,
  sourcePath,
  capabilityType,
  routeKindHints,
  summary,
  manualOnly = false,
  keywordParts,
  triggerCapabilities = [],
  executionMode,
  metadata = {},
}) {
  const keywordWeights = buildWeightedKeywordMap(keywordParts);
  const normalizedRouteKindHints = [...new Set(routeKindHints)];
  const explanationMetadata = {
    summary: normalizeWhitespace(summary),
    description: normalizeWhitespace(description),
    sourceKind: metadata.sourceKind ?? capabilityType,
    manualOnly,
    routeKindHints: normalizedRouteKindHints,
    explanationMode: "recommendation_only",
  };
  return {
    id,
    name,
    targetName: name,
    targetType: capabilityType,
    capabilityType,
    description: normalizeWhitespace(description),
    summary: explanationMetadata.summary,
    sourcePath,
    routeKindHints: normalizedRouteKindHints,
    routeKind: normalizedRouteKindHints[0] ?? "direct",
    manualOnly,
    triggerTerms: buildTriggerTerms(keywordWeights),
    triggerCapabilities: dedupeStrings(triggerCapabilities),
    executionMode: executionMode ?? inferExecutionMode({
      capabilityType,
      routeKindHints: normalizedRouteKindHints,
      manualOnly,
    }),
    explanationMetadata,
    metadata,
    keywordWeights,
    keywords: keywordList(keywordWeights),
  };
}

function buildToolRouteHints(name, _extensionName) {
  return TOOL_ROUTE_HINTS[name] ?? [];
}

function buildManifestEntry(capability) {
  return {
    id: capability.id,
    routeKind: capability.routeKind,
    routeKindHints: capability.routeKindHints,
    targetName: capability.targetName,
    targetType: capability.targetType,
    sourcePath: capability.sourcePath,
    triggerTerms: capability.triggerTerms,
    triggerCapabilities: capability.triggerCapabilities,
    executionMode: capability.executionMode,
    explanation: capability.explanationMetadata,
  };
}

function extractToolSpecs(sourceText) {
  const lines = String(sourceText || "").split("\n");
  const tools = [];
  for (let index = 0; index < lines.length; index += 1) {
    const nameMatch = lines[index].match(/name:\s*"([^"]+)"/);
    if (!nameMatch) {
      continue;
    }
    let description = "";
    for (let lookahead = index + 1; lookahead < Math.min(lines.length, index + 8); lookahead += 1) {
      if (!lines[lookahead].includes("description:")) {
        continue;
      }
      description = readDescription(lines, lookahead);
      break;
    }
    tools.push({
      name: nameMatch[1],
      description,
    });
  }
  return tools.filter((tool, index, array) =>
    array.findIndex((candidate) => candidate.name === tool.name) === index
  );
}

function extractHookNames(sourceText) {
  const matches = [
    ...String(sourceText || "").matchAll(/\b(on[A-Z][A-Za-z0-9]+)\s*:/g),
  ];
  return [...new Set(matches.map((match) => match[1]))].sort();
}

async function scanSkills(rootPath) {
  const manifests = await collectSkillManifests(rootPath);
  const skills = [];
  const validationErrors = [];
  const degradedSkills = [];

  for (const { skillDir, skillFile, content, attributes, body } of manifests) {
    if (!content) {
      validationErrors.push({
        skill_dir: skillDir,
        reason: "SKILL.md file not found or not readable",
      });
      continue;
    }

    // Validate frontmatter
    const fmErrors = validateSkillFrontmatter(attributes, skillDir);
    if (fmErrors) {
      validationErrors.push({
        skill_dir: skillDir,
        reason: `Frontmatter validation failed: ${fmErrors.join("; ")}`,
      });
      continue;
    }
    
    const name = attributes.name;
    const description = attributes.description;
    const useWhen = extractBulletSection(body, "Use this skill when");
    const avoidWhen = extractBulletSection(body, "Do not use this skill when");
    const summary = extractLeadParagraph(body);
    const sourcePath = relativePath(rootPath, skillFile);

    skills.push(buildCapabilityBase({
      id: `skill:${name}`,
      name,
      description,
      sourcePath,
      capabilityType: "skill",
      routeKindHints: ["skill"],
      summary,
      keywordParts: [
        { text: name, weight: 4 },
        { text: description, weight: 3 },
        { text: summary, weight: 2 },
        ...useWhen.map((text) => ({ text, weight: 2 })),
        ...avoidWhen.map((text) => ({ text, weight: 1 })),
        ...Object.values(attributes.metadata ?? {}).map((text) => ({ text: String(text), weight: 1 })),
      ],
      triggerCapabilities: [
        ...useWhen,
        ...Object.entries(attributes.metadata ?? {}).map(([key, value]) => `${key}:${value}`),
      ],
      metadata: {
        sourceKind: "skill",
        useWhen,
        avoidWhen,
        frontmatter: attributes,
      },
    }));
  }

  return {
    skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    validation_errors: validationErrors,
    degraded_skills: degradedSkills,
  };
}

// fallow-ignore-next-line complexity
async function scanAgents(rootPath) {
  const agentsDir = path.join(rootPath, "agents");
  const entries = await safeReadDir(agentsDir);
  const agents = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".agent.md")) {
      continue;
    }
    const agentFile = path.join(agentsDir, entry.name);
    const content = await safeReadFile(agentFile);
    if (!content) {
      continue;
    }

    const { attributes, body } = parseFrontmatter(content);
    const name = typeof attributes.name === "string" && attributes.name
      ? attributes.name
      : entry.name.replace(/\.agent\.md$/, "");
    const description = typeof attributes.description === "string" ? attributes.description : "";
    const summary = extractLeadParagraph(body);
    const sourcePath = relativePath(rootPath, agentFile);
    const manualOnly = /manual-only/i.test(description) || /manual-only/i.test(summary);

    agents.push(buildCapabilityBase({
      id: `agent:${name}`,
      name,
      description,
      sourcePath,
      capabilityType: "agent",
      routeKindHints: ["agent"],
      summary,
      manualOnly,
      keywordParts: [
        { text: name, weight: 4 },
        { text: description, weight: 3 },
        { text: summary, weight: 2 },
        { text: body, weight: 1 },
      ],
      triggerCapabilities: [
        summary,
        manualOnly ? "manual-only" : "delegated",
      ],
      metadata: {
        sourceKind: "agent",
        frontmatter: attributes,
      },
    }));
  }

  return agents.sort((left, right) => left.name.localeCompare(right.name));
}

function extensionSummary(rootPath, extensionName, extensionFile, sourceText, toolNames) {
  return {
    name: extensionName,
    sourcePath: relativePath(rootPath, extensionFile),
    hookNames: extractHookNames(sourceText),
    toolNames: [...toolNames].sort(),
  };
}

// fallow-ignore-next-line complexity
async function scanExtensionSurfaces(rootPath) {
  const extensionsDir = path.join(rootPath, "extensions");
  const entries = await safeReadDir(extensionsDir);
  const extensions = [];
  const tools = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const extensionFile = path.join(extensionsDir, entry.name, "extension.mjs");
    const sourceText = await safeReadFile(extensionFile);
    if (!sourceText) {
      continue;
    }

    const toolSpecs = entry.name === "lore" ? [] : extractToolSpecs(sourceText);
    const sourcePath = relativePath(rootPath, extensionFile);
    for (const tool of toolSpecs) {
      tools.push(buildCapabilityBase({
        id: `tool:${tool.name}`,
        name: tool.name,
        description: tool.description || `${entry.name} tool`,
        sourcePath,
        capabilityType: "tool",
        routeKindHints: buildToolRouteHints(tool.name, entry.name),
        summary: `${entry.name} extension tool`,
        keywordParts: [
          { text: tool.name, weight: 4 },
          { text: tool.description, weight: 3 },
          { text: entry.name, weight: 1 },
        ],
        triggerCapabilities: [
          entry.name,
          ...buildToolRouteHints(tool.name, entry.name),
        ],
        metadata: {
          sourceKind: "extension_tool",
          extensionName: entry.name,
        },
      }));
    }

    extensions.push(extensionSummary(
      rootPath,
      entry.name,
      extensionFile,
      sourceText,
      toolSpecs.map((tool) => tool.name),
    ));
  }

  const loreToolsFile = path.join(rootPath, "extensions", "lore", "lib", "memory-tools.mjs");
  const loreEntry = extensions.find((extension) => extension.name === "lore");
  if (loreEntry) {
    for (const spec of LORE_CAPABILITY_SPECS) {
      tools.push(buildCapabilityBase({
        id: `tool:${spec.name}`,
        name: spec.name,
        description: spec.description || "lore tool",
        sourcePath: relativePath(rootPath, loreToolsFile),
        capabilityType: "tool",
        routeKindHints: spec.routeKindHints,
        summary: "lore extension tool",
        keywordParts: [
          { text: spec.name, weight: 4 },
          { text: spec.description, weight: 3 },
          { text: "lore memory retrieval diagnostics backfill", weight: 1 },
        ],
        triggerCapabilities: [
          "lore",
          ...spec.routeKindHints,
        ],
        metadata: {
          sourceKind: "lore_tool",
          extensionName: "lore",
        },
      }));
    }

    loreEntry.toolNames = [...new Set([...loreEntry.toolNames, ...LORE_CAPABILITY_SPECS.map((spec) => spec.name)])]
      .sort();
    loreEntry.toolSourcePaths = [
      loreEntry.sourcePath,
      relativePath(rootPath, loreToolsFile),
    ];
  }

  const dedupedTools = tools.filter((tool, index, array) =>
    array.findIndex((candidate) => candidate.id === tool.id) === index
  );

  return {
    extensions: extensions.sort((left, right) => left.name.localeCompare(right.name)),
    tools: dedupedTools.sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/**
 * Scan repo-authored skills, agents, and extension surfaces into a capability inventory.
 *
 * @param {{ rootPath?: string }} [options]
 * @returns {Promise<object>}
 */
export async function scanCapabilityInventory({ rootPath = DEFAULT_REPO_ROOT } = {}) {
  const [skillsResult, agents, extensionScan] = await Promise.all([
    scanSkills(rootPath),
    scanAgents(rootPath),
    scanExtensionSurfaces(rootPath),
  ]);

  const skills = skillsResult.skills;
  const validationErrors = skillsResult.validation_errors;
  const degradedSkills = skillsResult.degraded_skills;

  const capabilities = [...skills, ...agents, ...extensionScan.tools];
  const routes = buildRouteEntries(capabilities);
  const manifest = capabilities.map(buildManifestEntry);
  const routerCorpus = buildRouterCorpusScaffold();

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "local_first_inventory",
    manifestVersion: 1,
    rootPath,
    counts: {
      skills: skills.length,
      agents: agents.length,
      extensions: extensionScan.extensions.length,
      tools: extensionScan.tools.length,
      capabilities: capabilities.length,
      manifestEntries: manifest.length,
      routes: routes.length,
    },
    routes: routes.map((route) => ({
      id: route.id,
      label: route.label,
      explanation: route.explanation,
      supportLevel: route.supportLevel,
      available: route.available,
      recommendedWhen: route.recommendedWhen,
      supportingCapabilityIds: route.supportingCapabilityIds,
      gaps: route.gaps,
    })),
    skills,
    agents,
    extensions: extensionScan.extensions.map((extension) => ({
      ...extension,
      toolCount: extension.toolNames.length,
    })),
    tools: extensionScan.tools,
    capabilities,
    manifest,
    routerCorpus,
    validation: {
      errors: validationErrors,
      degradedSkills,
    },
  };
}
