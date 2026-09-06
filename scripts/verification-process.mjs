import { execFile } from "node:child_process";

// Some commands never read stdin; hooks may stop reading rejected input early.
// EPIPE is therefore transport information, not the child's final outcome.
export function runVerificationProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { input, ...execOptions } = options;
    let inputError;
    const child = execFile(command, args, execOptions, (error, stdout, stderr) => {
      const failure = error ?? inputError;
      if (failure) reject(Object.assign(failure, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") inputError = error;
    });
    child.stdin.end(input);
  });
}
