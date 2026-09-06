import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/", import.meta.url));
async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => entry.isDirectory()
    ? walk(path.join(directory, entry.name))
    : [path.join(directory, entry.name)]));
  return nested.flat();
}
const files = (await walk(root)).filter((file) => file.endsWith(".html"));
const failures = [];
let checked = 0;
for (const file of files) {
  const html = await readFile(file, "utf8");
  const origin = "https://lore.invalid";
  const page = path.relative(root, file).replaceAll(path.sep, "/").replace(/index\.html$/, "");
  for (const [, reference] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const url = new URL(reference.replaceAll("&amp;", "&"), `${origin}/${page}`);
    if (url.origin !== origin) continue;
    let target = path.join(root, decodeURIComponent(url.pathname));
    try {
      if ((await stat(target)).isDirectory()) target = path.join(target, "index.html");
      const body = await readFile(target);
      if (url.hash && target.endsWith(".html")) {
        const anchor = decodeURIComponent(url.hash.slice(1));
        if (!body.toString().includes(`id="${anchor}"`)) throw new Error(`missing anchor ${anchor}`);
      }
      checked++;
    } catch (error) {
      failures.push(`${page || "/"}: ${reference} (${error.message})`);
    }
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Verified ${checked} local links and assets across ${files.length} pages.`);
}
