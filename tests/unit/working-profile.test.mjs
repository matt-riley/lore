import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { assembleMemoryCapsule } from "../../lib/capsule-assembler.mjs";
import { buildWorkingProfileSection } from "../../lib/working-profile.mjs";
import { FTS5_AVAILABLE, withFixtureDb } from "../helpers/fixture-db.mjs";

const SKIP_NO_FTS5 = !FTS5_AVAILABLE
  ? "FTS5 not compiled into this Node.js SQLite build (Copilot CLI runtime has it; check your local Node install)"
  : false;

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

describe("buildWorkingProfileSection", () => {
  test("is disabled when the rollout flag is off", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb();
    try {
      const section = buildWorkingProfileSection({ db, config });
      assert.equal(section.text, "");
      assert.equal(section.trace.enabled, false);
      assert.equal(section.trace.reason, "rollout_disabled");
    } finally {
      cleanup();
    }
  });

  test("reports no_user_domain when no user-kind domain exists", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { rollout: { ambientWorkingProfile: true } },
    });
    try {
      db.upsertMemoryDomain({
        domainKey: "repo:core",
        kind: "repo",
        title: "Core Lore",
        scope: "repo",
        repository: "owner/repo",
      });

      const section = buildWorkingProfileSection({ db, config });
      assert.equal(section.text, "");
      assert.equal(section.trace.reason, "no_user_domain");
    } finally {
      cleanup();
    }
  });

  test("reports no_observation when the user domain has no observation yet", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { rollout: { ambientWorkingProfile: true } },
    });
    try {
      db.upsertMemoryDomain({
        domainKey: "matt",
        kind: "user",
        title: "Matt — Working Profile",
        scope: "global",
      });

      const section = buildWorkingProfileSection({ db, config });
      assert.equal(section.text, "");
      assert.equal(section.trace.reason, "no_observation");
      assert.equal(section.trace.domainKey, "matt");
    } finally {
      cleanup();
    }
  });

  test("includes a fresh observation's summary, capped by config.budgets.workingProfile", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { rollout: { ambientWorkingProfile: true } },
    });
    try {
      db.upsertMemoryDomain({
        domainKey: "matt",
        kind: "user",
        title: "Matt — Working Profile",
        scope: "global",
      });
      db.upsertObservation({
        observationKey: "matt-profile",
        domainKey: "matt",
        title: "Matt profile",
        focus: "patterns",
        summary: "Matt prefers concise, direct answers and conventional-commit messages.",
        scope: "global",
        freshnessHours: 24,
        source: "lore_reflect",
        lastRefreshedAt: isoHoursAgo(1),
      });

      const section = buildWorkingProfileSection({ db, config });
      assert.match(section.text, /^## Working Profile\n\n/);
      assert.match(section.text, /Matt prefers concise, direct answers/);
      assert.equal(section.trace.enabled, true);
      assert.equal(section.trace.reason, "included");
      assert.equal(section.trace.domainKey, "matt");
      assert.equal(section.trace.observationKey, "matt-profile");
      assert.equal(section.trace.ageHours, 1);
      assert.equal(section.trace.freshnessHours, 24);
    } finally {
      cleanup();
    }
  });

  test("reports stale when the observation has aged past freshnessHours", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { rollout: { ambientWorkingProfile: true } },
    });
    try {
      db.upsertMemoryDomain({
        domainKey: "matt",
        kind: "user",
        title: "Matt — Working Profile",
        scope: "global",
      });
      db.upsertObservation({
        observationKey: "matt-profile",
        domainKey: "matt",
        title: "Matt profile",
        focus: "patterns",
        summary: "Stale summary that should not surface.",
        scope: "global",
        freshnessHours: 1,
        source: "lore_reflect",
        lastRefreshedAt: isoHoursAgo(10),
      });

      const section = buildWorkingProfileSection({ db, config });
      assert.equal(section.text, "");
      assert.equal(section.trace.reason, "stale");
      assert.equal(section.trace.observationKey, "matt-profile");
      assert.equal(section.trace.freshnessHours, 1);
      assert.ok(section.trace.ageHours >= 10);
    } finally {
      cleanup();
    }
  });

  test("truncates long summaries to the configured token budget", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: {
        rollout: { ambientWorkingProfile: true },
        budgets: { workingProfile: 10 },
      },
    });
    try {
      db.upsertMemoryDomain({
        domainKey: "matt",
        kind: "user",
        title: "Matt — Working Profile",
        scope: "global",
      });
      db.upsertObservation({
        observationKey: "matt-profile",
        domainKey: "matt",
        title: "Matt profile",
        focus: "patterns",
        summary: "This summary is intentionally much longer than the tiny ten token budget allows for this test case.",
        scope: "global",
        freshnessHours: 24,
        source: "lore_reflect",
        lastRefreshedAt: isoHoursAgo(1),
      });

      const section = buildWorkingProfileSection({ db, config });
      const summaryLine = section.text.split("\n\n")[1];
      // 10 tokens * 4 chars/token = 40 char budget, plus the "## Working Profile\n\n" header.
      assert.ok(summaryLine.length <= 40);
      assert.match(summaryLine, /…$/);
    } finally {
      cleanup();
    }
  });
});

describe("assembleMemoryCapsule Working Profile integration", () => {
  test("surfaces the working profile section when enabled with a fresh observation", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb({
      configOverrides: { rollout: { ambientWorkingProfile: true } },
    });
    try {
      db.upsertMemoryDomain({
        domainKey: "matt",
        kind: "user",
        title: "Matt — Working Profile",
        scope: "global",
      });
      db.upsertObservation({
        observationKey: "matt-profile",
        domainKey: "matt",
        title: "Matt profile",
        focus: "patterns",
        summary: "Matt prefers concise, direct answers.",
        scope: "global",
        freshnessHours: 24,
        source: "lore_reflect",
        lastRefreshedAt: isoHoursAgo(1),
      });

      const result = await assembleMemoryCapsule({
        prompt: "let's keep going on the migration",
        repository: "owner/repo",
        proceduralProfile: "",
        db,
        sessionStore: {
          searchIndex: () => [],
          findRelevantSessions: () => [],
          getRecentSessions: () => [],
        },
        config,
        includeTrace: true,
      });

      assert.match(result.text, /## Working Profile/);
      assert.match(result.text, /Matt prefers concise, direct answers/);
      assert.equal(result.trace.lookups.workingProfile.reason, "included");
    } finally {
      cleanup();
    }
  });

  test("omits the working profile section when the rollout flag is disabled", { skip: SKIP_NO_FTS5 }, async () => {
    const { db, config, cleanup } = await withFixtureDb();
    try {
      const result = await assembleMemoryCapsule({
        prompt: "let's keep going on the migration",
        repository: "owner/repo",
        proceduralProfile: "",
        db,
        sessionStore: {
          searchIndex: () => [],
          findRelevantSessions: () => [],
          getRecentSessions: () => [],
        },
        config,
        includeTrace: true,
      });

      assert.doesNotMatch(result.text, /## Working Profile/);
      assert.equal(result.trace.lookups.workingProfile.reason, "rollout_disabled");
      assert.ok(
        result.trace.omissions.some(
          (omission) => omission.stage === "working_profile" && omission.reason === "rollout_disabled",
        ),
      );
    } finally {
      cleanup();
    }
  });
});
