// Drift report. The runner fills one row per step per change. This file only totals them.

export interface DriftRow {
  workflow: string;
  change: string;
  stepId: string;
  label?: string;
  passed: boolean;
  brokenAttr?: string;
  reason?: string;
  /** Locator kind that hit, when the step stored more than one. */
  locator?: string;
  /** Repair, later locator, or heal that recovered a miss. Empty when the first locator hit. */
  fixedBy?: string;
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

export interface DriftStepRate {
  stepId: string;
  label?: string;
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

export interface WindowStepResult {
  id: string;
  label?: string;
  passed: boolean;
  brokenAttr?: string;
  reason?: string;
}

/**
 * A move that never landed is a harness miss. Replay steps count only after
 * the window bounds match the request.
 */
export function windowChangeRows(opts: {
  workflow: string;
  change: string;
  applied: boolean;
  reason: string;
  steps?: WindowStepResult[];
}): DriftRow[] {
  if (!opts.applied) {
    const reason = opts.reason.startsWith("n/a-harness") ? opts.reason : `n/a-harness: ${opts.reason}`;
    return [{
      workflow: opts.workflow,
      change: opts.change,
      stepId: "window",
      passed: false,
      na: true,
      reason,
    }];
  }
  const rows: DriftRow[] = [{
    workflow: opts.workflow,
    change: opts.change,
    stepId: "window",
    passed: true,
    reason: opts.reason,
  }];
  for (const step of opts.steps ?? []) {
    rows.push({
      workflow: opts.workflow,
      change: opts.change,
      stepId: step.id,
      label: step.label,
      passed: step.passed,
      brokenAttr: step.passed ? undefined : step.brokenAttr,
      reason: step.reason,
    });
  }
  return rows;
}

export interface DriftWorkflowRate {
  workflow: string;
  passed: number;
  failed: number;
  na: number;
  rate: number;
}

export interface DriftReport {
  generatedAt: string;
  rows: DriftRow[];
  summary: DriftSummary[];
  steps: DriftStepRate[];
  workflows: DriftWorkflowRate[];
}

function totals(rows: DriftRow[], key: (row: DriftRow) => string): { key: string; label?: string; passed: number; failed: number; na: number; rate: number }[] {
  const buckets = new Map<string, { passed: number; failed: number; na: number; label?: string }>();
  for (const row of rows) {
    const bucket = buckets.get(key(row)) ?? { passed: 0, failed: 0, na: 0 };
    if (row.label) bucket.label = row.label;
    if (row.na) bucket.na += 1;
    else if (row.passed) bucket.passed += 1;
    else bucket.failed += 1;
    buckets.set(key(row), bucket);
  }
  return [...buckets.entries()].map(([name, bucket]) => {
    const total = bucket.passed + bucket.failed;
    return { key: name, label: bucket.label, passed: bucket.passed, failed: bucket.failed, na: bucket.na, rate: total ? bucket.passed / total : 0 };
  });
}

export function driftReport(rows: DriftRow[], generatedAt: string): DriftReport {
  const summary = totals(rows, (row) => row.change).map((row) => ({
    change: row.key,
    passed: row.passed,
    failed: row.failed,
    na: row.na,
    rate: row.rate,
  }));
  const steps = totals(rows, (row) => row.stepId).map((row) => ({
    stepId: row.key,
    label: row.label,
    passed: row.passed,
    failed: row.failed,
    na: row.na,
    rate: row.rate,
  }));
  const workflows = totals(rows, (row) => row.workflow).map((row) => ({
    workflow: row.key,
    passed: row.passed,
    failed: row.failed,
    na: row.na,
    rate: row.rate,
  }));
  return { generatedAt, rows, summary, steps, workflows };
}

export function recoveryRows(input: {
  workflow: string;
  change: string;
  steps: { id: string; label?: string; passed: boolean; reason?: string; brokenAttr?: string }[];
  locatorHits?: { stepId: string; kind: string; detail?: string }[];
  repairs?: { stepId: string; repair: string; detail?: string }[];
  healedStepIds?: string[];
  firstLocator?: Record<string, string | undefined>;
}): DriftRow[] {
  return input.steps.map((step) => {
    const hit = (input.locatorHits ?? []).filter((item) => item.stepId === step.id).at(-1);
    const repairs = (input.repairs ?? []).filter((item) => item.stepId === step.id);
    const healed = (input.healedStepIds ?? []).includes(step.id);
    const first = input.firstLocator?.[step.id];
    let fixedBy: string | undefined;
    let brokenAttr = step.brokenAttr;
    if (!step.passed) {
      fixedBy = "none";
      brokenAttr = brokenAttr || first;
    } else if (healed) {
      fixedBy = "heal";
      brokenAttr = brokenAttr || first || "identity";
    } else if (repairs.length) {
      fixedBy = repairs.map((item) => item.repair).join("+");
      const expectWait = repairs.some((item) => (item.detail || "").includes("expect"));
      brokenAttr = expectWait ? "expect" : (brokenAttr || first || "identity");
    } else if (hit && first && hit.kind !== first) {
      fixedBy = `locator:${hit.kind}`;
      brokenAttr = first;
    }
    const reason = step.reason || repairs.map((item) => item.detail).filter(Boolean).join("; ") || hit?.detail;
    return {
      workflow: input.workflow,
      change: input.change,
      stepId: step.id,
      label: step.label,
      passed: step.passed,
      brokenAttr: fixedBy || !step.passed ? brokenAttr : undefined,
      fixedBy,
      locator: hit?.kind,
      reason,
    };
  });
}

export function driftMarkdown(report: DriftReport): string {
  const lines = [
    `# Drift report`,
    ``,
    `Generated ${report.generatedAt}. Rates exclude n/a rows. Each failure lists the attribute that broke.`,
    ``,
    `| change | passed | failed | n/a | rate |`,
    `| --- | --- | --- | --- | --- |`,
  ];
  for (const row of report.summary) {
    lines.push(`| ${row.change} | ${row.passed} | ${row.failed} | ${row.na} | ${(row.rate * 100).toFixed(0)}% |`);
  }
  lines.push(``, `## Steps`, ``, `| step | label | passed | failed | n/a | rate |`, `| --- | --- | --- | --- | --- | --- |`);
  for (const row of report.steps) {
    lines.push(`| ${row.stepId} | ${row.label || ""} | ${row.passed} | ${row.failed} | ${row.na} | ${(row.rate * 100).toFixed(0)}% |`);
  }
  lines.push(``, `## Workflows`, ``, `| workflow | passed | failed | n/a | rate |`, `| --- | --- | --- | --- | --- |`);
  for (const row of report.workflows) {
    lines.push(`| ${row.workflow} | ${row.passed} | ${row.failed} | ${row.na} | ${(row.rate * 100).toFixed(0)}% |`);
  }
  lines.push(``, `## Failures`, ``, `| workflow | change | step | attribute | fixed by | reason |`, `| --- | --- | --- | --- | --- | --- |`);
  const failed = report.rows.filter((item) => !item.passed && !item.na);
  for (const row of failed) {
    lines.push(`| ${row.workflow} | ${row.change} | ${row.stepId} | ${row.brokenAttr || ""} | ${row.fixedBy || "none"} | ${row.reason || ""} |`);
  }
  if (!failed.length) lines.push(`| | | | | | none |`);
  const recovered = report.rows.filter((item) => item.passed && item.fixedBy);
  if (recovered.length) {
    lines.push(``, `## Recovered`, ``, `The first locator missed. A later locator, a repair, or a heal made the step pass.`, ``, `| workflow | change | step | attribute | fixed by | reason |`, `| --- | --- | --- | --- | --- | --- |`);
    for (const row of recovered) {
      lines.push(`| ${row.workflow} | ${row.change} | ${row.stepId} | ${row.brokenAttr || ""} | ${row.fixedBy || ""} | ${row.reason || ""} |`);
    }
  }
  const harness = report.rows.filter((row) => row.na && (row.reason || "").includes("n/a-harness"));
  if (harness.length) {
    lines.push(``, `## Harness`, ``, `These rows are n/a. The window never reached the requested bounds, so the replay steps were not scored.`, ``, `| workflow | change | reason |`, `| --- | --- | --- |`);
    for (const row of harness) lines.push(`| ${row.workflow} | ${row.change} | ${row.reason || ""} |`);
  }
  lines.push("");
  return lines.join("\n");
}
