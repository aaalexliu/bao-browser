// Replay one captured workflow under scripted page changes.
// Reports which attribute would have been the one that broke.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { launchOwnedChrome } from "../../src/launch";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { driftMarkdown, driftReport, type DriftRow } from "../../src/v1/drift";
import { unavailableHeal } from "../../src/v1/heal";
import { replay } from "../../src/v1/replay";
import type { WorkflowV2 } from "../../src/v1/schema";

process.env.BAO_DRIVE = "1";

async function post(port: number, pathname: string, body?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error || res.status));
  return json;
}

test("drift: shift, theme, font, order, slow network, and 2x scale", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-drift-"));
  const note = path.join(home, "note.txt");
  writeFileSync(note, "drift\n");
  const app = await startApp({ home, port: 0 });
  const rows: DriftRow[] = [];
  try {
    await post(app.port, "/api/sessions", { url: `http://127.0.0.1:${app.port}/fixture` });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#username", value: "ada" } });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#password", value: "secret-value" } });
    await post(app.port, "/api/sessions/drive", { click: "#login-btn" });
    await post(app.port, "/api/sessions/drive", { click: "[data-name=Grace]" });
    const saved = await post(app.port, "/api/sessions/stop") as unknown as WorkflowV2;
    const changes: { name: string; query: string; scale?: number; slow?: boolean }[] = [
      { name: "shift", query: "shift=1" },
      { name: "theme", query: "theme=dark" },
      { name: "font", query: "font=big" },
      { name: "order", query: "order=flip" },
      { name: "slow", query: "", slow: true },
      { name: "scale-2x", query: "", scale: 2 },
    ];
    for (const change of changes) {
      const workflow: WorkflowV2 = {
        ...saved,
        startUrl: `http://127.0.0.1:${app.port}/fixture${change.query ? `?${change.query}` : ""}`,
      };
      const profile = mkdtempSync(path.join(tmpdir(), "bao-drift-chrome-"));
      const ctx = await launchOwnedChrome({ userDataDir: profile, headless: true, deviceScaleFactor: change.scale });
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
        for (const step of result.steps) {
          const savedStep = workflow.steps.find((item) => item.id === step.id);
          rows.push({
            workflow: "browser-form",
            change: change.name,
            stepId: step.id,
            label: savedStep?.label,
            passed: step.status === "passed",
            brokenAttr: result.failure?.stepId === step.id ? result.failure.brokenAttr : undefined,
            reason: step.reason,
          });
        }
      } finally {
        await ctx.close();
      }
    }
    const report = driftReport(rows, new Date().toISOString());
    const md = driftMarkdown(report);
    writeFileSync(path.join(home, "drift.json"), JSON.stringify(report, null, 2));
    writeFileSync(path.join(home, "drift.md"), md);
    if (process.env.BAO_DRIFT_OUT) {
      writeFileSync(path.join(process.env.BAO_DRIFT_OUT, "drift.json"), JSON.stringify(report, null, 2));
      writeFileSync(path.join(process.env.BAO_DRIFT_OUT, "drift.md"), md);
    }
    const failed = rows.filter((row) => !row.passed);
    assert.equal(failed.length, 0, JSON.stringify(failed, null, 2));
  } finally {
    await app.close();
  }
});
