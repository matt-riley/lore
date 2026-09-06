# Repository Guidelines

## Project Structure & Module Organization
Lore provides local memory for Copilot CLI, Pi, Codex CLI, Claude Code, and Antigravity CLI. The Node 24.0.0+ runtime has no build step or runtime dependencies. Entrypoints are `extension.mjs` (Copilot), `lore-pi.ts`/`lore-server.mjs` (Pi), and `lore-cli.mjs` (native CLI hooks/commands). Core logic lives in `lib/`, the local dashboard in `browser/`, scripts in `scripts/`, schemas in `schemas/`, and reference docs in `docs/`. Tests live in `tests/unit/` and `tests/smoke/`, with shared helpers and fixtures. The separate Astro site lives in `website/`; guides are in `website/src/content/docs/` and assets in `website/public/`.

## Build, Test, and Development Commands

- `npm run setup` detects clients and installs selected integrations; use `-- --clients all --dry-run` to preview.
- `npm test` runs core tests; `npm run test:smoke` runs subprocess tests.
- `node --test tests/unit/config.test.mjs` runs a focused test file.
- `npm run validate-schema` checks config/schema parity; `npm run lint` runs oxlint.
- `npm run browser` starts the loopback-only dashboard.
- In `website/`, use Node 22.12+ and pnpm 11.24.0: `pnpm install --frozen-lockfile`, then `pnpm dev`. Validate with `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm check:links`.

## Coding Style & Naming Conventions
Use two-space indentation, double quotes, semicolons, and trailing commas. Keep core code in plain ESM (`.mjs`); Pi uses TypeScript and the website uses Astro/TypeScript. Prefer Node built-ins for runtime work. Use focused modules and descriptive names such as `memory-tools-*.mjs` and `*.test.mjs`.

## Testing Guidelines
Use `node:test` for unit and subprocess coverage. Name tests after their modules. Test installers with isolated homes, covering selection, cancellation, preservation, reruns, and rollback; never modify real client settings during tests. Run core tests before PRs and website checks for site changes. Verify rendered UI changes on desktop and mobile.

## Commit & Pull Request Guidelines
Use atomic Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`); release-please relies on them. Follow `.github/pull_request_template.md`, link issues, describe behavior changes, and include verification evidence and screenshots for UI changes. Keep README and website guidance aligned.

## Security & Release Notes
Keep the dashboard loopback-only. Treat Lore databases, configs, transcripts, and backups as sensitive. Preserve configured paths and legacy storage; never migrate user data implicitly. Update `lib/capability-manifest.mjs` and `docs/support-matrix.md` together when changing tool metadata or support levels.
