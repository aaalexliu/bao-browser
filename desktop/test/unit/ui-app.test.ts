// Headless window. Fixture page only. No vendor network and no real profile.

import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { startApp } from "../../src/app/server";
import type { Identity, WorkflowV2 } from "../../src/v1/schema";
import { applyHermeticApp } from "../runtime";

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function workflow(port: number, id: string, name: string, start: string, steps: WorkflowV2["steps"]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name,
    startUrl: `http://127.0.0.1:${port}${start}`,
    inputs: [],
    createdAt: 1,
    steps,
  };
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
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    const confirmWf = workflow(app.port, "wf-confirm", "fixture apply", "/fixture", [
      {
        id: "login",
        index: 0,
        action: "login",
        human: true,
        label: "sign in",
        surface: "dom",
        timeoutMs: 15000,
        postcondition: { kind: "text", match: "Welcome", timeoutMs: 15000 },
      },
      {
        id: "apply",
        index: 1,
        action: "confirm",
        human: true,
        label: 'you press "Apply"',
        surface: "dom",
        identity: ident({ name: "Apply", text: "Apply" }),
        timeoutMs: 15000,
        postcondition: { kind: "text", match: "Applied", timeoutMs: 15000 },
      },
    ]);
    app.library.save(confirmWf);
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.waitForSelector("button[data-screen=library]");
    const rail = await page.locator("#rail").innerText();
    assert.match(rail, /Library/);
    assert.match(rail, /Capture/);
    assert.match(rail, /Runs/);
    assert.match(rail, /Heals/);
    assert.match(rail, /Settings/);
    assert.equal(await page.locator("#rail button[data-screen=trail]").count(), 0);
    assert.match(rail, /helper off|helper ok|helper needs permission/);
    assert.match(rail, /no model|fixture model|model ready|cursor account/);

    // Open the replay window first, so the one-second bound below times the act bar, not a cold Chrome start.
    app.library.save(workflow(app.port, "wf-open", "fixture open", "/fixture", []));
    await post(app.port, "/api/replay", { id: "wf-open", args: {} });

    const started = Date.now();
    const pending = post(app.port, "/api/replay", { id: confirmWf.id, args: {} });
    await page.waitForSelector("#act-bar[data-ask=login]", { timeout: 1000 });
    assert.ok(Date.now() - started < 1000, "login bar was late");
    assert.equal((await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json()).replaying, true);
    const loginBar = await page.locator("#act-bar").innerText();
    assert.match(loginBar, /Sign in to the fixture in the Bao window/);
    assert.match(await page.locator("#attention").getAttribute("data-count") || "", /[1-9]/);
    assert.ok(app.notifications.some((item) => item.title.includes("Sign in to the fixture in the Bao window") && item.title === item.body && item.title === item.tooltip));

    const pressedLogin = Date.now();
    await post(app.port, "/api/replay/press", { fill: { selector: "#username", value: "ada" } });
    await post(app.port, "/api/replay/press", { fill: { selector: "#password", value: "not-a-real-password" } });
    await post(app.port, "/api/replay/press", { name: "Log in" });
    await page.waitForSelector("#act-bar[data-ask=confirm]", { timeout: 2000 });
    assert.ok(Date.now() - pressedLogin < 2000);
    const confirmBar = await page.locator("#act-bar").innerText();
    assert.match(confirmBar, /Press Apply on the fixture in the Bao window/);
    assert.match(confirmBar, /nothing applied/);
    assert.equal(await page.locator("#act-bar button", { hasText: "Approve" }).count(), 0);
    assert.equal(await page.locator("#act-continue").count(), 0);
    assert.ok(app.notifications.some((item) => item.body.includes("Press Apply")));

    await post(app.port, "/api/replay/press", { name: "Apply" });
    const confirmRun = await pending as { runId: string; status: string; modelCalls: number; failure?: { reason: string } };
    assert.equal(confirmRun.status, "passed", JSON.stringify(confirmRun.failure));
    assert.equal(confirmRun.modelCalls, 0);
    assert.equal((await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json()).replaying, false);
    await page.click("button[data-screen=runs]");
    await page.click(`[data-open-run="${confirmRun.runId}"]`);
    await page.waitForSelector("#model-calls");
    assert.match(await page.locator("#model-calls").innerText(), /0 model calls/);

    const drift = workflow(app.port, "wf-drift", "upload note", "/fixture?drift=1", [
      {
        id: "upload",
        index: 0,
        action: "click",
        label: "click Upload",
        intent: "Send the file",
        surface: "dom",
        identity: ident({ name: "Upload", id: "file-submit" }),
        timeoutMs: 1000,
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
    assert.equal(failed.failure?.identity?.candidates?.[0]?.score, 80);
    assert.equal(failed.failure?.identity?.candidates?.[1]?.score, 70);
    assert.match(failed.failure?.identity?.changed || "", /Upload file/);
    await page.click("button[data-screen=runs]");
    await page.click(`[data-open-run="${failed.runId}"]`);
    await page.waitForSelector("#why-stopped");
    const why = await page.locator("#why-stopped").innerText();
    assert.match(why, /Step 1 "click Upload"/);
    assert.match(why, /scored 80 and 70/);
    assert.match(why, /lead 10 < 25/);
    assert.match(why, /name "Upload" → "Upload file"/);
    assert.equal(await page.locator("#step-bar .seg").count(), 1);
    const table = await page.locator("#identity-table").innerText();
    assert.match(table, /80/);
    assert.match(table, /70/);

    process.env.BAO_HEAL_FIXTURE = "1";
    app.library.save(workflow(app.port, "wf-text", "textedit write", "/fixture", [
      {
        id: "write",
        index: 0,
        action: "click",
        label: "Click write",
        surface: "dom",
        identity: ident({ name: "Write" }),
        timeoutMs: 500,
      },
    ]));
    const healWf = workflow(app.port, "wf-heal", "fixture login", "/fixture", [
      {
        id: "login",
        index: 0,
        action: "click",
        label: "Click login",
        intent: "the missing control",
        surface: "dom",
        identity: ident({ testId: "missing-login" }),
        timeoutMs: 500,
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
    await page.click("button[data-screen=heals]");
    await page.waitForSelector("[data-heal]");
    const inbox = await page.locator("#heal-inbox").innerText();
    assert.match(inbox, /fixture login/);
    assert.equal(inbox.includes("textedit write"), false);
    await page.click("[data-heal]");
    await page.waitForSelector("article#heal-detail");
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
    assert.equal(kept.steps[0]?.identity?.testId, "missing-login");
    assert.equal(JSON.stringify(app.library.readRun(healed.runId).heals), before);
    assert.equal(app.library.readRun(healed.runId).decisions?.[0]?.decision, "keep");
    await page.waitForSelector("[data-revert]");
    await page.click("[data-revert]");
    await page.waitForFunction(() => document.body.innerText.includes("Patch reverted"));
    const reverted = app.library.read("wf-heal");
    assert.equal(reverted.steps[0]?.identity?.testId, "missing-login");
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
