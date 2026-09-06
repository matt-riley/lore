import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const serverUrl = new URL("../../browser/server.mjs", import.meta.url).href;

function runServerCheck(source) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout.trim();
}

test("IPv6 loopback dashboard serves health requests", () => {
  const output = runServerCheck(`
    import { once } from "node:events";
    import { startLoreBrowserServer } from ${JSON.stringify(serverUrl)};
    const { server } = startLoreBrowserServer({ db: { config: {} }, host: "::1", port: 0 });
    await once(server, "listening");
    try {
      const response = await fetch("http://[::1]:" + server.address().port + "/api/health");
      console.log(JSON.stringify({ status: response.status, ok: (await response.json()).ok }));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `);
  assert.deepEqual(JSON.parse(output), { status: 200, ok: true });
});

test("malformed request URLs return 400 without terminating the dashboard", () => {
  const output = runServerCheck(`
    import { once } from "node:events";
    import { get } from "node:http";
    import { startLoreBrowserServer } from ${JSON.stringify(serverUrl)};
    const { server } = startLoreBrowserServer({ db: { config: {} }, port: 0 });
    await once(server, "listening");
    const port = server.address().port;
    try {
      const status = await new Promise((resolve, reject) => {
        get({ hostname: "127.0.0.1", port, path: "http://[" }, response => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        }).on("error", reject);
      });
      const health = await fetch("http://127.0.0.1:" + port + "/api/health");
      console.log(JSON.stringify({ status, healthy: health.status }));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `);
  assert.deepEqual(JSON.parse(output), { status: 400, healthy: 200 });
});


test("dashboard server API rejects non-loopback hosts before creating a listener", () => {
  const output = runServerCheck(`
    import assert from "node:assert/strict";
    import http from "node:http";
    import { syncBuiltinESMExports } from "node:module";
    http.createServer = () => { throw new Error("listener created before host validation"); };
    syncBuiltinESMExports();
    const { startLoreBrowserServer } = await import(${JSON.stringify(serverUrl)});
    for (const host of ["0.0.0.0", "::", "192.0.2.1", "example.com", ""]) {
      assert.throws(() => startLoreBrowserServer({ db: {}, host }), /host must be loopback-only/);
    }
    console.log("ok");
  `);
  assert.equal(output, "ok");
});
