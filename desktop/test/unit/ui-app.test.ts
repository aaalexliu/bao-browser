import { testWorkflow } from "../support/workflow";
import { stepTarget, locatorValue, type WorkflowV2 } from "../../src/v1/schema";
// Headless window. Fixture page only. No vendor network and no real profile.

import assert from "node:assert/strict";
import test from "node:test";
import { testChromium as chromium } from "../../src/test-browser.js";
import { startApp } from "../../src/app/server";
import { applyHermeticApp } from "../runtime";

function workflow(port: number, id: string, name: string, start: string, steps: WorkflowV2["steps"]): WorkflowV2 {
  return testWorkflow({
    schema: "bao.workflow/v4",
    id,
    name,
    startUrl: `http://127.0.0.1:${port}${start}`,
    inputs: [],
    createdAt: 1,
    steps,
  });
}

async function post(port: number, pathname: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as { error?: string } : {};
  if (!res.ok) throw new Error(`${pathname} ${res.status} ${json.error || text}`);
  return json;
}

test("act bar, run viewer, and heal review in the window", { timeout: 180000 }, async () => {
  process.env.BAO_DRIVE = "1";
  delete process.env.BAO_HEAL_FIXTURE;
  const previousChrome = process.env.BAO_CHROME_USER_DATA;
  const previousHome = process.env.BAO_HOME;
  const previousHeaded = process.env.BAO_HEADED;
  const previousBrowser = process.env.BAO_BROWSER;
  const dirs = applyHermeticApp("ui-app");
  const app = await startApp({ home: dirs.home, port: 0 });
  const browser = await chromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    const confirmWf = workflow(app.port, "wf-confirm", "fixture apply", "/fixture", [
      {
        id: "login",
        index: 0,
        timeoutMs: 15000,
        caption: { text: "sign in" },
        action: "handoff",
        reason: "sign-in",
        check: { kind: "text", match: "Welcome", timeoutMs: 15000 },
      },
      {
        id: "apply",
        index: 1,
        timeoutMs: 15000,
        caption: { text: "you press \"Apply\"" },
        action: "handoff",
        reason: "owner-press",
        target: {
          locators: [{ kind: "role", role: "button", name: "Apply" }, { kind: "text", value: "Apply" }],
          hint: { role: "button", surface: "dom" },
        },
        check: { kind: "text", match: "Applied", timeoutMs: 15000 },
      },
    ]);
    app.library.save(confirmWf);
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.waitForSelector("#rail button[data-place=workflows]");
    const rail = await page.locator("#rail").innerText();
    assert.match(rail, /Workflows/);
    assert.match(rail, /Runs/);
    assert.match(rail, /Settings/);
    await page.click("#rail button[data-place=workflows]");
    await page.getByRole("heading", { name: "Workflows", exact: true }).waitFor();
    assert.equal(await page.locator("#screen-list").isHidden(), true);
    assert.equal(await page.getByRole("button", { name: "Record", exact: true }).isVisible(), true);
    assert.equal(await page.locator("#rail button[data-screen=trail]").count(), 0);
    await page.click("#rail button[data-place=settings]");
    await page.locator("#settings-advanced > summary").click();
    await page.locator("#settings-helper").waitFor();
    await page.waitForFunction(() => Boolean(document.getElementById("settings-helper")?.innerText.trim()));
    assert.match(await page.locator("#settings-helper").innerText(), /^(?:Mac helper (?:un)?available|The Mac helper is only available on macOS)\./);
    assert.match(await page.getByRole("combobox", { name: "Use AI to suggest heals" }).inputValue(), /^(none|cursor-account|api-key)$/);
    await page.click("#rail button[data-place=workflows]");

    // Open the replay window before exercising the handoffs.
    app.library.save(workflow(app.port, "wf-open", "fixture open", "/fixture", []));
    await post(app.port, "/api/replay", { id: "wf-open", args: {} });

    await page.locator(`[data-open-workflow="${confirmWf.id}"]`).click();
    await page.locator(`#main [data-screen=replay][data-workflow="${confirmWf.id}"]`).click();
    await page.waitForSelector("#run");
    const waitForAsk = (kind: "login" | "confirm") => page.waitForResponse(async (response) => {
      if (response.url() !== `http://127.0.0.1:${app.port}/api/state`) return false;
      const state = await response.json() as { activeAsk?: { kind: string; workflowId: string } };
      return state.activeAsk?.kind === kind && state.activeAsk.workflowId === confirmWf.id;
    });
    const [confirmRun] = await Promise.all([
      page.waitForResponse((response) =>
        response.url() === `http://127.0.0.1:${app.port}/api/replay` && response.request().method() === "POST",
      ).then(async (response) => {
        const run = await response.json() as { runId: string; status: string; modelCalls: number; failure?: { reason: string } };
        assert.ok(response.ok(), JSON.stringify(run));
        return run;
      }),
      (async () => {
        await Promise.all([waitForAsk("login"), page.click("#run")]);
        // Time rendering after the handoff arrives, not navigation, pictures, or browser startup.
        const loginRenderStarted = Date.now();
        await page.waitForSelector("#act-bar[data-ask=login]", { timeout: 1000 });
        assert.ok(Date.now() - loginRenderStarted < 1000, "login bar was late");
        assert.equal((await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json()).replaying, true);
        const loginBar = await page.locator("#act-bar").innerText();
        assert.match(loginBar, /Sign in to the fixture in the Bao window/);
        assert.match(await page.locator("#attention").getAttribute("data-count") || "", /[1-9]/);
        assert.ok(app.notifications.some((item) => item.title.includes("Sign in to the fixture in the Bao window") && item.title === item.body && item.title === item.tooltip));

        await Promise.all([
          waitForAsk("confirm"),
          (async () => {
            await post(app.port, "/api/replay/press", { fill: { selector: "#username", value: "ada" } });
            await post(app.port, "/api/replay/press", { fill: { selector: "#password", value: "not-a-real-password" } });
            await post(app.port, "/api/replay/press", { name: "Log in" });
          })(),
        ]);
        const confirmRenderStarted = Date.now();
        await page.waitForSelector("#act-bar[data-ask=confirm]", { timeout: 2000 });
        assert.ok(Date.now() - confirmRenderStarted < 2000, "confirm bar was late");
        const confirmBar = await page.locator("#act-bar").innerText();
        assert.match(confirmBar, /Press Apply on the fixture in the Bao window/);
        assert.match(confirmBar, /nothing applied/);
        assert.equal(await page.locator("#act-bar button", { hasText: "Approve" }).count(), 0);
        assert.equal(await page.locator("#act-continue").count(), 0);
        assert.ok(app.notifications.some((item) => item.body.includes("Press Apply")));

        await post(app.port, "/api/replay/press", { name: "Apply" });
      })(),
    ]);
    assert.equal(confirmRun.status, "passed", JSON.stringify(confirmRun.failure));
    assert.equal(confirmRun.modelCalls, 0);
    assert.equal((await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json()).replaying, false);
    await page.click("#rail button[data-place=runs]");
    await page.click(`[data-open-run="${confirmRun.runId}"]`);
    await page.getByText("Detailed evidence", { exact: true }).click();
    await page.waitForSelector("#model-calls");
    assert.match(await page.locator("#model-calls").innerText(), /0 model calls/);

    const drift = workflow(app.port, "wf-drift", "upload note", "/fixture?drift=1", [
      {
        id: "upload",
        index: 0,
        timeoutMs: 1000,
        caption: { text: "click Upload", citation: { text: "Upload", source: "name" } },
        action: "click",
        target: { locators: [{ kind: "role", role: "button", name: "Upload" }], hint: { role: "button", surface: "dom" } },
      },
    ]);
    app.library.save(drift);
    const failed = await post(app.port, "/api/replay", { id: drift.id, args: {} }) as {
      runId: string;
      status: string;
      failure?: { reason?: string; identity?: { changed?: string; candidates?: { score: number }[] } };
    };
    assert.equal(failed.status, "failed", JSON.stringify(failed.failure));
    assert.equal(failed.failure?.reason, "tie");
    const scores = (failed.failure?.identity?.candidates ?? []).map((row) => row.score);
    assert.equal(scores[0], scores[1]);
    assert.ok((scores[0] ?? 0) > 0);
    await page.click("#rail button[data-place=runs]");
    await page.click(`[data-open-run="${failed.runId}"]`);
    await page.getByText("Detailed evidence", { exact: true }).click();
    await page.waitForSelector("#why-stopped");
    const why = await page.locator("#why-stopped").innerText();
    assert.match(why, /Step 1, click "Upload":/);
    assert.match(why, new RegExp(`scored ${scores[0]} and ${scores[1]}`));
    assert.match(why, /lead 0 < 25/);
    assert.equal(await page.locator("#step-bar .seg").count(), 1);
    const table = await page.locator("#identity-table").innerText();
    assert.match(table, new RegExp(String(scores[0])));

    process.env.BAO_HEAL_FIXTURE = "1";
    app.library.save(workflow(app.port, "wf-text", "textedit write", "/fixture", [
      {
        id: "write",
        index: 0,
        timeoutMs: 500,
        caption: { text: "Click write", citation: { text: "Write", source: "name" } },
        action: "click",
        target: {
          locators: [{ kind: "role", role: "button", name: "Write" }, { kind: "text", value: "Write" }],
          hint: { role: "button", surface: "dom" },
        },
      },
    ]));
    const healWf = workflow(app.port, "wf-heal", "fixture login", "/fixture", [
      {
        id: "login",
        index: 0,
        timeoutMs: 500,
        caption: { text: "Click login" },
        action: "click",
        target: {
          locators: [{ kind: "testid", value: "missing-login" }, { kind: "css", value: "[data-testid=\"missing-login\"]" }],
          hint: { role: "button", surface: "dom" },
        },
      },
    ]);
    app.library.save(healWf);
    const healed = await post(app.port, "/api/replay", { id: healWf.id, args: {} }) as {
      runId: string;
      status: string;
      heals?: { id: string; prompt?: string }[];
    };
    assert.equal(healed.status, "passed", JSON.stringify(healed));
    const before = JSON.stringify(app.library.readRun(healed.runId).heals);
    await page.click("#rail button[data-place=runs]");
    await page.locator(`#screen-list [data-heal="${healed.heals![0]!.id}"][data-run="${healed.runId}"]`).waitFor();
    assert.match(await page.locator("#screen-list").innerText(), /Heal to keep/);
    await page.keyboard.press("Meta+k");
    await page.locator("#palette-input").fill("Heals");
    await page.locator('#palette-list [data-command="heals"]').click();
    await page.waitForSelector("[data-heal]");
    const inbox = await page.locator("#heal-inbox").innerText();
    assert.match(inbox, /fixture login/);
    assert.equal(inbox.includes("textedit write"), false);
    await page.click("[data-heal]");
    await page.waitForSelector("article#heal-detail");
    await page.locator(".heal-technical > summary").click();
    const detail = await page.locator("#heal-detail").innerText();
    assert.match(detail, /fixture login/);
    assert.equal(detail.includes("textedit write"), false);
    assert.match(detail, /Recorded/);
    assert.match(detail, /Proposed/);
    assert.match(detail, /missing-login|login/);
    assert.equal(await page.locator("#heal-prompt").evaluate((el) => (el as HTMLDetailsElement).open), false);
    await page.click("article#heal-detail [data-keep]");
    await page.waitForFunction(() => document.body.innerText.includes("Patch kept"));
    const kept = app.library.read("wf-heal");
    assert.equal(locatorValue(stepTarget(kept.steps[0]), "testid"), "missing-login");
    assert.equal(JSON.stringify(app.library.readRun(healed.runId).heals), before);
    assert.equal(app.library.readRun(healed.runId).decisions?.[0]?.decision, "keep");
    await page.waitForSelector("[data-revert]");
    await page.click("[data-revert]");
    await page.locator('#heal-revert-confirm [value="revert"]').click();
    await page.waitForFunction(() => document.body.innerText.includes("Patch reverted"));
    const reverted = app.library.read("wf-heal");
    assert.equal(locatorValue(stepTarget(reverted.steps[0]), "testid"), "missing-login");
    const runAfter = app.library.readRun(healed.runId);
    assert.equal(JSON.stringify(runAfter.heals), before);
    assert.deepEqual(runAfter.decisions?.map((item) => item.decision), ["keep", "revert"]);

    const imported = await post(app.port, "/api/import-login", { from: "chrome", domain: "example.com" }) as { id: string; phase: string };
    assert.equal(imported.phase, "confirm");
    await page.waitForSelector("#import-confirm");
    assert.match(await page.locator("#act-bar").innerText(), /example\.com/);
    await post(app.port, "/api/import-login/answer", { id: imported.id, accept: true });
    await page.waitForSelector("#import-error");
    const err = await page.locator("#import-error").innerText();
    assert.match(err, /not_macos|import_failed|no_profiles/);
    assert.equal(err.includes("could not import"), false);
    const code = await page.locator("#import-error").getAttribute("data-error-code");
    assert.ok(code && code !== "could not import");
  } finally {
    if (previousChrome === undefined) delete process.env.BAO_CHROME_USER_DATA;
    else process.env.BAO_CHROME_USER_DATA = previousChrome;
    if (previousHome === undefined) delete process.env.BAO_HOME;
    else process.env.BAO_HOME = previousHome;
    if (previousHeaded === undefined) delete process.env.BAO_HEADED;
    else process.env.BAO_HEADED = previousHeaded;
    if (previousBrowser === undefined) delete process.env.BAO_BROWSER;
    else process.env.BAO_BROWSER = previousBrowser;
    delete process.env.BAO_HEAL_FIXTURE;
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await app.close();
  }
});
