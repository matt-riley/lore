import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const browserRoot = fileURLToPath(new URL("../../browser/", import.meta.url));
const libRoot = fileURLToPath(new URL("../../lib/", import.meta.url));

function runStaticCheck(source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { spawnSync } from "node:child_process";
    import { once } from "node:events";
    import fs from "node:fs/promises";
    import { syncBuiltinESMExports } from "node:module";
    import { tmpdir } from "node:os";
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const temporary = await fs.mkdtemp(path.join(tmpdir(), "lore-static-containment-"));
    const root = path.join(temporary, "browser");
    let server;
    try {
      await fs.mkdir(root);
      for (const filename of ["server.mjs", "index.html", "styles.css", "app.js"]) {
        await fs.copyFile(path.join(${JSON.stringify(browserRoot)}, filename), path.join(root, filename));
      }
      await fs.symlink(${JSON.stringify(libRoot)}, path.join(temporary, "lib"), "dir");
      const { startLoreBrowserServer } = await import(pathToFileURL(path.join(root, "server.mjs")));
      ({ server } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 }));
      await once(server, "listening");
      const base = "http://127.0.0.1:" + server.address().port;
      ${source}
      console.log("ok");
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      await fs.rm(temporary, { recursive: true, force: true });
    }
  `], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  assert.equal(result.stdout.trim(), "ok");
}

test("static requests cannot follow an intermediate directory swapped at open", () => {
  runStaticCheck(`
    const directory = path.join(root, "assets");
    const external = path.join(temporary, "external");
    await fs.mkdir(directory);
    await fs.mkdir(external);
    await fs.writeFile(path.join(directory, "secret.html"), "safe asset");
    await fs.writeFile(path.join(external, "secret.html"), "sensitive local data");

    const originalOpen = fs.open;
    fs.open = async (filePath, ...args) => {
      if (path.basename(filePath) === "secret.html") {
        await fs.rename(directory, directory + "-original");
        await fs.symlink(external, directory, "dir");
      }
      return originalOpen(filePath, ...args);
    };
    syncBuiltinESMExports();

    const response = await fetch(base + "/assets/secret.html");
    const body = await response.text();
    assert.equal(response.status, 404, body);
    assert.deepEqual(JSON.parse(body), { ok: false, error: "not_found" });
  `);
});

test("static handler rejects symlink replacements of packaged assets", () => {
  runStaticCheck(`
    const asset = path.join(root, "index.html");
    const external = path.join(temporary, "secret.html");
    await fs.writeFile(external, "sensitive local data");
    await fs.unlink(asset);
    for (const target of [external, path.join(root, "styles.css")]) {
      await fs.symlink(target, asset);
      const response = await fetch(base + "/");
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { ok: false, error: "not_found" });
      await fs.unlink(asset);
    }
  `);
});

test("static handler rejects FIFOs without blocking and remains responsive", { skip: process.platform === "win32" }, () => {
  runStaticCheck(`
    const asset = path.join(root, "index.html");
    await fs.unlink(asset);
    const result = spawnSync("mkfifo", [asset], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const response = await fetch(base + "/", { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false, error: "not_found" });
    const health = await fetch(base + "/api/health");
    assert.equal(health.status, 200);
  `);
});

test("static handler serves every packaged asset and refuses unlisted files", () => {
  runStaticCheck(`
    for (const [pathname, filename, contentType] of [
      ["/", "index.html", "text/html; charset=utf-8"],
      ["/index.html", "index.html", "text/html; charset=utf-8"],
      ["/styles.css", "styles.css", "text/css; charset=utf-8"],
      ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ]) {
      const response = await fetch(base + pathname);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), contentType);
      assert.equal(await response.text(), await fs.readFile(path.join(root, filename), "utf8"));
    }
    await fs.writeFile(path.join(root, "private.json"), "sensitive local data");
    for (const pathname of ["/private.json", "/server.mjs", "/assets/index.html"]) {
      const response = await fetch(base + pathname);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { ok: false, error: "not_found" });
    }
  `);
});
