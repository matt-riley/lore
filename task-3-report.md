# Task 3 baseline report: independent quality corpus and benchmark harness

This report records the baseline from commit `4e05aa1` before the reliability production waves are integrated. The corpus expectations are frozen in `tests/fixtures/reliability-corpus.mjs`; changing them requires root review.

## Corpus and adapters

The corpus contains 27 semantic scenarios for each client (135 total), with unique scenario IDs. It covers explicit repository and global preferences, completed decisions with rationale, questions, negation, quotations, hypotheticals, ordinary bug reports, corrections, changed decisions, explicit cross-project scope, repository isolation, suppression, multiple propositions, assistant outcome claims, and a proposition after 13 filler turns.

The Codex, Claude, and Antigravity cases are encoded and parsed through `parseCliTranscript` using each adapter's response-item, parent-chain, and completed-step shapes. Copilot cases use canonical session-artifact shapes because this checkout has no Copilot transcript reader. Pi cases are written to isolated JSONL files and parsed through the native `readPiSessionFile` reader, including ignored tool results and file tool calls. The remaining limitation is therefore Copilot native file-reader coverage; a future reader should replace only that fixture parser while preserving the expectations.

## Baseline quality

Command:

```text
node scripts/reliability-quality.mjs --json
```

Result (expected failure before production integration):

| Metric | Result | Gate |
| --- | ---: | ---: |
| Scenarios | 135 | 120 minimum |
| Client coverage | 27 each | 24 each minimum |
| Extraction precision | 64.29% | >=95% |
| Explicit proposition recall | 45.00% (45/100) | >=90% |
| Retention recall | 56.00% (56/100) | >=90% |
| False global promotions | 0 | 0 |
| Negative false positives | 30 | 0 |
| Critical failures | 8 | 0 |

Critical failures were the suppression and explicit-forget cases for Pi, Codex, Claude, and Antigravity. After forgetting, each case replays the same transcript before recall, exposing resurrection. Forbidden evidence was recalled in 36 adapter-specific negative/reversal cases (nine each for Pi, Codex, Claude, and Antigravity), which remains reported as a safety failure. The baseline has 89 cases with at least one quality failure; no expectations were relaxed to fit current behavior.

The evaluator matches evidence using type, scope, repository, and a multi-anchor token overlap threshold. A repeated keyword without the proposition's evidence is counted as a false positive. The pipeline under test is transcript parsing, `extractSessionMemories`, `applySessionExtraction`/retention, and `recallMemory`; it does not hand-seed the expected positive memories. Isolation uses a second extracted transcript in a foreign repository. Suppression applies the current forget path to an extracted retained row, replays the same transcript, and verifies that the proposition does not resurrect.

## Native benchmark

Command:

```text
node scripts/reliability-benchmark.mjs --warmups=1 --repeats=3
```

Environment: Node `v26.8.1`, Darwin arm64. Each size used a fresh temporary Lore home and an explicit synthetic `LORE_HOME`, `LORE_CONFIG`, and `LORE_REPOSITORY`; inherited `LORE_*` variables are removed. The run invokes the actual `node lore-cli.mjs tool memory_status` and `node lore-cli.mjs tool lore_recall` subprocesses.

| Rows | Startup p95 | Prompt p95 | Native CLI | Disk-cold claim |
| ---: | ---: | ---: | --- | --- |
| 1,000 | 90.40 ms | 96.60 ms | passed | false |
| 10,000 | 96.00 ms | 96.45 ms | passed | false |
| 100,000 | 176.54 ms | 99.34 ms | passed | false |

The 10k deterministic latency thresholds are startup p95 <300 ms and prompt p95 <200 ms. The benchmark does not flush or otherwise control the OS disk cache, so it reports `diskCold=false` and does not claim disk-cold performance.

Embedding paths are deterministic mocks, reported separately from native latency. Cold work populates the cache; the second warm pass performs zero embedding calls. For 1k, 10k, and 100k rows the bounded mock input is 1,000, 2,000, and 2,000 records respectively, with capture delta work equal to the cold calls. No network/model deadline is asserted; embedding deadline and partial coverage remain separate fields.

## Verification

The corpus shape, evidence matching, frozen gates, mock embedding accounting, and native benchmark isolation are covered by `tests/unit/reliability-quality.test.mjs`. The full quality gate test is intentionally red against the pre-integration production baseline above and should turn green after the extraction, database lifecycle, and client/retrieval waves are integrated.
