import { checkRuntime, formatRuntimeDiagnostics } from "../lib/runtime.mjs";

const result = await checkRuntime();
if (result.ok) console.log(`Node ${process.version}: SQLite and FTS5 available.`);
else {
  console.error(formatRuntimeDiagnostics(result));
  process.exitCode = 1;
}
