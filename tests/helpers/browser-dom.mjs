import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    contains(name) {
      return classes.has(name);
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

export function createBrowserTestEnvironment() {
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
  const history = { replaceState() {} };
  return { elements, document, history };
}

export function createAppRunner() {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const appSource = readFileSync(
    path.resolve(__dirname, "../../browser/app.js"),
    "utf8",
  );
  const runApp = new AsyncFunction(
    "document",
    "window",
    "fetch",
    "history",
    "setInterval",
    "URLSearchParams",
    appSource,
  );
  return (document, window, fetch, history) =>
    runApp(document, window, fetch, history, () => 1, URLSearchParams);
}

export function createDefaultFetch(overrides = {}) {
  return async (requestPath) => {
    if (requestPath === "/api/health") {
      return createResponse({ repository: "owner/repo" });
    }
    if (requestPath === "/api/overview") {
      return createResponse({ data: {} });
    }
    if (requestPath === "/api/maintenance") {
      return createResponse(
        overrides.maintenanceData !== undefined ? { data: overrides.maintenanceData } : { data: {} },
      );
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
    if (overrides.extra) {
      const result = await overrides.extra(requestPath);
      if (result !== undefined) {
        return result;
      }
    }
    throw new Error(`Unexpected fetch path: ${requestPath}`);
  };
}
