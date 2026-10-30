import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { liveSessionView } from "../../src/app/live-view";
import { insertTextRefusal, navigationRefusal, INSTACART_HOSTS } from "../../src/cdp-live/allowlist";
import { buildView, pageHalt, planClick, sameTarget, targetVerdict, type PageFacts } from "../../src/cdp-live/live-ops";
import { liveCliBody, liveToolResult } from "../../src/mcp/live-proxy";
import { acquireCdpLock, parseLock, releaseCdpLock } from "../../src/cdp-live/lock";
import { createLiveHost, replayLive, type ReplayTarget } from "../../src/cdp-live/live-host";
import { CdpLiveDriver } from "../../src/cdp-live/driver";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { guardPreset } from "../../src/cdp-live/presets";
import { WORKFLOW_SCHEMA_ID, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";
import type { LiveSessionRecord } from "../../src/cdp-live/live-record";

const generic = guardPreset("generic");
const instacart = guardPreset("instacart");

function facts(controls: PageFacts["controls"], extra: Partial<PageFacts> = {}): PageFacts {
  return { path: "/", title: "Shop", headings: [], blocked: "", controls, ...extra };
}

test("preset commit and deny stop Place your order, a search submit, and Delete account", () => {
  const read = buildView(facts([
    { index: 0, label: "Place your order", kind: "button" },
    { index: 1, label: "Place order", kind: "submit", form: "search" },
    { index: 2, label: "Delete account", kind: "button" },
    { index: 3, label: "Pay now", kind: "button" },
    { index: 4, label: "Add to cart", kind: "button" },
  ]), 1, generic);
  assert.equal(read.view.controls.some((control) => /place|delete|pay now/i.test(control.label)), false);
  assert.equal(planClick(read, "e1.c0").ok, false);
  assert.equal(planClick(read, "e1.c1").ok, false);
  assert.equal(planClick(read, "e1.c2").ok, false);
  const pay = buildView(facts([{ index: 0, label: "Pay now", kind: "button" }]), 1, instacart);
  assert.equal(pay.view.stopBeforeConfirm.length > 0, true);
  assert.equal(planClick(pay, "e1.c0").ok, false);
  const cart = planClick(read, "e1.c4");
  assert.equal(cart.ok, true);
});

test("stop paths match the hash and account-settings, and a different loopback port is another origin", () => {
  assert.equal(navigationRefusal("https://www.instacart.com/#/checkout", INSTACART_HOSTS), "blocked-path");
  assert.equal(navigationRefusal("https://www.instacart.com/account-settings", INSTACART_HOSTS), "blocked-path");
  assert.equal(navigationRefusal("https://www.instacart.com/store/s", INSTACART_HOSTS), null);
  const otherPort = navigationRefusal("http://127.0.0.1:18082/landed", ["127.0.0.1"], ["http://127.0.0.1:18081"]);
  assert.equal(otherPort == null, false);
  assert.equal(navigationRefusal("http://127.0.0.1:18081/cart", ["127.0.0.1"], ["http://127.0.0.1:18081"]), null);
});

test("security code, PIN, and verification code are credential fields and halt", () => {
  const read = buildView(facts([
    { index: 0, label: "Security code", kind: "field", field: { type: "text", name: "cvc", autocomplete: "cc-csc" } },
    { index: 1, label: "PIN", kind: "field", field: { type: "text", name: "pin", autocomplete: "" } },
    { index: 2, label: "Note", kind: "field", field: { type: "text", name: "note", autocomplete: "off" } },
  ]), 2, generic);
  assert.equal(read.view.controls.some((control) => control.label === "Security code" || control.label === "PIN"), false);
  assert.equal(read.view.credentialFields >= 2, true);
  assert.equal(pageHalt({ blocked: "", path: "/pay", passwordFields: read.view.credentialFields, text: "Security code" }), "login_wall");
  assert.equal(pageHalt({ blocked: "", path: "/2fa", passwordFields: 1, text: "Enter the verification code" }), "login_wall");
});

test("captcha, SSO, and a bot wall halt before a click", () => {
  assert.equal(pageHalt({ blocked: "", path: "/captcha", passwordFields: 0, text: "I'm not a robot" }), "bot_wall");
  assert.equal(pageHalt({ blocked: "", path: "/sso", passwordFields: 0, text: "Continue with Google" }), "login_wall");
  assert.equal(pageHalt({ blocked: "", path: "/bot", passwordFields: 0, text: "Request unsuccessful. Powered by Imperva" }), "bot_wall");
});

test("a hidden password does not halt, and a visible password still refuses typing", () => {
  assert.equal(pageHalt({ blocked: "", path: "/fixture", passwordFields: 0, text: "Signed in" }), null);
  const visible = buildView(facts([
    { index: 0, label: "Password", kind: "field", field: { type: "password", name: "password", autocomplete: "current-password" } },
  ]), 3, generic);
  assert.equal(visible.view.controls.some((control) => control.label === "Password"), false);
});

test("a card number or SSN assembled across keystrokes is refused", () => {
  assert.equal(insertTextRefusal("41111111") == null, true);
  assert.notEqual(insertTextRefusal("11111111", "41111111"), null);
  assert.notEqual(insertTextRefusal("123-45-6789"), null);
  assert.notEqual(insertTextRefusal("6789", "123-45-"), null);
});

test("a new page with no opener is closed only when it was not already open", () => {
  assert.equal(targetVerdict({ type: "page", targetId: "pay", openerId: "own" }, "own"), "close");
  assert.equal(targetVerdict({ type: "page", targetId: "pay" }, "own", new Set(["own"])), "close");
  assert.equal(targetVerdict({ type: "page", targetId: "pay" }, "own", new Set(["own", "pay"])), "ignore");
  assert.equal(targetVerdict({ type: "service_worker", targetId: "sw" }, "own", new Set(["own"])), "ignore");
});

test("the live screen can open the first audit page and move to the next", () => {
  const audit = Array.from({ length: 45 }, (_, index) => ({
    action: `step-${index}`,
    label: `label-${index}`,
    path: "/shop",
    isTrusted: true,
    ms: 1,
    at: index,
    shot: index === 0 ? "shot-001.png" : "",
    via: "cdp" as const,
  }));
  const session: LiveSessionRecord = {
    id: "wf-shop",
    intent: "Shop",
    status: "passed",
    host: "127.0.0.1",
    updatedAt: 1,
    steps: audit.map((row) => ({ name: row.action, status: "passed", ms: 1 })),
    audit,
    note: "",
  };
  const first = liveSessionView(session, 0);
  assert.match(first, /step-0/);
  assert.match(first, /shot-001\.png/);
  assert.match(first, /id="live-pager"/);
  assert.doesNotMatch(first, /step-44/);
  const opened = liveSessionView(session);
  assert.match(opened, /shot-001\.png/);
  assert.match(opened, /Audit page 1 of/);
});

test("workflow id survives the CLI and a refused or halted MCP call is an error", () => {
  const body = liveCliBody("live_session_start", ["--workflow-id", "wf-from-the-flag", "--intent", "Shop"]);
  assert.equal(body.workflowId, "wf-from-the-flag");
  for (const kind of ["rejected", "refused", "halted"]) {
    assert.equal(liveToolResult({ outcome: { kind } }).isError, true, kind);
  }
  assert.equal(liveToolResult({ outcome: { kind: "applied" } }).isError, false);
});

test("a dead lock holder is stale and the lock records a pid", async () => {
  const parsed = parseLock("agent=bao-live\nstartedAt=1\npid=999999\n") as { agentId: string; startedAt: number; pid?: number };
  assert.equal(parsed.pid, 999999);
  const exited = path.join(mkdtempSync(path.join(tmpdir(), "bao-exit-lock-")), "lock");
  const child = spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(__dirname, "../../src/cdp-live/lock.js"))}).acquireCdpLock("child", { file: ${JSON.stringify(exited)} }).then(() => { console.log(require("node:fs").readFileSync(${JSON.stringify(exited)}, "utf8")); process.exit(0); })`], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(parseLock(child.stdout)?.pid, child.pid);
  assert.equal(existsSync(exited), false);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "bao-dead-lock-")), "lock");
  writeFileSync(file, "agent=bao-live\nstartedAt=1\npid=999999\n");
  let waits = 0;
  await acquireCdpLock("next", {
    file,
    now: () => 10,
    timeoutMs: 0,
    sleep: async () => {
      waits += 1;
      if (waits > 1) throw new Error("not stale");
    },
  });
  assert.equal(waits, 0);
  releaseCdpLock("next", file);
});

test("a stale lock that cannot be removed fails at the deadline instead of spinning", { skip: process.getuid?.() === 0 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-stuck-lock-"));
  const file = path.join(dir, "lock");
  writeFileSync(file, "agent=bao-live\nstartedAt=1\npid=999999\n");
  chmodSync(dir, 0o500);
  let now = 0;
  let sleeps = 0;
  try {
    await assert.rejects(acquireCdpLock("next", {
      file,
      now: () => now,
      timeoutMs: 1_000,
      sleep: async (ms) => {
        sleeps += 1;
        now += ms;
      },
    }), /cdp lock is held/);
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.equal(sleeps, 2);
  assert.equal(existsSync(file), true);
});

test("a release from another pid leaves the holder's lock, and closing an idle host does too", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-foreign-lock-"));
  const file = path.join(home, "lock");
  writeFileSync(file, `agent=bao-live\nstartedAt=${Date.now()}\npid=${process.ppid}\n`);
  releaseCdpLock("bao-live", file);
  assert.equal(existsSync(file), true);
  writeFileSync(file, `agent=bao-live\nstartedAt=${Date.now()}\n`);
  await createLiveHost({ home, lockFile: file }).close();
  assert.equal(existsSync(file), true);
});

test("the live entry refuses a stop path before navigation and keeps a blocked path distinct from a host miss", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-live-guard-"));
  const host = createLiveHost({ home, lockFile: path.join(home, "lock") });
  const portFile = path.join(home, "DevToolsActivePort");
  const checkout = await host.call({
    op: "live_session_start",
    intent: "Shop",
    url: "http://127.0.0.1:9/checkout",
    portFile,
    preset: "generic",
    workflowId: "wf-from-the-flag",
  }) as { outcome?: { kind?: string; reason?: string }; session?: string };
  assert.equal(checkout.outcome?.reason, "stop-path");
  assert.equal(checkout.session, "");
  const hash = await host.call({
    op: "live_session_start",
    intent: "Shop",
    url: "https://www.instacart.com/#/checkout",
    portFile,
    preset: "instacart",
  }) as { outcome?: { reason?: string } };
  assert.equal(hash.outcome?.reason, "blocked-path");
  const account = await host.call({
    op: "live_session_start",
    intent: "Shop",
    url: "https://www.instacart.com/account-settings",
    portFile,
    preset: "instacart",
  }) as { outcome?: { reason?: string } };
  assert.equal(account.outcome?.reason, "blocked-path");
  await host.close();
});

function replayTarget(pages: PageFacts[], marked?: PageFacts, blockOnClick = ""): { target: ReplayTarget; clicks: string[] } {
  const clicks: string[] = [];
  let at = 0;
  let blockedNav = "stale-block";
  const driver = {
    setOrigins: () => undefined,
    goto: async () => undefined,
    evaluateFunction: async (_fn: unknown, arg: { markIndex: number }) => {
      if (arg.markIndex >= 0 && marked) return marked;
      return pages[Math.min(at, pages.length - 1)];
    },
    clickCss: async (selector: string) => {
      clicks.push(selector);
      blockedNav = blockOnClick;
      if (!blockOnClick) at += 1;
    },
    takeBlockedNav: () => {
      const reason = blockedNav;
      blockedNav = "";
      return reason;
    },
  } as unknown as ReplayTarget["driver"];
  return { target: { driver, guard: generic, stopPath: generic.stopPath, hosts: ["127.0.0.1"], origins: ["http://127.0.0.1"] }, clicks };
}

function liveStep(index: number, action: "click" | "type", name: string, extra: Partial<WorkflowStep> = {}): WorkflowStep {
  const role = action === "type" ? "textbox" : "button";
  return {
    id: `wf-shop-${index}`,
    index,
    action,
    label: action === "type" ? "Type {{text}}" : `Click "${name}"`,
    surface: "dom",
    timeoutMs: 8000,
    identity: { surface: "dom", role, name, path: [] },
    locators: [{ kind: "role", role, name }],
    ...extra,
  };
}

function liveWorkflow(steps: WorkflowStep[], inputs: WorkflowV2["inputs"] = []): WorkflowV2 {
  return {
    schema: WORKFLOW_SCHEMA_ID,
    version: 2,
    id: "wf-shop",
    name: "Shop",
    startUrl: "http://127.0.0.1/shop",
    inputs,
    steps,
    createdAt: 1,
    driver: "cdp-live",
  };
}

function addTwice(): WorkflowV2 {
  return liveWorkflow([liveStep(0, "click", "Add to cart"), liveStep(1, "click", "Add to cart")]);
}

test("live replay refuses while another session holds the cdp lock", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-live-replay-"));
  const file = path.join(home, "lock");
  await acquireCdpLock("session", { file, timeoutMs: 0 });
  const { target, clicks } = replayTarget([facts([{ index: 0, label: "Add to cart", kind: "button" }])]);
  await assert.rejects(replayLive(target, addTwice(), file), /cdp lock is held/);
  assert.deepEqual(clicks, []);
  assert.equal(parseLock(readFileSync(file, "utf8"))?.agentId, "session");
  releaseCdpLock("session", file);
});

test("live replay stops for a person on a halt page and releases the lock", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-live-replay-"));
  const file = path.join(home, "lock");
  const shop = facts([{ index: 0, label: "Add to cart", kind: "button" }]);
  const wall = facts([{ index: 0, label: "Add to cart", kind: "button" }], { text: "I'm not a robot" });
  const workflow = addTwice();
  const { target, clicks } = replayTarget([shop, wall]);
  const result = await replayLive(target, workflow, file);
  assert.equal(result.status, "needs_human");
  assert.equal(result.stoppedAt, workflow.steps[1]?.id);
  assert.equal(clicks.length, 1);
  assert.equal(existsSync(file), false);
  const landed = replayTarget([shop, shop, wall]);
  const end = await replayLive(landed.target, workflow, file);
  assert.equal(end.status, "needs_human");
  assert.equal(landed.clicks.length, 2);
  const clean = replayTarget([shop]);
  assert.equal((await replayLive(clean.target, workflow, file)).status, "passed");
  assert.equal(existsSync(file), false);
  const checkout = replayTarget([shop, facts([{ index: 0, label: "Add to cart", kind: "button" }], { path: "/checkout" })]);
  const stopped = await replayLive(checkout.target, workflow, file);
  assert.equal(stopped.status, "needs_human");
  assert.equal(stopped.reason, "stop-path");
  assert.equal(checkout.clicks.length, 1);
});

test("live replay fails the step whose click navigation the guard blocked", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "bao-live-replay-")), "lock");
  const shop = facts([{ index: 0, label: "Add to cart", kind: "button" }]);
  const workflow = addTwice();
  const blocked = replayTarget([shop], undefined, "off-origin");
  const result = await replayLive(blocked.target, workflow, file);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "off-origin");
  assert.equal(result.stoppedAt, workflow.steps[0]?.id);
  assert.deepEqual(result.steps.map((step) => step.status), ["failed", "skipped"]);
  assert.equal(blocked.clicks.length, 1);
  assert.equal(existsSync(file), false);
});

test("live replay refuses a control that moved before the click, and names the step it stopped on", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "bao-live-replay-")), "lock");
  const shop = facts([{ index: 0, label: "Add to cart", kind: "button" }]);
  const moved = facts([{ index: 0, label: "Place your order", kind: "button" }]);
  const workflow = addTwice();
  const stale = replayTarget([shop], moved);
  const result = await replayLive(stale.target, workflow, file);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "stale_ref");
  assert.equal(result.stoppedAt, workflow.steps[0]?.id);
  assert.deepEqual(result.steps.map((step) => step.status), ["failed", "skipped"]);
  assert.deepEqual(stale.clicks, []);
  const missing = await replayLive(replayTarget([facts([])]).target, workflow, file);
  assert.equal(missing.stoppedAt, workflow.steps[0]?.id);
  assert.equal(missing.reason, "not_found");
  const typed = liveWorkflow([
    liveStep(0, "click", "Add to cart"),
    liveStep(1, "type", "Instructions", { input: "text", value: "{{text}}" }),
  ], [{ name: "text", type: "text", required: true, default: "milk" }]);
  const human = await replayLive(replayTarget([shop]).target, typed, file);
  assert.equal(human.status, "needs_human");
  assert.deepEqual(human.steps.map((step) => step.status), ["passed", "needs_human"]);
});

test("live replay skips an Add whose result is already on the page, and runs it when it is not", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "bao-live-replay-")), "lock");
  const workflow = liveWorkflow([
    liveStep(0, "click", "Add 1 ct Blueberries", { when: { absent: "Increment quantity of Blueberries" } }),
  ]);
  const inCart = replayTarget([facts([
    { index: 0, label: "Remove Blueberries", kind: "button" },
    { index: 1, label: "Increment quantity of Blueberries", kind: "button" },
  ])]);
  const skipped = await replayLive(inCart.target, workflow, file);
  assert.equal(skipped.status, "passed");
  assert.deepEqual(inCart.clicks, []);
  const empty = replayTarget([
    facts([{ index: 0, label: "Add 1 ct Blueberries", kind: "button" }]),
    facts([{ index: 0, label: "Increment quantity of Blueberries", kind: "button" }]),
  ]);
  const added = await replayLive(empty.target, workflow, file);
  assert.equal(added.status, "passed");
  assert.equal(empty.clicks.length, 1);
});

test("live replay finds a saved control whose name has digits the view redacts", async () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "bao-live-replay-")), "lock");
  const name = "Add 1 ct Kirkland Signature Bath Tissue, 380 sheets";
  const workflow = liveWorkflow([liveStep(0, "click", name)]);
  const shop = replayTarget([facts([{ index: 0, label: name, kind: "button" }])]);
  const result = await replayLive(shop.target, workflow, file);
  assert.equal(result.status, "passed");
  assert.equal(shop.clicks.length, 1);
});

test("a click or type plan holds only while the marked control keeps its label and kind", () => {
  const before = buildView(facts([
    { index: 0, label: "Add to cart", kind: "button" },
    { index: 1, label: "Instructions", kind: "field", field: { type: "text", name: "note", autocomplete: "" } },
  ]), 3, generic);
  const same = buildView(facts([
    { index: 0, label: "Add to cart", kind: "button" },
    { index: 1, label: "Instructions", kind: "field", field: { type: "text", name: "note", autocomplete: "" } },
  ]), 3, generic);
  assert.equal(sameTarget(before, same, "e3.c0"), true);
  assert.equal(sameTarget(before, same, "e3.c1"), true);
  const shifted = buildView(facts([
    { index: 0, label: "Place your order", kind: "button" },
    { index: 1, label: "Card number", kind: "field", field: { type: "text", name: "cc", autocomplete: "cc-number" } },
  ]), 3, generic);
  assert.equal(sameTarget(before, shifted, "e3.c0"), false);
  assert.equal(sameTarget(before, shifted, "e3.c1"), false);
  const relabeled = buildView(facts([{ index: 0, label: "Remove", kind: "button" }]), 3, generic);
  assert.equal(sameTarget(before, relabeled, "e3.c0"), false);
});

test("a page that lands on a stop path halts", () => {
  assert.equal(pageHalt({ blocked: "", path: "/checkout", passwordFields: 0, stopPath: generic.stopPath }), "stop-path");
  assert.equal(pageHalt({ blocked: "", path: "/#/payment", passwordFields: 0, stopPath: generic.stopPath }), "stop-path");
  assert.equal(pageHalt({ blocked: "", path: "/shop", passwordFields: 0, stopPath: generic.stopPath }), null);
});

function fakeCdp(): { cdp: CdpSocket; sent: { method: string; params: Record<string, unknown> }[]; emit(method: string, params: Record<string, unknown>): void } {
  const sent: { method: string; params: Record<string, unknown> }[] = [];
  const handlers = new Map<string, (params: Record<string, unknown>) => void>();
  const cdp = {
    send: async (method: string, params: Record<string, unknown> = {}) => {
      sent.push({ method, params });
      return {};
    },
    on: (method: string, _session: string | undefined, handler: (params: Record<string, unknown>) => void) => {
      handlers.set(method, handler);
    },
  } as unknown as CdpSocket;
  return { cdp, sent, emit: (method, params) => handlers.get(method)?.(params) };
}

test("the live window blocks only its own main frame, stops a load on a stop path, and an attached tab is not intercepted", async () => {
  const own = fakeCdp();
  const driver = new CdpLiveDriver(own.cdp, "s", "MAIN", ["127.0.0.1"]);
  driver.setOrigins(["http://127.0.0.1"]);
  await driver.start();
  assert.equal(own.sent.some((item) => item.method === "Fetch.enable"), true);
  own.emit("Fetch.requestPaused", { requestId: "r1", frameId: "IFRAME", request: { url: "https://www.google.com/recaptcha/api2/anchor" } });
  assert.equal(driver.takeBlockedNav(), "");
  own.emit("Fetch.requestPaused", { requestId: "r2", frameId: "MAIN", request: { url: "https://evil.example/" } });
  assert.equal(driver.takeBlockedNav(), "evil.example");
  own.emit("Fetch.requestPaused", { requestId: "r3", frameId: "MAIN", request: { url: "http://127.0.0.1/shop" } });
  driver.setStopPath(generic.stopPath);
  own.emit("Fetch.requestPaused", { requestId: "r4", frameId: "MAIN", request: { url: "http://127.0.0.1/checkout?step=1" } });
  assert.equal(driver.takeBlockedNav(), "stop-path");
  own.emit("Fetch.requestPaused", { requestId: "r5", frameId: "MAIN", request: { url: "http://127.0.0.1/cart" } });
  const verdict = (id: string) => own.sent.find((item) => item.params.requestId === id)?.method;
  assert.equal(verdict("r1"), "Fetch.continueRequest");
  assert.equal(verdict("r2"), "Fetch.failRequest");
  assert.equal(verdict("r3"), "Fetch.continueRequest");
  assert.equal(verdict("r4"), "Fetch.failRequest");
  assert.equal(verdict("r5"), "Fetch.continueRequest");
  const attached = fakeCdp();
  await new CdpLiveDriver(attached.cdp, "s", "TAB", ["127.0.0.1"], true).start();
  assert.equal(attached.sent.some((item) => item.method === "Fetch.enable"), false);
});
