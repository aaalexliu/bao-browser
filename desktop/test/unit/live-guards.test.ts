import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { liveSessionView } from "../../src/app/live-view";
import { insertTextRefusal, navigationRefusal, INSTACART_HOSTS } from "../../src/cdp-live/allowlist";
import { buildView, pageHalt, planClick, targetVerdict, type PageFacts } from "../../src/cdp-live/live-ops";
import { liveCliBody } from "../../src/mcp/live-proxy";
import { acquireCdpLock, parseLock, releaseCdpLock } from "../../src/cdp-live/lock";
import { guardPreset } from "../../src/cdp-live/presets";
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
  ]), 1, generic.commit, generic.deny);
  assert.equal(read.view.controls.some((control) => /place|delete|pay now/i.test(control.label)), false);
  assert.equal(planClick(read, "e1.c0").ok, false);
  assert.equal(planClick(read, "e1.c1").ok, false);
  assert.equal(planClick(read, "e1.c2").ok, false);
  const pay = buildView(facts([{ index: 0, label: "Pay now", kind: "button" }]), 1, instacart.commit, instacart.deny);
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
  ]), 2, generic.commit, generic.deny);
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
  ]), 3, generic.commit);
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
  const source = readFileSync(path.join(process.cwd(), "desktop/src/mcp/live-proxy.ts"), "utf8");
  assert.match(source, /isError[\s\S]{0,160}refused/);
  assert.match(source, /isError[\s\S]{0,160}halted/);
});

test("a dead lock holder is stale and the lock records a pid", async () => {
  const parsed = parseLock("agent=bao-live\nstartedAt=1\npid=999999\n") as { agentId: string; startedAt: number; pid?: number };
  assert.equal(parsed.pid, 999999);
  const source = readFileSync(path.join(process.cwd(), "desktop/src/cdp-live/lock.ts"), "utf8");
  assert.match(source, /pid/);
  assert.match(source, /process\.on\("exit"/);
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
  releaseCdpLock("next", file);
});

test("live Chrome stays allowed when Screen Recording is granted", () => {
  const host = readFileSync(path.join(process.cwd(), "desktop/src/cdp-live/live-host.ts"), "utf8");
  const session = readFileSync(path.join(process.cwd(), "desktop/src/cdp-live/session.ts"), "utf8");
  assert.equal(host.includes("screen recording is granted"), false);
  assert.equal(session.includes("screen recording is granted"), false);
  assert.match(host, /liveChromeBlock/);
  assert.match(session, /liveChromeBlock/);
});
