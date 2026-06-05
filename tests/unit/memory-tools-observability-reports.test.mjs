import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  formatRetrievalTraceSampleRows,
  formatTrajectoryArtifactRows,
} from "../../lib/memory-tools-trace-reports.mjs";
import {
  formatDoctorReport,
  formatDoctorSafetyGateSection,
  formatReviewGateReport,
} from "../../lib/memory-tools-governance-reports.mjs";

describe("memory-tools-observability-reports", () => {
  test("formatRetrievalTraceSampleRows renders repository, sections, and prompt preview", () => {
    const output = formatRetrievalTraceSampleRows([{
      id: "trace-1",
      hook: "onUserPromptSubmitted",
      repository: null,
      route: "memory_recall",
      routeReason: "matched_recall_prompt",
      contextInjected: true,
      latencyMs: 42,
      sectionTitles: ["Context", "History"],
      recordedAt: "2026-06-05T10:00:00.000Z",
      promptPreview: "continue auth migration",
    }]);

    assert.match(output, /\[trace-1\] hook=onUserPromptSubmitted/);
    assert.match(output, /repository=global/);
    assert.match(output, /sections=Context,History/);
    assert.match(output, /prompt=continue auth migration/);
  });

  test("formatTrajectoryArtifactRows includes source, latency, and context keys", () => {
    const output = formatTrajectoryArtifactRows([{
      id: "artifact-1",
      kind: "doctor-report",
      source_kind: "session",
      source_case_id: "case-1",
      severity: "warning",
      outcome: "recorded",
      latency_ms: 18,
      target_ms: 50,
      improvement_artifact_id: "improvement-1",
      event_key: "doctor.snapshot",
      context: { repository: "fixture-repo", route: "memory_status" },
      summary: "Observed a repeat latency spike",
      created_at: "2026-06-05T10:00:00.000Z",
    }]);

    assert.match(output, /\[artifact-1\] kind=doctor-report/);
    assert.match(output, /source=session:case-1/);
    assert.match(output, /contextKeys=repository,route/);
    assert.match(output, /summary=Observed a repeat latency spike/);
  });

  test("formatDoctorReport renders incident details and context", () => {
    const output = formatDoctorReport({
      generatedAt: "2026-06-05T10:00:00.000Z",
      repository: "fixture-repo",
      incidentCount: 1,
      criticalCount: 0,
      warningCount: 1,
      infoCount: 0,
      recordedArtifactId: "artifact-9",
      signals: {
        maintenanceTaskCount: 2,
        trajectoryRecentCount: 4,
        improvementActiveCount: 1,
      },
      incidents: [{
        severity: "warning",
        kind: "latency_regression",
        summary: "Replay latency exceeded target",
        context: {
          latestMs: 420,
          targetMs: 250,
        },
      }],
    });

    assert.match(output, /# Lore Doctor Report/);
    assert.match(output, /recordedArtifact: artifact-9/);
    assert.match(output, /\[warning\] latency_regression: Replay latency exceeded target/);
    assert.match(output, /context: latestMs=420 targetMs=250/);
  });

  test("formatDoctorSafetyGateSection renders observe-only action risk details", () => {
    const output = formatDoctorSafetyGateSection({
      actionCount: 1,
      highestRisk: "high",
      riskCounts: {
        low: 0,
        moderate: 0,
        high: 1,
        critical: 0,
      },
      actions: [{
        riskTier: "high",
        toolName: "memory_scope_override",
        operation: "apply",
        id: "action-1",
        target: "semantic:memory-1",
        mutability: "mutable",
        reversibility: "partial",
        scope: "repository",
        riskScore: 0.82,
        riskReasons: ["writes_db", "changes_scope"],
      }],
    });

    assert.match(output, /## Safety Gate \(observe-only\)/);
    assert.match(output, /\[high\] memory_scope_override.apply id=action-1/);
    assert.match(output, /riskReasons=writes_db,changes_scope/);
  });

  test("formatReviewGateReport renders findings when required sections are missing", () => {
    const output = formatReviewGateReport({
      generatedAt: "2026-06-05T10:00:00.000Z",
      wordCount: 120,
      findingCount: 2,
      recordedArtifactId: "artifact-4",
      findings: [
        { severity: "warning", section: "risk", detail: "Missing risk section" },
        { severity: "info", section: "acceptance", detail: "Acceptance criteria too vague" },
      ],
    });

    assert.match(output, /# Review Gate — proposal_doc/);
    assert.match(output, /recordedArtifact: artifact-4/);
    assert.match(output, /\[warning\] risk: Missing risk section/);
    assert.match(output, /\[info\] acceptance: Acceptance criteria too vague/);
  });
});
