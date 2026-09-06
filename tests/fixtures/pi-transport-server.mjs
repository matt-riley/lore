import { StringDecoder } from "node:string_decoder";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const mode = process.argv[2] ?? process.env.LORE_PI_TRANSPORT_MODE ?? "normal";
const marker = process.env.LORE_PI_TRANSPORT_MARKER;
const launches = process.env.LORE_PI_TRANSPORT_LAUNCHES;
const onceState = process.env.LORE_PI_TRANSPORT_ONCE_STATE;
const decoder = new StringDecoder("utf8");
let input = "";

if (launches) {
  appendFileSync(launches, "launch\n");
}

function writeFragmented(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  const split = Math.max(1, Math.floor(bytes.length / 2));
  process.stdout.write(bytes.subarray(0, split));
  setImmediate(() => process.stdout.write(bytes.subarray(split)));
}

if (mode === "fail-start") {
  process.exit(1);
}

function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (
    (mode === "exit-after-status" && request.method !== "status")
    || (mode === "exit-once" && request.method !== "status" && onceState && !existsSync(onceState))
  ) {
    if (mode === "exit-once" && onceState) {
      writeFileSync(onceState, "used\n");
    }
    process.exit(2);
  }
  if (request.method === "close") {
    writeFragmented({ id: request.id, ok: true, result: { closing: true } });
    return;
  }
  const result = request.method === "status"
    ? { ready: "pi-transport-✓" }
    : request.method === "recall"
      ? { text: "", includedRows: 0, memoryCount: 0 }
      : request.method === "search"
        ? []
        : request.method === "backfill"
          ? { queued: 0 }
          : { echo: request.params?.message ?? null };
  writeFragmented({
    id: request.id,
    ok: true,
    result,
  });
}

process.stdin.on("data", (chunk) => {
  input += decoder.write(chunk);
  let newline;
  while ((newline = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    handleLine(line);
  }
});

process.stdin.on("end", () => {
  if (marker) {
    appendFileSync(marker, `${marker}:eof\n`);
  }
  process.exit(0);
});
