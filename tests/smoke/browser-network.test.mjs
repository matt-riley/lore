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

test("dashboard server rejects invalid and rebinding host headers with 403", () => {
  const output = runServerCheck(`
    import { once } from "node:events";
    import http from "node:http";
    import net from "node:net";
    import { startLoreBrowserServer } from ${JSON.stringify(serverUrl)};
    const { server } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = server.address().port;

    async function checkHost(hostHeader) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port,
          path: "/api/health",
          headers: { host: hostHeader },
        }, (res) => {
          let data = "";
          res.on("data", chunk => { data += chunk; });
          res.on("end", () => resolve({
            status: res.statusCode,
            headers: res.headers,
            body: JSON.parse(data),
          }));
        });
        req.on("error", reject);
        req.end();
      });
    }

    async function checkMissingHost() {
      return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1", () => {
          socket.write("GET /api/health HTTP/1.0\\r\\n\\r\\n");
        });
        let raw = "";
        socket.on("data", chunk => { raw += chunk.toString(); });
        socket.on("end", () => {
          const [headerPart, ...bodyParts] = raw.split("\\r\\n\\r\\n");
          const [statusLine, ...headerLines] = headerPart.split("\\r\\n");
          const statusCode = Number(statusLine.split(" ")[1]);
          const headers = {};
          for (const line of headerLines) {
            const idx = line.indexOf(":");
            if (idx !== -1) {
              headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
            }
          }
          resolve({
            status: statusCode,
            headers,
            body: JSON.parse(bodyParts.join("\\r\\n\\r\\n")),
          });
        });
        socket.on("error", reject);
      });
    }

    try {
      const evilRes = await checkHost("evil.com:43111");
      const attackerRes = await checkHost("attacker.com");
      const subdomainRes = await checkHost("localhost.evil.com");
      const ipSubdomainRes = await checkHost("127.0.0.1.evil.com");
      const missingRes = await checkMissingHost();

      console.log(JSON.stringify({
        evil: evilRes,
        attacker: attackerRes,
        subdomain: subdomainRes,
        ipSubdomain: ipSubdomainRes,
        missing: missingRes,
      }));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `);

  const results = JSON.parse(output);
  for (const [key, res] of Object.entries(results)) {
    assert.equal(res.status, 403, `${key} should return 403`);
    assert.deepEqual(res.body, { ok: false, error: "forbidden", message: "Invalid host header" });
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["content-security-policy"], "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  }
});

test("dashboard server accepts valid loopback host headers", () => {
  const output = runServerCheck(`
    import { once } from "node:events";
    import http from "node:http";
    import { startLoreBrowserServer } from ${JSON.stringify(serverUrl)};
    const { server: serverIpv4 } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 });
    await once(serverIpv4, "listening");
    const portIpv4 = serverIpv4.address().port;

    const { server: serverIpv6 } = startLoreBrowserServer({ db: { config: {} }, host: "::1", port: 0 });
    await once(serverIpv6, "listening");
    const portIpv6 = serverIpv6.address().port;

    async function checkHost(hostname, port, hostHeader) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname,
          port,
          path: "/api/health",
          headers: { host: hostHeader },
        }, (res) => {
          let data = "";
          res.on("data", chunk => { data += chunk; });
          res.on("end", () => resolve({
            status: res.statusCode,
            body: JSON.parse(data),
          }));
        });
        req.on("error", reject);
        req.end();
      });
    }

    try {
      const localhostWithPort = await checkHost("127.0.0.1", portIpv4, "localhost:" + portIpv4);
      const ipv4WithPort = await checkHost("127.0.0.1", portIpv4, "127.0.0.1:" + portIpv4);
      const localhostWithoutPort = await checkHost("127.0.0.1", portIpv4, "localhost");
      const ipv4WithoutPort = await checkHost("127.0.0.1", portIpv4, "127.0.0.1");
      const ipv6WithPort = await checkHost("::1", portIpv6, "[::1]:" + portIpv6);
      const ipv6WithoutPort = await checkHost("::1", portIpv6, "[::1]");

      console.log(JSON.stringify({
        localhostWithPort,
        ipv4WithPort,
        localhostWithoutPort,
        ipv4WithoutPort,
        ipv6WithPort,
        ipv6WithoutPort,
      }));
    } finally {
      serverIpv4.closeAllConnections();
      serverIpv6.closeAllConnections();
      await Promise.all([
        new Promise(resolve => serverIpv4.close(resolve)),
        new Promise(resolve => serverIpv6.close(resolve)),
      ]);
    }
  `);

  const results = JSON.parse(output);
  for (const [key, res] of Object.entries(results)) {
    assert.equal(res.status, 200, `${key} should return 200`);
    assert.equal(res.body.ok, true, `${key} should be ok`);
  }
});

test("dashboard server refuses to serve server.mjs and disallowed static files", () => {
  const output = runServerCheck(`
    import { once } from "node:events";
    import http from "node:http";
    import { startLoreBrowserServer } from ${JSON.stringify(serverUrl)};
    const { server } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = server.address().port;

    async function fetchPath(path) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port,
          path,
        }, (res) => {
          let data = "";
          res.on("data", chunk => { data += chunk; });
          res.on("end", () => resolve({
            status: res.statusCode,
            contentType: res.headers["content-type"],
            headers: res.headers,
            body: data,
          }));
        });
        req.on("error", reject);
        req.end();
      });
    }

    try {
      const serverMjs = await fetchPath("/server.mjs");
      const traversal = await fetchPath("/../package.json");
      const indexHtml = await fetchPath("/index.html");
      const rootHtml = await fetchPath("/");
      const stylesCss = await fetchPath("/styles.css");
      const appJs = await fetchPath("/app.js");

      console.log(JSON.stringify({
        serverMjs: { status: serverMjs.status, body: JSON.parse(serverMjs.body) },
        traversal: { status: traversal.status, body: JSON.parse(traversal.body) },
        indexHtml: { status: indexHtml.status, contentType: indexHtml.contentType },
        rootHtml: { status: rootHtml.status, contentType: rootHtml.contentType },
        stylesCss: { status: stylesCss.status, contentType: stylesCss.contentType },
        appJs: { status: appJs.status, contentType: appJs.contentType },
      }));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `);

  const results = JSON.parse(output);
  assert.equal(results.serverMjs.status, 404);
  assert.deepEqual(results.serverMjs.body, { ok: false, error: "not_found" });
  assert.equal(results.traversal.status, 404);
  assert.deepEqual(results.traversal.body, { ok: false, error: "not_found" });
  assert.equal(results.indexHtml.status, 200);
  assert.equal(results.indexHtml.contentType, "text/html; charset=utf-8");
  assert.equal(results.rootHtml.status, 200);
  assert.equal(results.rootHtml.contentType, "text/html; charset=utf-8");
  assert.equal(results.stylesCss.status, 200);
  assert.equal(results.stylesCss.contentType, "text/css; charset=utf-8");
  assert.equal(results.appJs.status, 200);
  assert.equal(results.appJs.contentType, "text/javascript; charset=utf-8");
});

test("dashboard server includes security headers in static and api responses", () => {
  const output = runServerCheck(`
    import { once } from "node:events";
    import http from "node:http";
    import { startLoreBrowserServer } from ${JSON.stringify(serverUrl)};
    const { server } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const port = server.address().port;

    async function getHeaders(path) {
      return new Promise((resolve, reject) => {
        const req = http.request({
          hostname: "127.0.0.1",
          port,
          path,
        }, (res) => {
          res.resume();
          res.on("end", () => resolve({
            status: res.statusCode,
            headers: res.headers,
          }));
        });
        req.on("error", reject);
        req.end();
      });
    }

    try {
      const staticRes = await getHeaders("/");
      const apiRes = await getHeaders("/api/health");
      const notFoundRes = await getHeaders("/nonexistent.js");

      console.log(JSON.stringify({
        staticRes,
        apiRes,
        notFoundRes,
      }));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `);

  const results = JSON.parse(output);
  for (const [key, res] of Object.entries(results)) {
    assert.equal(res.headers["x-content-type-options"], "nosniff", `${key} X-Content-Type-Options`);
    assert.equal(res.headers["x-frame-options"], "DENY", `${key} X-Frame-Options`);
    assert.equal(res.headers["referrer-policy"], "no-referrer", `${key} Referrer-Policy`);
    assert.equal(
      res.headers["content-security-policy"],
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
      `${key} Content-Security-Policy`
    );
  }
});
