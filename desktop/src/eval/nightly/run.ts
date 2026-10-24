// bao eval nightly. Drift suite, frozen intent batches 2–5, and the scripted
// driver fixtures. Each run writes results.json and one trajectory per case.
// The diff against the last saved run names the case and the step.

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scriptedFixtureTrails } from "../drivers";
import { frozenHeldout } from "../heldout/run";
import { runDriftSuite } from "./drift-suite";
import { diffNightly, formatRegression, type NightlyResults, type SuiteCase } from "./result";

const FROZEN = [
  { name: "batch2", dir: path.join("docs", "eval", "heldout", "batch2") },
  { name: "batch3", dir: path.join("docs", "eval", "heldout", "batch3") },
  { name: "batch4", dir: path.join("docs", "eval", "heldout", "batch4") },
  { name: "batch5", dir: path.join("docs", "eval", "heldout", "batch5") },
];

export async function runNightly(opts: { out: string; baseline: string; saveBaseline: boolean }): Promise<number> {
  const cases: SuiteCase[] = [];
  cases.push(...await runDriftSuite());
  const frozen = await frozenHeldout(FROZEN);
  cases.push(...frozen);
  const drivers = await scriptedFixtureTrails();
  for (const trail of drivers) {
    cases.push({
      caseId: `drivers/scripted/${trail.task}`,
      passed: trail.passed,
      detail: trail.detail,
      steps: trail.steps,
      trajectory: trail.trajectory,
    });
  }
  writeRun(opts.out, cases);
  if (opts.saveBaseline) {
    mkdirSync(path.dirname(opts.baseline), { recursive: true });
    cpSync(opts.out, opts.baseline, { recursive: true });
  }
  const baselineFile = path.join(opts.baseline, "results.json");
  if (!existsSync(baselineFile)) {
    console.log(`No baseline at ${baselineFile}.`);
    return opts.saveBaseline ? 0 : 2;
  }
  if (opts.saveBaseline) {
    console.log(`Saved baseline ${opts.baseline}. ${cases.length} cases.`);
    return 0;
  }
  const regressions = diffNightly(readResults(opts.baseline), readResults(opts.out));
  for (const item of regressions) console.log(formatRegression(item));
  console.log(`${regressions.length} regression${regressions.length === 1 ? "" : "s"} against ${opts.baseline}.`);
  return regressions.length ? 1 : 0;
}

export function writeRun(dir: string, cases: readonly SuiteCase[]): void {
  mkdirSync(dir, { recursive: true });
  const results: NightlyResults = {
    generated: new Date().toISOString(),
    cases: cases.map((item) => ({
      caseId: item.caseId,
      passed: item.passed,
      detail: item.detail,
      steps: item.steps,
    })),
  };
  writeFileSync(path.join(dir, "results.json"), JSON.stringify(results, null, 2));
  for (const item of cases) {
    const file = path.join(dir, "trajectories", `${item.caseId}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ caseId: item.caseId, steps: item.trajectory }, null, 2));
  }
}

export function readResults(dir: string): NightlyResults {
  return JSON.parse(readFileSync(path.join(dir, "results.json"), "utf8")) as NightlyResults;
}
