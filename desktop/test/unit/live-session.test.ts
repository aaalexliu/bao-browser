import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { captureTrailOwnsSteps, liveSessionView } from "../../src/app/live-view";
import { SessionLog, readLiveSession } from "../../src/cdp-live/audit";
import { insertTextRefusal } from "../../src/cdp-live/allowlist";
import { clearInbox } from "../../src/cdp-live/connect";
import { auditPage, publicLiveSession, type AuditRow } from "../../src/cdp-live/live-record";
import {
  admit,
  buildView,
  pageHalt,
  planClick,
  planType,
  publicLiveResult,
  focusLiveMark,
  readLivePage,
  targetVerdict,
  workflowIdsFromIntent,
  LIVE_TOOL_NAMES,
  LIVE_TOOLS,
} from "../../src/cdp-live/live-ops";
import { parseLock } from "../../src/cdp-live/lock";
import { guardPreset, resolveGuardFlags } from "../../src/cdp-live/presets";
import { RELAY_TOOLS } from "../../../web/src/lib/relay-tools";

function row(index: number): AuditRow {
  return {
    action: `step-${index}`,
    label: `label-${index}`,
    path: "/catalogue",
    isTrusted: true,
    ms: index,
    at: index,
    shot: "",
    via: "cdp",
  };
}

test("a preset fills the guard patterns so the caller does not invent them", () => {
  const books = guardPreset("books");
  assert.equal(books.hosts.includes("books.toscrape.com"), true);
  assert.equal(books.start, "https://books.toscrape.com/");
  for (const pattern of [books.deny, books.commit, books.stopPath, books.reached]) {
    assert.equal(pattern.length > 0, true);
    new RegExp(pattern, "i");
  }
  const filled = resolveGuardFlags({ preset: "books" });
  assert.equal(filled.deny, books.deny);
  assert.equal(filled.commit, books.commit);
  assert.equal(filled.stopPath, books.stopPath);
  assert.equal(filled.reached, books.reached);
  assert.deepEqual(filled.hosts, [...books.hosts]);
  const instacart = resolveGuardFlags({ preset: "instacart" });
  assert.match(instacart.deny, /checkout/i);
  assert.equal(resolveGuardFlags({ preset: "generic", hosts: ["example.com"], start: "https://example.com/" }).hosts[0], "example.com");
  assert.throws(() => guardPreset("custom"), /unknown preset/);
});

test("the live record keeps every audit row and the view pages them", () => {
  const audit = Array.from({ length: 41 }, (_, index) => row(index));
  const record = publicLiveSession({
    id: "live",
    intent: "page the audit",
    status: "running",
    host: "books.toscrape.com",
    updatedAt: 1,
    steps: audit.map((item) => ({ name: item.action, status: "passed", ms: item.ms })),
    audit,
    note: "",
  });
  assert.ok(record);
  assert.equal(record?.audit.length, 41);
  assert.equal(record?.steps.length, 41);
  const last = auditPage(record?.audit || []);
  assert.equal(last.total, 41);
  assert.equal(last.pages, 2);
  assert.equal(last.page, 1);
  assert.equal(last.rows.length, 1);
  assert.equal(last.rows[0]?.action, "step-40");
  const html = liveSessionView(record, last.page);
  assert.match(html, /step-40/);
  assert.match(html, /41 rows/);
  const auditHtml = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] || "";
  assert.match(auditHtml, />step-40</);
  assert.doesNotMatch(auditHtml, />step-0</);
  const stepsHtml = html.match(/<ol id="live-steps">([\s\S]*?)<\/ol>/)?.[1] || "";
  assert.equal((stepsHtml.match(/<li /g) || []).length, 41);
  assert.match(stepsHtml, />step-0</);
  assert.match(stepsHtml, />step-40</);
});

test("one lock reader accepts both lock bodies", () => {
  assert.equal(parseLock("agent-a\n10\n")?.agentId, "agent-a");
  assert.equal(parseLock("agent=bao-live\nstartedAt=5\n")?.agentId, "bao-live");
  assert.equal(parseLock("agent=bao-live\nstartedAt=5\n")?.startedAt, 5);
});

test("the inbox is cleared only after the lock is held", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-inbox-"));
  const file = path.join(dir, "session-inbox.txt");
  await assert.rejects(clearInbox(file, false), /lock/);
  await clearInbox(file, true);
  assert.equal(readFileSync(file, "utf8"), "");
});

test("confirm controls are listed and not clicked, and credential fields refuse typing", () => {
  const read = buildView({
    path: "/checkout",
    title: "Checkout",
    headings: ["Checkout"],
    blocked: "",
    controls: [
      { index: 0, label: "Place order", kind: "submit" },
      { index: 1, label: "Go", kind: "submit", form: "search" },
      { index: 2, label: "Password", kind: "field", field: { type: "password", name: "password", autocomplete: "current-password" } },
      { index: 3, label: "Search", kind: "field", field: { type: "search", name: "q", autocomplete: "off" } },
      { index: 4, label: "Mystery", kind: "link" },
    ],
  }, 7, { commit: "place order|pay now|checkout", deny: "", submit: "" });
  assert.deepEqual(read.view.stopBeforeConfirm.map((item) => item.label), ["Place order"]);
  assert.equal(read.view.credentialFields, 1);
  assert.equal(read.view.controls.some((control) => control.label === "Place order"), false);
  assert.equal(read.view.controls.some((control) => control.label === "Password"), false);
  const blocked = planClick(read, "e7.c0");
  assert.equal(blocked.ok, false);
  if (!blocked.ok) assert.equal(blocked.refusal, "stop_before_confirm");
  const password = planType(read, read.targets.passwordRef || "e7.c2", "secret");
  assert.equal(password.ok, false);
  const search = read.view.controls.find((control) => control.label === "Search");
  assert.ok(search);
  const typed = planType(read, search.ref, "agatha christie");
  assert.equal(typed.ok, true);
  assert.equal(planType(read, search.ref, "password123").ok, false);
  assert.equal(insertTextRefusal("password123"), "cdp-live does not type secrets");
  assert.equal(planClick(read, "e6.c0").ok, false);
});

test("a login wall halts, a new tab opened by the page is blocked, and cookies never come back", () => {
  assert.equal(pageHalt({ blocked: "login", path: "/login", passwordFields: 1 }), "login_wall");
  assert.equal(pageHalt({ blocked: "", path: "/catalogue", passwordFields: 0 }), null);
  assert.equal(targetVerdict({ type: "page", targetId: "B", openerId: "A" }, "A"), "close");
  assert.equal(targetVerdict({ type: "page", targetId: "C" }, "A"), "ignore");
  assert.equal(targetVerdict({ type: "page", targetId: "A", openerId: "A" }, "A"), "ignore");
  const cleaned = publicLiveResult({
    op: "live_snapshot",
    session: "live-1",
    outcome: { kind: "applied" },
    view: null,
    shot: "",
    cookies: "session=secret",
    localStorage: { token: "secret" },
  });
  assert.equal(JSON.stringify(cleaned).includes("secret"), false);
  const touched: string[] = [];
  const spy = (name: string) => ({ get() { touched.push(name); return ""; }, configurable: true });
  const page = globalThis as unknown as Record<string, unknown>;
  const document = { title: "Shop", body: { innerText: "Shop" }, querySelectorAll: () => [], querySelector: () => null };
  Object.defineProperty(document, "cookie", spy("cookie"));
  page.document = document;
  page.location = { pathname: "/shop", hash: "" };
  page.HTMLElement = class {};
  for (const name of ["localStorage", "sessionStorage", "indexedDB"]) Object.defineProperty(globalThis, name, spy(name));
  try {
    assert.equal(readLivePage({ markIndex: 0 }).path, "/shop");
    focusLiveMark({ markIndex: 0 });
  } finally {
    for (const name of ["document", "location", "HTMLElement", "localStorage", "sessionStorage", "indexedDB"]) delete page[name];
  }
  assert.deepEqual(touched, []);
});

test("the live tools stay off the remote relay and a workflow id comes from the intent", () => {
  assert.deepEqual(LIVE_TOOL_NAMES, [
    "live_session_start",
    "live_snapshot",
    "live_navigate",
    "live_tabs",
    "live_switch_tab",
    "live_select",
    "live_read",
    "live_click",
    "live_type",
    "live_key",
    "live_scroll",
    "live_screenshot",
    "live_stop",
  ]);
  assert.deepEqual(LIVE_TOOLS.map((tool) => tool.name), [...LIVE_TOOL_NAMES]);
  const relayNames: readonly string[] = RELAY_TOOLS.map((tool) => tool.name);
  for (const name of LIVE_TOOL_NAMES) {
    assert.equal(relayNames.includes(name), false);
  }
  assert.deepEqual(workflowIdsFromIntent("Find the cheapest mystery"), {
    workflowId: "wf-find-the-cheapest-mystery",
    runId: "run-find-the-cheapest-mystery",
  });
  assert.equal(workflowIdsFromIntent("Unfreeze credit", "wf-unfreeze-credit").runId, "run-unfreeze-credit");
  const long = workflowIdsFromIntent("put costco blueberries into the cart at instacart").workflowId;
  assert.equal(long, "wf-put-costco-blueberries-into-the-cart", "a long intent's id fits in 40 characters and does not end on a dash");
});

test("a second start is busy, a second stop writes nothing, and a click after stop is closed", () => {
  assert.equal(admit({ phase: "open", id: "live-1" }, "live_session_start").kind, "reject");
  assert.equal(admit({ phase: "closed", id: "live-1", status: "passed" }, "live_stop").kind, "stop-already");
  assert.equal(admit({ phase: "closed", id: "live-1", status: "passed" }, "live_click").kind, "reject");
  assert.equal(admit({ phase: "idle" }, "live_stop").kind, "reject");
  assert.equal(admit({ phase: "open", id: "live-1" }, "live_click").kind, "run");
});

test("a live session file is replaced whole, and the capture trail does not own the live steps", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-live-log-"));
  const log = new SessionLog(dir, "show the steps");
  await log.flush("running");
  for (let i = 0; i < 20; i += 1) {
    await log.add({ action: "look", label: "Books", path: "/", isTrusted: true, ms: i });
    assert.ok(await readLiveSession(dir));
  }
  const saved = await readLiveSession(dir);
  assert.equal(saved?.audit.length, 20);
  assert.equal(captureTrailOwnsSteps("live"), false);
  assert.equal(captureTrailOwnsSteps("capture"), true);
});

test("completing an audit row preserves its trust, time and evidence without replacing prior calls", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-live-completion-"));
  const log = new SessionLog(dir, "read member details");
  const first = Buffer.alloc(48, 1);
  const beforeImage = Buffer.alloc(48, 2);
  const afterImage = Buffer.alloc(48, 3);
  const row = { action: "click", label: "Continue", path: "/member", isTrusted: true, ms: 0, via: "ax" as const };
  try {
    await log.add({ ...row, label: "Earlier call", png: first });
    await log.add({ ...row, png: beforeImage });
    const before = (await readLiveSession(dir))!;
    const message = "Sign in again in Chrome, then start a new live session.";
    await log.flush("needs_human", message);
    await log.add({ action: row.action, label: message, path: row.path, isTrusted: null, ms: 5 }, true);
    const completed = (await readLiveSession(dir))!;
    assert.equal(completed.status, "needs_human");
    assert.equal(completed.note, message);
    assert.equal(completed.audit.length, 2);
    assert.deepEqual(completed.audit[0], before.audit[0]);
    assert.deepEqual(completed.audit[1], { ...before.audit[1], label: message, ms: 5 });
    assert.deepEqual(readFileSync(path.join(dir, "shots", completed.audit[1]!.shot)), beforeImage);
    await log.add({ ...row, label: message, isTrusted: null, png: afterImage }, true);
    const withShot = (await readLiveSession(dir))!;
    assert.equal(withShot.audit.length, 2);
    assert.equal(withShot.audit[1]?.at, before.audit[1]?.at);
    assert.equal(withShot.audit[1]?.isTrusted, true);
    assert.deepEqual(readFileSync(path.join(dir, "shots", withShot.audit[1]!.shot)), afterImage);
    assert.deepEqual(readFileSync(path.join(dir, "shots", before.audit[0]!.shot)), first);
    await log.add({ ...row, isTrusted: false });
    const next = (await readLiveSession(dir))!;
    assert.equal(next.audit.length, 3);
    assert.deepEqual(next.audit.slice(0, 2), withShot.audit);
    assert.equal(next.audit[2]?.isTrusted, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
