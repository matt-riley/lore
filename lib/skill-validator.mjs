/**
 * lib/skill-validator.mjs
 *
 * Standalone tool for diagnosing skill configuration issues.
 * Reuses scanSkills from capability-inventory.mjs
 */

import path from "node:path";
import { readFile, readdir } from "node:fs/promises";

function stripYamlScalar(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseFrontmatter(markdown) {
  const lines = String(markdown || "").split("\n");
  if (lines[0]?.trim() !== "---") {
    return { attributes: {}, body: markdown };
  }

  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (endIndex < 0) {
    return { attributes: {}, body: markdown };
  }

  const attributes = {};
  let nestedKey = null;
  for (const line of lines.slice(1, endIndex)) {
    if (!line.trim()) {
      continue;
    }
    const nestedMatch = nestedKey
      ? line.match(/^\s{2}([a-zA-Z0-9_-]+):\s*(.*)$/)
      : null;
    if (nestedMatch) {
      attributes[nestedKey][nestedMatch[1]] = stripYamlScalar(nestedMatch[2]);
      continue;
    }

    const topLevelMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!topLevelMatch) {
      nestedKey = null;
      continue;
    }

    const [, key, rawValue] = topLevelMatch;
    if (rawValue.trim().length === 0) {
      attributes[key] = {};
      nestedKey = key;
      continue;
    }

    attributes[key] = stripYamlScalar(rawValue);
    nestedKey = null;
  }

  return {
    attributes,
    body: lines.slice(endIndex + 1).join("\n").trim(),
  };
}

function validateSkillName(name) {
  if (!name || typeof name !== "string") {
    return "Name must be a non-empty string";
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return "Name must not be empty";
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return "Name must contain only alphanumeric characters, hyphens, and underscores";
  }
  return null;
}

function validateSkillDescription(description) {
  if (!description || typeof description !== "string") {
    return "Description must be a non-empty string";
  }
  const trimmed = description.trim();
  if (trimmed.length === 0) {
    return "Description must not be empty";
  }
  if (trimmed.length < 10) {
    return `Description should be at least 10 characters (currently ${trimmed.length})`;
  }
  return null;
}

function validateSkillFrontmatter(attributes, skillDir) {
  const errors = [];

  const nameError = validateSkillName(attributes.name);
  if (nameError) {
    errors.push(`Invalid name: ${nameError}`);
  }

  const descError = validateSkillDescription(attributes.description);
  if (descError) {
    errors.push(`Invalid description: ${descError}`);
  }

  return errors.length > 0 ? errors : null;
}

async function safeReadFile(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function safeReadDir(dirPath) {
  try {
    return await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Validate all skills in the repository
 * Returns: { validSkills, validationErrors, degradedSkills, summary }
 */
export async function validateSkillsDirectory(rootPath) {
  const skillsDir = path.join(rootPath, "skills");
  const entries = await safeReadDir(skillsDir);

  const validSkills = [];
  const validationErrors = [];
  const degradedSkills = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const skillDir = entry.name;
    const skillFile = path.join(skillsDir, skillDir, "SKILL.md");
    const content = await safeReadFile(skillFile);

    if (!content) {
      validationErrors.push({
        skillDir,
        reason: "SKILL.md file not found or not readable",
        remediation: `Ensure ${skillDir}/SKILL.md exists and is readable`,
      });
      continue;
    }

    const { attributes, body } = parseFrontmatter(content);

    // Validate frontmatter
    const fmErrors = validateSkillFrontmatter(attributes, skillDir);
    if (fmErrors) {
      validationErrors.push({
        skillDir,
        reason: `Frontmatter validation failed: ${fmErrors.join("; ")}`,
        remediation:
          "Add YAML frontmatter with `name` (alphanumeric/hyphens/underscores) and `description` (min 10 chars)",
      });
      continue;
    }

    validSkills.push({
      skillDir,
      name: attributes.name,
      description: attributes.description,
    });
  }

  const summary = {
    total: entries.filter((e) => e.isDirectory()).length,
    valid: validSkills.length,
    errors: validationErrors.length,
    degraded: degradedSkills.length,
  };

  return {
    summary,
    validSkills: validSkills.sort((a, b) => a.name.localeCompare(b.name)),
    validationErrors,
    degradedSkills,
  };
}

/**
 * Format validation results as human-readable output
 */
export function formatValidationResults(result, action = "summary") {
  const { summary, validSkills, validationErrors, degradedSkills } = result;

  if (action === "summary") {
    const icon = summary.errors === 0 && summary.degraded === 0 ? "✓" : "⚠";
    return [
      `${icon} Skills validation report`,
      `Total: ${summary.total}, Valid: ${summary.valid}, Errors: ${summary.errors}, Degraded: ${summary.degraded}`,
    ].join("\n");
  }

  // Detailed output
  const lines = [];

  lines.push("## Valid Skills");
  if (validSkills.length === 0) {
    lines.push("None");
  } else {
    for (const skill of validSkills) {
      lines.push(`- ${skill.name} (${skill.skillDir})`);
    }
  }

  lines.push("");
  lines.push("## Validation Errors");
  if (validationErrors.length === 0) {
    lines.push("None");
  } else {
    for (const error of validationErrors) {
      lines.push(`- ${error.skillDir}`);
      lines.push(`  reason: ${error.reason}`);
      lines.push(`  remediation: ${error.remediation}`);
    }
  }

  lines.push("");
  lines.push("## Degraded Skills");
  if (degradedSkills.length === 0) {
    lines.push("None");
  } else {
    for (const skill of degradedSkills) {
      lines.push(`- ${skill.skillDir}`);
      for (const issue of skill.issues) {
        lines.push(`  ${issue.field}: ${issue.issue}`);
        if (issue.suggestion) {
          lines.push(`    suggestion: ${issue.suggestion}`);
        }
      }
    }
  }

  lines.push("");
  lines.push(`Summary: ${summary.total} total, ${summary.valid} valid, ${summary.errors} errors, ${summary.degraded} degraded`);

  return lines.join("\n");
}
