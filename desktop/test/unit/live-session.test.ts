import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveBaoHome } from "../../src/app/bao-home";
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
  assert.doesNotMatch(html, />step-0</);
  assert.match(html, /id="live-steps"/);
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
  const source = readFileSync(path.join(process.cwd(), "desktop/src/cdp-live/session.ts"), "utf8");
  const lockAt = source.indexOf("acquireCdpLock");
  const clearAt = source.indexOf("clearInbox(");
  assert.equal(lockAt >= 0 && clearAt > lockAt, true);
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
  }, 7, "place order|pay now|checkout");
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
  assert.doesNotMatch(readLivePage.toString(), /document\.cookie|localStorage|sessionStorage|indexedDB|Network\.getCookies/);
  assert.doesNotMatch(focusLiveMark.toString(), /document\.cookie|localStorage|sessionStorage|indexedDB|Network\.getCookies/);
});

test("the six live tools stay off the remote relay and a workflow id comes from the intent", () => {
  assert.deepEqual(LIVE_TOOL_NAMES, [
    "live_session_start",
    "live_snapshot",
    "live_click",
    "live_type",
    "live_screenshot",
    "live_stop",
  ]);
  const relayNames: readonly string[] = RELAY_TOOLS.map((tool) => tool.name);
  for (const name of LIVE_TOOL_NAMES) {
    assert.equal(relayNames.includes(name), false);
  }
  assert.deepEqual(workflowIdsFromIntent("Find the cheapest mystery"), {
    workflowId: "wf-find-the-cheapest-mystery",
    runId: "run-find-the-cheapest-mystery",
  });
  assert.equal(workflowIdsFromIntent("Unfreeze credit", "wf-unfreeze-credit").runId, "run-unfreeze-credit");
});

test("the app home follows the flag, then BAO_HOME, then the platform default", () => {
  assert.equal(resolveBaoHome({ homeFlag: "/tmp/flag", env: { BAO_HOME: "/tmp/env" }, platform: "darwin", homedir: "/Users/a" }), "/tmp/flag");
  assert.equal(resolveBaoHome({ env: { BAO_HOME: "/tmp/env" }, platform: "linux", homedir: "/Users/a" }), "/tmp/env");
  assert.equal(resolveBaoHome({ env: {}, platform: "darwin", homedir: "/Users/a" }), "/Users/a/Library/Application Support/bao");
  assert.equal(resolveBaoHome({ env: {}, platform: "linux", homedir: "/Users/a" }), "/Users/a/.local/share/bao");
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
