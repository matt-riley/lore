import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { canonicalRemoteIdentity, resolveRepositoryIdentity } from "../../lib/utils/repository-identity.mjs";

test("remote identities retain host and full path while normalizing transports", () => {
  assert.equal(canonicalRemoteIdentity("git@github.com:Team/project.git"), "github.com/Team/project");
  assert.equal(canonicalRemoteIdentity("https://github.com/Team/project.git"), "github.com/Team/project");
  assert.equal(canonicalRemoteIdentity("ssh://git@gitlab.com/group/subgroup/project.git"), "gitlab.com/group/subgroup/project");
  assert.notEqual(canonicalRemoteIdentity("https://github.com/team/project"), canonicalRemoteIdentity("https://gitlab.com/team/project"));
  assert.equal(canonicalRemoteIdentity("ssh://git@host.example:2222/team/project.git"), "host.example:2222/team/project");
  for (const value of ["team/project", "../local.git", "/tmp/project", "file:///tmp/project", ""]) assert.equal(canonicalRemoteIdentity(value), null);
});

test("explicit identity wins, ambiguous legacy identity requires a mapping", () => {
  assert.equal(resolveRepositoryIdentity({ explicit: " custom/key ", legacy: "team/project" }), "custom/key");
  assert.equal(resolveRepositoryIdentity({ legacy: "team/project" }), null);
  assert.equal(resolveRepositoryIdentity({ legacy: "team/project", mappings: [{ legacy: "team/project", canonical: "github.com/team/project" }] }), "github.com/team/project");
  assert.equal(resolveRepositoryIdentity({ legacy: "team/project", mappings: [{ legacy: "team/project", canonical: "github.com/team/project" }, { legacy: "team/project", canonical: "gitlab.com/team/project" }] }), null);
});

test("same-basename local repos are isolated and Git worktrees share identity", () => {
  const root = mkdtempSync(path.join(tmpdir(), "lore-repository-identity-"));
  const git = (args, cwd = root) => execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" }).trim();
  try {
    const first = path.join(root, "one", "project");
    const second = path.join(root, "two", "project");
    mkdirSync(first, { recursive: true }); mkdirSync(second, { recursive: true });
    git(["init", "-q"], first); git(["init", "-q"], second);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture"], first);
    const linked = path.join(root, "linked");
    git(["worktree", "add", "--detach", linked], first);
    const identity = resolveRepositoryIdentity({ cwd: first });
    assert.match(identity, /^local:[a-f0-9]{64}$/);
    assert.notEqual(identity, resolveRepositoryIdentity({ cwd: second }));
    assert.equal(identity, resolveRepositoryIdentity({ cwd: linked }));
    git(["remote", "add", "origin", "git@github.com:team/project.git"], first);
    assert.equal(resolveRepositoryIdentity({ cwd: first }), "github.com/team/project");
    assert.equal(resolveRepositoryIdentity({ cwd: linked }), "github.com/team/project");
    assert.equal(resolveRepositoryIdentity({ cwd: root }), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
