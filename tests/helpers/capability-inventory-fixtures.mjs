import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSourceExtractor } from "./source-parser.mjs";

const CAPABILITY_SOURCE_EXTRACTORS = [
  "../../lib/capability-utils.mjs",
  "../../lib/capability-scanner.mjs",
  "../../lib/capability-router.mjs",
  "../../lib/capability-renderer.mjs",
].map((relativePath) => makeSourceExtractor(readFileSync(new URL(relativePath, import.meta.url), "utf8")));

function extractCapabilityFunctionSource(name) {
  for (const extractFunctionSource of CAPABILITY_SOURCE_EXTRACTORS) {
    try {
      return extractFunctionSource(name);
    } catch (error) {
      if (/expected .* to exist in source/.test(String(error?.message))) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`expected ${name} to exist in capability sources`);
}

export function loadCapabilityFunctions(names) {
  const functionSources = names.map((name) => extractCapabilityFunctionSource(name)).join("\n\n");
  return Function(`"use strict"; ${functionSources}; return { ${names.join(", ")} };`)();
}

export function createCapabilityFixtureRoot({
  includeReversePrompt = true,
  includeSkillCreator = true,
  includePlannerAgent = false,
  includeCiMigrationSkill = false,
} = {}) {
  const rootPath = mkdtempSync(path.join(os.tmpdir(), "lore-capability-inventory-"));
  const skillsDir = path.join(rootPath, "skills");
  mkdirSync(skillsDir, { recursive: true });

  if (includeReversePrompt) {
    writeSkillFixture(skillsDir, "reverse-prompt", {
      description: "Sharpen or rewrite a rough request into a repository-grounded brief before planning or implementation.",
      useWhen: [
        "The user explicitly asks to sharpen, rewrite, or improve a prompt before moving on.",
        "The user wants a repo-grounded brief before planning or implementation.",
      ],
      avoidWhen: [
        "The user is asking you to implement the change directly without prompt rewriting first.",
      ],
    });
  }

  if (includeSkillCreator) {
    writeSkillFixture(skillsDir, "skill-creator", {
      description: "Create or upgrade a local skill under ~/.copilot/skills when the user wants better triggers, validation, or support-file structure.",
      useWhen: [
        "The user asks to create a new skill under ~/.copilot/skills.",
        "The user wants a skill's trigger boundaries, validation steps, or support-file layout improved.",
      ],
      avoidWhen: [
        "The task is normal repo code instead of skill authoring.",
      ],
    });
  }

  if (includeCiMigrationSkill) {
    writeSkillFixture(skillsDir, "circleci-to-github-actions-migration", {
      description: "Guide a CircleCI to GitHub Actions migration with repo-local guardrails and staged rollout advice.",
      useWhen: [
        "The user wants to migrate from CircleCI to GitHub Actions.",
        "The task needs a reusable migration workflow instead of ad-hoc edits.",
      ],
      avoidWhen: [
        "The prompt only asks a generic reference question without asking for a migration workflow.",
      ],
    });
  }

  if (includePlannerAgent) {
    const agentsDir = path.join(rootPath, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeAgentFixture(agentsDir, "implementation-planner", {
      description: "Manual-only planning agent for breaking work into a repo-grounded implementation plan.",
      summary: "Use this agent when the task needs planning, orchestration, or step-by-step implementation sequencing before editing.",
    });
  }

  return {
    rootPath,
    cleanup() {
      rmSync(rootPath, { recursive: true, force: true });
    },
  };
}

function writeSkillFixture(skillsDir, skillName, { description, useWhen, avoidWhen }) {
  const skillDir = path.join(skillsDir, skillName);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---
name: ${skillName}
description: ${description}
---

## Use this skill when

${useWhen.map((item) => `- ${item}`).join("\n")}

## Do not use this skill when

${avoidWhen.map((item) => `- ${item}`).join("\n")}
`,
    "utf8"
  );
}

function writeAgentFixture(agentsDir, agentName, { description, summary }) {
  writeFileSync(
    path.join(agentsDir, `${agentName}.agent.md`),
    `---
name: ${agentName}
description: ${description}
---

${summary}
`,
    "utf8"
  );
}
