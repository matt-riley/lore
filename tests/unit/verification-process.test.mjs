import assert from "node:assert/strict";
import { test } from "node:test";
import { runVerificationProcess } from "../../scripts/verification-process.mjs";

const closeInput = "require('node:fs').closeSync(0);";

test("verification commands that do not consume stdin retain their output", async () => {
  const result = await runVerificationProcess(process.execPath, ["-e", `${closeInput}console.log('READY');`]);
  assert.equal(result.stdout.trim(), "READY");
});

test("verification survives a child rejecting input before a large write completes", async () => {
  const result = await runVerificationProcess(process.execPath, ["-e", `${closeInput}console.log('{}');`], {
    input: "x".repeat(16 * 1024 * 1024),
  });
  assert.equal(result.stdout.trim(), "{}");
});

test("closed stdin does not hide a failed child's exit status or diagnostics", async () => {
  await assert.rejects(runVerificationProcess(process.execPath, ["-e", `${closeInput}console.error('rejected');process.exit(7);`], {
    input: "x".repeat(16 * 1024 * 1024),
  }), (error) => error.code === 7 && error.stderr.trim() === "rejected");
});

test("verification sends EOF when no input is supplied", async () => {
  const result = await runVerificationProcess(process.execPath, ["-e", "process.stdin.resume();process.stdin.on('end', () => console.log('EOF'));"], { timeout: 5000 });
  assert.equal(result.stdout.trim(), "EOF");
});
