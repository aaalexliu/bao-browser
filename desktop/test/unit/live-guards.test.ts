import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { liveSessionView } from "../../src/app/live-view";
import { insertTextRefusal, navigationRefusal, INSTACART_HOSTS } from "../../src/cdp-live/allowlist";
import { buildView, markedFieldValue, pageHalt, planClick, readLivePage, sameTarget, targetVerdict, type PageFacts } from "../../src/cdp-live/live-ops";
import { liveCliBody, liveToolResult } from "../../src/mcp/live-proxy";
import { acquireCdpLock, parseLock, releaseCdpLock } from "../../src/cdp-live/lock";
import { createLiveHost } from "../../src/cdp-live/live-host";
import { GuardedLiveDriver, liveReplayArgs, liveScope, replayGuarded, replayLiveWorkflow, type LiveWindow } from "../../src/cdp-live/live-replay";
import { CdpLiveDriver } from "../../src/cdp-live/driver";
import type { CdpSocket } from "../../src/cdp-live/socket";
import { guardPreset } from "../../src/cdp-live/presets";
import { WORKFLOW_SCHEMA_ID, type Identity, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";
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

test("a host with its own live lock drives only its configured Chrome, whatever port file a call names", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-live-own-lock-"));
  const lockFile = path.join(home, "lock");
  const configured = path.join(home, "own", "DevToolsActivePort");
  const host = createLiveHost({
    home,
    lockFile,
    target: { kind: "throwaway", portFile: configured },
    helper: () => {
      throw new Error("no helper call");
    },
  });
  const start = (portFile: string) => host.call({
    op: "live_session_start",
    intent: "Shop",
    url: "https://www.instacart.com/store/costco/storefront",
    portFile,
  }) as Promise<{ outcome?: { kind?: string; reason?: string } }>;
  try {
    const other = await start(path.join(home, "other", "DevToolsActivePort"));
    assert.deepEqual(other.outcome, { kind: "rejected", reason: "this app has its own live lock, so it drives only its configured Chrome" });
    const own = await start(configured);
    assert.deepEqual(own.outcome, { kind: "rejected", reason: "the live target has no DevToolsActivePort" });
    assert.equal(existsSync(lockFile), false);
  } finally {
    await host.close();
  }
});

interface FakeControl {
  label: string;
  kind: "button" | "link" | "field" | "submit";
  href?: string;
  form?: string;
  field?: { type: string; name: string; autocomplete: string };
  /** On the page, but not a control the live view lists. */
  unlisted?: boolean;
}

interface FakePage {
  path?: string;
  text?: string;
  controls: FakeControl[];
}

/**
 * A live window over a list of pages. A click or a key press moves to the next page.
 * tree() gives each control the handle of its index, and readLivePage marks by that handle.
 */
function liveWindow(pages: FakePage[], opts: { moved?: FakePage; blockOnClick?: string } = {}): { window: LiveWindow; calls: string[] } {
  let at = 0;
  let blocked = "";
  const calls: string[] = [];
  const handles = new WeakMap<Identity, string>();
  const page = (): FakePage => pages[Math.min(at, pages.length - 1)]!;
  const url = (): string => `http://127.0.0.1${page().path || "/shop"}`;
  const role = (control: FakeControl): string => (control.kind === "field" ? "textbox" : control.kind === "link" ? "link" : "button");
  const factsOf = (shown: FakePage, handle?: string): PageFacts => {
    const listed = shown.controls.map((control, index) => ({ control, index })).filter(({ control }) => !control.unlisted);
    return {
      path: shown.path || "/shop",
      title: "Shop",
      headings: [],
      blocked: "",
      text: shown.text || "",
      controls: listed.map(({ control, index }) => ({
        index,
        label: control.label,
        kind: control.kind,
        href: control.href || "",
        form: control.form || "",
        field: control.field,
      })),
      ...(handle === undefined ? {} : { marked: listed.find(({ index }) => String(index) === handle)?.index ?? -1 }),
    };
  };
  const fake = {
    tree: async () => {
      const nodes = page().controls.map((control, index) => {
        const node: Identity = { surface: "dom", role: role(control), name: control.label, path: [] };
        handles.set(node, String(index));
        return node;
      });
      return { nodes, url: url(), texts: [page().text || ""], values: [] };
    },
    handleOf: (node: Identity) => handles.get(node) || "",
    snapshot: async () => ({ dom: [] }),
    pageSignals: async () => ({ url: url(), title: "Shop", texts: [], iframeSrcs: [], markers: [], widgets: [], hasPassword: false, closes: [], cookies: [] }),
    waitIdle: async () => undefined,
    sleep: async () => undefined,
    goto: async (to: string) => {
      calls.push(`goto ${to}`);
    },
    evaluateFunction: async (fn: unknown, arg: { markIndex?: number; markHandle?: string }) => {
      if (fn === readLivePage) {
        if ((arg.markIndex ?? -1) >= 0 && opts.moved) return factsOf(opts.moved);
        return factsOf(page(), arg.markHandle);
      }
      if (fn === markedFieldValue) return "";
      calls.push(`${(fn as { name: string }).name} ${arg.markIndex}`);
      return undefined;
    },
    clickCss: async (selector: string) => {
      calls.push(`click ${page().controls[Number(/\d+/.exec(selector)?.[0])]?.label}`);
      if (opts.blockOnClick) blocked = opts.blockOnClick;
      else at += 1;
    },
    markTrust: () => undefined,
    insertText: async (text: string) => {
      calls.push(`insert ${text}`);
    },
    pressMarked: async (key: string, index: number) => {
      calls.push(`press ${key} ${page().controls[index]?.label ?? ""}`.trim());
      at += 1;
    },
    takeBlockedNav: () => {
      const reason = blocked;
      blocked = "";
      return reason;
    },
    returnFromBlock: async () => {
      calls.push("returnFromBlock");
    },
  };
  return { window: fake as unknown as LiveWindow, calls };
}

const SHOP_SCOPE = liveScope("http://127.0.0.1/shop", "generic");

function liveStep(index: number, action: WorkflowStep["action"], name: string, extra: Partial<WorkflowStep> = {}): WorkflowStep {
  const role = action === "type" ? "textbox" : "button";
  return {
    id: `wf-shop-${index}`,
    index,
    action,
    label: action === "type" ? "Type {{query}}" : `Click "${name}"`,
    surface: "dom",
    timeoutMs: 100,
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

async function guarded(workflow: WorkflowV2, pages: FakePage[], opts: { moved?: FakePage; blockOnClick?: string; inputs?: Record<string, string> } = {}) {
  const { window, calls } = liveWindow(pages, opts);
  const run = await replayGuarded(workflow, opts.inputs || {}, new GuardedLiveDriver(window, SHOP_SCOPE), "run-test");
  return { run, calls };
}

const ADD_TO_CART: FakePage = { controls: [{ label: "Add to cart", kind: "button" }] };

test("a live replay waits for the cdp lock a session holds, and does not connect", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-live-replay-"));
  const file = path.join(home, "lock");
  const portFile = path.join(home, "DevToolsActivePort");
  writeFileSync(portFile, "9\n/devtools/browser/fake\n");
  await acquireCdpLock("bao-live", { file, timeoutMs: 0 });
  const opened: string[] = [];
  await assert.rejects(replayLiveWorkflow(addTwice(), {}, {
    target: { kind: "throwaway", portFile },
    lockFile: file,
    openProfile: async () => {
      opened.push("window");
    },
    axLog: path.join(home, "ax.jsonl"),
  }), /cdp lock is held/);
  assert.deepEqual(opened, []);
  assert.equal(parseLock(readFileSync(file, "utf8"))?.agentId, "bao-live");
  releaseCdpLock("bao-live", file);
  await assert.rejects(replayLiveWorkflow({ ...addTwice(), driver: "playwright" }, {}, {
    target: { kind: "throwaway", portFile },
    lockFile: file,
    openProfile: async () => undefined,
    axLog: path.join(home, "ax.jsonl"),
  }), /not a live workflow/);
});

test("the replay scope comes from the start url's preset, not a default host list", () => {
  const shop = liveScope("https://www.instacart.com/store/costco/storefront");
  assert.equal(shop.preset, "instacart");
  assert.deepEqual(shop.hosts, ["www.instacart.com", "instacart.com"]);
  assert.deepEqual(shop.origins, ["https://www.instacart.com", "https://instacart.com", "http://instacart.com"]);
  assert.equal(shop.guard.deny, instacart.deny);
  const other = liveScope("http://127.0.0.1:8080/shop");
  assert.equal(other.preset, "generic");
  assert.deepEqual(other.hosts, ["127.0.0.1"]);
  assert.deepEqual(other.origins, ["http://127.0.0.1:8080"]);
  assert.throws(() => liveScope("http://127.0.0.1/shop", "nope"), /unknown preset/);
});

test("replay inputs start from the recorded defaults, and an empty value keeps the default", () => {
  const workflow = liveWorkflow([], [
    { name: "query", type: "text", required: true, default: "blueberries" },
    { name: "count", type: "number", required: false, default: "2" },
    { name: "pin", type: "secret", required: false },
  ]);
  assert.deepEqual(liveReplayArgs(workflow, {}), { query: "blueberries", count: 2 });
  assert.deepEqual(liveReplayArgs(workflow, { query: "" }), { query: "blueberries", count: 2 });
  assert.deepEqual(liveReplayArgs(workflow, { query: "strawberries", pin: "1234" }), { query: "strawberries", count: 2, pin: "1234" });
});

test("a guarded replay types the input over the field's text, presses Enter on that field, and clicks the Add", async () => {
  const search: FakeControl = { label: "Search Costco", kind: "field", form: "search", field: { type: "search", name: "k", autocomplete: "off" } };
  const workflow = liveWorkflow([
    liveStep(0, "type", "Search Costco", { input: "query", value: "{{query}}" }),
    liveStep(1, "key", "Search Costco", { key: "Enter", identity: { surface: "dom", role: "textbox", name: "Search Costco", path: [] }, locators: [{ kind: "role", role: "textbox", name: "Search Costco" }] }),
    liveStep(2, "click", "Add 1 ct Blueberries"),
  ], [{ name: "query", type: "text", required: true, default: "blueberries" }]);
  const pages: FakePage[] = [
    { controls: [search] },
    { path: "/s", controls: [search, { label: "Add 1 ct Blueberries", kind: "button" }] },
    { path: "/s", controls: [search, { label: "Increment quantity of Blueberries", kind: "button" }] },
  ];
  const organic = await guarded(workflow, pages, { inputs: { query: "organic blueberries" } });
  assert.equal(organic.run.status, "passed", JSON.stringify(organic.run.failure));
  assert.equal(organic.run.modelCalls, 0);
  assert.deepEqual(organic.calls, [
    "focusLiveMark 0",
    "selectLiveMark 0",
    "insert organic blueberries",
    "press Enter Search Costco",
    "click Add 1 ct Blueberries",
  ]);
  const plain = await guarded(workflow, pages);
  assert.ok(plain.calls.includes("insert blueberries"), plain.calls.join(", "));
});

test("a guarded replay pauses for a person on a bot wall or a stop path, and on a new window", async () => {
  const wall: FakePage = { text: "I'm not a robot", controls: [{ label: "Add to cart", kind: "button" }] };
  const bot = await guarded(addTwice(), [ADD_TO_CART, wall]);
  assert.equal(bot.run.status, "paused");
  assert.equal(bot.run.pausedKind, "wall");
  assert.equal(bot.run.pausedStepId, "wf-shop-1");
  assert.deepEqual(bot.run.steps.map((step) => [step.status, step.reason ?? ""]), [["passed", ""], ["paused", "bot_wall"]]);
  assert.match(bot.run.ask?.instruction || "", /bot check/);
  assert.deepEqual(bot.calls, ["click Add to cart"]);
  assert.equal(bot.run.modelCalls, 0);

  const checkout: FakePage = { path: "/checkout", controls: [{ label: "Add to cart", kind: "button" }] };
  const stopped = await guarded(addTwice(), [ADD_TO_CART, checkout]);
  assert.equal(stopped.run.status, "paused");
  assert.equal(stopped.run.steps[1]?.reason, "stop-path");
  assert.deepEqual(stopped.calls, ["click Add to cart"]);

  const { window, calls } = liveWindow([ADD_TO_CART]);
  const driver = new GuardedLiveDriver(window, SHOP_SCOPE);
  driver.halted = "new_target";
  const popped = await replayGuarded(addTwice(), {}, driver, "run-popup");
  assert.equal(popped.status, "paused");
  assert.equal(popped.steps[0]?.reason, "new_target");
  assert.deepEqual(calls, []);
});

test("a guarded replay refuses a confirm or denied control, a blocked load, a control that moved, and a control the live view does not list", async () => {
  const order = await guarded(liveWorkflow([liveStep(0, "click", "Place your order")]), [{ controls: [{ label: "Place your order", kind: "button" }] }]);
  assert.equal(order.run.status, "failed");
  assert.equal(order.run.failure?.reason, "stop_before_confirm");
  const account = await guarded(liveWorkflow([liveStep(0, "click", "Delete account")]), [{ controls: [{ label: "Delete account", kind: "button" }] }]);
  assert.equal(account.run.failure?.reason, "denied");
  const away = await guarded(liveWorkflow([liveStep(0, "click", "Deals")]), [{ controls: [{ label: "Deals", kind: "link", href: "https://evil.example/deals" }] }]);
  assert.equal(away.run.failure?.reason, "url is not on the host list");
  assert.deepEqual([...order.calls, ...account.calls, ...away.calls], []);

  const blocked = await guarded(addTwice(), [ADD_TO_CART], { blockOnClick: "evil.example" });
  assert.equal(blocked.run.status, "failed");
  assert.equal(blocked.run.failure?.reason, "evil.example");
  assert.deepEqual(blocked.run.steps.map((step) => step.status), ["failed", "pending"]);
  assert.deepEqual(blocked.calls, ["click Add to cart"]);

  const moved = await guarded(addTwice(), [ADD_TO_CART], { moved: { controls: [{ label: "Place your order", kind: "button" }] } });
  assert.equal(moved.run.failure?.reason, "stale_ref");
  assert.deepEqual(moved.calls, []);

  const hidden = await guarded(addTwice(), [{ controls: [{ label: "Add to cart", kind: "button", unlisted: true }] }]);
  assert.equal(hidden.run.failure?.reason, "not_a_live_control");
  assert.deepEqual(hidden.calls, []);
  for (const run of [order, account, away, blocked, moved, hidden]) assert.equal(run.run.modelCalls, 0);
});

test("a guarded replay skips an Add whose result is already on the page, and runs it when it is not", async () => {
  const workflow = liveWorkflow([
    liveStep(0, "click", "Add 1 ct Blueberries", { when: { absent: "Increment quantity of Blueberries" } }),
  ]);
  const inCart = await guarded(workflow, [{ controls: [
    { label: "Remove Blueberries", kind: "button" },
    { label: "Increment quantity of Blueberries", kind: "button" },
  ] }]);
  assert.equal(inCart.run.status, "passed");
  assert.equal(inCart.run.steps[0]?.reason, "already done");
  assert.deepEqual(inCart.calls, []);
  const empty = await guarded(workflow, [{ controls: [{ label: "Add 1 ct Blueberries", kind: "button" }] }]);
  assert.equal(empty.run.status, "passed");
  assert.deepEqual(empty.calls, ["click Add 1 ct Blueberries"]);
});

test("a guarded replay does not type a secret, a card number, or into a credential field", async () => {
  const note: FakeControl = { label: "Note", kind: "field", field: { type: "text", name: "note", autocomplete: "" } };
  const typed = (value: string, extra: Partial<WorkflowStep> = {}) => liveWorkflow([liveStep(0, "type", "Note", { value, ...extra })]);
  const card = await guarded(typed("4111 1111 1111 1111"), [{ controls: [note] }]);
  assert.equal(card.run.failure?.reason, "cdp-live does not type card numbers");
  const secret = await guarded(typed("hunter2", { sensitive: true, value: undefined, input: "pin" }), [{ controls: [note] }], { inputs: { pin: "hunter2" } });
  assert.equal(secret.run.status, "failed");
  const pin: FakeControl = { label: "PIN", kind: "field", field: { type: "text", name: "pin", autocomplete: "" } };
  const credential = await guarded(liveWorkflow([liveStep(0, "type", "PIN", { value: "1234" })]), [{ controls: [pin] }]);
  assert.equal(credential.run.failure?.reason, "credential_field");
  assert.deepEqual([...card.calls, ...secret.calls, ...credential.calls].filter((call) => call.startsWith("insert")), []);
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
