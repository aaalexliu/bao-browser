import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import type { ShellState } from "../../src/app/views";
import { testChromium } from "../../src/test-browser";
import { makeAsk } from "../../src/v1/human-ask";
import { writePendingPrompt } from "../../src/v1/pending-prompt";
import type { WorkflowV2 } from "../../src/v1/schema";
import { applyHermeticApp } from "../runtime";

function workflow(id: string, name: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2", version: 2, id, name, createdAt: 1, startUrl: "/fixture", inputs: [],
    steps: [{ id: "open", index: 0, label: "Open", action: "click", surface: "dom", identity: { surface: "dom", role: "button", name: "Open", path: [] }, timeoutMs: 1000 }],
  };
}

test("Now lists only the server active run, so an old hold and a guide stay out", { timeout: 30_000 }, async () => {
  const previousHome = process.env.HOME;
  const dirs = applyHermeticApp("runs-now");
  process.env.HOME = dirs.home;
  const app = await startApp({ home: dirs.home, port: 0, extensionHost: false, chromeUserData: dirs.chromeUserData, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const clock = new Date(2026, 10, 6, 12);
  const now = +clock;
  const yesterday = new Date(clock);
  yesterday.setDate(yesterday.getDate() - 1);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    app.library.save(workflow("wf-old", "Pay the electricity bill"));
    app.library.save(workflow("wf-live", "Book a class"));
    app.library.save(workflow("wf-guide", "File the permit"));
    app.library.saveRun({
      id: "run-old", workflowId: "wf-old", status: "paused", at: +yesterday, steps: [], heals: [],
      envelope: { status: "needs_human", ask: "Press Pay in the Bao window." },
    });
    app.library.saveRun({
      id: "run-live", workflowId: "wf-live", status: "paused", at: now, steps: [], heals: [],
      envelope: { status: "needs_human", ask: "Press Reserve in the Bao window." },
    });
    app.library.saveRun({
      id: "guide-permit", workflowId: "wf-guide", status: "paused", at: now - 1000, steps: [], heals: [],
      envelope: { status: "needs_human", ask: "Follow the highlighted control." },
    });
    writePendingPrompt(dirs.home, {
      runId: "run-live",
      ask: makeAsk({
        kind: "confirm", workflowId: "wf-live", workflowName: "Book a class", stepId: "reserve",
        stepIndex: 1, stepCount: 2, label: "Press Reserve", button: "Reserve", site: "example.test",
        timeoutMs: 7_200_000, now: Date.now(), runId: "run-live",
      }),
    });
    await page.clock.setFixedTime(clock);
    await page.goto(base);
    await page.locator("#runs").waitFor();
    const state = await (await fetch(`${base}/api/state`)).json() as ShellState;
    assert.equal(state.activeRun?.id, "run-live");
    assert.equal(state.activeRun?.phase, "waiting");
    assert.equal(state.guide, null);
    assert.deepEqual(await page.locator('#runs section[aria-label="Now"] [data-open-run]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-open-run"))), ["run-live"]);
    assert.equal(await page.locator('#runs ul[aria-label="Needs you"] [data-open-run="run-live"]').count(), 1);
    assert.equal(await page.locator('#runs ul[aria-label="Needs you"] [data-open-run="run-old"]').count(), 1);
    assert.equal(await page.locator('#runs section[aria-label="Now"] [data-open-run="run-old"]').count(), 0);
    assert.equal(await page.locator('#runs section[aria-label="Yesterday"] [data-open-run="run-old"]').count(), 1);
    assert.equal(await page.locator('#runs section[aria-label="Now"] [data-open-run="guide-permit"]').count(), 0);
    assert.equal(await page.locator('#runs section[aria-label="Today"] [data-open-run="guide-permit"]').count(), 1);
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});
