import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { renderEpisode } from "../../lib/capsule-assembler.mjs";
import { matchesReflectFocus } from "../../lib/memory-operations.mjs";

describe("matchesReflectFocus", () => {
  test("treats recurring mistakes as decision-focused evidence", () => {
    assert.equal(
      matchesReflectFocus(
        {
          kind: "recurring_mistake",
          text: "Never ship the old fallback again.",
        },
        "decisions",
      ),
      true,
    );
  });

  test("treats assistant goals as next-action evidence", () => {
    assert.equal(
      matchesReflectFocus(
        {
          kind: "assistant_goal",
          text: "Implement the final scope validation.",
        },
        "next_actions",
      ),
      true,
    );
  });
});

describe("renderEpisode", () => {
  test("renders early cross-repo episodes with decision/open detail priority", () => {
    assert.equal(
      renderEpisode(
        {
          summary: "Migrated the shared release workflow",
          date_key: "2024-05-01",
          decisions_json: JSON.stringify(["Keep SHA-pinned actions"]),
          open_items_json: JSON.stringify(["Backfill the release smoke test"]),
          actions_json: JSON.stringify(["updated workflow"]),
          themes_json: JSON.stringify(["ci", "release"]),
          repository: "owner/other-repo",
          currentRepository: "owner/test-repo",
        },
        0,
      ),
      "- 2024-05-01: Migrated the shared release workflow [example from owner/other-repo] — decision: Keep SHA-pinned actions | open: Backfill the release smoke test",
    );
  });

  test("renders later episodes with theme-only detail fallback", () => {
    assert.equal(
      renderEpisode(
        {
          summary: "Documented rollout follow-up",
          date_key: "2024-05-02",
          decisions_json: JSON.stringify([]),
          open_items_json: JSON.stringify([]),
          actions_json: JSON.stringify(["updated docs"]),
          themes_json: JSON.stringify(["docs", "rollout", "follow-up"]),
          repository: "owner/test-repo",
          currentRepository: "owner/test-repo",
        },
        2,
      ),
      "- 2024-05-02: Documented rollout follow-up — themes: docs, rollout",
    );
  });
});
