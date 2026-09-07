import { parseCliTranscript } from "../../lib/clients/cli-session-reader.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readPiSessionFile } from "../../pi-session-reader.mjs";

const CLIENTS = Object.freeze(["copilot", "pi", "codex", "claude", "antigravity"]);

const CASES = Object.freeze([
  {
    id: "repo-preference",
    family: "preference",
    repository: "acme/checkout",
    user: "For this checkout repository, please prefer small pure functions over clever abstractions; it keeps review predictable.",
    assistant: "I will keep the implementation composed from small pure functions and explain any unavoidable state.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["prefer", "small", "pure", "functions", "checkout"] }],
    query: "How should helpers in checkout be structured?",
  },
  {
    id: "repo-rejection",
    family: "rejection",
    repository: "acme/payments",
    user: "Please avoid silently retrying payment mutations. A duplicate charge is worse than a visible failure, so retries need an idempotency key.",
    assistant: "The payment path will surface failures and only retry with an idempotency key.",
    expected: [{ type: "rejected_approach", scope: "repo", anchors: ["avoid", "silently", "retrying", "payment", "mutations"] }],
    query: "What retry rule did we settle on for payment mutations?",
  },
  {
    id: "global-style",
    family: "global",
    repository: "acme/editor",
    user: "Across all of my projects, I prefer examples that show the failure path before the happy path; this is a durable teaching preference.",
    assistant: "I will use failure-first examples when explaining work across repositories.",
    expected: [{ type: "user_preference", scope: "global", anchors: ["prefer", "examples", "failure", "path", "happy"] }],
    query: "What teaching style should I use in another project?",
  },
  {
    id: "decision-rationale",
    family: "decision",
    repository: "acme/ledger",
    user: "Which persistence layer should the ledger use under concurrent writers?",
    assistant: "We decided to use PostgreSQL because row-level locking and transactional constraints matter for concurrent ledger writers.",
    expected: [{ type: "decision", scope: "repo", anchors: ["decided", "PostgreSQL", "row-level", "locking", "concurrent"] }],
    query: "What persistence decision did we make for the ledger?",
  },
  {
    id: "question-only",
    family: "question",
    repository: "acme/search",
    user: "Would it make sense to always cache the search response, or should we measure the hit rate first? I am asking for options, not setting a rule.",
    assistant: "We should measure the hit rate before choosing a caching policy.",
    expected: [],
    forbidden: [{ anchors: ["always", "cache", "search", "response"] }],
    query: "Did we establish a cache rule for search?",
  },
  {
    id: "negated-directive",
    family: "negation",
    repository: "acme/importer",
    user: "The importer does not always need a background worker; for a one-shot repair, keeping it in the foreground is safer.",
    assistant: "That is a constraint for this repair, not a blanket preference about workers.",
    expected: [],
    forbidden: [{ anchors: ["always", "background", "worker"] }],
    query: "What did we decide about importer workers?",
  },
  {
    id: "quoted-rule",
    family: "quotation",
    repository: "acme/docs",
    user: "The old runbook says, \"Always publish from main.\" I am quoting it so we can replace that unsafe advice, not asking Lore to remember it.",
    assistant: "We should replace the runbook wording and require a reviewed release branch.",
    expected: [],
    forbidden: [{ anchors: ["always", "publish", "main"] }],
    query: "What publishing rule should the docs retain?",
  },
  {
    id: "hypothetical",
    family: "hypothetical",
    repository: "acme/alerts",
    user: "If we ever moved alert delivery to a queue, we might prefer batches of fifty, but that is only a scenario for discussion.",
    assistant: "The current alert delivery remains synchronous while we gather measurements.",
    expected: [],
    forbidden: [{ anchors: ["prefer", "batches", "fifty", "alert"] }],
    query: "What alert batch size is currently agreed?",
  },
  {
    id: "ordinary-bug-report",
    family: "bug-report",
    repository: "acme/api",
    user: "The API returned a 502 after the proxy upgrade. Please inspect the timeout and include the failing request in the bug report.",
    assistant: "I will inspect the proxy timeout and reproduce the failing request before proposing a change.",
    expected: [],
    forbidden: [{ anchors: ["prefer", "timeout", "proxy"] }],
    query: "Did we record an API timeout preference?",
  },
  {
    id: "correction",
    family: "correction",
    repository: "acme/worker",
    user: "Use a 30 second timeout for the worker.",
    assistant: "I will use a 30 second timeout.",
    correction: { user: "Actually, that is wrong: use a 45 second timeout because the upstream batch window is longer.", assistant: "Understood; the corrected worker timeout is 45 seconds for this repository." },
    expected: [{ type: "user_preference", scope: "repo", anchors: ["use", "45", "second", "timeout", "worker"] }],
    forbidden: [{ anchors: ["use", "30", "second", "timeout", "worker"] }],
    query: "Which worker timeout is the corrected one?",
  },
  {
    id: "changed-decision",
    family: "reversal",
    repository: "acme/catalog",
    user: "We initially chose Redis for catalog invalidation.",
    assistant: "The initial catalog decision was Redis.",
    correction: { user: "The decision changed after the durability review: use PostgreSQL notifications instead, because losing invalidations is unacceptable.", assistant: "The current decision is PostgreSQL notifications; Redis is historical context." },
    expected: [{ type: "decision", scope: "repo", anchors: ["decision", "PostgreSQL", "notifications", "durability", "invalidations"] }],
    forbidden: [{ anchors: ["initial", "Redis", "catalog", "invalidation"] }],
    query: "What is the current catalog invalidation decision?",
  },
  {
    id: "explicit-cross-project",
    family: "global",
    repository: "acme/cli",
    user: "Make this rule global across repositories: never put credentials in examples, including test fixtures, because readers copy them.",
    assistant: "I will treat credential-free examples as a cross-project rule and keep fixtures obviously synthetic.",
    expected: [{ type: "rejected_approach", scope: "global", anchors: ["never", "credentials", "examples", "test", "fixtures"] }],
    query: "What security rule applies to examples in a new repository?",
  },
  {
    id: "repo-default",
    family: "scope",
    repository: "acme/mobile",
    user: "For the mobile app only, prefer snapshot fixtures that include accessibility labels. This does not apply to my other repositories.",
    assistant: "I will keep that fixture preference scoped to the mobile app.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["prefer", "snapshot", "fixtures", "accessibility", "mobile"] }],
    query: "What fixture preference does the mobile app have?",
  },
  {
    id: "relevance-negative",
    family: "relevance",
    repository: "acme/infra",
    user: "The deployment question is still open; first compare the rollback runbooks and their recovery time objectives.",
    assistant: "I will compare the runbooks before recommending a deployment mechanism.",
    expected: [],
    forbidden: [{ anchors: ["prefer", "deployment", "mechanism"] }],
    query: "What is the capital of Finland?",
    negativeQuery: "How do penguins stay warm?",
  },
  {
    id: "long-window",
    family: "retention-window",
    repository: "acme/longrun",
    turnsBefore: 13,
    user: "Remember this repository decision: use append-only event records and derive projections asynchronously, because audit replay is required.",
    assistant: "I will preserve the append-only event decision and its audit replay rationale.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["append-only", "event", "records", "projections", "audit"] }],
    query: "What event storage decision protects audit replay?",
  },
  {
    id: "isolation-primary",
    family: "isolation",
    repository: "acme/alpha",
    user: "For alpha, prefer UTC timestamps in persisted records so ordering is stable across regions.",
    assistant: "Alpha will persist UTC timestamps for cross-region ordering.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["prefer", "UTC", "timestamps", "persisted", "alpha"] }],
    foreign: { repository: "acme/beta", user: "For beta, prefer local wall-clock timestamps in display reports.", assistant: "Beta display reports can use local wall-clock timestamps." },
    query: "What timestamp policy does alpha use?",
    forbidden: [{ anchors: ["local", "wall-clock", "timestamps", "beta"] }],
    critical: ["isolation"],
  },
  {
    id: "suppression",
    family: "suppression",
    repository: "acme/suppressed",
    user: "Prefer a compact release note with only user-visible changes; internal refactors belong in the engineering log.",
    assistant: "I will keep release notes focused on user-visible changes.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["prefer", "compact", "release", "note", "user-visible"] }],
    query: "How detailed should release notes be?",
    suppress: true,
    critical: ["suppression"],
  },
  {
    id: "multi-proposition",
    family: "multi-proposition",
    repository: "acme/edge",
    user: "For edge services, prefer bounded queues and never drop the request identifier from logs; both rules matter when diagnosing overload.",
    assistant: "I will retain both the bounded queue preference and the request identifier requirement.",
    expected: [
      { type: "user_preference", scope: "repo", anchors: ["prefer", "bounded", "queues", "edge"] },
      { type: "rejected_approach", scope: "repo", anchors: ["never", "drop", "request", "identifier", "logs"] },
    ],
    query: "What queue and logging rules apply to edge services?",
  },
  {
    id: "assistant-outcome",
    family: "decision",
    repository: "acme/stream",
    user: "We need to choose a serialization format for the stream boundary.",
    assistant: "After comparing compatibility and tooling, we chose Avro with a schema registry; the earlier JSON suggestion is not the final decision.",
    expected: [{ type: "decision", scope: "repo", anchors: ["chose", "Avro", "schema", "registry", "compatibility"] }],
    forbidden: [{ anchors: ["earlier", "JSON", "stream", "boundary"] }],
    query: "Which serialization format was chosen for the stream boundary?",
  },
  {
    id: "assistant-claim",
    family: "outcome-verification",
    repository: "acme/verify",
    user: "Can you investigate why the verification job is flaky?",
    assistant: "I think I fixed the verification job, but I have not run the complete suite yet.",
    expected: [],
    forbidden: [{ anchors: ["fixed", "verification", "job", "complete", "suite"] }],
    query: "What verified decision did we retain for the flaky job?",
  },
  {
    id: "soft-preference",
    family: "preference",
    repository: "acme/web",
    user: "It helps me when implementation notes lead with the user impact and then explain the code, so please use that order in this project.",
    assistant: "I will lead implementation notes with user impact and follow with the technical explanation.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["implementation", "notes", "user", "impact", "order"] }],
    query: "How should implementation notes be ordered here?",
  },
  {
    id: "explicit-forget",
    family: "suppression",
    repository: "acme/privacy",
    user: "Never retain personal customer names in debugging memories; use opaque account identifiers instead.",
    assistant: "I will use opaque identifiers and exclude personal names from retained debugging context.",
    expected: [{ type: "rejected_approach", scope: "repo", anchors: ["never", "retain", "personal", "customer", "names"] }],
    query: "What customer identifier rule applies to debugging memories?",
    suppress: true,
    critical: ["suppression"],
  },
  {
    id: "correction-implicit",
    family: "correction",
    repository: "acme/docs-site",
    user: "Please use the short link in the guide.",
    assistant: "I will use the short link.",
    correction: { user: "No, I meant the canonical full URL so copied guides remain self-contained.", assistant: "Understood; use the canonical full URL in the guide." },
    expected: [{ type: "user_preference", scope: "repo", anchors: ["canonical", "full", "URL", "copied", "guides"] }],
    forbidden: [{ anchors: ["short", "link", "guide"] }],
    query: "Which URL format is current for the guide?",
  },
  {
    id: "quoted-preference",
    family: "quotation",
    repository: "acme/review",
    user: "I disagree with the sentence \"Prefer one huge review commit.\" For this work, split changes by behavior so each commit can be reverted.",
    assistant: "I will split commits by behavior and keep each change independently revertible.",
    expected: [{ type: "user_preference", scope: "repo", anchors: ["split", "changes", "behavior", "commit", "reverted"] }],
    forbidden: [{ anchors: ["prefer", "one", "huge", "review", "commit"] }],
    query: "How should review commits be organized?",
  },
  {
    id: "global-identity",
    family: "global",
    repository: "acme/profile",
    user: "Across projects I work best with direct, concise status updates that name uncertainty instead of hiding it.",
    assistant: "I will keep status updates direct and call out uncertainty wherever we work.",
    expected: [{ type: "user_preference", scope: "global", anchors: ["status", "updates", "uncertainty", "direct", "concise"] }],
    query: "What status update style should carry into a different repository?",
  },
  {
    id: "negative-prefer-word",
    family: "bug-report",
    repository: "acme/runtime",
    user: "The word prefer appears in a compatibility warning from the runtime; this report describes observed behavior and does not set a preference.",
    assistant: "I will record the warning as diagnostic evidence and wait for a confirmed policy.",
    expected: [],
    forbidden: [{ anchors: ["prefer", "compatibility", "warning", "runtime"] }],
    query: "Did the runtime report create a preference?",
  },
  {
    id: "decision-tradeoff",
    family: "decision",
    repository: "acme/cache",
    user: "Should cache invalidation happen on a timer or from domain events?",
    assistant: "We chose domain events over a timer because an event gives us immediate invalidation without a polling race; document that tradeoff.",
    expected: [{ type: "decision", scope: "repo", anchors: ["chose", "domain", "events", "timer", "invalidation"] }],
    query: "Why did we choose domain events for cache invalidation?",
  },
]);

function clientLabel(client) {
  return client[0].toUpperCase() + client.slice(1);
}

function materializeTurns(blueprint, client) {
  const tail = blueprint.turnsBefore
    ? Array.from({ length: blueprint.turnsBefore }, (_, index) => ({
      user_message: `Progress note ${index + 1}: inspect the ${clientLabel(client)} fixture without making a durable policy decision.`,
      assistant_response: "No durable preference was established in this progress note.",
    }))
    : [];
  const turns = [
    { user_message: blueprint.user, assistant_response: blueprint.assistant },
    ...tail,
  ];
  if (blueprint.correction) turns.splice(1, 0, { user_message: blueprint.correction.user, assistant_response: blueprint.correction.assistant });
  return turns.map((turn, index) => ({ ...turn, turn_index: index + 1 }));
}

function canonicalArtifacts(blueprint, client, repository = blueprint.repository) {
  const turns = materializeTurns(blueprint, client).map((turn) => ({ ...turn, source_record_id: `${client}-${blueprint.id}-${turn.turn_index}` }));
  return {
    session: { id: `${client}:${blueprint.id}`, cwd: `/tmp/lore-quality/${client}`, repository, branch: "quality", summary: `Synthetic ${client} quality scenario ${blueprint.id}`, updated_at: "2026-09-07T12:00:00.000Z" },
    checkpoints: [], files: [], refs: [], turns,
  };
}

function encodeRawEntries(blueprint, client) {
  const turns = materializeTurns(blueprint, client);
  if (client === "codex") {
    return turns.flatMap((turn) => [
      { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: turn.user_message }] } },
      { type: "response_item", payload: { type: "reasoning", summary: "private reasoning omitted" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: turn.assistant_response }] } },
    ]);
  }
  if (client === "claude") {
    let parentUuid = null;
    return turns.flatMap((turn, index) => {
      const userUuid = `${blueprint.id}-u-${index}`;
      const assistantUuid = `${blueprint.id}-a-${index}`;
      const entries = [
        { uuid: userUuid, parentUuid, type: "user", message: { role: "user", content: turn.user_message } },
        { uuid: assistantUuid, parentUuid: userUuid, type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning omitted" }, { type: "text", text: turn.assistant_response }] } },
      ];
      parentUuid = assistantUuid;
      return entries;
    });
  }
  if (client === "antigravity") {
    return turns.flatMap((turn, index) => [
      { step_index: index * 2, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: `<USER_REQUEST>${turn.user_message}</USER_REQUEST><ADDITIONAL_METADATA>fixture metadata</ADDITIONAL_METADATA>` },
      { step_index: index * 2 + 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: turn.assistant_response },
    ]);
  }
  return null;
}

export function parseScenarioTranscript(blueprint, client) {
  if (client === "copilot") return canonicalArtifacts(blueprint, client);
  if (client === "pi") {
    const home = mkdtempSync(path.join(os.tmpdir(), "lore-quality-pi-"));
    const filePath = path.join(home, "session.jsonl");
    const turns = materializeTurns(blueprint, client);
    const entries = [
      { type: "session", id: `pi:${blueprint.id}`, cwd: `/tmp/lore-quality/pi`, timestamp: "2026-09-07T12:00:00.000Z" },
      ...turns.flatMap((turn) => [
        { type: "message", timestamp: "2026-09-07T12:00:01.000Z", message: { role: "user", content: [{ type: "text", text: turn.user_message }] } },
        { type: "message", timestamp: "2026-09-07T12:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: turn.assistant_response }, { type: "toolCall", name: "read", arguments: { path: "README.md" } }] } },
        { type: "message", timestamp: "2026-09-07T12:00:03.000Z", message: { role: "toolResult", content: "ignored tool output" } },
      ]),
    ];
    try {
      writeFileSync(filePath, `${entries.map(JSON.stringify).join("\n")}\n`, "utf8");
      return readPiSessionFile(filePath, { repository: blueprint.repository }).sessionArtifacts;
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
  const raw = encodeRawEntries(blueprint, client);
  return parseCliTranscript(raw.map(JSON.stringify).join("\n"), {
    client,
    sessionId: `${client}:${blueprint.id}`,
    cwd: `/tmp/lore-quality/${client}`,
    repository: blueprint.repository,
    timestamp: "2026-09-07T12:00:00.000Z",
  });
}

export function buildScenario(blueprint, client) {
  return Object.freeze({
    ...blueprint,
    client,
    scenarioId: `${client}:${blueprint.id}`,
    sessionId: `${client}:${blueprint.id}`,
    transcript: parseScenarioTranscript(blueprint, client),
  });
}

export const RELIABILITY_BLUEPRINTS = CASES;
export const RELIABILITY_CLIENTS = CLIENTS;
export const RELIABILITY_CORPUS = Object.freeze(CLIENTS.flatMap((client) => CASES.map((blueprint) => buildScenario(blueprint, client))));
