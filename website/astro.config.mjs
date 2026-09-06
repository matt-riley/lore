import { defineConfig } from "astro/config";

export default defineConfig({
  site: process.env.SITE_URL || undefined,
  output: "static",
  trailingSlash: "always",
  devToolbar: { enabled: false },
  markdown: { shikiConfig: { theme: "github-light" } },
});
