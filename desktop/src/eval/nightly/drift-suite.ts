// The fixture drift suite: one captured form, six scripted page changes.
// Step ids are the step index and label, so a later run can diff them.
// The live capture's workflow id changes every run and is not the diff key.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startApp } from "../../app/server";
import { launchOwnedChrome } from "../../launch";
import { BrowserDriver } from "../../v1/browser-driver";
import { unavailableHeal } from "../../v1/heal";
import { replay } from "../../v1/replay";
import type { WorkflowV2 } from "../../v1/schema";
import type { SuiteCase } from "./result";

const CHANGES: { name: string; query: string; scale?: number; slow?: boolean }[] = [
  { name: "shift", query: "shift=1" },
  { name: "theme", query: "theme=dark" },
  { name: "font", query: "font=big" },
  { name: "order", query: "order=flip" },
  { name: "slow", query: "", slow: true },
  { name: "scale-2x", query: "", scale: 2 },
];

export async function runDriftSuite(): Promise<SuiteCase[]> {
  process.env.BAO_DRIVE = "1";
  const home = mkdtempSync(path.join(tmpdir(), "bao-nightly-drift-"));
  writeFileSync(path.join(home, "note.txt"), "drift\n");
  const app = await startApp({ home, port: 0 });
  const cases: SuiteCase[] = [];
  try {
    await post(app.port, "/api/sessions", { url: `http://127.0.0.1:${app.port}/fixture` });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#username", value: "ada" } });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#password", value: "secret-value" } });
    await post(app.port, "/api/sessions/drive", { click: "#login-btn" });
    await post(app.port, "/api/sessions/drive", { click: "[data-name=Grace]" });
    const saved = await post(app.port, "/api/sessions/stop") as unknown as WorkflowV2;
    for (const change of CHANGES) {
      cases.push(await replayChange(app.port, saved, change));
    }
  } finally {
    await app.close();
  }
  return cases;
}

async function replayChange(
  port: number,
  saved: WorkflowV2,
  change: { name: string; query: string; scale?: number; slow?: boolean },
): Promise<SuiteCase> {
  const caseId = `drift/browser-form/${change.name}`;
  const workflow: WorkflowV2 = {
    ...saved,
    startUrl: `http://127.0.0.1:${port}/fixture${change.query ? `?${change.query}` : ""}`,
  };
  const profile = mkdtempSync(path.join(tmpdir(), "bao-nightly-drift-chrome-"));
  const ctx = await launchOwnedChrome({
    userDataDir: profile,
    headless: true,
    deviceScaleFactor: change.scale,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    if (change.slow) {
      await page.route("**/*", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 250));
        await route.continue();
      });
    }
    await page.goto(workflow.startUrl);
    const args: Record<string, string> = {};
    for (const input of saved.inputs) {
      if (input.type === "secret") args[input.name] = "secret-value";
      else if (input.default) args[input.name] = input.default;
      else args[input.name] = "ada";
    }
    const result = await replay(workflow, args, new BrowserDriver(page), { heal: unavailableHeal(), settings: { heal: "approve" } });
    const steps = result.steps.map((step, index) => {
      const savedStep = workflow.steps.find((item) => item.id === step.id);
      return {
        stepId: `${index}:${savedStep?.label || step.id}`,
        passed: step.status === "passed",
        detail: step.reason || "",
      };
    });
    const failed = steps.filter((step) => !step.passed);
    const item: SuiteCase = {
      caseId,
      passed: failed.length === 0 && result.status === "passed",
      detail: failed.length ? failed.map((step) => step.detail || step.stepId).join("; ") : "pass",
      steps,
      trajectory: result.trajectory,
    };
    console.log(`${caseId} ${item.passed ? "pass" : item.detail}`);
    return item;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.log(`${caseId} ${detail}`);
    return {
      caseId,
      passed: false,
      detail,
      steps: [{ stepId: "replay", passed: false, detail }],
      trajectory: [],
    };
  } finally {
    await ctx.close();
  }
}

async function post(port: number, pathname: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(`${pathname} ${json.error || res.status}`);
  return json;
}
