import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { emptyLogin, loginsScreen } from "../../src/app/logins-view";
import { actBar, consolePane, healDetail, healInbox, importCard, networkPane, passGrid, runsList, trailPane } from "../../src/app/views";
import { driftMarkdown } from "../../src/v1/drift";
import { makeAsk } from "../../src/v1/human-ask";
import { when } from "../../src/v1/time";

const AT = Date.parse("2026-10-22T04:50:16.442Z");
const NOW = Date.parse("2026-10-22T05:13:00.000Z");

const ISO_Z = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/;
const ISO_DAY = /\b\d{4}-\d{2}-\d{2}\b/;
const BARE_CLOCK = /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b(?!\s*(?:[A-Z]{2,5}|GMT[+-]?\d{0,2}|UTC))/;

test("clock times use the machine zone and a recent row says how long ago", () => {
  const compiled = require.resolve("../../src/v1/time");
  assert.equal(zoned(compiled, `formatClock(${AT})`, "America/New_York"), "Oct 22, 12:50 AM EDT");
  const utc = zoned(compiled, `formatClock(${AT})`, "UTC");
  assert.match(utc, /4:50 AM/);
  assert.match(utc, /UTC|GMT/);
  assert.equal(utc.includes("12:50"), false);
  assert.equal(zoned(compiled, `formatRelative(${AT - 3 * 60 * 1000}, ${AT})`, "America/New_York"), "3 min ago");
  assert.equal(zoned(compiled, `formatRelative(${AT - 20 * 1000}, ${AT})`, "America/New_York"), "just now");
  assert.equal(zoned(compiled, `formatWhen(${AT}, ${NOW})`, "America/New_York"), "23 min ago · Oct 22, 12:50 AM EDT");
  const night = Date.parse("2026-10-22T06:00:00.000Z");
  const morning = Date.parse("2026-10-22T08:30:00.000Z");
  assert.equal(zoned(compiled, `formatFriendly(${night}, ${morning})`, "America/New_York"), "Last night, 2:00 AM EDT");
  const utcNight = zoned(compiled, `formatFriendly(${night}, ${morning})`, "UTC");
  assert.match(utcNight, /6:00 AM/);
  assert.match(utcNight, /UTC|GMT/);
  assert.equal(utcNight.includes("EDT"), false);
  assert.equal(utcNight.includes("2:00 AM"), false);
});

test("rendered pages have no ISO timestamp and no clock without a zone", () => {
  const ask = makeAsk({
    kind: "login",
    workflowId: "wf",
    workflowName: "Fixture login",
    stepId: "s1",
    stepIndex: 1,
    stepCount: 2,
    label: "Click login",
    timeoutMs: 120 * 60 * 1000,
    now: NOW,
  });
  const login = emptyLogin();
  login.saved = [{
    origin: "https://example.com",
    probeUrl: "",
    signedInSelector: "",
    signedInText: "",
    botCookies: "skip",
    origins: [],
    lastProbeAt: AT,
  }];
  const green = when("2026-10-22T04:50:16.442Z", NOW);
  const pages = [
    passGrid([
      { id: "run-old", workflowId: "wf", status: "passed", at: Date.parse("2026-10-22T04:41:51.000Z"), steps: [{ id: "s1", status: "passed" }] },
      { id: "run-new", workflowId: "wf", status: "passed", at: AT, steps: [{ id: "s1", status: "passed" }], heals: [{ id: "h1", failedStep: { id: "s1" } }] },
    ], [{ id: "s1", label: "Click login" }]),
    healInbox([{
      id: "run-new",
      workflowId: "wf",
      status: "passed",
      at: AT,
      decisions: [],
      heals: [{ id: "h1", ts: AT, workflowId: "wf", intent: "Click missing control", failedStep: { id: "s1", label: "Click login" } }],
    }], [{ id: "wf", name: "Fixture login", steps: 1 }]),
    healDetail({
      id: "run-new",
      workflowId: "wf",
      status: "passed",
      decisions: [{ ts: AT, healId: "h1", decision: "keep" }],
      heals: [],
    }, {
      id: "h1",
      ts: AT,
      intent: "Click missing control",
      mode: "auto",
      failedStep: { id: "s1", label: "Click login" },
      model: { name: "bao-heal-fixture", version: "1" },
    }),
    trailPane([{ ts: AT, kind: "repair", op: "reveal", id: "s1" }]),
    runsList([{ id: "run-new", workflowId: "wf", status: "passed", at: AT, steps: [], heals: [] }], [{ id: "wf", name: "Fixture login", steps: 1 }]),
    actBar({ activeAsk: ask }, NOW),
    importCard({ phase: "done", audit: { domain: "example.com", count: 1, at: AT } }),
    loginsScreen(login),
    consolePane([{ stepId: "s1", type: "info", text: "ready", ts: AT }], "s1"),
    networkPane([{ stepId: "s1", method: "GET", url: "http://127.0.0.1/fixture", status: 200, ts: AT }], "s1"),
    `<p data-testid="last-green">Publisher replayed green: ${green}</p>`,
    `<p class="muted">last green ${when(AT, NOW)}</p>`,
    driftMarkdown({
      generatedAt: "2026-10-22T04:50:16.442Z",
      rows: [],
      summary: [],
      steps: [],
      workflows: [],
    }),
  ].join("\n");

  assertNoRawTimes(pages);
  assert.match(pages, /Oct 22,/);
  assert.match(pages, /(UTC|GMT|EDT|EST|CDT|CST|MDT|MST|PDT|PST)/);
  assert.match(green, /(AM|PM) /);
  assert.equal(green.includes("2026-10-22"), false);

  assert.throws(() => assertNoRawTimes("<p>2026-10-22T04:50:16.442Z</p>"), /ISO Z timestamp/);
  assert.throws(() => assertNoRawTimes("<p>2026-10-22</p>"), /ISO date/);
  assert.throws(() => assertNoRawTimes("<time>4:50 AM</time>"), /no zone/);
  assertNoRawTimes("<time>Oct 22, 12:50 AM EDT</time>");
  assertNoRawTimes("<time>Oct 22, 4:50 AM UTC</time>");
  assertNoRawTimes("<time>Oct 22, 4:50 AM GMT-4</time>");
});

function assertNoRawTimes(html: string): void {
  const iso = html.match(ISO_Z);
  assert.equal(iso, null, `ISO Z timestamp in a rendered page: ${iso?.[0] ?? ""}`);
  const day = html.match(ISO_DAY);
  assert.equal(day, null, `ISO date in a rendered page: ${day?.[0] ?? ""}`);
  const bare = html.match(BARE_CLOCK);
  assert.equal(bare, null, `clock with no zone in a rendered page: ${bare?.[0] ?? ""}`);
}

function zoned(compiled: string, call: string, tz: string): string {
  const result = spawnSync(process.execPath, ["-e", `process.stdout.write(String(require(${JSON.stringify(compiled)}).${call}))`], {
    env: { ...process.env, TZ: tz },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
