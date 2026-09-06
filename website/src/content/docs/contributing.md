---
title: "Contributing"
description: "A practical path for improving Lore's code, documentation, and experimental surfaces."
section: "Reference"
order: 10
---

Contributions are welcome, especially fixes, clear documentation, useful diagnostics, and focused improvements that preserve Lore's local-first design.

## Before changing code

Read the README, [compatibility contract](https://github.com/matt-riley/lore/blob/main/docs/compatibility.md), and support matrix. For tool or hook changes, inspect `lib/capability-manifest.mjs` first; it is the canonical metadata source. Significant changes to memory behavior, retention, or the database should begin with an issue to discuss the approach.

## Set up a checkout

```sh
git clone <repo-url> ~/dev/lore
cd ~/dev/lore
```

Lore is plain ESM with no build step. Node 24.0.0 or later is required. If you want to run the checkout as a live Copilot extension, preview and then run the development installer:

```sh
node scripts/dev-install.mjs --dry-run
node scripts/dev-install.mjs
```

## Validate your work

Run the full test suite before opening a pull request:

```sh
npm test
npm run test:smoke
```

For configuration or schema changes, also run:

```sh
npm run validate-schema
```

Keep unit tests focused and fast. Use smoke tests for scripts, temporary homes, and subprocess behavior. Check rendered browser changes in a browser as well as in source.

## Style and scope

Use ESM, two-space indentation, double quotes, semicolons, and trailing commas. Prefer Node built-ins and small focused modules. Preserve unrelated work in a dirty checkout, and keep changes scoped to the behavior being fixed.

## Documentation changes

Describe user-visible behavior and mark experimental features clearly. When tool metadata or support changes, update `lib/capability-manifest.mjs` and `docs/support-matrix.md` together. Keep compatibility and release-facing docs in sync with public behavior.

## Pull requests

Use a Conventional Commit title such as `fix: handle missing session store`. Include the tests you ran, relevant screenshots for browser work, and links to related issues. Fill in the repository pull request template. Release-please uses these titles to classify changes.

## Privacy while contributing

Never commit `~/.config/lore/lore.db`, `lore.json`, raw session stores, credentials, or generated exports containing private work. Use temporary homes and fixtures for tests. If reporting a problem, share the smallest reproducible details and redact code, paths, and session notes.
