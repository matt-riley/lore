import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliTranscript } from "../../lib/clients/cli-session-reader.mjs";

const parse = (client, entries) => parseCliTranscript(entries.map(JSON.stringify).join("\n"), {
  client, sessionId: `${client}:session`, cwd: "/test", repository: "test", timestamp: "2026-09-06T12:00:00Z",
});

test("Codex extracts conversation text once and excludes reasoning, tools, and injected context", () => {
  const parsed = parse("codex", [
    { type: "event_msg", payload: { type: "user_message", message: "duplicate" } },
    { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "private instructions" }] } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Remember SQLite <lore_context>old memory</lore_context>" }] } },
    { type: "response_item", payload: { type: "reasoning", summary: "private reasoning" } },
    { type: "response_item", payload: { type: "message", role: "assistant", channel: "analysis", content: [{ type: "output_text", text: "private analysis" }] } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Decided to use SQLite." }] } },
  ]);
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].user_message, "Remember SQLite");
  assert.equal(parsed.turns[0].assistant_response, "Decided to use SQLite.");
  assert.doesNotMatch(JSON.stringify(parsed), /private|duplicate|old memory/);
});

test("Claude follows the active parent chain and ignores tool results and thinking", () => {
  const parsed = parse("claude", [
    { uuid: "1", parentUuid: null, type: "user", message: { role: "user", content: "hello" } },
    { uuid: "abandoned", parentUuid: "1", type: "assistant", message: { role: "assistant", content: "abandoned branch" } },
    { uuid: "2", parentUuid: "1", type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: "reply" }] } },
    { uuid: "3", parentUuid: "2", type: "user", message: { role: "user", content: [{ type: "tool_result", content: "private output" }] } },
  ]);
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].assistant_response, "reply");
  assert.doesNotMatch(JSON.stringify(parsed), /abandoned|secret|private/);
});

test("Antigravity uses completed user/model steps, latest step revisions, and excludes thinking", () => {
  const parsed = parse("antigravity", [
    { step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", content: "<USER_REQUEST>Remember SQLite</USER_REQUEST><ADDITIONAL_METADATA>private expanded command instructions</ADDITIONAL_METADATA>" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "RUNNING", content: "partial" },
    { step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", content: "final", thinking: "private" },
    { step_index: 2, source: "MODEL", type: "GENERIC", status: "DONE", content: "tool output" },
  ]);
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].user_message, "Remember SQLite");
  assert.equal(parsed.turns[0].assistant_response, "final");
  assert.doesNotMatch(JSON.stringify(parsed), /partial|private|tool output/);
});

test("reader tolerates only an unfinished trailing JSON record", () => {
  const options = { client: "codex", sessionId: "test" };
  assert.doesNotThrow(() => parseCliTranscript('{"partial":', options));
  assert.throws(() => parseCliTranscript('{broken}\n{}\n', options), /Malformed/);
});

test("bounded latest Antigravity prompt works beyond 32 MiB and ignores incomplete trailing data", async () => {
  const { readLatestCliPrompt } = await import("../../lib/clients/cli-session-reader.mjs");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const path = await import("node:path"); const os = await import("node:os");
  const home = await mkdtemp(path.join(os.tmpdir(), "lore-latest-prompt-"));
  try {
    const file = path.join(home, "t.jsonl");
    await writeFile(file, (JSON.stringify({ type: "THINKING", content: "x".repeat(1024) }) + "\n").repeat(33_000)
      + JSON.stringify({ step_index: 4, type: "USER_INPUT", source: "USER_EXPLICIT", status: "DONE", content: "<USER_REQUEST>latest 🥝</USER_REQUEST>" }) + "\n{unfinished");
    assert.equal(await readLatestCliPrompt(file, { client: "antigravity" }), "latest 🥝");
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("Claude slash-command echo with only injected content produces no turn", () => {
  const parsed = parse("claude", [
    { uuid: "1", parentUuid: null, type: "user", isMeta: false, message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>" } },
  ]);
  assert.equal(parsed.turns.length, 0);
});

test("Claude message with slash-command and real content preserves only the real content", () => {
  const parsed = parse("claude", [
    { uuid: "1", parentUuid: null, type: "user", isMeta: false, message: { role: "user", content: "Please fix the bug\n<command-name>/debug</command-name>\n<local-command-stdout>Error found</local-command-stdout>\nThank you" } },
  ]);
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].user_message, "Please fix the bug\n\nThank you");
  assert(!parsed.turns[0].user_message.includes("command-name"));
  assert(!parsed.turns[0].user_message.includes("Error found"));
});

test("Codex AGENTS.md instructions with only injected content produces no turn", () => {
  const parsed = parse("codex", [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for lib/utils\n<INSTRUCTIONS>Use utility functions</INSTRUCTIONS>\n<environment_context>Node 24.0.0</environment_context>" }] } },
  ]);
  assert.equal(parsed.turns.length, 0);
});

test("Codex message with AGENTS.md instructions and real content preserves only the real content", () => {
  const parsed = parse("codex", [
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Check the implementation.\n# AGENTS.md instructions for test\n<INSTRUCTIONS>Read carefully</INSTRUCTIONS>\nLet me know." }] } },
  ]);
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].user_message, "Check the implementation.\n\nLet me know.");
  assert(!parsed.turns[0].user_message.includes("AGENTS.md"));
  assert(!parsed.turns[0].user_message.includes("INSTRUCTIONS"));
});

test("Claude message with system-reminder blocks strips them", () => {
  const parsed = parse("claude", [
    { uuid: "1", parentUuid: null, type: "user", isMeta: false, message: { role: "user", content: "Test the changes\n<system-reminder>Do not capture</system-reminder>" } },
  ]);
  assert.equal(parsed.turns.length, 1);
  assert.equal(parsed.turns[0].user_message, "Test the changes");
  assert(!parsed.turns[0].user_message.includes("system-reminder"));
});
