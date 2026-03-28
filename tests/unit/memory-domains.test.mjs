import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { buildMemoryDomain, MEMORY_DOMAIN_KIND, MEMORY_DOMAIN_STATUS } from "../../lib/memory-domains.mjs";

describe("buildMemoryDomain", () => {
  test("normalizes key, scope, repository, and payloads", () => {
    const domain = buildMemoryDomain({
      domainKey: "  Repo:Core  ",
      kind: MEMORY_DOMAIN_KIND.REPO,
      title: " Core Lore ",
      mission: " Keep Lore tidy ",
      scope: "repo",
      repository: " mattriley/lore ",
      directives: ["prefer local-first", "show provenance"],
      disposition: { owner: "Lore" },
      metadata: { priority: "high" },
      status: MEMORY_DOMAIN_STATUS.ACTIVE,
    });

    assert.deepEqual(domain, {
      domainKey: "repo:core",
      kind: "repo",
      title: "Core Lore",
      mission: "Keep Lore tidy",
      scope: "repo",
      repository: "mattriley/lore",
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
