import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it, test } from "node:test";
import { startApp, type App } from "../../src/app/server";
import { runViewer } from "../../src/app/views";
import { liveCliBody } from "../../src/mcp/live-proxy";
import { navigationGuard, stopPathHit } from "../../src/cdp-live/allowlist";
import { LiveNavigationHalt, openLiveWindow } from "../../src/cdp-live/driver";
import { buildView, pageHalt, planClick, planKey, readLivePage, type PageFacts } from "../../src/cdp-live/live-ops";
import { signedOutSurface } from "../../src/cdp-live/session";
import { connectCdp } from "../../src/cdp-live/socket";
import { liveScope } from "../../src/cdp-live/live-replay";
import { liveTrailSteps, workflowFromTrail } from "../../src/cdp-live/live-trail";
import * as targets from "../../src/cdp-live/live-target";
import { guardPreset, presetForUrl } from "../../src/cdp-live/presets";
import { McpClient } from "../../src/eval/mcp-client";
import { listChromeProfiles } from "../../src/engines/chrome-profile-copy";
import { testChromium } from "../../src/test-browser.js";
import type { RunResult } from "../../src/v1/replay";
import type { WorkflowV2 } from "../../src/v1/schema";
import { launchFixtureBrowser, type FixtureBrowser } from "../instacart/browser";
import { startExperianFixture } from "../experian/fixture";
import { laneChildEnv } from "../runtime";

const generic = guardPreset("generic");

test("security and SSO copy needs a visible credential input; bot walls do not", () => {
  for (const text of ["PIN", "security code", "two-factor", "2fa", "verification code", "one-time code", "SSO", "sign in with Google", "sign in with Apple"]) {
    assert.equal(pageHalt({ blocked: "", path: "/member", passwordFields: 0, text }), null, text);
    assert.equal(pageHalt({ blocked: "", path: "/member", passwordFields: 1, text }), "login_wall", text);
  }
  for (const text of ["Request unsuccessful", "Powered by Imperva", "Incapsula incident ID", "Verify you are human", "I'm not a robot", "recaptcha challenge"]) {
    assert.equal(pageHalt({ blocked: "", path: "/", passwordFields: 0, text }), "bot_wall", text);
  }
});

test("generic stop paths use whole segments, including hash routes", () => {
  for (const pathname of ["/member/accounts/summary", "/member/account-settings", "/login-help", "/payment-history", "/member?next=/login"]) {
    assert.equal(navigationGuard(`https://credit.test${pathname}`, ["credit.test"], ["https://credit.test"], generic.stopPath), null, pathname);
  }
  for (const pathname of ["/account", "/account/security", "/checkout", "/payment"]) {
    assert.equal(navigationGuard(`https://credit.test${pathname}`, ["credit.test"], ["https://credit.test"], generic.stopPath), "stop-path", pathname);
  }
  for (const pathname of ["/login", "/login/index", "/member/login/index", "/#/login", "/#/signin", "/signin", "/sign-in"]) {
    const url = `https://credit.test${pathname}`;
    assert.equal(stopPathHit(url), false, pathname);
    assert.equal(stopPathHit(url, ""), false, pathname);
    assert.equal(stopPathHit(url, "/checkout"), false, pathname);
    assert.equal(stopPathHit(url, "["), false, pathname);
    assert.equal(stopPathHit(url, generic.stopPath), true, pathname);
    assert.equal(navigationGuard(url, ["credit.test"], ["https://credit.test"], generic.stopPath), "login_wall", pathname);
    assert.equal(pageHalt({ path: pathname, stopPath: generic.stopPath, blocked: "", passwordFields: 0 }), "login_wall", pathname);
  }
  assert.equal(navigationGuard("https://other.test/login", ["credit.test"], ["https://credit.test"], generic.stopPath), "url is not on the host list");
});

test("Experian selects both hosts and allows freeze controls while denying unrelated writes", () => {
  for (const host of ["www.experian.com", "usa.experian.com"]) {
    assert.equal(presetForUrl(`https://${host}/`, "generic"), "experian");
    const scope = liveScope(`https://${host}/`);
    for (const other of ["www.experian.com", "usa.experian.com"]) {
      assert.equal(navigationGuard(`https://${other}/member/accounts/summary`, scope.hosts, scope.origins, scope.stopPath), null);
    }
    const labels = ["Freeze", "Unfreeze", "Lift freeze", "Thaw", "Lock", "Unlock", "Dispute", "Sign out", "Log out", "Cancel", "Delete account", "Change password"];
    const read = buildView({ path: "/member", title: "Credit", headings: [], blocked: "", controls: labels.map((label, index) => ({ index, label, kind: "button" })) }, 1, scope.guard);
    labels.forEach((label, index) => assert.equal(planClick(read, `e1.c${index}`).ok, index < 6, label));
  }
});

test("Experian final freeze commits stop by default; session opt-in never widens the commit floor", () => {
  const scope = liveScope("https://usa.experian.com/member");
  for (const label of ["Unfreeze", "Freeze", "Lift freeze", "Thaw", "Confirm", "Submit"]) {
    const facts = { path: "/member/unfreeze/review", title: "Review unfreeze", headings: ["Review unfreeze"], blocked: "", controls: [
      { index: 0, label, kind: "submit" },
      { index: 1, label: "Note", kind: "field", field: { type: "text", name: "note", autocomplete: "" }, formSubmit: label },
      { index: 2, label: "Place order", kind: "button" },
      { index: 3, label: "Dispute", kind: "button" },
      { index: 4, label: "Unfreeze", kind: "link", href: "https://usa.experian.com/member/unfreeze" },
    ] };
    const stopped = buildView(facts, 1, scope.guard);
    assert.deepEqual(planClick(stopped, "e1.c0"), { ok: false, refusal: "experian_commit" }, label);
    assert.deepEqual(planKey(stopped, "Enter", "e1.c1"), { ok: false, refusal: "experian_commit" }, label);
    if (label === "Unfreeze") {
      const dashboard = buildView({ ...facts, path: "/member", title: "Dashboard", headings: [] }, 1, scope.guard);
      assert.equal(dashboard.view.reached, undefined);
      assert.equal(planClick(dashboard, "e1.c0").ok, true);
      assert.equal(planKey(dashboard, "Enter", "e1.c1").ok, true);
    }
    assert.equal(planClick(stopped, "e1.c4").ok, true, "navigation stays allowed");
    const optIn = { ...scope.guard, allowCommit: true };
    const allowed = buildView(facts, 1, optIn);
    assert.equal(planClick(allowed, "e1.c0").ok, true, label);
    assert.equal(planKey(allowed, "Enter", "e1.c1").ok, true, label);
    assert.equal(planClick(allowed, "e1.c2").ok, false, "checkout stays refused");
    assert.equal(planClick(allowed, "e1.c3").ok, false, "deny labels stay refused");
    const genericOptIn = { ...generic, allowCommit: true };
    assert.equal(planClick(buildView(facts, 1, genericOptIn), "e1.c2").ok, false);
  }
  const body = liveCliBody("live_session_start", ["--intent", "Unfreeze", "--url", "https://usa.experian.com/member", "--allow-commit"]);
  assert.equal(body.allowCommit, true);
  assert.equal(liveCliBody("live_session_start", []).allowCommit, undefined);
  assert.match(runViewer({ id: "run-opt-in", kind: "capture", allowCommit: true, workflowId: "wf-freeze", status: "passed", steps: [] }, { name: "Unfreeze credit", steps: [] }), /Experian commit opt-in was on/);
});

test("Experian flow starters stay ordinary clicks and Enter submissions", () => {
  const guard = guardPreset("experian");
  for (const route of ["/member", "/member/freeze", "/member/unfreeze"]) {
    for (const label of ["Unfreeze", "Freeze", "Lift freeze", "Thaw", "Continue", "Next", "Review"]) {
      const read = buildView({ path: route, title: "Manage credit freeze", headings: [], blocked: "", controls: [
        { index: 0, kind: "submit", label },
        { index: 1, kind: "field", label: "Note", field: { type: "text", name: "note", autocomplete: "" }, formSubmit: label },
      ] }, 1, guard);
      assert.equal(read.view.reached, undefined, `${route} ${label}`);
      assert.equal(planClick(read, "e1.c0").ok, true, `${route} ${label}`);
      assert.equal(planKey(read, "Enter", "e1.c1").ok, true, `${route} ${label}`);
    }
  }
});

test("Experian workflows retain repeated clicks, typed corrections and keys in order", () => {
  const identity = { surface: "dom" as const, role: "textbox", name: "Search", path: [] };
  const events = [
    { id: "a", ts: 1, kind: "act" as const, op: "click", identity },
    { id: "b", ts: 2, kind: "act" as const, op: "click", identity },
    { id: "c", ts: 3, kind: "act" as const, op: "type", identity, value: "wrong", literal: true },
    { id: "d", ts: 4, kind: "act" as const, op: "type", identity, value: "correct", literal: true },
    { id: "e", ts: 5, kind: "act" as const, op: "key", key: "Enter", identity },
  ];
  const built = liveTrailSteps(events, { id: "wf-false-starts", startUrl: "https://usa.experian.com/member" });
  assert.deepEqual(built.workflow.steps.map(s => s.action), ["click", "click", "type", "type", "key"]);
  assert.deepEqual(built.workflow.steps.filter(s => s.action === "type").map(s => s.value), ["wrong", "correct"]);
  assert.deepEqual(built.groups.map(g => g.map(e => e.id)), [["a"], ["b"], ["c"], ["d"], ["e"]]);
});

test("other live presets condense repeated Add clicks and keep their step groups aligned", () => {
  const startUrl = "https://www.instacart.com/store/costco/storefront";
  const identity = { surface: "dom" as const, role: "button", name: "Add to cart", path: [] };
  const events = [1, 2].map(n => ({ id: `add-${n}`, ts: n, kind: "act" as const, op: "click", identity, beforeUrl: startUrl, afterUrl: startUrl, subtreeBefore: "", subtreeAfter: "1 in cart" }));
  const built = liveTrailSteps(events, { id: "wf-add", startUrl });
  assert.equal(built.workflow.steps.length, 1);
  assert.deepEqual(built.groups.map(group => group.map(event => event.id)), [["add-1"]]);
  const explicit = liveTrailSteps(events, { id: "wf-add", startUrl: "https://credit.test/member" }, guardPreset("experian"));
  assert.equal(explicit.workflow.steps.length, 2);
  assert.deepEqual(explicit.groups.map(group => group.map(event => event.id)), [["add-1"], ["add-2"]]);
  const saved = workflowFromTrail({ id: "wf-add", name: "Add item", intent: "Add item", startUrl, createdAt: 1, savedAt: 2, events, guard: guardPreset("instacart") });
  assert.deepEqual(saved.steps, built.workflow.steps);
});

test("generic refuses sign out and log out before a click", () => {
  const read = buildView({ path: "/", title: "Credit", headings: [], blocked: "", controls: ["Sign out", "Log out"].map((label, index) => ({ index, label, kind: "button" })) }, 1, generic);
  assert.equal(planClick(read, "e1.c0").ok, false);
  assert.equal(planClick(read, "e1.c1").ok, false);
});

test("Settings lists real profile folders, saves the live choice and reads it at each start", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-live-profile-"));
  const source = path.join(root, "profiles");
  for (const name of ["Default", "Profile 2", "Profile 3", "Not a profile"]) await mkdir(path.join(source, name), { recursive: true });
  await writeFile(path.join(source, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Personal" }, "Profile 2": { name: "Credit reports" }, "Profile 9": { name: "Gone" } } } }));
  const seen: targets.LiveTarget[] = [];
  t.mock.method(targets, "prepareTarget", async (target: targets.LiveTarget) => { seen.push(target); throw new Error("test stops before Chrome connection"); });
  const home = path.join(root, "bao");
  let app = await startApp({ home, port: 0, chromeProfilesRoot: source });
  const ui = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const page = await ui.newPage();
  const put = (body: unknown) => fetch(`http://127.0.0.1:${app.port}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const start = () => fetch(`http://127.0.0.1:${app.port}/api/live`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "live_session_start", intent: "read credit", url: "https://credit.test/member" }) });
  try {
    assert.deepEqual((await listChromeProfiles(source)).map((p) => [p.directory, p.name]), [["Profile 2", "Credit reports"], ["Default", "Personal"], ["Profile 3", "Profile 3"]]);
    assert.equal((await put({ liveChromeProfile: "../outside" })).status, 400);
    assert.equal((await put({ liveChromeProfile: "Profile 9" })).status, 400);
    await page.goto(`http://127.0.0.1:${app.port}/?screen=settings`);
    await page.waitForSelector("#library-search");
    assert.equal(await page.locator("#live-chrome-settings").count(), 0);
    await page.click("button[data-screen=settings]");
    await page.waitForFunction(() => document.querySelectorAll("#live-chrome-profile option").length === 3);
    assert.deepEqual(await page.locator("#live-chrome-profile option").allTextContents(), ["Credit reports (Profile 2)", "Personal (Default)", "Profile 3 (Profile 3)"]);
    assert.match(await page.locator("#live-chrome-settings").innerText(), /--live-target.*wins over.*BAO_LIVE_TARGET/s);
    assert.equal((await put({ liveChromeProfile: "Profile 2" })).status, 200);
    await page.reload();
    await page.click("button[data-screen=settings]");
    await page.waitForFunction(() => (document.getElementById("live-chrome-profile") as HTMLSelectElement)?.value === "Profile 2");
    await start();
    assert.deepEqual(seen.at(-1), { kind: "daily", profile: "Profile 2", portFile: path.join(source, "DevToolsActivePort") });
    assert.equal((await put({ liveChromeProfile: "Default" })).status, 200);
    await start();
    assert.equal((seen.at(-1) as { profile: string }).profile, "Default");
    await app.close();
    app = await startApp({ home, port: 0, chromeProfilesRoot: source, liveTarget: "daily:Profile 2" });
    await start();
    assert.equal((seen.at(-1) as { profile: string }).profile, "Profile 2", "launch override wins over saved Default");
    assert.equal((await fetch(`http://127.0.0.1:${app.port}/api/state`).then(r => r.json())).settings.liveChromeProfile, "Default");
    assert.match(await readFile(path.join(home, "settings.json"), "utf8"), /liveChromeProfile/);
    app.library.save({ schema: "bao.workflow/v2", version: 2, id: "wf-query-disabled", name: "Query route check", startUrl: "https://credit.test/member", createdAt: 1, inputs: [], steps: [{ id: "note", index: 0, action: "note", surface: "dom", label: "Read member page", timeoutMs: 1000 }] });
    app.library.saveRun({ id: "run-query-disabled", workflowId: "wf-query-disabled", status: "passed", at: 1, heals: [], steps: [] });
    await page.goto(`http://127.0.0.1:${app.port}/?screen=run&run=run-query-disabled`);
    await page.waitForSelector("#library-search");
    assert.equal(await page.locator("#run-viewer").count(), 0);
    await page.click("button[data-screen=runs]");
    await page.click('[data-open-run="run-query-disabled"]');
    await page.waitForSelector('#run-viewer[data-run="run-query-disabled"]');
  } finally { await ui.close(); await app.close(); await rm(root, { recursive: true, force: true }); }
});

interface LiveReply {
  session?: string;
  outcome: { kind: string; reason?: string; instruction?: string };
  view?: { path: string; epoch: number; reached?: { ref: string; label: string }; controls: { ref: string; label: string }[]; stopBeforeConfirm: { label: string }[] };
}

describe("Experian stand-in through the Bao API and product MCP", { timeout: 120_000 }, () => {
  let fixture: Awaited<ReturnType<typeof startExperianFixture>>;
  let browser: FixtureBrowser;
  let app: App;
  let root: string;
  let mcp: McpClient;
  const live = async (op: string, args: Record<string, unknown> = {}): Promise<LiveReply> => {
    const result = await mcp.call(op, args);
    return JSON.parse(result.text) as LiveReply;
  };
  const refOf = (reply: LiveReply, label: string) => {
    const ref = reply.view?.controls.find(c => c.label === label)?.ref;
    assert.ok(ref, `${label}: ${JSON.stringify(reply)}`);
    return ref;
  };
  before(async () => {
    fixture = await startExperianFixture();
    browser = await launchFixtureBrowser(fixture);
    const seed = await testChromium.connectOverCDP(browser.cdpUrl);
    try {
      const tab = seed.contexts()[0].pages()[0];
      for (const host of fixture.hosts) await tab.goto(fixture.url("/seed", host));
    } finally { await seed.close(); }
    root = await mkdtemp(path.join(tmpdir(), "bao-experian-app-"));
    const env = laneChildEnv("hermetic", process.env, () => browser.executable);
    env.HOME = path.join(root, "user");
    env.BAO_HOME = path.join(root, "bao");
    await mkdir(env.HOME);
    app = await startApp({ home: env.BAO_HOME, port: 0, liveTarget: `throwaway:${browser.portFile}`, liveLockFile: path.join(root, "live.lock") });
    mcp = McpClient.start(env);
    await mcp.handshake();
  });
  after(async () => { await mcp?.close(); await app?.close(); await browser?.close(); await fixture?.close(); if (root) await rm(root, { recursive: true, force: true }); });

  it("drivers enforce only installed stop paths and leave sign-in recovery usable", async () => {
    const cdp = await connectCdp(browser.cdpPort, new URL(browser.wsEndpoint).pathname);
    try {
      for (const stopPath of [undefined, "/checkout(?:/|$)"]) {
        for (const login of ["/login", "/login/index", "/member/login/index", "/signin", "/sign-in", "/#/login"]) {
          for (const redirect of [false, true]) {
            const driver = await openLiveWindow(cdp, ["credit.test"]);
            if (stopPath !== undefined) driver.setStopPath(stopPath);
            const url = fixture.url(login, "credit.test");
            try {
              await driver.goto(redirect ? fixture.url(`/member/expired?login=${encodeURIComponent(login)}`, "credit.test") : url);
              const facts = await driver.evaluateFunction<PageFacts>(readLivePage, { markIndex: -1 });
              assert.equal(await driver.locationHref(), url);
              assert.equal(signedOutSurface(facts), true, JSON.stringify({ stopPath, login, redirect, facts }));
              assert.equal(driver.takeBlockedNav(), "");
              if (login === "/login/index" && !redirect) {
                driver.setStopPath("/checkout(?:/|$)");
                await driver.evaluateFunction(() => { history.pushState({}, "", "/checkout"); }, undefined);
                await driver.returnFromBlock();
                assert.equal(await driver.locationHref(), url, "the login page is the last allowed recovery page");
              }
              await driver.goto(fixture.url("/member/security-help", "credit.test"));
              assert.equal((await driver.pageSignals()).title, "Security help");
            } finally { await driver.end(); }
          }
        }
      }
      for (const login of ["/login/index", "/signin", "/sign-in"]) {
        for (const redirect of [false, true]) {
          const driver = await openLiveWindow(cdp, ["credit.test"]);
          driver.setStopPath(generic.stopPath);
          const requests = () => fixture.requests.filter(request => request.host === "credit.test" && request.path === login).length;
          const before = requests();
          try {
            await assert.rejects(driver.goto(fixture.url(redirect ? `/member/expired?login=${encodeURIComponent(login)}` : login, "credit.test")), error => error instanceof LiveNavigationHalt && error.reason === "login_wall");
            assert.equal(requests(), before, "an installed login stop prevents the document request");
          } finally { await driver.end(); }
        }
      }
    } finally { cdp.close(); }
  });

  it("expired session start returns a login halt and replay saves a paused run", async () => {
    const started = await live("live_session_start", { intent: "Read credit", url: fixture.url("/member/expired") });
    assert.equal(started.outcome.kind, "halted", JSON.stringify(started));
    assert.equal(started.outcome.reason, "login_wall");
    assert.match(started.outcome.instruction || "", /Sign in again in Chrome.*new live session/);
    const workflow: WorkflowV2 = { schema: "bao.workflow/v2", version: 2, id: "wf-expired", name: "Read credit report", intent: "Read credit report", createdAt: 1, driver: "cdp-live", startUrl: fixture.url("/member/expired"), inputs: [], steps: [{ id: "report", index: 0, action: "note", surface: "dom", timeoutMs: 1000, label: "Read report" }] };
    app.library.save(workflow);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: workflow.id, args: {} }) });
    assert.equal(response.status, 200);
    const run = await response.json() as RunResult;
    assert.equal(run.status, "paused", JSON.stringify(run));
    assert.equal(run.pausedKind, "wall");
    assert.match(run.ask?.instruction || "", /Sign in to .* in Chrome/);
    assert.equal(run.modelCalls, 0);
    assert.equal(app.library.readRun(run.runId).status, "needs_human");
    assert.equal(fixture.requests.some(r => r.host === "usa.experian.com" && r.path === "/login/index"), false, "blocked login page never loads");
    const replayed = JSON.parse((await mcp.call("run_workflow", { id: workflow.id })).text);
    assert.equal(replayed.outcome, "needs_human", JSON.stringify(replayed));
  });

  it("click and Enter sign-in redirects halt the live session and pause MCP replay", async () => {
    for (const login of ["/login", "/login/index", "/signin", "/sign-in"]) {
      for (const op of ["click", "key"] as const) {
        const startUrl = fixture.url(`/member/session-links?login=${encodeURIComponent(login)}`);
        let reply = await live("live_session_start", { intent: "Read member actions", url: startUrl });
        try {
          assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
          const ref = refOf(reply, op === "click" ? "Continue" : "Search");
          reply = await live(`live_${op}`, { ref, ...(op === "key" ? { key: "Enter" } : {}) });
          assert.equal(reply.outcome.kind, "halted", `${login} ${op}: ${JSON.stringify(reply)}`);
          assert.equal(reply.outcome.reason, "login_wall");
          assert.match(reply.outcome.instruction || "", /sign in again.*Chrome/i);
          const state = await fetch(`http://127.0.0.1:${app.port}/api/state`).then(response => response.json());
          assert.equal(state.liveSessionOpen, true);
          assert.equal(state.liveSession.status, "needs_human");
          assert.equal(state.liveSession.note, reply.outcome.instruction);
          assert.equal(state.liveSession.audit.some((row: { label: string }) => row.label === "login_wall"), false);
          const again = await live("live_snapshot");
          assert.equal(again.outcome.kind, "halted");
          assert.equal(again.outcome.reason, "login_wall");
          assert.match(again.outcome.instruction || "", /sign in again.*Chrome/i);
        } finally { await live("live_stop"); }
        const workflow = workflowFromTrail({
          id: `wf-expired-${login.replace(/\W/g, "")}-${op}`, name: "Read member actions", intent: "Read member actions", startUrl, createdAt: 1, savedAt: 2,
          guard: liveScope(startUrl).guard,
          events: [{ id: "continue", ts: 1, kind: "act", op, ...(op === "key" ? { key: "Enter" } : {}), identity: { surface: "dom", role: op === "click" ? "link" : "input", name: op === "click" ? "Continue" : "Search", tag: op === "click" ? "a" : "input", path: [] } }],
        });
        app.library.save(workflow);
        const replayed = JSON.parse((await mcp.call("run_workflow", { id: workflow.id })).text);
        assert.equal(replayed.outcome, "needs_human", `${login} ${op}: ${JSON.stringify(replayed)}`);
        const saved = app.library.readRun(replayed.run_id);
        assert.equal(saved.status, "needs_human");
        assert.equal((saved.failure as RunResult["failure"])?.reason, "login_wall");
        assert.equal((saved.steps as RunResult["steps"])[0]?.status, "paused");
        assert.match(saved.envelope?.ask || "", /Sign in to .* in Chrome/);
        assert.equal(saved.modelCalls, 0);
      }
      assert.equal(fixture.requests.some(request => request.host === "usa.experian.com" && request.path === login), false, `${login} must never load`);
    }
  });

  it("direct login links halt click and Enter, persist the instruction, and pause replay", async () => {
    for (const login of ["/login", "/login/index", "/member/login/index", "/signin", "/sign-in", "/#/login"]) {
      for (const op of ["click", "key"] as const) {
        const startUrl = fixture.url(`/member/session-links?login=${encodeURIComponent(login)}`);
        let reply = await live("live_session_start", { intent: `Read direct ${login} ${op}`, url: startUrl });
        const targetPath = new URL(fixture.url(login)).pathname;
        const requests = () => fixture.requests.filter(request => request.path === targetPath).length;
        const before = requests();
        try {
          assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
          reply = await live("live_key", { key: "Tab", ref: refOf(reply, "Search") });
          assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
          reply = await live(`live_${op}`, { ref: refOf(reply, "Resume"), ...(op === "key" ? { key: "Enter" } : {}) });
          assert.equal(reply.outcome.kind, "halted", `${login} ${op}: ${JSON.stringify(reply)}`);
          assert.equal(reply.outcome.reason, "login_wall");
          assert.match(reply.outcome.instruction || "", /Sign in again in Chrome/);
          const state = await fetch(`http://127.0.0.1:${app.port}/api/state`).then(response => response.json());
          assert.equal(state.liveSessionOpen, true);
          assert.equal(state.liveSession.status, "needs_human");
          assert.equal(state.liveSession.note, reply.outcome.instruction);
          assert.equal(state.liveSession.audit.at(-1)?.label, reply.outcome.instruction);
          assert.equal(state.liveSession.steps.at(-1)?.status, "needs_human");
        } finally { await live("live_stop"); }
        const record = JSON.parse(await readFile(path.join(root, "bao", "live-session", "session.json"), "utf8"));
        assert.equal(record.status, "needs_human");
        assert.equal(record.note, reply.outcome.instruction);
        const capture = app.library.listRuns().find(run => run.workflowId === reply.session && run.kind === "capture");
        assert.equal(capture?.status, "needs_human");
        assert.equal(capture?.envelope?.ask, reply.outcome.instruction);
        const workflow = workflowFromTrail({
          id: `wf-direct-${login.replace(/\W/g, "")}-${op}`, name: "Read member actions", intent: "Read member actions", startUrl, createdAt: 1, savedAt: 2,
          guard: liveScope(startUrl).guard,
          events: [{ id: "resume", ts: 1, kind: "act", op, ...(op === "key" ? { key: "Enter" } : {}), identity: { surface: "dom", role: "link", name: "Resume", tag: "a", path: [] } }],
        });
        app.library.save(workflow);
        const replayed = JSON.parse((await mcp.call("run_workflow", { id: workflow.id })).text);
        assert.equal(replayed.outcome, "needs_human", `${login} ${op}: ${JSON.stringify(replayed)}`);
        const saved = app.library.readRun(replayed.run_id);
        assert.equal(saved.status, "needs_human");
        assert.equal((saved.failure as RunResult["failure"])?.reason, "login_wall");
        assert.match(saved.envelope?.ask || "", /Sign in to .* in Chrome/);
        assert.equal(saved.modelCalls, 0);
        assert.equal(requests(), before, `${login} must never load`);
      }
    }
  });

  it("generic sessions also persist login halts before click or Enter returns", async () => {
    for (const op of ["click", "key"] as const) {
      let reply = await live("live_session_start", { intent: "Read member actions", url: fixture.url("/member/session-links?login=%2Flogin%2Findex", "credit.test") });
      try {
        reply = await live(`live_${op}`, { ref: refOf(reply, "Resume"), ...(op === "key" ? { key: "Enter" } : {}) });
        assert.equal(reply.outcome.kind, "halted", JSON.stringify(reply));
        assert.equal(reply.outcome.reason, "login_wall");
        assert.equal(reply.outcome.instruction, "Sign in again in Chrome, then start a new live session.");
        const state = await fetch(`http://127.0.0.1:${app.port}/api/state`).then(response => response.json());
        assert.equal(state.liveSessionOpen, true);
        assert.equal(state.liveSession.status, "needs_human");
        assert.equal(state.liveSession.note, reply.outcome.instruction);
        assert.equal(state.liveSession.audit.at(-1)?.label, reply.outcome.instruction);
      } finally { await live("live_stop"); }
    }
  });

  it("an already-open login path saves the sign-in sentence immediately and on stop", async () => {
    for (const login of ["/login", "/member/login/index", "/signin", "/sign-in", "/#/login"]) {
      let reply = await live("live_session_start", { intent: `Read on-page ${login}`, url: fixture.url(`/member/session-links?login=${encodeURIComponent(login)}`) });
      try {
        reply = await live("live_click", { ref: refOf(reply, "More details") });
        assert.equal(reply.outcome.kind, "halted", JSON.stringify(reply));
        assert.equal(reply.outcome.reason, "login_wall");
        const record = JSON.parse(await readFile(path.join(root, "bao", "live-session", "session.json"), "utf8"));
        assert.equal(record.note, reply.outcome.instruction);
        assert.match(record.note, /Sign in again in Chrome/);
      } finally { await live("live_stop"); }
      const record = JSON.parse(await readFile(path.join(root, "bao", "live-session", "session.json"), "utf8"));
      assert.equal(record.note, reply.outcome.instruction);
    }
  });

  it("direct login starts and navigate steps leave typed halts and paused owner asks", async () => {
    for (const login of ["/login", "/signin", "/sign-in", "/#/login"]) {
      const started = await live("live_session_start", { intent: "Read credit", url: fixture.url(login) });
      assert.equal(started.outcome.kind, "halted", JSON.stringify(started));
      assert.equal(started.outcome.reason, "login_wall");
      assert.match(started.outcome.instruction || "", /Sign in again in Chrome/);
      for (const direct of [false, true]) {
        const workflow: WorkflowV2 = { schema: "bao.workflow/v2", version: 2, id: `wf-navigate-${login.replace(/\W/g, "")}-${direct}`, name: "Read member actions", createdAt: 1, driver: "cdp-live", startUrl: fixture.url(direct ? login : "/member/security-help"), inputs: [], steps: [{ id: "resume", index: 0, action: "navigate", surface: "dom", value: fixture.url(login), label: "Resume member actions", timeoutMs: 1000 }] };
        app.library.save(workflow);
        const response = await fetch(`http://127.0.0.1:${app.port}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: workflow.id, args: {} }) });
        assert.equal(response.status, 200);
        const run = await response.json() as RunResult;
        assert.equal(run.status, "paused", JSON.stringify(run));
        assert.equal(run.pausedKind, "wall");
        assert.match(run.ask?.instruction || "", /Sign in to .* in Chrome/);
        assert.equal(app.library.readRun(run.runId).status, "needs_human");
        assert.equal(app.library.readRun(run.runId).envelope?.ask, run.ask?.instruction);
        const replayed = JSON.parse((await mcp.call("run_workflow", { id: workflow.id })).text);
        assert.equal(replayed.outcome, "needs_human", JSON.stringify(replayed));
        const saved = app.library.readRun(replayed.run_id);
        assert.equal(saved.status, "needs_human");
        assert.match(saved.envelope?.ask || "", /Sign in to .* in Chrome/);
        assert.equal(saved.modelCalls, 0);
      }
    }
  });

  it("saves ordinary confirm pauses as needing the owner through the app and MCP", async () => {
    const workflow: WorkflowV2 = { schema: "bao.workflow/v2", version: 2, id: "wf-owner-confirm", name: "Confirm credit change", createdAt: 1, driver: "cdp-live", startUrl: fixture.url("/member/freeze"), inputs: [], steps: [{ id: "confirm", index: 0, action: "confirm", human: true, surface: "dom", timeoutMs: 1000, label: "Confirm credit change" }] };
    app.library.save(workflow);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: workflow.id, args: {} }) });
    const run = await response.json() as RunResult;
    assert.equal(run.status, "paused", JSON.stringify(run));
    assert.equal(run.pausedKind, "confirm");
    assert.equal(run.failure, undefined);
    const saved = app.library.readRun(run.runId);
    assert.equal(saved.status, "needs_human");
    assert.equal(saved.envelope?.ask, run.ask?.instruction);
    const replayed = JSON.parse((await mcp.call("run_workflow", { id: workflow.id })).text);
    assert.equal(replayed.outcome, "needs_human", JSON.stringify(replayed));
    const stored = app.library.readRun(replayed.run_id);
    assert.equal(stored.status, "needs_human");
    assert.equal(stored.envelope?.ask, replayed.ask);
    assert.equal(stored.failure, undefined);
  });

  it("security copy does not halt, real OTP does, and Imperva still halts", async () => {
    for (const [pathname, expected] of [["/member/security-help", "applied"], ["/member/verify", "halted"], ["/member/bot", "halted"], ["/member/account-redirect", "halted"]]) {
      const reply = await live("live_session_start", { intent: "Read security help", url: fixture.url(pathname) });
      try {
        assert.equal(reply.outcome.kind, expected, JSON.stringify(reply));
        const reason = pathname === "/member/security-help" ? undefined : pathname === "/member/verify" ? "login_wall" : pathname === "/member/bot" ? "bot_wall" : "stop-path";
        assert.equal(reply.outcome.reason, reason);
      }
      finally { await live("live_stop"); }
    }
  });

  it("crosses both Experian hosts and records false starts in order", async () => {
    let reply = await live("live_session_start", { intent: "Unfreeze credit", url: fixture.url("/", "www.experian.com"), allowCommit: true });
    try {
      assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
      reply = await live("live_click", { ref: refOf(reply, "Member center") });
      assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
      reply = await live("live_click", { ref: refOf(reply, "Accounts summary") });
      assert.equal(reply.view?.path, "/member/accounts/summary");
      reply = await live("live_click", { ref: refOf(reply, "Dashboard") });
      for (const label of ["Freeze", "Freeze", "Lock", "Unlock"]) {
        reply = await live("live_click", { ref: refOf(reply, label) });
        assert.equal(reply.outcome.kind, "applied", label);
      }
      for (const [index, label] of [[10, "Dispute"], [11, "Sign out"], [12, "Log out"], [13, "Cancel"]] as const) {
        assert.ok(reply.view?.stopBeforeConfirm.some(c => c.label === label), label);
        const refused = await live("live_click", { ref: `e${reply.view!.epoch}.c${index}` });
        assert.equal(refused.outcome.kind, "refused", label);
        assert.equal(refused.outcome.reason, "denied", label);
      }
      assert.equal(fixture.requests.filter(r => r.path === "/write").length, 4, "only the four allowed clicks wrote");
      reply = await live("live_click", { ref: refOf(reply, "Unfreeze") });
      assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
      assert.equal(reply.view?.path, "/member/freeze");
      await live("live_stop");
      const saved = app.library.read(reply.session || "");
      assert.deepEqual(saved.steps.map(s => s.identity?.name || s.identity?.text || s.identity?.label), ["Member center", "Accounts summary", "Dashboard", "Freeze", "Freeze", "Lock", "Unlock", "Unfreeze"]);
      assert.equal(saved.driver, "cdp-live");
    } finally { await live("live_stop"); }
  });

  it("reaches the final unfreeze by default and clicks it only with a fresh session opt-in", async () => {
    const commits = () => fixture.requests.filter(r => r.path === "/commit-unfreeze").length;
    const reach = async (allowCommit: boolean) => {
      try {
        let reply = await live("live_session_start", { intent: `Unfreeze credit ${allowCommit ? "authorized" : "preview"}`, url: fixture.url("/member"), ...(allowCommit ? { allowCommit: true } : {}) });
        assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
        reply = await live("live_click", { ref: refOf(reply, "Unfreeze") });
        assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
        assert.equal(reply.view?.path, "/member/freeze");
        reply = await live("live_click", { ref: refOf(reply, "Unfreeze my credit") });
        assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
        return await live("live_click", { ref: refOf(reply, "Continue") });
      } catch (error) { await live("live_stop"); throw error; }
    };
    const wrongPreset = await live("live_session_start", { intent: "Invalid opt-in site", url: fixture.url("/member/freeze", "credit.test"), allowCommit: true });
    assert.equal(wrongPreset.outcome.kind, "rejected");
    assert.match(wrongPreset.outcome.reason || "", /only.*Experian/);
    const reviewStart = await live("live_session_start", { intent: "Preview final freeze action", url: fixture.url("/member/unfreeze/review") });
    try {
      assert.equal(reviewStart.outcome.kind, "applied", "session start never reports reached");
      assert.equal((await live("live_snapshot")).outcome.kind, "reached");
    } finally { await live("live_stop"); }
    const invalid = await live("live_session_start", { intent: "Invalid opt-in", url: fixture.url("/member/freeze"), allowCommit: "true" });
    assert.equal(invalid.outcome.kind, "rejected");
    assert.match(invalid.outcome.reason || "", /boolean/);
    const reached = await reach(false);
    try {
      assert.equal(reached.outcome.kind, "reached", JSON.stringify(reached));
      assert.equal(reached.outcome.reason, "experian_commit");
      assert.match(reached.outcome.instruction || "", /owner|confirm/i);
      assert.match(reached.outcome.instruction || "", /allowCommit: true/);
      assert.equal(reached.view?.path, "/member/unfreeze/review");
      assert.equal(reached.view?.reached?.label, "Confirm");
      const state = await fetch(`http://127.0.0.1:${app.port}/api/state`).then(response => response.json()) as { liveSession?: { note?: string } };
      assert.equal(state.liveSession?.note, "The final unfreeze button is on screen. Bao stopped before clicking it.");
      assert.equal(commits(), 0);
      const enter = await live("live_key", { key: "Enter", ref: refOf(reached, "Note") });
      assert.equal(enter.outcome.kind, "reached", "Enter cannot bypass the final button");
      const refused = await live("live_click", { ref: reached.view!.reached!.ref });
      assert.equal(refused.outcome.kind, "reached");
      assert.equal(commits(), 0);
    } finally { await live("live_stop"); }
    const preview = app.library.read(reached.session!);
    assert.equal(preview.steps.length, 3, "all navigation before the final button stays recorded");
    const previewRun = app.library.listRuns().find(run => run.workflowId === preview.id);
    assert.equal(previewRun?.status, "needs_human");
    assert.equal(previewRun?.allowCommit, false);
    assert.equal(previewRun?.envelope?.reason, "experian_commit");
    assert.equal(previewRun?.envelope?.ask, "The final unfreeze button is on screen. Bao stopped before clicking it.");
    const final = await reach(true);
    try {
      assert.equal(final.outcome.kind, "applied", JSON.stringify(final));
      const clicked = await live("live_click", { ref: refOf(final, "Confirm") });
      assert.equal(clicked.outcome.kind, "applied", JSON.stringify(clicked));
      assert.equal(commits(), 1);
    } finally { await live("live_stop"); }
    const saved = app.library.read(final.session!);
    assert.equal(saved.steps.length, 4);
    const capture = app.library.listRuns().find(run => run.workflowId === saved.id);
    assert.equal(capture?.allowCommit, true, "capture run keeps the explicit opt-in");
    const response = await fetch(`http://127.0.0.1:${app.port}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: saved.id, args: {} }) });
    const replay = await response.json() as RunResult;
    assert.equal(replay.status, "paused", JSON.stringify(replay));
    assert.equal(replay.pausedKind, "confirm");
    const replayRun = app.library.readRun(replay.runId);
    assert.equal(replayRun.status, "needs_human");
    assert.equal(replayRun.envelope?.ask, "The final unfreeze button is on screen. Bao stopped before clicking it.");
    assert.equal(commits(), 1, "recording permission does not silently authorize a replay");
    const replayed = JSON.parse((await mcp.call("run_workflow", { id: saved.id })).text);
    assert.equal(replayed.outcome, "needs_human", JSON.stringify(replayed));
    const mcpRun = app.library.readRun(replayed.run_id);
    assert.equal(mcpRun.status, "needs_human");
    assert.equal(mcpRun.envelope?.ask, "The final unfreeze button is on screen. Bao stopped before clicking it.");
    assert.equal(commits(), 1, "MCP replay also needs fresh owner consent");
    const again = await reach(false);
    try { assert.equal(again.outcome.kind, "reached", "opt-in never carries to the next session"); }
    finally { await live("live_stop"); }
  });

  it("generic allows member/accounts and refuses both sign-out buttons without sending writes", async () => {
    const reply = await live("live_session_start", { intent: "Read accounts", url: fixture.url("/member", "credit.test") });
    try {
      assert.equal(reply.outcome.kind, "applied", JSON.stringify(reply));
      const writesBefore = fixture.requests.filter(r => r.path === "/write").length;
      for (const [index, label] of [[11, "Sign out"], [12, "Log out"]] as const) {
        assert.ok(reply.view?.stopBeforeConfirm.some(c => c.label === label));
        const refused = await live("live_click", { ref: `e${reply.view!.epoch}.c${index}` });
        assert.equal(refused.outcome.kind, "refused", label);
        assert.equal(refused.outcome.reason, "denied", label);
      }
      assert.equal(fixture.requests.filter(r => r.path === "/write").length, writesBefore);
      const after = await live("live_click", { ref: refOf(reply, "Accounts summary") });
      assert.equal(after.outcome.kind, "applied", JSON.stringify(after));
      assert.equal(after.view?.path, "/member/accounts/summary");
    } finally { await live("live_stop"); }
  });
});
