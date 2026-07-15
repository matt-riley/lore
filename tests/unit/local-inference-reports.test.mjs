import assert from "node:assert/strict";
import { test } from "node:test";

import { formatReflectionReport } from "../../lib/memory-tools-reports.mjs";

test("reflection reports advisory consolidation, contradiction, trend, and quality diagnostics", () => {
  const output = formatReflectionReport({
    repository: "fixture-repo",
    focus: "patterns",
    recall: {
      estimatedTokens: 120,
    },
    envelope: {
      sections: ["Relevant Knowledge"],
    },
    summary: "CI maintenance recurred.",
    insights: [{
      text: "The Node setup workflow was fixed.",
      source: "local episodes",
    }],
    analysis: {
      consolidations: [{
        text: "Two workflow items form one CI maintenance theme.",
        evidenceIndexes: [0, 1],
      }],
      contradictions: [{
        text: "A fix was followed by another deployment verification requirement.",
        evidenceIndexes: [0, 1],
      }],
      trends: [{
        text: "GitHub Actions maintenance recurred.",
        evidenceIndexes: [0, 1],
        occurrences: 2,
      }],
    },
    localInference: {
      requested: true,
      used: true,
      embeddingsUsed: true,
      evidenceCandidateCount: 4,
      evidenceSelectedCount: 2,
      groundingUsed: true,
      summaryGrounded: true,
      groundedInsightCount: 1,
      discardedInsightCount: 0,
      groundedAnalysisCount: 3,
      discardedAnalysisCount: 0,
      qualityEvaluationUsed: true,
      qualityAcceptedCount: 5,
      qualityRejectedCount: 1,
    },
  });

  assert.match(output, /## Memory Consolidation Proposals/);
  assert.match(output, /## Contradictions And Possible Supersessions/);
  assert.match(output, /## Recurring Trends/);
  assert.match(output, /localInferenceAnalysis: consolidations=1 contradictions=1 trends=1 grounded=3 discarded=0/);
  assert.match(output, /localInferenceQuality: used accepted=5 rejected=1/);
});
