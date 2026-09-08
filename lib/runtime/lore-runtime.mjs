import { chmodSync, existsSync } from "node:fs";

import { loadConfig as loadLoreConfig } from "../core/config.mjs";
import { checkRuntime as checkLoreRuntime, formatRuntimeDiagnostics } from "../core/runtime.mjs";
import { LoreDb } from "../db/db.mjs";
import { assembleRecall, detectPromptContextNeed, SESSION_START_PHASES } from "../context/recall-assembler.mjs";
import { resolveRepositoryIdentity } from "../utils/repository-identity.mjs";
import { resolveLoreToolName } from "../capabilities/capability-manifest.mjs";
import {
  listCopilotJoinTools,
  listModelTools,
  listRegisteredTools,
} from "./tool-registry.mjs";
import { dispatchSlash as dispatchSlashFromArgv } from "./slash-dispatch.mjs";

export const LORE_CLIENTS = Object.freeze(["copilot", "pi", "codex", "claude", "antigravity"]);
export const LORE_SURFACES = Object.freeze(["hook", "tool", "cli", "slash"]);

function normalizeClient(client) {
  const value = String(client ?? "").trim();
  return LORE_CLIENTS.includes(value) ? value : value || "copilot";
}

function normalizeSurface(surface) {
  const value = String(surface ?? "").trim();
  return LORE_SURFACES.includes(value) ? value : "hook";
}

function unavailableMessage(message) {
  const text = String(message ?? "not initialized").trim() || "not initialized";
  return text.startsWith("lore unavailable") ? text : `lore unavailable: ${text}`;
}

function enforcePrivateFileModes(dbPath) {
  if (!dbPath) {
    return;
  }
  for (const candidate of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(candidate)) {
        chmodSync(candidate, 0o600);
      }
    } catch {
      // Best-effort privacy on the existing store; never move configured paths.
    }
  }
}

function unavailableSession(message, extra = {}) {
  const error = extra.lastError instanceof Error ? extra.lastError : new Error(message);
  const unavailable = unavailableMessage(message);
  return {
    client: extra.client ?? null,
    surface: extra.surface ?? "hook",
    initialized: false,
    enabled: extra.enabled === false ? false : true,
    lastError: error,
    config: extra.config ?? null,
    db: null,
    repository: extra.repository ?? null,
    sessionId: extra.sessionId ?? null,
    sessionSource: extra.sessionSource ?? null,
    metrics: {},
    lastBackupPath: null,
    async handleLifecycle() {
      return {};
    },
    async dispatchTool() {
      return unavailable;
    },
    async dispatchSlash() {
      return unavailable;
    },
    async doctor() {
      return unavailable;
    },
    close() {},
  };
}

function promptOnboardingPhase(need) {
  return need?.identityOnly === true || need?.directAddressed === true;
}

/**
 * Host-agnostic long-lived Lore session. Never returns null: disabled or
 * unusable runtimes are fail-open stubs whose tools still "work" as
 * "lore unavailable" replies.
 */
export async function createLoreSession({
  client,
  surface = "hook",
  cwd,
  sessionId = null,
  sessionSource = null,
  readOnly = false,
  config: configOverride = null,
  getRuntime = null,
  checkRuntime = checkLoreRuntime,
  loadConfig = loadLoreConfig,
} = {}) {
  const resolvedClient = normalizeClient(client);
  const resolvedSurface = normalizeSurface(surface);

  let runtimeCheck;
  try {
    runtimeCheck = await checkRuntime();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailableSession(message, { client: resolvedClient, surface: resolvedSurface });
  }
  if (!runtimeCheck?.ok) {
    return unavailableSession(formatRuntimeDiagnostics(runtimeCheck) || "runtime preflight failed", {
      client: resolvedClient,
      surface: resolvedSurface,
    });
  }

  let config = configOverride;
  if (!config) {
    try {
      config = await loadConfig();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unavailableSession(message, { client: resolvedClient, surface: resolvedSurface });
    }
  }
  if (config?.enabled !== true) {
    return unavailableSession(
      `lore is disabled — set "enabled": true in ${config?.configPath ?? "lore.json"}`,
      {
        client: resolvedClient,
        surface: resolvedSurface,
        config,
        enabled: false,
        sessionId,
        sessionSource,
      },
    );
  }

  const db = new LoreDb(config);
  let lastBackupPath = null;
  try {
    if (readOnly) {
      db.openReadOnly();
    } else {
      const initResult = db.initialize();
      lastBackupPath = initResult?.backupPath ?? null;
    }
  } catch (error) {
    try {
      db.close();
    } catch {
      // already unusable
    }
    const message = error instanceof Error ? error.message : String(error);
    return unavailableSession(message, {
      client: resolvedClient,
      surface: resolvedSurface,
      config,
    });
  }

  enforcePrivateFileModes(config.paths?.derivedStorePath);

  const repository = resolveRepositoryIdentity({
    cwd: cwd ?? process.cwd(),
    explicit: process.env.LORE_REPOSITORY,
    mappings: typeof db.getRepositoryMappings === "function" ? db.getRepositoryMappings() : [],
  });

  const session = {
    client: resolvedClient,
    surface: resolvedSurface,
    initialized: true,
    enabled: true,
    lastError: null,
    config,
    db,
    repository,
    sessionId,
    sessionSource,
    sessionStore: sessionSource,
    metrics: {},
    lastBackupPath,
  };

  const toolsBySurface = new Map();

  function runtimeForSurface(invocationSurface) {
    return async (invocationSessionId) => {
      const base = typeof getRuntime === "function"
        ? await getRuntime(invocationSessionId)
        : session;
      return {
        ...session,
        ...base,
        client: resolvedClient,
        surface: invocationSurface,
        sessionId: invocationSessionId ?? session.sessionId,
      };
    };
  }

  function toolsForSurface(invocationSurface) {
    const cached = toolsBySurface.get(invocationSurface);
    if (cached) {
      return cached;
    }
    const tools = listRegisteredTools({ getRuntime: runtimeForSurface(invocationSurface) });
    toolsBySurface.set(invocationSurface, tools);
    return tools;
  }

  session.listModelTools = () => listModelTools({ getRuntime: runtimeForSurface("tool") });
  session.listRegisteredTools = () => toolsForSurface("tool");
  session.listCopilotJoinTools = () => listCopilotJoinTools({ getRuntime: runtimeForSurface("tool") });

  session.dispatchTool = async function dispatchTool(name, args = {}, extra = {}) {
    if (!session.initialized || session.lastError) {
      return unavailableMessage(session.lastError?.message ?? "not initialized");
    }
    const invocationSurface = extra.surface ?? "tool";
    const resolved = resolveLoreToolName(name) ?? name;
    const tools = toolsForSurface(invocationSurface);
    const tool = tools.find((candidate) => candidate.name === name)
      ?? tools.find((candidate) => candidate.name === resolved);
    if (!tool) {
      return `lore unavailable: unknown tool ${name}`;
    }
    const previousRepository = session.repository;
    if (Object.hasOwn(extra, "repository")) {
      session.repository = extra.repository;
    }
    try {
      return await tool.handler(args ?? {}, {
        sessionId: extra.sessionId ?? session.sessionId,
        surface: invocationSurface,
        client: resolvedClient,
      });
    } finally {
      session.repository = previousRepository;
    }
  };

  session.dispatchSlash = async function dispatchSlash(argsText, extra = {}) {
    if (!session.initialized || session.lastError) {
      return unavailableMessage(session.lastError?.message ?? "not initialized");
    }
    return dispatchSlashFromArgv(
      argsText,
      (name, args, meta) => session.dispatchTool(name, args, meta),
      { ...extra, surface: extra.surface ?? "slash" },
    );
  };

  session.handleLifecycle = async function handleLifecycle(event, payload = {}) {
    if (!session.initialized || session.lastError) {
      return {};
    }
    try {
      const prompt = String(payload.prompt ?? payload.initialPrompt ?? "");
      const eventRepository = payload.repository ?? session.repository;
      const store = session.sessionSource ?? session.sessionStore ?? null;
      if (event === "session_start") {
        const assembled = await assembleRecall({
          db: session.db,
          prompt,
          repository: eventRepository,
          sessionSource: store,
          sessionStore: store,
          config: session.config,
          phases: {
            ...SESSION_START_PHASES,
            onboarding: true,
          },
        });
        const text = assembled?.text ?? "";
        return {
          additionalContext: text || undefined,
          text,
          assembled,
        };
      }
      if (event === "prompt") {
        const need = detectPromptContextNeed(prompt);
        const assembled = await assembleRecall({
          db: session.db,
          prompt,
          repository: eventRepository,
          includeOtherRepositories: need.allowCrossRepoFallback === true,
          limit: session.config?.limits?.promptContextLimit,
          sessionSource: store,
          sessionStore: store,
          config: session.config,
          promptNeed: need,
          phases: {
            procedural: false,
            proposals: false,
            onboarding: promptOnboardingPhase(need),
            directives: true,
            workstream: true,
          },
        });
        const text = assembled?.text ?? "";
        return {
          additionalContext: text || undefined,
          text,
          assembled,
        };
      }
      return {};
    } catch {
      return {};
    }
  };

  session.doctor = async function doctor(args = {}, extra = {}) {
    return session.dispatchTool("lore_doctor", args, extra);
  };

  session.close = function close() {
    try {
      session.db?.close();
    } catch {
      // best-effort close
    }
    session.db = null;
    session.initialized = false;
    toolsBySurface.clear();
  };

  return session;
}
