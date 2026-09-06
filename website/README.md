# Lore documentation website

An Astro static site with a Blender-authored archive sculpture, an optional Three.js viewer, and a friendly Markdown guide collection. The site is independent of Lore’s extension runtime and its local memory dashboard.

## Work locally

Use Node.js 24.0.0 or later and pnpm 11.24.0. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open `http://127.0.0.1:4321`. To validate and preview the production output:

```sh
pnpm check
pnpm test
pnpm build
pnpm check:links
pnpm preview
```

The production files are written to `dist/`. The Three.js engine and GLB load only when a reader opens the 3D view or steps through the memory illustration. The static artwork stays visible if WebGL is unavailable. Reduced-motion preferences disable ambient motion; the guides and search work independently of WebGL. Fonts are bundled locally.

## Cloudflare Workers

Connect the repository to a Cloudflare Workers project using these settings:

| Setting | Value |
| --- | --- |
| Root directory | `website` |
| Build command | `pnpm build` |
| Deploy command | `pnpm exec wrangler deploy` |
| `NODE_VERSION` | `24.0.0` or a newer supported release |
| `PNPM_VERSION` | `11.24.0` |
| `SITE_URL` | Your final public origin, including `https://` |

`SITE_URL` is optional during local development. Set it to the production domain when deploying so canonical metadata uses the correct origin. This is a static Astro site, so it does not need the `@astrojs/cloudflare` adapter. `public/_headers` applies caching and standard response headers. The `assets.not_found_handling` setting in `wrangler.jsonc` serves the generated `404.html` page.

For a manual deployment from this directory:

```sh
pnpm build
pnpm exec wrangler deploy
```

Cloudflare Workers Builds runs the build and deploy commands separately. Do not use `npx wrangler deploy` from the repository root: set the project root to `website` so Wrangler reads `website/wrangler.jsonc` and uploads `dist/`.

See the official [Astro Cloudflare deployment guide](https://docs.astro.build/en/guides/deploy/cloudflare/) for the Workers Builds setup.

## Edit the guides

Pages live in `src/content/docs/*.md`. Each has `title`, `description`, `section`, and numeric `order` frontmatter. The schema in `src/content.config.ts` validates these fields. The guide index, sidebar, table of contents, previous/next navigation, and local search index are generated from the collection.

Link to guides as `/guides/<filename-without-extension>/`. Keep facts aligned with the repository’s `README.md`, `docs/support-matrix.md`, configuration defaults, and capability manifest. The site explains supported and experimental features; it does not change their status.

## Interactive examples

Pi is the primary onboarding path. `/playground/` demonstrates saving and recalling across sessions, repository scope, and lexical versus optional semantic candidates. The homepage includes the session example and explains how the archive sculpture represents sessions, memories, and the local store.

Examples run entirely in the page with fictional data; they neither connect to Lore nor run a model. Scope and retrieval are intentionally simplified and labeled. The shared state model in `src/scripts/demo-model.mjs` has unit coverage in `tests/demo-model.test.mjs`.

## Artwork

`art/create-archive.py` reproducibly generates the Blender source, still render, and GLB. See [the artwork notes](art/README.md). Only the optimized render and model are published; the `.blend` and Python source remain in the repository. The visual direction is warm ivory, dark ink, moss green, bronze, and amber, with Newsreader headlines and DM Sans body text.
