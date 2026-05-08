import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startLoreBrowserServer } from "../../browser/server.mjs";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const appSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../browser/app.js"),
  "utf8",
);

function createClassList(initial = []) {
  const classes = new Set(initial.filter(Boolean));
  return {
    add(name) {
      classes.add(name);
    },
    toggle(name, force) {
      if (force === undefined) {
        if (classes.has(name)) {
          classes.delete(name);
          return false;
        }
        classes.add(name);
        return true;
      }
      if (force) {
        classes.add(name);
        return true;
      }
      classes.delete(name);
      return false;
    },
  };
}

function createElement({ id = null, dataset = {}, classes = [] } = {}) {
  return {
    id,
    dataset: { ...dataset },
    style: {},
    value: "",
    innerHTML: "",
    textContent: "",
    onclick: null,
    classList: createClassList(classes),
    listeners: new Map(),
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 100, height: 40 };
    },
    setAttribute() {},
    clientWidth: 100,
    clientHeight: 40,
  };
}

function createResponse(payload) {
  return {
    ok: true,
    async json() {
      return payload;
    },
  };
}

async function runMaintenanceView(maintenanceData) {
  const elements = new Map();
  const tabButtons = ["overview", "memories", "maintenance", "episodes", "drilldown"].map((tab) =>
    createElement({ dataset: { tab }, classes: ["tab"] }),
  );

  for (const id of [
    "view-overview",
    "view-memories",
    "view-maintenance",
    "view-episodes",
    "view-drilldown",
    "status-pill",
    "scope-pill",
    "tabs",
  ]) {
    elements.set(id, createElement({ id }));
  }

  const document = {
    body: createElement(),
    getElementById(id) {
      return elements.get(id) ?? null;
    },
    querySelectorAll(selector) {
      if (selector === ".tab") {
        return tabButtons;
      }
      return [];
    },
  };

  const window = {
    location: {
      hash: "",
      pathname: "/browser",
      search: "",
    },
    listeners: new Map(),
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    requestAnimationFrame() {
      return 1;
    },
  };

  const history = {
    replaceState() {},
  };

  const fetch = async (requestPath) => {
    if (requestPath === "/api/health") {
      return createResponse({ repository: "owner/repo" });
    }
    if (requestPath === "/api/overview") {
      return createResponse({ data: {} });
    }
    if (requestPath === "/api/maintenance") {
      return createResponse({ data: maintenanceData });
    }
    if (requestPath === "/api/episodes") {
      return createResponse({ data: {} });
    }
    if (requestPath === "/api/memories/filters") {
      return createResponse({ data: {} });
    }
    if (requestPath.startsWith("/api/memories?")) {
      return createResponse({ data: { rows: [] } });
    }
    throw new Error(`Unexpected fetch path: ${requestPath}`);
  };

  const runApp = new AsyncFunction(
    "document",
    "window",
    "fetch",
    "history",
    "setInterval",
    "URLSearchParams",
    appSource,
  );

  await runApp(document, window, fetch, history, () => 1, URLSearchParams);
  return elements.get("view-maintenance").innerHTML;
}

async function startServerHarness({ repository = " owner/repo ", db = { config: { paths: { derivedStorePath: "fixture.db" } } } } = {}) {
  const { server } = startLoreBrowserServer({
    db,
    host: "127.0.0.1",
    port: 0,
    repository,
  });
  await new Promise((resolve) => server.on("listening", resolve));
  const address = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

describe("sixth-wave browser and server hotspots", () => {
  test("renderMaintenance shows populated maintenance sections without fallback placeholders", async () => {
    const html = await runMaintenanceView({
      maintenancePlan: {
        dueTasks: [
          {
            label: "Trace compaction",
            dueReason: "cadence",
            lastRunMinutesAgo: null,
            cadenceMinutes: 30,
          },
        ],
      },
      taskStates: [
        {
          task_name: "traceCompaction",
          last_status: "completed",
          total_runs: 4,
          total_failures: 1,
          total_needs_attention: 0,
          last_completed_at: "2024-06-10T10:00:00.000Z",
        },
      ],
      runs: [
        {
          started_at: "2024-06-10T09:00:00.000Z",
          status: "completed",
          trigger: "status",
          repository: "owner/repo",
          completed_count: 3,
          failed_count: 0,
          needs_attention_count: 1,
        },
      ],
      deferred: [
        {
          sessionId: "session-1",
          repository: "owner/repo",
          status: "pending",
          priority: 2,
          availableAt: "2024-06-10T09:30:00.000Z",
          attempts: 1,
          lastError: "none",
        },
      ],
      doctorReports: [
        {
          summary: "Trace recorder drift detected",
          severity: "warning",
          outcome: "recorded",
          created_at: "2024-06-10T11:00:00.000Z",
        },
      ],
    });

    assert.match(html, /Trace compaction/);
    assert.match(html, /lastRunMinutesAgo=n\/a cadenceMinutes=30/);
    assert.match(html, /traceCompaction/);
    assert.match(html, /session-1/);
    assert.match(html, /Trace recorder drift detected/);
    assert.doesNotMatch(html, /No due tasks right now/);
    assert.doesNotMatch(html, /No doctor reports found/);
  });

  test("startLoreBrowserServer serves health data and HttpError drilldown payloads", async () => {
    const { server, baseUrl } = await startServerHarness();
    try {
      const healthResponse = await fetch(`${baseUrl}/api/health`);
      const health = await healthResponse.json();
      const drilldownResponse = await fetch(`${baseUrl}/api/drilldown?entity=unknown&id=bad`);
      const drilldown = await drilldownResponse.json();

      assert.equal(healthResponse.status, 200);
      assert.equal(health.repository, "owner/repo");
      assert.equal(health.mode, "read_only");
      assert.equal(drilldownResponse.status, 400);
      assert.equal(drilldown.ok, false);
      assert.equal(drilldown.mode, "read_only");
      assert.equal(drilldown.error, "unsupported_drilldown_entity");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});
