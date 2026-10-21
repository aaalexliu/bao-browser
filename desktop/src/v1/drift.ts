// Drift report. The runner fills one row per step per change. This file only totals them.

export interface DriftRow {
  workflow: string;
  change: string;
  stepId: string;
  passed: boolean;
  brokenAttr?: string;
  reason?: string;
}

export interface DriftSummary {
  change: string;
  passed: number;
  failed: number;
  rate: number;
}

export interface DriftReport {
  generatedAt: string;
  rows: DriftRow[];
  summary: DriftSummary[];
}

export function driftReport(rows: DriftRow[], generatedAt: string): DriftReport {
  const byChange = new Map<string, { passed: number; failed: number }>();
  for (const row of rows) {
    const bucket = byChange.get(row.change) ?? { passed: 0, failed: 0 };
    if (row.passed) bucket.passed += 1;
    else bucket.failed += 1;
    byChange.set(row.change, bucket);
  }
  const summary = [...byChange.entries()].map(([change, bucket]) => {
    const total = bucket.passed + bucket.failed;
    return { change, passed: bucket.passed, failed: bucket.failed, rate: total ? bucket.passed / total : 0 };
  });
  return { generatedAt, rows, summary };
}

export function driftMarkdown(report: DriftReport): string {
  const lines = [
    `# Drift report`,
    ``,
    `Generated ${report.generatedAt}.`,
    ``,
    `| change | passed | failed | rate |`,
    `| --- | --- | --- | --- |`,
  ];
  for (const row of report.summary) {
    lines.push(`| ${row.change} | ${row.passed} | ${row.failed} | ${(row.rate * 100).toFixed(0)}% |`);
  }
  lines.push(``, `## Failures`, ``, `| workflow | change | step | attribute | reason |`, `| --- | --- | --- | --- | --- |`);
  for (const row of report.rows.filter((item) => !item.passed)) {
    lines.push(`| ${row.workflow} | ${row.change} | ${row.stepId} | ${row.brokenAttr || ""} | ${row.reason || ""} |`);
  }
  if (!report.rows.some((row) => !row.passed)) lines.push(`| | | | | none |`);
  lines.push("");
  return lines.join("\n");
}
