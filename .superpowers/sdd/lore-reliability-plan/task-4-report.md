# Task 4 report: resumable native capture and shared adapter identity

## Scope

Implemented bounded, resumable JSONL capture for Codex, Claude, Antigravity,
and Pi session sources. Capture reads asynchronously, then persists the cursor
and extraction in one synchronous checkpoint CAS transaction. The checkpoint
revision is kept separate from the source revision, and stale writers return a
categorical conflict without changing evidence.

Adapter state contains only sanitized user/assistant text and source offsets.
Claude follows the active parent leaf, Antigravity keeps the latest completed
step by `step_index`, and Codex/Pi retain stable byte-offset record IDs.
Missing, malformed, and oversized records produce categorical health codes;
oversized records skip to their next newline. Rewrites, truncation, inode
changes, and prefix changes reset the scan generation safely.

Canonical repository identity now hydrates Copilot workspace/session rows and is
used by native and Pi paths. Ambiguous raw repository slugs resolve to null
unless explicitly mapped. Pi shutdown/archive extraction uses the bounded
reader, while existing full-reader APIs remain available for compatibility.

`lore-cli.mjs capture --resume --client <client> --session <native-id>` runs one
bounded pass and returns pending/health JSON; direct capture errors are nonzero,
while hook failures remain neutral.

## Verification

- Focused adapters/readers/identity/transaction tests: 42 passed.
- Native hook, Pi server, Pi lifecycle, and ingestion smoke/unit tests: 6 passed.
- Full `npm test`: 921 passed, 0 failed.
- Oxlint on all changed runtime files: clean.
- `git diff --check`: clean.

## Remaining risks

The Pi TypeScript extension keeps a small local identity implementation because
the isolated adapter harness copies only `lore-pi.ts`; production behavior
matches the shared resolver's canonical remote/local identity rules. Existing
legacy checkpoints without a stored prefix hash cannot detect a historical
prefix rewrite until their next successful bounded checkpoint stores one.
