import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { isAllowedHostHeader, startLoreBrowserServer } from "../../browser/server.mjs";

describe("browser dashboard security hardening", () => {
  describe("isAllowedHostHeader", () => {
    test("accepts valid loopback hostnames with or without ports", () => {
      assert.equal(isAllowedHostHeader("localhost"), true);
      assert.equal(isAllowedHostHeader("localhost:43111"), true);
      assert.equal(isAllowedHostHeader("LOCALHOST:80"), true);
      assert.equal(isAllowedHostHeader("127.0.0.1"), true);
      assert.equal(isAllowedHostHeader("127.0.0.1:43111"), true);
      assert.equal(isAllowedHostHeader("127.0.0.1:8080"), true);
      assert.equal(isAllowedHostHeader("::1"), true);
      assert.equal(isAllowedHostHeader("[::1]"), true);
      assert.equal(isAllowedHostHeader("[::1]:43111"), true);
      assert.equal(isAllowedHostHeader("[::1]:8080"), true);
      assert.equal(isAllowedHostHeader("  localhost:43111  "), true);
    });

    test("rejects unauthorized hostnames and rebinding attempts", () => {
      assert.equal(isAllowedHostHeader("evil.com"), false);
      assert.equal(isAllowedHostHeader("evil.com:43111"), false);
      assert.equal(isAllowedHostHeader("attacker.com"), false);
      assert.equal(isAllowedHostHeader("localhost.evil.com"), false);
      assert.equal(isAllowedHostHeader("127.0.0.1.nip.io"), false);
      assert.equal(isAllowedHostHeader("127.0.0.1.evil.com:43111"), false);
      assert.equal(isAllowedHostHeader("0.0.0.0"), false);
      assert.equal(isAllowedHostHeader("192.168.1.1"), false);
      assert.equal(isAllowedHostHeader("[::2]"), false);
      assert.equal(isAllowedHostHeader("[::2]:43111"), false);
      assert.equal(isAllowedHostHeader(""), false);
      assert.equal(isAllowedHostHeader("   "), false);
      assert.equal(isAllowedHostHeader(null), false);
      assert.equal(isAllowedHostHeader(undefined), false);
      assert.equal(isAllowedHostHeader(123), false);
      assert.equal(isAllowedHostHeader({}), false);
    });

    test("rejects malformed port specifications", () => {
      assert.equal(isAllowedHostHeader("localhost:"), false);
      assert.equal(isAllowedHostHeader("localhost:abc"), false);
      assert.equal(isAllowedHostHeader("127.0.0.1:"), false);
      assert.equal(isAllowedHostHeader("127.0.0.1:abc"), false);
      assert.equal(isAllowedHostHeader("[::1]:"), false);
      assert.equal(isAllowedHostHeader("[::1]:abc"), false);
      assert.equal(isAllowedHostHeader("[::1"), false);
    });
  });

  describe("HTTP server security enforcement", () => {
    test("rejects requests with unauthorized host header with 403 Forbidden", async () => {
      const { server } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 });
      await new Promise((resolve) => server.once("listening", resolve));
      const port = server.address().port;

      try {
        const response = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: "127.0.0.1",
            port,
            path: "/api/health",
            headers: { host: "evil.com:43111" },
          }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => resolve({
              status: res.statusCode,
              headers: res.headers,
              body: JSON.parse(data),
            }));
          });
          req.on("error", reject);
          req.end();
        });

        assert.equal(response.status, 403);
        assert.deepEqual(response.body, { ok: false, error: "forbidden", message: "Invalid host header" });
        assert.equal(response.headers["x-content-type-options"], "nosniff");
        assert.equal(response.headers["x-frame-options"], "DENY");
        assert.equal(response.headers["referrer-policy"], "no-referrer");
        assert.equal(
          response.headers["content-security-policy"],
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        );
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    test("refuses to serve server.mjs returning 404", async () => {
      const { server } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 });
      await new Promise((resolve) => server.once("listening", resolve));
      const port = server.address().port;

      try {
        const response = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: "127.0.0.1",
            port,
            path: "/server.mjs",
          }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => resolve({
              status: res.statusCode,
              headers: res.headers,
              body: JSON.parse(data),
            }));
          });
          req.on("error", reject);
          req.end();
        });

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { ok: false, error: "not_found" });
        assert.equal(response.headers["x-content-type-options"], "nosniff");
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    test("refuses path traversal attempts outside static root returning 404", async () => {
      const { server } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 });
      await new Promise((resolve) => server.once("listening", resolve));
      const port = server.address().port;

      try {
        const response = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: "127.0.0.1",
            port,
            path: "/../package.json",
          }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => resolve({
              status: res.statusCode,
              body: JSON.parse(data),
            }));
          });
          req.on("error", reject);
          req.end();
        });

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { ok: false, error: "not_found" });
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    test("refuses static symlinks that resolve outside the dashboard root", async () => {
      const temporary = await mkdtemp(path.join(tmpdir(), "lore-browser-static-"));
      const secret = path.join(temporary, "secret.html");
      const linkName = `.security-test-${process.pid}-${Date.now()}.html`;
      const link = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "browser", linkName);
      await writeFile(secret, "sensitive local data", "utf8");
      await symlink(secret, link);

      const { server } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 });
      await new Promise((resolve) => server.once("listening", resolve));
      const port = server.address().port;

      try {
        const response = await new Promise((resolve, reject) => {
          http.get({ hostname: "127.0.0.1", port, path: `/${linkName}` }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
          }).on("error", reject);
        });

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { ok: false, error: "not_found" });
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await rm(link, { force: true });
        await rm(temporary, { recursive: true, force: true });
      }
    });

    test("serves allowed static files with security headers", async () => {
      const { server } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 });
      await new Promise((resolve) => server.once("listening", resolve));
      const port = server.address().port;

      try {
        const response = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: "127.0.0.1",
            port,
            path: "/index.html",
          }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
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

        assert.equal(response.status, 200);
        assert.equal(response.contentType, "text/html; charset=utf-8");
        assert.match(response.body, /<!doctype html>/i);
        assert.equal(response.headers["x-content-type-options"], "nosniff");
        assert.equal(response.headers["x-frame-options"], "DENY");
        assert.equal(response.headers["referrer-policy"], "no-referrer");
        assert.equal(
          response.headers["content-security-policy"],
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        );
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });

    test("includes security headers in JSON API responses", async () => {
      const { server } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 });
      await new Promise((resolve) => server.once("listening", resolve));
      const port = server.address().port;

      try {
        const response = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: "127.0.0.1",
            port,
            path: "/api/health",
          }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => resolve({
              status: res.statusCode,
              headers: res.headers,
              body: JSON.parse(data),
            }));
          });
          req.on("error", reject);
          req.end();
        });

        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.equal(response.headers["x-content-type-options"], "nosniff");
        assert.equal(response.headers["x-frame-options"], "DENY");
        assert.equal(response.headers["referrer-policy"], "no-referrer");
        assert.equal(
          response.headers["content-security-policy"],
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
        );
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
});
