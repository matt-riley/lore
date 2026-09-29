import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
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

    for (const kind of ["file symlink", "directory symlink", "directory"]) {
      test(`refuses static ${kind} fixtures`, async (t) => {
        const temporary = await mkdtemp(path.join(tmpdir(), "lore-browser-static-"));
        t.after(() => rm(temporary, { recursive: true, force: true }));
        const secret = path.join(temporary, "secret.html");
        await writeFile(secret, "sensitive local data", "utf8");
        const fixtureName = `.security-test-${process.pid}-${Date.now()}.html`;
        const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "browser", fixtureName);
        t.after(() => rm(fixture, { recursive: true, force: true }));
        if (kind === "file symlink") {
          await symlink(secret, fixture);
        } else if (kind === "directory symlink") {
          await symlink(temporary, fixture, "dir");
        } else {
          await mkdir(fixture);
        }

        const { server } = startLoreBrowserServer({ db: { config: {} }, host: "127.0.0.1", port: 0 });
        t.after(async () => {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        });
        await new Promise((resolve) => server.once("listening", resolve));
        const port = server.address().port;
        const requestPath = kind === "directory symlink" ? `/${fixtureName}/secret.html` : `/${fixtureName}`;
        const response = await new Promise((resolve, reject) => {
          const request = http.get({ hostname: "127.0.0.1", port, path: requestPath }, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
          });
          request.on("error", reject);
          request.setTimeout(2000, () => request.destroy(new Error("static response timed out")));
        });

        assert.equal(response.status, 404);
        assert.deepEqual(response.body, { ok: false, error: "not_found" });
      });
    }

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
