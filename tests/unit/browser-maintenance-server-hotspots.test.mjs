import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { startLoreBrowserServer } from "../../browser/server.mjs";
import { createAppRunner, createBrowserTestEnvironment, createDefaultFetch } from "../helpers/browser-dom.mjs";

const runApp = createAppRunner();

async function runMaintenanceView(maintenanceData) {
  const { elements, document, history } = createBrowserTestEnvironment();
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

  const fetch = createDefaultFetch({ maintenanceData });

  await runApp(document, window, fetch, history);
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
