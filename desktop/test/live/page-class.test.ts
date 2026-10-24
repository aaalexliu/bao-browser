// Live page class. Local fixtures mimic each vendor, a modal the tree does not
// list, and the Experian session: member 200, graphql 403, then a client
// navigation to /login/index with no HTTP redirect. Public pages are only
// observed. Nothing here solves or clicks a captcha.

import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { startApp } from "../../src/app/server";
import { getRun, runWorkflow } from "../../src/mcp/catalog";
import { launchOwnedChrome } from "../../src/launch";
import { makeAsk } from "../../src/v1/human-ask";
import { writePendingPrompt } from "../../src/v1/pending-prompt";
import { classifyPage, clickKnownClose, readPageMarkers } from "../../src/v1/page-class";
import { BrowserDriver } from "../../src/v1/browser-driver";
import { replay, type RunResult } from "../../src/v1/replay";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";

process.env.BAO_CHROME_NO_SANDBOX = "1";
process.env.BAO_HEAL_CURSOR_ACCOUNT = "0";
process.env.BAO_HEADED = "0";

const ARTIFACTS = "/opt/cursor/artifacts";
const LINE = "Experian is showing a bot check. Complete the check in the Bao window, then press Continue.";
const LOGIN_LINE = "Sign in in the Bao window, then press Continue.";

function pageOf(title: string, body: string, withApply = true): string {
  const apply = withApply ? `<button id="apply" data-testid="apply">Apply</button>` : "";
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}${apply}</body></html>`;
}

function wall(title: string, body: string): string {
  return pageOf(title, body, false);
}

const PAGES: Record<string, string> = {
  "/recaptcha": wall("Check", `<div class="g-recaptcha" data-sitekey="site"></div><iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe><p>I'm not a robot</p>`),
  "/hcaptcha": wall("Check", `<div class="h-captcha"></div><iframe src="https://newassets.hcaptcha.com/captcha"></iframe>`),
  "/turnstile": wall("Check", `<div class="cf-turnstile"></div><iframe src="https://challenges.cloudflare.com/turnstile"></iframe>`),
  "/cloudflare": wall("Just a moment...", `<div id="cf-challenge"></div><p>Checking your browser before accessing the site</p>`),
  "/akamai": wall("Access Denied", `<div class="akamai"></div><p>Reference #18.6f4a</p>`),
  "/imperva": wall("Request unsuccessful", `<iframe src="/_Incapsula_Resource?SWUDNSAI=1"></iframe><p>Incapsula incident ID: 123</p>`),
  "/perimeterx": wall("Access denied", `<div id="px-captcha"></div><p>Press &amp; Hold</p>`),
  "/datadome": wall("Check", `<div class="datadome"></div><iframe src="https://geo.captcha-delivery.com/captcha"></iframe>`),
  "/human": wall("Human", `<p>Verify you are human</p>`),
  "/ads": pageOf("Tables", `<p>Web Tables</p><iframe src="https://www.google.com/recaptcha/api2/aframe" style="display:none;width:0;height:0" aria-hidden="true"></iframe>`),
  "/newsletter": pageOf("News", `<h2>Sign up for our newsletter</h2><p onclick="this.remove()">No thanks</p>`),
  "/ad": pageOf("Ad", `<div class="modal"><h3>This is an advertisement</h3><p onclick="this.parentElement.remove()">Close</p></div>`),
  "/chat": pageOf("Chat", `<div class="chat"><p>Chat with us</p><p onclick="this.parentElement.remove()">Close</p></div>`),
  "/modal": pageOf("Modal", `<div class="modal" id="modal" style="position:fixed;inset:0;background:#fff;z-index:2"><h3>This is a modal window</h3><p onclick="document.getElementById('modal').remove()">Close</p></div>`),
  "/member": `<!doctype html><html><head><title>Member</title></head><body><p id="account">Account</p><script>
    fetch("/api/router/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .finally(function () { location.replace("/login/index?refUrl=" + encodeURIComponent(location.pathname)); });
  </script></body></html>`,
  "/login/index": pageOf("Sign in", `<h1>Sign in</h1>`),
  "/ready": pageOf("Ready", `<p>Account ready</p>`),
};

function serve(reqPath: string, res: ServerResponse): void {
  if (reqPath === "/api/router/graphql") {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(`{"error":"forbidden"}`);
    return;
  }
  if (reqPath === "/blocked") {
    res.writeHead(403, { "content-type": "text/html", "cf-mitigated": "challenge" });
    res.end(pageOf("Blocked", `<p>blocked</p>`, false));
    return;
  }
  const html = PAGES[reqPath];
  if (!html) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(html);
}

function workflow(startUrl: string, id = "wf"): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name: "Fixture",
    startUrl,
    createdAt: 1,
    inputs: [],
    steps: [{
      id: "apply",
      index: 0,
      action: "click",
      label: "Click Apply",
      surface: "dom",
      timeoutMs: 2000,
      identity: { surface: "dom", role: "button", text: "Apply", testId: "apply", path: [] },
    }],
  };
}

async function play(page: Page, startUrl: string): Promise<{ result: RunResult; proposed: number }> {
  let proposed = 0;
  const driver = new BrowserDriver(page);
  if (startUrl.endsWith("/member")) {
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    await page.waitForURL(/\/login\/index/, { timeout: 8000 });
  } else {
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
  }
  const result = await replay(workflow(startUrl.endsWith("/member") ? startUrl : page.url()), {}, driver, {
    heal: {
      available: () => true,
      propose: async () => {
        proposed += 1;
        return null;
      },
    },
    runId: `run-${Date.now().toString(36)}`,
  });
  return { result, proposed };
}

test("local fixtures classify each wall and dismiss clutter with no heal", { timeout: 120_000 }, async () => {
  const server = createServer((req, res) => serve(new URL(req.url || "/", "http://127.0.0.1").pathname, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const base = `http://127.0.0.1:${port}`;
  const profile = await mkdtemp(path.join(tmpdir(), "bao-class-"));
  const context = await launchOwnedChrome({ userDataDir: profile, headless: true });
  const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-class-lib-")));
  let token = "";
  try {
    const page = context.pages()[0] || await context.newPage();
    const walls = ["/recaptcha", "/hcaptcha", "/turnstile", "/cloudflare", "/akamai", "/imperva", "/perimeterx", "/datadome", "/human", "/blocked"];
    for (const route of walls) {
      const { result, proposed } = await play(page, `${base}${route}`);
      assert.equal(result.status, "paused", `${route} ${result.status} ${result.failure?.reason || ""}`);
      assert.equal(result.pausedKind, "wall", route);
      assert.equal(result.pageClasses.at(-1)?.class, "bot_wall", route);
      assert.equal(result.heals.length, 0, route);
      assert.equal(result.modelCalls, 0, route);
      assert.equal(proposed, 0, route);
      assert.match(result.ask?.instruction || "", /bot check/);
    }
    const expired = await play(page, `${base}/member`);
    assert.equal(expired.result.status, "paused");
    assert.equal(expired.result.pausedKind, "wall");
    assert.equal(expired.result.pageClasses.at(-1)?.class, "login_wall");
    const evidence = expired.result.pageClasses.at(-1)?.evidence.map((item) => item.detail).join("\n") || "";
    assert.match(evidence, /\/login\/index\?refUrl=/);
    assert.match(evidence, /POST \/api\/router\/graphql 403/);
    assert.equal(expired.result.heals.length, 0);
    assert.equal(expired.result.modelCalls, 0);
    assert.equal(expired.proposed, 0);
    assert.match(page.url(), /\/login\/index\?refUrl=/);
    for (const route of ["/modal", "/newsletter", "/ad", "/chat"]) {
      const { result, proposed } = await play(page, `${base}${route}`);
      assert.equal(result.status, "passed", `${route} ${result.failure?.reason || result.steps[0]?.reason || ""}`);
      assert.equal(result.steps[0]?.reason, "recovered: clutter", route);
      assert.equal(result.pageClasses.at(-1)?.class, "clutter", route);
      assert.equal(result.heals.length, 0, route);
      assert.equal(result.modelCalls, 0, route);
      assert.equal(proposed, 0, route);
    }
    const open = await play(page, `${base}/ready`);
    assert.equal(open.result.status, "passed");
    assert.equal(open.proposed, 0);
    assert.equal(open.result.heals.length, 0);
    const ads = await play(page, `${base}/ads`);
    assert.equal(ads.result.status, "passed", `${ads.result.status} ${ads.result.failure?.reason || ads.result.steps[0]?.reason || ""}`);
    assert.notEqual(ads.result.pausedKind, "wall");
    assert.equal((ads.result.pageClasses || []).some((note) => note.class === "bot_wall"), false);

    library.save(workflow(`${base}/imperva`, "imperva"));
    const outcome = await runWorkflow(library, { id: "imperva" });
    token = outcome.resume_token || outcome.resume || "";
    assert.equal(outcome.status, "needs_human", JSON.stringify(outcome));
    assert.match(outcome.reason || "", /bot check/);
    assert.match(outcome.reason || "", /Continue/);
    assert.equal(outcome.pageClass?.class, "bot_wall");
    assert.equal(outcome.pageClass?.vendor, "Imperva");
    assert.ok((outcome.pageClass?.evidence.length || 0) > 0);
    const stored = library.readRun(outcome.run_id || "");
    assert.equal(stored.status, "needs_human");
    assert.equal((stored.heals as unknown[]).length, 0);
    assert.equal(stored.modelCalls, 0);
    const fetched = getRun(library, outcome.run_id || "");
    assert.equal(fetched.status, "needs_human");
    assert.equal(fetched.pageClass?.class, "bot_wall");
    assert.match(fetched.reason || "", /bot check/);
  } finally {
    if (token) await runWorkflow(library, { resume: token, cancel: true }).catch(() => undefined);
    await context.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the-internet modals classify as clutter and a public challenge is reported as it loads", { timeout: 90_000 }, async () => {
  const notes: { site: string; class?: string; vendor?: string; url?: string; detail?: string; error?: string }[] = [];
  const profile = await mkdtemp(path.join(tmpdir(), "bao-public-"));
  const context = await launchOwnedChrome({ userDataDir: profile, headless: true });
  const page = context.pages()[0] || await context.newPage();
  try {
    await page.goto("https://the-internet.herokuapp.com/entry_ad", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(800);
    const entry = classifyPage(await page.evaluate(readPageMarkers));
    assert.equal(entry.class, "clutter", JSON.stringify(entry));
    assert.equal(await page.evaluate(clickKnownClose), true);
    notes.push({ site: "the-internet entry_ad", class: entry.class, detail: entry.reason, url: page.url() });

    await page.goto("https://the-internet.herokuapp.com/exit_intent", { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.mouse.move(400, 300);
    await page.mouse.move(400, 0);
    await page.evaluate(() => {
      document.documentElement.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true, clientY: 0 }));
      document.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, clientY: -1 }));
    });
    await page.waitForTimeout(500);
    const exit = classifyPage(await page.evaluate(readPageMarkers));
    assert.equal(exit.class, "clutter", JSON.stringify(exit));
    assert.equal(await page.evaluate(clickKnownClose), true);
    notes.push({ site: "the-internet exit_intent", class: exit.class, detail: exit.reason, url: page.url() });

    for (const site of ["https://practicesoftwaretesting.com/", "https://usa.experian.com/", "https://nowsecure.nl/"]) {
      try {
        await page.goto(site, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForTimeout(2500);
        const decision = classifyPage(await page.evaluate(readPageMarkers));
        notes.push({ site, class: decision.class, vendor: decision.vendor, detail: decision.reason, url: page.url() });
      } catch (err) {
        notes.push({ site, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    mkdirSync(ARTIFACTS, { recursive: true });
    writeFileSync(path.join(ARTIFACTS, "page-class-live.json"), JSON.stringify(notes, null, 2));
    await context.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
  const challenged = notes.filter((note) => note.class === "bot_wall");
  if (!challenged.length) {
    process.stdout.write(`no public page showed a bot wall from this VM\n${JSON.stringify(notes)}\n`);
  }
});

test("the needs_human run page and act prompt render in light and dark", { timeout: 90_000 }, async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-shot-"));
  const library = new Library(home);
  library.save({
    schema: "bao.workflow/v2",
    version: 2,
    id: "experian",
    name: "Experian",
    startUrl: "https://usa.experian.com/member",
    createdAt: 1,
    inputs: [],
    steps: [{ id: "open", index: 0, action: "click", label: "Open account", surface: "dom", timeoutMs: 2000 }],
  });
  const ask = makeAsk({
    kind: "wall",
    wall: "bot",
    workflowId: "experian",
    workflowName: "Experian",
    stepId: "open",
    stepIndex: 1,
    stepCount: 1,
    label: "Open account",
    site: "usa.experian.com",
    timeoutMs: 0,
    runId: "run-wall",
  });
  assert.equal(ask.instruction, LINE);
  library.saveRun({
    id: "run-wall",
    workflowId: "experian",
    status: "needs_human",
    at: Date.now(),
    heals: [],
    modelCalls: 0,
    steps: [{ id: "open", status: "paused", reason: "bot_wall", label: "Open account" }],
    pageClasses: [{
      stepId: "open",
      at: Date.now(),
      class: "bot_wall",
      reason: "bot check",
      vendor: "Imperva",
      line: LINE,
      evidence: [{ source: "text", detail: "Incapsula incident ID" }],
    }],
    envelope: { status: "needs_human", run_id: "run-wall", step: "open", reason: LINE, ask: LINE, deadline: "No timeout" },
  });
  writePendingPrompt(home, { ask, runId: "run-wall" });
  let server: Awaited<ReturnType<typeof startApp>> | undefined = await startApp({ home, port: 0 });
  const browser: Browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const videoDir = path.join(tmpdir(), "bao-class-video");
  mkdirSync(videoDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  const shotDir = path.join(ARTIFACTS, "screenshots");
  mkdirSync(shotDir, { recursive: true });
  try {
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForSelector("#act-bar");
    await page.click("button[data-screen=runs]");
    await page.click("button[data-open-run=run-wall]");
    await page.waitForSelector("#page-class");
    await page.waitForSelector("#act-continue");
    const lightText = await page.locator("#act-bar .instruction").innerText();
    assert.equal(lightText, LINE);
    assert.match(await page.locator("#page-class").innerText(), /bot check/);
    assert.match(await page.locator("#page-class-calls").innerText(), /0 heals · 0 model calls/);
    const lightCard = await page.locator("#run-envelope").innerText();
    assert.equal(lightCard.split(LINE).length - 1, 1);
    assert.match(lightCard, /waiting on step 1, Open account · no timeout/);
    assert.match(await page.locator("#why-stopped").innerText(), /stopped at an Imperva bot check/);
    await page.screenshot({ path: path.join(shotDir, "needs-human-run-light.png") });
    await page.locator("#act-bar").screenshot({ path: path.join(shotDir, "needs-human-act-light.png") });
    await page.waitForTimeout(900);
    await page.evaluate(() => localStorage.setItem("bao-theme", "dark"));
    await page.reload();
    await page.waitForSelector("#act-bar");
    await page.click("button[data-screen=runs]");
    await page.click("button[data-open-run=run-wall]");
    await page.waitForSelector("#page-class");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
    assert.equal(await page.locator("#act-bar .instruction").innerText(), LINE);
    await page.screenshot({ path: path.join(shotDir, "needs-human-run-dark.png") });
    await page.locator("#act-bar").screenshot({ path: path.join(shotDir, "needs-human-act-dark.png") });
    await page.waitForTimeout(700);
    await page.click("button[data-screen=heals]");
    await page.waitForSelector("[data-page-class=bot_wall]");
    await page.waitForTimeout(900);
    assert.match(await page.locator("[data-page-class=bot_wall]").innerText(), /bot check/);
    assert.match(await page.locator("[data-page-class=bot_wall]").innerText(), /0 heals · 0 model calls/);
    await server.close();
    server = undefined;
    library.saveRun({
      id: "run-login",
      workflowId: "experian",
      status: "needs_human",
      at: Date.now(),
      heals: [],
      modelCalls: 0,
      steps: [{ id: "open", status: "paused", reason: "sign in", label: "Open account" }],
      pageClasses: [{
        stepId: "open",
        at: Date.now(),
        class: "login_wall",
        reason: "session expired",
        line: LOGIN_LINE,
        evidence: [
          { source: "url", detail: "https://usa.experian.com/login/index" },
          { source: "response", detail: "POST /api/router/graphql 403" },
        ],
      }],
      envelope: { status: "needs_human", run_id: "run-login", step: "open", reason: LOGIN_LINE, ask: LOGIN_LINE, deadline: "No timeout" },
    });
    const loginAsk = makeAsk({
      kind: "wall",
      wall: "login",
      workflowId: "experian",
      workflowName: "Experian",
      stepId: "open",
      stepIndex: 1,
      stepCount: 1,
      label: "Open account",
      site: "usa.experian.com",
      timeoutMs: 0,
      runId: "run-login",
    });
    assert.equal(loginAsk.instruction, LOGIN_LINE);
    writePendingPrompt(home, { ask: loginAsk, runId: "run-login" });
    server = await startApp({ home, port: 0 });
    try {
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.evaluate(() => localStorage.setItem("bao-theme", "light"));
      await page.reload();
      await page.waitForSelector("#act-bar");
      await page.click("button[data-screen=runs]");
      await page.click("button[data-open-run=run-login]");
      await page.waitForSelector("#page-class");
      assert.equal(await page.locator("#envelope-ask").innerText(), LOGIN_LINE);
      assert.equal(await page.locator("#act-bar .instruction").innerText(), LOGIN_LINE);
      assert.match(await page.locator("#page-class").innerText(), /sign-in needed/);
      assert.match(await page.locator("#page-class").innerText(), /POST \/api\/router\/graphql 403/);
      await page.screenshot({ path: path.join(shotDir, "needs-human-login-light.png") });
      await page.evaluate(() => localStorage.setItem("bao-theme", "dark"));
      await page.reload();
      await page.waitForSelector("#act-bar");
      await page.click("button[data-screen=runs]");
      await page.click("button[data-open-run=run-login]");
      await page.waitForSelector("#envelope-ask");
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");
      assert.equal(await page.locator("#envelope-ask").innerText(), LOGIN_LINE);
      await page.screenshot({ path: path.join(shotDir, "needs-human-login-dark.png") });
    } finally {
      await server?.close();
      server = undefined;
    }
  } finally {
    const video = page.video();
    await context.close();
    await browser.close();
    if (video) {
      const src = await video.path();
      mkdirSync(ARTIFACTS, { recursive: true });
      const { copyFileSync } = await import("node:fs");
      copyFileSync(src, path.join(ARTIFACTS, "page-class-needs-human.webm"));
    }
    await server?.close();
  }
});
