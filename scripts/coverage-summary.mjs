// Totals from LCOV reports, for a terminal read and for the coverage
// workflow's step summary. Usage: node scripts/coverage-summary.mjs [file...]

import { appendFileSync, readFileSync } from "node:fs";

const files = process.argv.slice(2).filter((file) => file !== "");
if (files.length === 0) {
  console.error("usage: node scripts/coverage-summary.mjs <lcov file> [file...]");
  process.exit(1);
}

function readTotals(file) {
  const totals = { lines: [0, 0], functions: [0, 0], branches: [0, 0] };
  let current = null;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.startsWith("SF:")) current = line.slice(3);
    if (line.startsWith("end_of_record")) current = null;
    if (!current) continue;
    if (line.startsWith("LF:")) totals.lines[1] += Number(line.slice(3));
    if (line.startsWith("LH:")) totals.lines[0] += Number(line.slice(3));
    if (line.startsWith("FNF:")) totals.functions[1] += Number(line.slice(4));
    if (line.startsWith("FNH:")) totals.functions[0] += Number(line.slice(4));
    if (line.startsWith("BRF:")) totals.branches[1] += Number(line.slice(4));
    if (line.startsWith("BRH:")) totals.branches[0] += Number(line.slice(4));
  }
  return totals;
}

const percent = ([hit, found]) => (found === 0 ? "n/a" : `${((hit / found) * 100).toFixed(1)}%`);
const rows = files.map((file) => {
  const totals = readTotals(file);
  return `| ${file} | ${percent(totals.lines)} | ${percent(totals.functions)} | ${percent(totals.branches)} |`;
});

const report = [
  "| report | lines | functions | branches |",
  "| --- | --- | --- | --- |",
  ...rows,
  "",
].join("\n");

console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);
