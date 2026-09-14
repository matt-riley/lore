import assert from "node:assert/strict";
import { test } from "node:test";

import { createAppRunner, createBrowserTestEnvironment } from "../helpers/browser-dom.mjs";

const runApp = createAppRunner();

const MEMORY_ELEMENT_IDS = [
  "mem-filter-type",
  "mem-filter-scope",
  "mem-filter-repo",
  "mem-filter-canonical",
  "mem-filter-query",
  "mem-filter-state",
  "mem-apply",
  "mem-prev",
  "mem-next",
];

function response(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return payload;
    },
  };
}

function errorResponse(status, message) {
  return {
    ok: false,
    status,
    async json() {
      return { message };
    },
  };
}

function makeWindow() {
  return {
    location: { hash: "", pathname: "/", search: "" },
    listeners: new Map(),
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    setTimeout,
  };
}

function memoryRows(count, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `memory-${offset + index}`,
    type: "user_preference",
    scope: "repo",
    repository: "owner/repo",
    canonicalKey: null,
    content: `Fixture memory ${offset + index}`,
    updatedAt: "2026-09-07T08:00:00.000Z",
    supersededBy: null,
  }));
}

function createMemoryFetch({ total = 0, rowsForPage = () => [], failuresFor = () => null } = {}) {
  const requests = [];
  const fetchImpl = async (requestPath) => {
    const failure = failuresFor(requestPath);
    if (failure) {
      return failure;
    }
    if (requestPath === "/api/health") return response({ repository: "owner/repo" });
    if (requestPath === "/api/overview") return response({ data: {} });
    if (requestPath === "/api/maintenance") return response({ data: {} });
    if (requestPath === "/api/episodes") return response({ data: {} });
    if (requestPath === "/api/memories/filters") return response({ data: {} });
    if (requestPath.startsWith("/api/memories?")) {
      const params = new URLSearchParams(requestPath.slice(requestPath.indexOf("?") + 1));
      requests.push(params);
      const page = Number(params.get("page")) || 1;
      const pageSize = Number(params.get("pageSize")) || 25;
      return response({ data: { page, pageSize, total, rows: rowsForPage(page) } });
    }
    throw new Error(`Unexpected fetch: ${requestPath}`);
  };
  return { fetchImpl, requests };
}

function buttonMarkup(html, id) {
  const match = html.match(new RegExp(`<button[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(match, `expected button #${id} in rendered markup`);
  return match[0];
}

test("renders bounded pagination controls with accessible labels", async () => {
  const { elements, document, history } = createBrowserTestEnvironment({ elementIds: MEMORY_ELEMENT_IDS });
  const app = createMemoryFetch({
    total: 26,
    rowsForPage: (page) => memoryRows(page === 1 ? 25 : 1, (page - 1) * 25),
  });

  await runApp(document, makeWindow(), app.fetchImpl, history);

  const html = elements.get("view-memories").innerHTML;
  assert.match(html, /aria-label="Memory result pages"/);
  assert.match(buttonMarkup(html, "mem-prev"), /aria-label="Previous page"/);
  assert.match(buttonMarkup(html, "mem-prev"), /disabled/);
  assert.match(buttonMarkup(html, "mem-next"), /aria-label="Next page"/);
  assert.doesNotMatch(buttonMarkup(html, "mem-next"), /disabled/);
  assert.match(html, /page 1 of 2 · 26 memories/);
});

test("next and previous walk pages while preserving applied filters", async () => {
  const { elements, document, history } = createBrowserTestEnvironment({ elementIds: MEMORY_ELEMENT_IDS });
  const app = createMemoryFetch({
    total: 60,
    rowsForPage: (page) => memoryRows(25, (page - 1) * 25),
  });

  await runApp(document, makeWindow(), app.fetchImpl, history);

  elements.get("mem-filter-type").value = "decision";
  elements.get("mem-filter-query").value = "postgres";
  await elements.get("mem-apply").onclick();

  const applied = app.requests.at(-1);
  assert.equal(applied.get("type"), "decision");
  assert.equal(applied.get("query"), "postgres");
  assert.equal(applied.get("page"), "1");

  await elements.get("mem-next").onclick();

  const secondPage = app.requests.at(-1);
  assert.equal(secondPage.get("page"), "2");
  assert.equal(secondPage.get("type"), "decision");
  assert.equal(secondPage.get("query"), "postgres");
  assert.equal(secondPage.get("state"), "active");

  const secondHtml = elements.get("view-memories").innerHTML;
  assert.match(secondHtml, /page 2 of 3 · 60 memories/);
  assert.doesNotMatch(buttonMarkup(secondHtml, "mem-prev"), /disabled/);
  assert.doesNotMatch(buttonMarkup(secondHtml, "mem-next"), /disabled/);
  assert.equal(elements.get("mem-filter-type").value, "decision");
  assert.equal(elements.get("mem-filter-query").value, "postgres");

  await elements.get("mem-prev").onclick();
  assert.equal(app.requests.at(-1).get("page"), "1");
});

test("enter in the search box applies the term and resets to page one", async () => {
  const { elements, document, history } = createBrowserTestEnvironment({ elementIds: MEMORY_ELEMENT_IDS });
  const app = createMemoryFetch({
    total: 60,
    rowsForPage: (page) => memoryRows(25, (page - 1) * 25),
  });

  await runApp(document, makeWindow(), app.fetchImpl, history);
  await elements.get("mem-next").onclick();
  assert.equal(app.requests.at(-1).get("page"), "2");

  elements.get("mem-filter-query").value = "migration";
  const prevented = [];
  await elements.get("mem-filter-query").onkeydown({
    key: "Enter",
    preventDefault: () => prevented.push(true),
  });

  const applied = app.requests.at(-1);
  assert.equal(applied.get("query"), "migration");
  assert.equal(applied.get("page"), "1");
  assert.deepEqual(prevented, [true]);
});

test("empty results show a query-aware empty state", async () => {
  const { elements, document, history } = createBrowserTestEnvironment({ elementIds: MEMORY_ELEMENT_IDS });
  const app = createMemoryFetch({ total: 0, rowsForPage: () => [] });

  await runApp(document, makeWindow(), app.fetchImpl, history);
  assert.match(elements.get("view-memories").innerHTML, /No memories match the current filters/);

  elements.get("mem-filter-query").value = "nothing-here";
  await elements.get("mem-apply").onclick();
  assert.match(
    elements.get("view-memories").innerHTML,
    /No memories match “nothing-here” and the current filters/,
  );
});

test("load failures render an error state without blanking the rest of the dashboard", async () => {
  const { elements, document, history } = createBrowserTestEnvironment({ elementIds: MEMORY_ELEMENT_IDS });
  const app = createMemoryFetch({
    total: 5,
    rowsForPage: () => memoryRows(5),
    failuresFor: (requestPath) => requestPath.startsWith("/api/memories")
      ? errorResponse(500, "database is locked")
      : null,
  });

  await runApp(document, makeWindow(), app.fetchImpl, history);

  const html = elements.get("view-memories").innerHTML;
  assert.match(html, /role="alert"/);
  assert.match(html, /Memories could not be loaded/);
  assert.match(html, /database is locked/);
  assert.notEqual(elements.get("view-overview").innerHTML, "");
});
