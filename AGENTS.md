# Repository Guidelines

## Project Structure & Module Organization
Lore is a Node 22+ ESM extension for GitHub Copilot CLI with no build step. `extension.mjs` is the runtime entrypoint. Core logic lives in `lib/`, browser dashboard code lives in `browser/`, developer scripts live in `scripts/`, JSON schema files live in `schemas/`, and long-form docs live in `docs/`. Tests are split between fast unit coverage in `tests/unit/`, subprocess smoke coverage in `tests/smoke/`, plus shared helpers and fixtures under `tests/helpers/` and `tests/fixtures/`.

## Build, Test, and Development Commands
- `npm test` runs the full Node test suite.
- `npm run test:smoke` runs subprocess-oriented smoke tests only.
- `node --test tests/unit/query-normalizer.test.mjs` runs one test file while iterating.
- `npm run validate-schema` checks `lib/config.mjs` defaults against `schemas/lore.schema.json`.
- `npm run lint` runs `oxlint` across the main source directories.
- `npm run dev-install` copies a development checkout into `~/.copilot/extensions/lore`.
- `npm run browser` starts the localhost-only read-only dashboard.

## Coding Style & Naming Conventions
Stay in plain ESM: `import`/`export`, `.mjs`, double quotes, semicolons, and trailing commas to match the current codebase. Follow the existing two-space indentation style. Prefer Node built-ins over new packages; Lore is intentionally zero-runtime-dependency. Keep modules focused and use descriptive names such as `memory-tools-*.mjs`, `*-utils.mjs`, and `*.test.mjs`.

## Testing Guidelines
Add unit tests for isolated logic and smoke tests for script, temp-home, or subprocess behavior. Name tests after the target module, for example `tests/unit/config.test.mjs`. Run `npm test` before opening a PR; if you changed config or schema behavior, also run `npm run validate-schema`.

## Commit & Pull Request Guidelines
Recent history uses Conventional Commits such as `fix: ...`, `refactor: ...`, and `chore: ...`; keep commits and PR titles in that format because release-please depends on them. Link related issues, describe user-visible behavior changes, and include terminal output or screenshots when touching the browser dashboard. Use `.github/pull_request_template.md` and keep release-facing docs in sync when changing public surfaces.

## Security & Release Notes
Do not expose the browser dashboard beyond loopback. Treat `~/.config/lore/lore.db` and `~/.config/lore/lore.json` as sensitive local data. When changing tool metadata or support levels, update `lib/capability-manifest.mjs` and `docs/support-matrix.md` together.
