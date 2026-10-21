// Drift report. The runner fills one row per step per change. This file only totals them.

export interface DriftRow {
  workflow: string;
  change: string;
  stepId: string;
  passed: boolean;
  brokenAttr?: string;
  reason?: string;
  /** The change cannot be performed. Not counted as a pass or a failure. */
  na?: boolean;
}

export interface DriftSummary {
  change: string;
  passed: number;
  failed: number;
  na: number;
  rate: number;
}

/** Calculator rejects AXSize with -25200. Resize is not a pass. */
export function macChangeApplicability(change: string, bundleId: string): "run" | "na" {
  if (change === "resize" && bundleId === "com.apple.calculator") return "na";
  return "run";
}

export interface DriftReport {
  generatedAt: string;
  rows: DriftRow[];
  summary: DriftSummary[];
}

export function driftReport(rows: DriftRow[], generatedAt: string): DriftReport {
  const byChange = new Map<string, { passed: number; failed: number; na: number }>();
  for (const row of rows) {
    const bucket = byChange.get(row.change) ?? { passed: 0, failed: 0, na: 0 };
    if (row.na) bucket.na += 1;
    else if (row.passed) bucket.passed += 1;
    else bucket.failed += 1;
    byChange.set(row.change, bucket);
  }
  const summary = [...byChange.entries()].map(([change, bucket]) => {
    const total = bucket.passed + bucket.failed;
    return { change, passed: bucket.passed, failed: bucket.failed, na: bucket.na, rate: total ? bucket.passed / total : 0 };
  });
  return { generatedAt, rows, summary };
}

export function driftMarkdown(report: DriftReport): string {
  const lines = [
    `# Drift report`,
    ``,
    `Generated ${report.generatedAt}.`,
    ``,
    `| change | passed | failed | n/a | rate |`,
    `| --- | --- | --- | --- | --- |`,
  ];
  for (const row of report.summary) {
    lines.push(`| ${row.change} | ${row.passed} | ${row.failed} | ${row.na} | ${(row.rate * 100).toFixed(0)}% |`);
  }
  lines.push(``, `## Failures`, ``, `| workflow | change | step | attribute | reason |`, `| --- | --- | --- | --- | --- |`);
  for (const row of report.rows.filter((item) => !item.passed && !item.na)) {
    lines.push(`| ${row.workflow} | ${row.change} | ${row.stepId} | ${row.brokenAttr || ""} | ${row.reason || ""} |`);
  }
  if (!report.rows.some((row) => !row.passed && !row.na)) lines.push(`| | | | | none |`);
  lines.push("");
  return lines.join("\n");
}
