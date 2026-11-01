import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { TEST_MEDIA_ARGS } from "../../src/test-browser.js";
import { openLiveWindow, type CdpLiveDriver } from "../../src/cdp-live/driver";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { clickLive, pressLiveKey, scrollLive, typeLive, type LiveActTarget } from "../../src/cdp-live/live-act";
import {
  buildView,
  focusLiveMark,
  LIVE_PAGE_SIZE,
  planClick,
  planKey,
  planScroll,
  readLivePage,
  sameTarget,
  viewPage,
  type LabelGuard,
  type LiveRead,
  type PageFacts,
} from "../../src/cdp-live/live-ops";
import { guardPreset } from "../../src/cdp-live/presets";
import { connectCdp } from "../../src/cdp-live/socket";
import { workflowFromTrail } from "../../src/cdp-live/live-trail";
import { liveCliBody } from "../../src/mcp/live-proxy";
import type { TrailEvent } from "../../src/v1/interpret";
import { validateWorkflow } from "../../src/v1/schema";

const generic = guardPreset("generic");
const instacart = guardPreset("instacart");
const books = guardPreset("books");

function facts(controls: PageFacts["controls"], extra: Partial<PageFacts> = {}): PageFacts {
  return { path: "/", title: "Shop", headings: [], blocked: "", controls, ...extra };
}

function refOf(read: LiveRead, label: string): string {
  const ref = read.view.controls.find((control) => control.label === label)?.ref || "";
  assert.ok(ref, `${label} has a ref`);
  return ref;
}

function refusal(plan: ReturnType<typeof planClick>): string {
  return plan.ok ? "" : plan.refusal;
}

test("under the instacart preset a form's Add to cart is clicked and checkout never is", () => {
  const read = buildView(facts([
    { index: 0, label: "Add to cart", kind: "submit" },
    { index: 1, label: "Add 1 ct Kirkland Signature Organic Blueberries, 3 lbs", kind: "submit" },
    { index: 2, label: "Add", kind: "submit" },
    { index: 3, label: "Checkout", kind: "submit" },
    { index: 4, label: "Go to checkout", kind: "button" },
    { index: 5, label: "Place order", kind: "submit" },
    { index: 6, label: "Place your order", kind: "button" },
    { index: 7, label: "Continue", kind: "submit" },
    { index: 8, label: "Review order", kind: "submit" },
    { index: 9, label: "Decrement quantity", kind: "submit" },
    { index: 10, label: "Remove Kirkland Signature Organic Blueberries, 3 lbs", kind: "submit" },
    { index: 11, label: "Remove all", kind: "submit" },
    { index: 12, label: "Add address", kind: "submit" },
  ]), 1, instacart);
  assert.deepEqual(read.view.controls.map((control) => control.label), [
    "Add to cart",
    "Add 1 ct Kirkland Signature Organic Blueberries, 3 lbs",
    "Add",
    "Decrement quantity",
    "Remove Kirkland Signature Organic Blueberries, 3 lbs",
  ]);
  for (const index of [0, 1, 2, 9, 10]) assert.equal(planClick(read, `e1.c${index}`).ok, true, `c${index}`);
  for (const index of [3, 4, 5, 6, 7, 8, 11, 12]) assert.notEqual(refusal(planClick(read, `e1.c${index}`)), "", `c${index}`);
  assert.deepEqual(read.view.stopBeforeConfirm.map((item) => item.label), [
    "Checkout",
    "Go to checkout",
    "Place order",
    "Place your order",
    "Continue",
    "Review order",
    "Remove all",
    "Add address",
  ]);
});

test("the generic preset keeps refusing a form submit outside a search form, and a search form still submits", () => {
  const read = buildView(facts([
    { index: 0, label: "Add to cart", kind: "submit" },
    { index: 1, label: "Search", kind: "submit", form: "search" },
    { index: 2, label: "Place order", kind: "submit", form: "search" },
    { index: 3, label: "Add to cart", kind: "button" },
  ]), 2, generic);
  assert.equal(refusal(planClick(read, "e2.c0")), "stop_before_confirm");
  assert.equal(planClick(read, "e2.c1").ok, true);
  assert.equal(refusal(planClick(read, "e2.c2")), "stop_before_confirm");
  assert.equal(planClick(read, "e2.c3").ok, true);
  const basket = buildView(facts([
    { index: 0, label: "Add to basket", kind: "submit" },
    { index: 1, label: "Proceed to checkout", kind: "submit" },
  ]), 3, books);
  assert.equal(planClick(basket, "e3.c0").ok, true);
  assert.equal(refusal(planClick(basket, "e3.c1")), "stop_before_confirm");
});

test("checkout and place order are refused even when the caller's patterns allow them", () => {
  const open: LabelGuard = { commit: "", deny: "", submit: ".*" };
  const read = buildView(facts([
    { index: 0, label: "Checkout", kind: "button" },
    { index: 1, label: "Check out now", kind: "link" },
    { index: 2, label: "Place my order", kind: "submit" },
    { index: 3, label: "Buy now", kind: "submit", form: "search" },
    { index: 4, label: "Pay now", kind: "button" },
    { index: 5, label: "Save for later", kind: "submit" },
  ]), 4, open);
  for (const index of [0, 1, 2, 3, 4]) assert.equal(refusal(planClick(read, `e4.c${index}`)), "stop_before_confirm", `c${index}`);
  assert.equal(planClick(read, "e4.c5").ok, true);
});

test("live_key presses only Enter, Tab, and Escape, and Enter needs a ref", () => {
  const read = buildView(facts([
    { index: 0, label: "Search Costco", kind: "field", field: { type: "text", name: "q", autocomplete: "off" } },
    { index: 1, label: "View cart", kind: "button" },
  ]), 5, instacart);
  for (const key of ["a", " ", "Space", "Backspace", "ArrowDown", "enter", "Meta+a"]) {
    assert.equal(refusal(planKey(read, key, "e5.c0")), "key_not_allowed", key);
  }
  assert.equal(refusal(planKey(read, "Enter", "")), "ref_required");
  assert.deepEqual(planKey(read, "Tab", ""), { ok: true, selector: "" });
  assert.deepEqual(planKey(read, "Escape", ""), { ok: true, selector: "" });
  assert.equal(planKey(read, "Enter", "e5.c0").ok, true);
  assert.equal(planKey(read, "Enter", "e5.c1").ok, true);
  assert.equal(refusal(planKey(read, "Enter", "e4.c0")), "stale_ref");
  assert.equal(refusal(planKey(read, "Enter", "e5.c9")), "unknown_ref");
});

test("Enter in a field is judged by the field's label and the button its form submits through", () => {
  const field = (index: number, label: string, extra: Partial<PageFacts["controls"][number]> = {}) => ({
    index,
    label,
    kind: "field",
    field: { type: "text", name: `f${index}`, autocomplete: "off" },
    ...extra,
  });
  const read = buildView(facts([
    field(0, "Search Costco"),
    field(1, "Search", { form: "search", formSubmit: "" }),
    field(2, "Quantity", { formSubmit: "Add to cart" }),
    field(3, "Order note", { formSubmit: "Place order" }),
    field(4, "Promo", { formSubmit: "" }),
    field(5, "Tip amount"),
    field(6, "Gift message", { formSubmit: "Continue" }),
    field(7, "Delivery notes", { formSubmit: "Sign in" }),
    { index: 8, label: "Password", kind: "field", field: { type: "password", name: "password", autocomplete: "current-password" } },
    { index: 9, label: "Checkout", kind: "button" },
    field(10, "Order note"),
    field(11, "Search deals", { form: "search", formSubmit: "Place order" }),
    field(12, "Find", { field: { type: "search", name: "find", autocomplete: "off" } }),
  ]), 6, instacart);
  assert.equal(planKey(read, "Enter", "e6.c0").ok, true, "a search box with no form");
  assert.equal(planKey(read, "Enter", "e6.c1").ok, true, "a search form");
  assert.equal(planKey(read, "Enter", "e6.c2").ok, true, "a form that adds to the cart");
  assert.equal(refusal(planKey(read, "Enter", "e6.c3")), "denied", "instacart denies place order before the commit rule");
  assert.equal(refusal(planKey(read, "Enter", "e6.c4")), "stop_before_confirm", "an unlabeled submit is a commit");
  assert.equal(refusal(planKey(read, "Enter", "e6.c5")), "denied");
  assert.equal(refusal(planKey(read, "Enter", "e6.c6")), "stop_before_confirm");
  assert.equal(refusal(planKey(read, "Enter", "e6.c7")), "denied");
  assert.equal(refusal(planKey(read, "Enter", "e6.c8")), "credential_field");
  assert.equal(refusal(planKey(read, "Enter", "e6.c9")), "denied");
  assert.equal(refusal(planKey(read, "Tab", "e6.c9")), "denied");
  assert.equal(planKey(read, "Tab", "e6.c3").ok, true, "Tab does not submit");
  assert.equal(planKey(read, "Escape", "e6.c4").ok, true);
  assert.equal(refusal(planKey(read, "Enter", "e6.c10")), "stop_before_confirm", "a field that is not a search box needs a submit button to judge");
  assert.equal(refusal(planKey(read, "Enter", "e6.c11")), "denied", "a search form's own submit button is still judged");
  assert.equal(planKey(read, "Enter", "e6.c12").ok, true, "a search-type field");
  const generic3 = buildView(facts([field(0, "Quantity", { formSubmit: "Add to cart" })]), 7, generic);
  assert.equal(refusal(planKey(generic3, "Enter", "e7.c0")), "stop_before_confirm");
});

test("a field whose form now submits through a different button is a stale mark", () => {
  const before = buildView(facts([
    { index: 0, label: "Note", kind: "field", field: { type: "text", name: "n", autocomplete: "" }, formSubmit: "Add to cart" },
  ]), 8, instacart);
  const after = buildView(facts([
    { index: 0, label: "Note", kind: "field", field: { type: "text", name: "n", autocomplete: "" }, formSubmit: "Place order" },
  ]), 8, instacart);
  assert.equal(sameTarget(before, before, "e8.c0"), true);
  assert.equal(sameTarget(before, after, "e8.c0"), false);
});

test("live_scroll takes four directions and a ref only from the latest snapshot", () => {
  const read = buildView(facts([
    { index: 0, label: "Item 1", kind: "link" },
    { index: 1, label: "Checkout", kind: "button" },
  ]), 9, instacart);
  for (const direction of ["down", "up", "left", "right"]) assert.equal(planScroll(read, direction, "").ok, true, direction);
  assert.equal(refusal(planScroll(read, "sideways", "")), "direction_not_allowed");
  assert.equal(planScroll(read, "right", "e9.c0").ok, true);
  assert.equal(refusal(planScroll(read, "down", "e8.c0")), "stale_ref");
  assert.equal(refusal(planScroll(read, "down", "e9.c1")), "denied");
});

test("a long snapshot is read one page at a time and every page keeps the same refs", () => {
  const many = Array.from({ length: 2 * LIVE_PAGE_SIZE + 20 }, (_, index) => ({ index, label: `Item ${index}`, kind: "link" }));
  const read = buildView(facts(many), 3, instacart);
  const first = viewPage(read.view);
  assert.equal(first.page, 1);
  assert.equal(first.pages, 3);
  assert.equal(first.controlsTotal, many.length);
  assert.equal(first.controls.length, LIVE_PAGE_SIZE);
  assert.equal(first.controls[0]?.ref, "e3.c0");
  const last = viewPage(read.view, 3);
  assert.equal(last.controls.length, 20);
  assert.equal(last.controls[0]?.ref, `e3.c${2 * LIVE_PAGE_SIZE}`);
  assert.equal(viewPage(read.view, 9).page, 3);
  assert.equal(viewPage(read.view, 0).page, 1);
  assert.equal(viewPage(read.view, Number.NaN).page, 1);
  assert.equal(planClick(read, `e3.c${2 * LIVE_PAGE_SIZE + 5}`).ok, true);
  const empty = viewPage(buildView(facts([]), 4, instacart).view);
  assert.deepEqual([empty.page, empty.pages, empty.controlsTotal], [1, 1, 0]);
  assert.equal(read.view.controls.length, many.length);
});

test("the CLI passes key, scroll direction, and snapshot page", () => {
  assert.deepEqual(liveCliBody("live_key", ["--key", "Enter", "--ref", "e2.c1"]), { op: "live_key", key: "Enter", ref: "e2.c1" });
  assert.deepEqual(liveCliBody("live_scroll", ["--direction", "down"]), { op: "live_scroll", direction: "down", ref: "" });
  assert.deepEqual(liveCliBody("live_snapshot", ["--page", "2"]), { op: "live_snapshot", page: 2 });
  assert.deepEqual(liveCliBody("live_snapshot", []), { op: "live_snapshot" });
});

test("a saved live workflow keeps each key press, on its control when it had one", () => {
  const field = { surface: "dom" as const, role: "input", name: "Search Costco", nameAttr: "k", tag: "input", path: [] };
  const storefront = "https://www.instacart.com/store/costco/storefront";
  const results = "https://www.instacart.com/store/costco/s?k=blueberries";
  const events: TrailEvent[] = [
    { id: "live-1", ts: 1, kind: "act", op: "type", identity: field, value: "blueberries", literal: true, beforeUrl: storefront, afterUrl: storefront },
    { id: "live-2", ts: 2, kind: "act", op: "key", key: "Enter", identity: field, beforeUrl: storefront, afterUrl: results },
    { id: "live-3", ts: 3, kind: "act", op: "key", key: "Escape", beforeUrl: results, afterUrl: results },
    {
      id: "live-4",
      ts: 4,
      kind: "act",
      op: "click",
      identity: { surface: "dom", role: "button", name: "Add to cart", tag: "button", path: [] },
      beforeUrl: results,
      afterUrl: results,
      subtreeBefore: "",
      subtreeAfter: "1 in cart",
    },
  ];
  const doc = workflowFromTrail({
    id: "wf-blueberries",
    name: "Blueberries",
    intent: "Put Costco blueberries in the cart",
    startUrl: storefront,
    createdAt: 1,
    savedAt: 2,
    events,
    guard: instacart,
  });
  assert.deepEqual(doc.steps.map((step) => step.action), ["type", "key", "key", "click"]);
  const enter = doc.steps[1];
  assert.equal(enter?.key, "Enter");
  assert.equal(enter?.identity?.name, "Search Costco");
  assert.equal(enter?.label, "Press Enter");
  assert.equal(enter?.expect?.match, "k=blueberries");
  const escape = doc.steps[2];
  assert.equal(escape?.key, "Escape");
  assert.equal(escape?.identity, undefined);
  assert.deepEqual(validateWorkflow(doc), []);
});

interface FakeLog {
  calls: string[];
}

function fakeTarget(
  read: LiveRead,
  opts: { marked?: PageFacts; press?: Error; click?: Error; prior?: string; blockedAfter?: string; scroll?: { target: string; moved: boolean } } = {},
): { target: LiveActTarget; log: FakeLog } {
  const log: FakeLog = { calls: [] };
  let blocked = "stale";
  const driver = {
    evaluateFunction: async (fn: { name?: string }, arg: { markIndex: number; direction?: string }) => {
      log.calls.push(`${fn.name}:${arg.markIndex}${arg.direction ? `:${arg.direction}` : ""}`);
      if (fn.name === "scrollLivePage") {
        blocked = opts.blockedAfter || "";
        return opts.scroll || { target: "page", moved: true };
      }
      if (fn.name === "markedFieldValue") return opts.prior ?? "";
      return opts.marked;
    },
    clickCss: async (selector: string) => {
      log.calls.push(`click:${selector}`);
      if (opts.click) throw opts.click;
      blocked = opts.blockedAfter || "";
    },
    markTrust: () => {
      log.calls.push("markTrust");
    },
    insertText: async (text: string, prior: string, index: number) => {
      log.calls.push(`insert:${text}:${prior}:${index}`);
      if (opts.press) throw opts.press;
    },
    pressMarked: async (key: string, index: number) => {
      log.calls.push(`press:${key}:${index}`);
      if (opts.press) throw opts.press;
      blocked = opts.blockedAfter || "";
    },
    takeBlockedNav: () => {
      const reason = blocked;
      blocked = "";
      return reason;
    },
    returnFromBlock: async () => {
      log.calls.push("returnFromBlock");
    },
    sleep: async () => undefined,
  } as unknown as LiveActTarget["driver"];
  return {
    log,
    target: {
      driver,
      read,
      guard: instacart,
      stopPath: instacart.stopPath,
      hosts: ["127.0.0.1"],
      origins: ["http://127.0.0.1"],
      before: async (action, label) => {
        log.calls.push(`before:${action}:${label}`);
      },
      reread: async () => {
        log.calls.push("reread");
        return read;
      },
    },
  };
}

test("a refused key press never marks, writes, or presses, and a stale mark stops before the press", async () => {
  const shop = facts([
    { index: 0, label: "Search Costco", kind: "field", field: { type: "text", name: "q", autocomplete: "off" } },
    { index: 1, label: "Order note", kind: "field", field: { type: "text", name: "n", autocomplete: "" }, formSubmit: "Place order" },
    { index: 2, label: "Off host", kind: "link", href: "https://evil.example/" },
    { index: 3, label: "Account", kind: "link", href: "http://127.0.0.1/account" },
  ]);
  const read = buildView(shop, 1, instacart);
  for (const [key, ref, reason] of [
    ["Space", "e1.c0", "key_not_allowed"],
    ["Enter", "", "ref_required"],
    ["Enter", "e1.c1", "denied"],
    ["Enter", "e1.c2", "url is not on the host list"],
    ["Enter", "e1.c3", "stop-path"],
  ] as const) {
    const { target, log } = fakeTarget(read, { marked: shop });
    assert.deepEqual(await pressLiveKey(target, key, ref), { kind: "refused", reason }, `${key} ${ref}`);
    assert.deepEqual(log.calls, [], `${key} ${ref}`);
  }
  const moved = facts([{ index: 0, label: "Order note", kind: "field", field: { type: "text", name: "q", autocomplete: "off" } }]);
  const stale = fakeTarget(read, { marked: moved });
  assert.deepEqual(await pressLiveKey(stale.target, "Enter", "e1.c0"), { kind: "refused", reason: "stale_ref" });
  assert.deepEqual(stale.log.calls, ["readLivePage:0"]);
  const ok = fakeTarget(read, { marked: shop });
  assert.deepEqual(await pressLiveKey(ok.target, "Enter", "e1.c0"), { kind: "applied", label: "Search Costco", control: "field" });
  assert.deepEqual(ok.log.calls, ["readLivePage:0", "before:key:Enter Search Costco", "press:Enter:0"]);
  const free = fakeTarget(read);
  assert.deepEqual(await pressLiveKey(free.target, "Escape", ""), { kind: "applied", label: "", control: "" });
  assert.deepEqual(free.log.calls, ["before:key:Escape", "press:Escape:-1"]);
});

test("a click and a typed field go through the same guard path for a live tool and a replay", async () => {
  const shop = facts([
    { index: 0, label: "Add to cart", kind: "button" },
    { index: 1, label: "Note", kind: "field", field: { type: "text", name: "n", autocomplete: "" } },
    { index: 2, label: "Checkout", kind: "button" },
  ]);
  const read = buildView(shop, 1, instacart);
  const ok = fakeTarget(read, { marked: shop });
  assert.deepEqual(await clickLive(ok.target, "e1.c0"), { kind: "applied", label: "Add to cart", control: "button" });
  assert.deepEqual(ok.log.calls, ["readLivePage:0", "before:click:Add to cart", "markTrust", "click:[data-bao-live=\"0\"]"]);
  const denied = fakeTarget(read, { marked: shop });
  assert.deepEqual(await clickLive(denied.target, "e1.c2"), { kind: "refused", reason: "denied" });
  assert.deepEqual(denied.log.calls, []);
  const covered = fakeTarget(read, { marked: shop, click: new Error("element is covered") });
  assert.deepEqual(await clickLive(covered.target, "e1.c0"), { kind: "refused", reason: "element is covered" });
  const away = fakeTarget(read, { marked: shop, blockedAfter: "stop-path" });
  assert.deepEqual(await clickLive(away.target, "e1.c0"), { kind: "refused", reason: "stop-path" });
  assert.deepEqual(away.log.calls.slice(-2), ["returnFromBlock", "reread"]);

  const typed = fakeTarget(read, { marked: shop, prior: "blue" });
  assert.deepEqual(await typeLive(typed.target, "e1.c1", "berries"), { kind: "applied", label: "Note", control: "field" });
  assert.deepEqual(typed.log.calls, ["readLivePage:1", "markedFieldValue:1", "before:type:Note", "focusLiveMark:1", "insert:berries:blue:1"]);
  const replaced = fakeTarget(read, { marked: shop, prior: "blue" });
  assert.deepEqual(await typeLive(replaced.target, "e1.c1", "blueberries", true), { kind: "applied", label: "Note", control: "field" });
  assert.deepEqual(replaced.log.calls, ["readLivePage:1", "before:type:Note", "focusLiveMark:1", "selectLiveMark:1", "insert:blueberries::1"]);
  const card = fakeTarget(read, { marked: shop, prior: "41111111" });
  assert.deepEqual(await typeLive(card.target, "e1.c1", "11111111"), { kind: "refused", reason: "cdp-live does not type card numbers" });
  assert.equal(card.log.calls.some((call) => call.startsWith("insert")), false);
  const moved = fakeTarget(read, { marked: shop, press: new Error("focus_moved") });
  assert.deepEqual(await typeLive(moved.target, "e1.c1", "milk"), { kind: "halted", reason: "focus_moved" });
});

test("a key press halts when focus moves or lands in a credential field, and a blocked navigation is refused", async () => {
  const shop = facts([{ index: 0, label: "Search Costco", kind: "field", field: { type: "text", name: "q", autocomplete: "off" } }]);
  const read = buildView(shop, 1, instacart);
  for (const reason of ["focus_moved", "credential_field"]) {
    const { target } = fakeTarget(read, { marked: shop, press: new Error(reason) });
    assert.deepEqual(await pressLiveKey(target, "Enter", "e1.c0"), { kind: "halted", reason });
  }
  const broken = fakeTarget(read, { marked: shop, press: new Error("socket closed") });
  await assert.rejects(pressLiveKey(broken.target, "Enter", "e1.c0"), /socket closed/);
  const off = fakeTarget(read, { marked: shop, blockedAfter: "evil.example" });
  assert.deepEqual(await pressLiveKey(off.target, "Enter", "e1.c0"), { kind: "refused", reason: "evil.example" });
  assert.equal(off.log.calls.includes("returnFromBlock"), false);
});

test("a key press or scroll whose load is failed on a stop path goes back and reads the page again", async () => {
  const shop = facts([{ index: 0, label: "Search deals", kind: "field", field: { type: "search", name: "d", autocomplete: "" }, form: "search" }]);
  const read = buildView(shop, 1, instacart);
  const key = fakeTarget(read, { marked: shop, blockedAfter: "stop-path" });
  assert.deepEqual(await pressLiveKey(key.target, "Enter", "e1.c0"), { kind: "refused", reason: "stop-path" });
  assert.deepEqual(key.log.calls.slice(-3), ["press:Enter:0", "returnFromBlock", "reread"]);
  const scroll = fakeTarget(read, { blockedAfter: "stop-path" });
  assert.deepEqual(await scrollLive(scroll.target, "down", ""), { kind: "refused", reason: "stop-path" });
  assert.deepEqual(scroll.log.calls.slice(-2), ["returnFromBlock", "reread"]);
});

test("direct login links halt click and Enter before any page action", async () => {
  for (const login of ["/login", "/login/index", "/member/login/index", "/signin", "/sign-in", "/#/login"]) {
    const shop = facts([{ index: 0, label: "Resume", kind: "link", href: `http://127.0.0.1${login}` }]);
    const read = buildView(shop, 1, instacart);
    for (const act of [
      (target: LiveActTarget) => clickLive(target, "e1.c0"),
      (target: LiveActTarget) => pressLiveKey(target, "Enter", "e1.c0"),
    ]) {
      const { target, log } = fakeTarget(read, { marked: shop });
      assert.deepEqual(await act(target), { kind: "halted", reason: "login_wall" });
      assert.deepEqual(log.calls, []);
    }
  }
});

test("click, Enter and scroll halt on a blocked login redirect without returning to an expired page", async () => {
  const shop = facts([{ index: 0, label: "Search deals", kind: "field", field: { type: "search", name: "d", autocomplete: "" }, form: "search" }]);
  const read = buildView(shop, 1, instacart);
  for (const act of [
    (target: LiveActTarget) => clickLive(target, "e1.c0"),
    (target: LiveActTarget) => pressLiveKey(target, "Enter", "e1.c0"),
    (target: LiveActTarget) => scrollLive(target, "down", ""),
  ]) {
    const { target, log } = fakeTarget(read, { marked: shop, blockedAfter: "login_wall" });
    assert.deepEqual(await act(target), { kind: "halted", reason: "login_wall" });
    assert.equal(log.calls.includes("returnFromBlock"), false);
    assert.equal(log.calls.includes("reread"), false);
  }
});

test("a scroll checks its ref before it moves anything and reports whether the page moved", async () => {
  const shop = facts([
    { index: 0, label: "Item 1", kind: "link", href: "http://127.0.0.1/products/1" },
    { index: 1, label: "Checkout", kind: "button" },
  ]);
  const read = buildView(shop, 2, instacart);
  const bad = fakeTarget(read, { marked: shop });
  assert.deepEqual(await scrollLive(bad.target, "sideways", ""), { kind: "refused", reason: "direction_not_allowed" });
  assert.deepEqual(await scrollLive(bad.target, "down", "e2.c1"), { kind: "refused", reason: "denied" });
  assert.deepEqual(bad.log.calls, []);
  const page = fakeTarget(read, { scroll: { target: "page", moved: false } });
  assert.deepEqual(await scrollLive(page.target, "down", ""), { kind: "applied", label: "", control: "", scroll: { target: "page", moved: false } });
  assert.deepEqual(page.log.calls, ["before:scroll:down", "scrollLivePage:-1:down"]);
  const box = fakeTarget(read, { marked: shop, scroll: { target: "box", moved: true } });
  const moved = await scrollLive(box.target, "right", "e2.c0");
  assert.deepEqual(moved, { kind: "applied", label: "Item 1", control: "link", scroll: { target: "box", moved: true } });
  assert.deepEqual(box.log.calls, ["readLivePage:0", "before:scroll:right Item 1", "scrollLivePage:0:right"]);
  const gone = fakeTarget(read, { marked: shop, scroll: { target: "none", moved: false } });
  assert.deepEqual(await scrollLive(gone.target, "right", "e2.c0"), { kind: "refused", reason: "stale_ref" });
  const left = fakeTarget(read, { scroll: { target: "page", moved: true }, blockedAfter: "evil.example" });
  assert.deepEqual(await scrollLive(left.target, "down", ""), { kind: "refused", reason: "evil.example" });
});

const SHOP = `<!doctype html><title>Costco</title>
<header>
  <form action="/search"><input name="q" aria-label="Search Costco" autocomplete="off"></form>
  <button type="button" aria-label="View Cart. Items in cart: 0">Cart</button>
</header>
<div role="dialog" id="promo"><p>Fresh deals today</p></div>
<script>
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  document.getElementById("promo")?.remove();
  fetch("/effect?name=escaped");
});
</script>`;

const RESULTS = `<!doctype html><title>Results</title><h1>Results for blueberries</h1>
<div id="deals" style="overflow-x:auto;white-space:nowrap;width:300px">
  ${Array.from({ length: 10 }, (_, i) => `<a href="/products/deal-${i}" style="display:inline-block;width:120px">Deal ${i}</a>`).join("")}
</div>
<main id="grid"></main>
<script>
const grid = document.getElementById("grid");
let shown = 0;
const more = () => {
  for (let i = 0; i < 30 && shown < 90; i += 1, shown += 1) {
    const name = shown === 89 ? "Kirkland Signature Organic Blueberries, 3 lbs" : "Blueberries " + shown;
    const card = document.createElement("div");
    card.style.height = "60px";
    card.innerHTML = '<a href="/products/' + shown + '">' + name + '</a> <button type="button" aria-label="Add 1 ct ' + name + '">Add</button>';
    grid.appendChild(card);
  }
};
more();
addEventListener("scroll", () => {
  if (innerHeight + scrollY < document.documentElement.scrollHeight - 300) return;
  more();
  fetch("/effect?name=more");
});
</script>`;

const SHELL = `<!doctype html><title>Aisles</title>
<style>html, body { margin: 0; height: 100%; overflow: hidden; }</style>
<main id="aisles" style="height: 100%; overflow-y: auto">
  ${Array.from({ length: 40 }, (_, i) => `<p style="height: 80px"><a href="/aisle/${i}">Aisle ${i}</a></p>`).join("")}
</main>`;

const PRODUCT = `<!doctype html><title>Kirkland Signature Organic Blueberries, 3 lbs</title>
<h1>Kirkland Signature Organic Blueberries, 3 lbs</h1>
<form id="add"><input name="qty" aria-label="Quantity" value="1"><button type="submit">Add to cart</button></form>
<button onclick="fetch('/effect?name=checkout')">Checkout</button>
<form id="note"><input name="note" aria-label="Order note"><button type="submit">Place order</button></form>
<button onclick="fetch('/effect?name=saved')">Save</button>
<form id="list"><input type="submit" value="Add to list"></form>
<form id="gift" action="/order"><input name="gift" aria-label="Gift message"></form>
<form action="/checkout"><input type="search" name="d" aria-label="Search deals"></form>
<label for="card">Card number</label><input id="card" name="number" autocomplete="off">
<input type="password" id="pw" aria-label="Password">
<script>
document.getElementById("add").onsubmit = (event) => { event.preventDefault(); fetch("/effect?name=added"); };
document.getElementById("note").onsubmit = (event) => { event.preventDefault(); fetch("/effect?name=ordered"); };
</script>`;

function testBrowser(): string {
  const pinned = process.env.BAO_TEST_BROWSER || chromium.executablePath();
  return pinned && existsSync(pinned) ? pinned : "";
}

async function waitForPortFile(file: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (existsSync(file) && /^\d+\n\/devtools\/browser\//.test(readFileSync(file, "utf8"))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("DevToolsActivePort was not written");
}

test("in a real page Enter submits a search box with no button, scroll loads more results, and Enter never submits an order", { skip: !testBrowser(), timeout: 120_000 }, async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url || "/";
    hits.push(url);
    const name = url.split("?")[0];
    const pages: Record<string, string> = { "/shop": SHOP, "/search": RESULTS, "/shell": SHELL, "/products/blueberries": PRODUCT };
    const body = pages[name || ""] || "ok";
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture port missing");
  const origin = `http://127.0.0.1:${address.port}`;
  const userData = mkdtempSync(path.join(tmpdir(), "bao-live-tools-"));
  let chrome: ChildProcess | undefined;
  let driver: CdpLiveDriver | undefined;
  let close = () => undefined as void;
  const effects = (name: string) => hits.filter((hit) => hit === `/effect?name=${name}`).length;
  try {
    chrome = spawn(testBrowser(), [
      "--headless=new",
      `--user-data-dir=${userData}`,
      "--remote-debugging-port=0",
      ...TEST_MEDIA_ARGS,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--use-mock-keychain",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "about:blank",
    ], { stdio: "ignore" });
    const portFile = path.join(userData, "DevToolsActivePort");
    await waitForPortFile(portFile);
    const endpoint = await readDevToolsActivePort(portFile);
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 15_000 });
    close = () => cdp.close();
    driver = await openLiveWindow(cdp, ["127.0.0.1"]);
    driver.setOrigins([origin]);
    driver.setStopPath(instacart.stopPath);
    const live = driver;
    let epoch = 0;
    const audit: string[] = [];
    const look = async (guard: LabelGuard = instacart): Promise<LiveRead> => {
      epoch += 1;
      return buildView(await live.evaluateFunction<PageFacts>(readLivePage, { markIndex: -1 }), epoch, guard);
    };
    const on = (page: LiveRead): LiveActTarget => ({
      driver: live,
      read: page,
      guard: instacart,
      stopPath: instacart.stopPath,
      hosts: ["127.0.0.1"],
      origins: [origin],
      before: async (action, label) => {
        audit.push(`${action} ${label}`);
      },
      reread: async () => {
        read = await look();
        return read;
      },
    });
    const pathNow = () => live.evaluateFunction<string>(() => location.pathname + location.search, null);
    const focused = () => live.evaluateFunction<string>(() => (document.activeElement?.getAttribute("aria-label") || document.activeElement?.textContent || "").trim(), null);

    await live.goto(`${origin}/shop`);
    let read = await look();
    assert.deepEqual(read.view.controls.map((control) => control.label), ["Search Costco", "View Cart. Items in cart: 0"]);
    assert.deepEqual(await pressLiveKey(on(read), "Escape", ""), { kind: "applied", label: "", control: "" });
    assert.equal(effects("escaped"), 1);
    const search = refOf(read, "Search Costco");
    const searchIndex = read.targets.byRef.get(search)?.index ?? -1;
    await live.evaluateFunction(readLivePage, { markIndex: searchIndex });
    await live.evaluateFunction(focusLiveMark, { markIndex: searchIndex });
    await live.insertText("blueberries", "", searchIndex);
    assert.deepEqual(await pressLiveKey(on(read), "Enter", search), { kind: "applied", label: "Search Costco", control: "field" });
    assert.equal(await pathNow(), "/search?q=blueberries");
    assert.equal(hits.includes("/search?q=blueberries"), true);

    read = await look();
    const want = "Add 1 ct Kirkland Signature Organic Blueberries, 3 lbs";
    assert.equal(read.view.controls.length > LIVE_PAGE_SIZE, true);
    assert.equal(viewPage(read.view).pages, 2);
    assert.equal(read.view.controls[0]?.label, "Deal 0");
    assert.equal(read.view.controls.some((control) => control.label === want), false);
    let scrolls = 0;
    let moves = 0;
    const down = async (): Promise<boolean> => {
      const result = await scrollLive(on(read), "down", "");
      assert.equal(result.kind, "applied", JSON.stringify(result));
      assert.equal(result.kind === "applied" && result.scroll?.target, "page");
      scrolls += 1;
      read = await look();
      return result.kind === "applied" && !!result.scroll?.moved;
    };
    while (!read.view.controls.some((control) => control.label === want) && scrolls < 20) {
      if (await down()) moves += 1;
    }
    assert.equal(read.view.controls.some((control) => control.label === want), true, `found after ${scrolls} scrolls`);
    assert.equal(moves >= 2, true);
    assert.equal(effects("more") >= 2, true);
    assert.equal(viewPage(read.view).pages, 4);
    let atEnd = false;
    for (let tries = 0; tries < 20 && !atEnd; tries += 1) atEnd = !await down();
    assert.equal(atEnd, true, "a scroll past the last result reports that nothing moved");
    const deal = refOf(read, "Deal 0");
    const sideways = await scrollLive(on(read), "right", deal);
    assert.equal(sideways.kind === "applied" && sideways.scroll?.target, "box");
    assert.equal(sideways.kind === "applied" && sideways.scroll?.moved, true);
    assert.equal(await live.evaluateFunction<number>(() => document.getElementById("deals")?.scrollLeft || 0, null) > 0, true);

    await live.goto(`${origin}/shell`);
    read = await look();
    const shell = await scrollLive(on(read), "down", "");
    assert.equal(shell.kind === "applied" && shell.scroll?.target, "box", "a page that cannot scroll moves its largest scrolling box");
    assert.equal(shell.kind === "applied" && shell.scroll?.moved, true);
    assert.equal(await live.evaluateFunction<number>(() => document.getElementById("aisles")?.scrollTop || 0, null) > 0, true);

    await live.goto(`${origin}/products/blueberries`);
    read = await look();
    assert.deepEqual(read.view.controls.map((control) => `${control.kind} ${control.label}`), [
      "field Quantity",
      "submit Add to cart",
      "field Order note",
      "button Save",
      "field Gift message",
      "field Search deals",
    ]);
    assert.deepEqual(read.view.stopBeforeConfirm.map((item) => item.label), ["Checkout", "Place order", "Add to list"]);
    assert.equal(read.view.credentialFields, 2, "a field named by its <label> is a credential field too");
    const strict = await look(generic);
    assert.equal(strict.view.controls.some((control) => control.label === "Add to cart"), false);
    assert.equal(strict.view.controls.some((control) => control.label === "Save"), true, "a button with no form submits nothing");

    read = await look();
    assert.deepEqual(await pressLiveKey(on(read), "Enter", refOf(read, "Order note")), { kind: "refused", reason: "denied" });
    assert.deepEqual(await pressLiveKey(on(read), "Tab", refOf(read, "Quantity")), { kind: "applied", label: "Quantity", control: "field" });
    assert.equal(await focused(), "Add to cart");
    assert.deepEqual(await pressLiveKey(on(read), "Enter", refOf(read, "Quantity")), { kind: "applied", label: "Quantity", control: "field" });
    assert.equal(effects("added"), 1);
    read = await look();
    assert.deepEqual(await pressLiveKey(on(read), "Enter", refOf(read, "Add to cart")), { kind: "applied", label: "Add to cart", control: "submit" });
    assert.equal(effects("added"), 2);
    assert.deepEqual(await pressLiveKey(on(read), "Enter", refOf(read, "Gift message")), { kind: "refused", reason: "stop_before_confirm" });
    const before = read.view.epoch;
    assert.deepEqual(await pressLiveKey(on(read), "Enter", refOf(read, "Search deals")), { kind: "refused", reason: "stop-path" });
    assert.equal(await pathNow(), "/products/blueberries", "a load failed on a stop path returns to the last allowed page");
    assert.equal(read.view.epoch > before, true, "the refusal reads the page again");
    assert.equal(read.view.path, "/products/blueberries");
    assert.deepEqual(await pressLiveKey(on(read), "Enter", refOf(read, "Quantity")), { kind: "applied", label: "Quantity", control: "field" });
    assert.equal(effects("added"), 3);
    await live.evaluateFunction(() => document.getElementById("pw")?.focus(), null);
    assert.deepEqual(await pressLiveKey(on(read), "Tab", ""), { kind: "halted", reason: "credential_field" });
    assert.equal(effects("ordered"), 0);
    assert.equal(effects("checkout"), 0);
    assert.equal(hits.some((hit) => hit.startsWith("/checkout") || hit.startsWith("/order")), false);
    assert.deepEqual(audit, [
      "key Escape",
      "key Enter Search Costco",
      ...Array.from({ length: scrolls }, () => "scroll down"),
      "scroll right Deal 0",
      "scroll down",
      "key Tab Quantity",
      "key Enter Quantity",
      "key Enter Add to cart",
      "key Enter Search deals",
      "key Enter Quantity",
      "key Tab",
    ]);
  } finally {
    await driver?.end().catch(() => undefined);
    close();
    if (chrome?.pid && !chrome.killed) {
      try { process.kill(chrome.pid, "SIGKILL"); } catch { /* already gone */ }
    }
    spawnSync("pkill", ["-9", "-f", `user-data-dir=${userData}`]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
