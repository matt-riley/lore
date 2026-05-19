import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildMemoryDomain } from "../../lib/memory-domains.mjs";

describe("buildMemoryDomain", () => {
  test("normalizes key, scope, repository, and payloads", () => {
    const domain = buildMemoryDomain({
      domainKey: "  Repo:Core  ",
      kind: "repo",
      title: " Core Lore ",
      mission: " Keep Lore tidy ",
      scope: "repo",
      repository: " matt-riley/lore ",
      directives: ["prefer local-first", "show provenance"],
      disposition: { owner: "Lore" },
      metadata: { priority: "high" },
      status: "active",
    });

    assert.deepEqual(domain, {
      domainKey: "repo:core",
      kind: "repo",
      title: "Core Lore",
      mission: "Keep Lore tidy",
      scope: "repo",
      repository: "matt-riley/lore",
      directives: ["prefer local-first", "show provenance"],
      disposition: { owner: "Lore" },
      metadata: { priority: "high" },
      status: "active",
    });
  });

  test("returns null when the key sanitizes away", () => {
    assert.equal(buildMemoryDomain({ domainKey: "   ", title: "Nothing" }), null);
  });
});
