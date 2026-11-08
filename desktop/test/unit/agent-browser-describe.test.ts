import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { describeStep, elementFor, shortName } from "../../src/engines/agent-browser-describe";
import { AgentBrowserRun } from "../../src/engines/agent-browser-record";

const ok = (stdout: string) => [{ stdout, stderr: "", exitCode: 0 }];
const page = { url: "https://shop.example/subscriptions", title: "Manage Your Deliveries" };

// The shape of a real full snapshot: each product card is a group whose last button is a bare "Edit".
const list = [
  "- heading \"Your Subscriptions\" [level=1, ref=e1]",
  "- generic",
  "  - generic",
  "    - button \"McCabe Organic Coix Seed - Job's Tears 2 Lbs| High Protein and Fiber | USDA and CCOF Certified\" [ref=e28]",
  "    - button \"Next delivery: Nov 8\" [ref=e30]",
  "    - button \"1 unit every 6 weeks\" [ref=e31]",
  "    - button \"Edit\" [ref=e32]",
  "  - generic",
  "    - button \"365 by Whole Foods Market Organic Lemon Juice\" [ref=e33]",
  "    - button \"Next delivery: Nov 15\" [ref=e34]",
  "    - button \"Edit\" [ref=e35]",
  "- searchbox \"Search subscriptions\" [ref=e2]",
].join("\n");
// The shape of a flat interactive read.
const flat = [
  "- searchbox \"Search subscriptions\" [ref=e2]",
  "- button \"McCabe Organic Dark Roasted Barley Tea\" [ref=e4]",
  "- button \"Edit\" [ref=e5]",
  "- button \"365 by Whole Foods Market Organic Lemon Juice\" [ref=e6]",
  "- button \"Edit\" [ref=e7]",
].join("\n");

test("a click quotes the element's own name and adds a neighbor when the page repeats it", () => {
  assert.deepEqual(elementFor("@e32", list), { role: "button", name: "Edit", context: "McCabe Organic Coix Seed - Job's Tears 2 Lbs| High Protein and Fiber | USDA and CCOF Certified" });
  assert.equal(elementFor("@e35", list)?.context, "365 by Whole Foods Market Organic Lemon Juice");
  assert.equal(elementFor("@e7", flat)?.context, "365 by Whole Foods Market Organic Lemon Juice");
  assert.equal(elementFor("@e5", flat)?.context, "McCabe Organic Dark Roasted Barley Tea");
  assert.equal(elementFor("@e2", list)?.context, undefined, "a unique name needs no neighbor");
  assert.equal(elementFor("@e320", list), undefined, "a ref prefix never matches a longer ref");
  assert.equal(shortName("McCabe Organic Coix Seed - Job's Tears 2 Lbs| High Protein and Fiber | USDA and CCOF Certified"), "McCabe Organic Coix Seed - Job's Tears 2 Lbs…");
  const click = describeStep({ command: "click", args: ["@e32"], results: ok("✓ Done\n"), snapshot: list, page, previousPage: page });
  assert.equal(click.text, 'Clicked "Edit" (button) for "McCabe Organic Coix Seed - Job\'s Tears 2 Lbs…".');
  assert.deepEqual(click.parts, ["Clicked ", { cite: "Edit" }, " (button)", " for ", { cite: "McCabe Organic Coix Seed - Job's Tears 2 Lbs…" }]);
  assert.equal(click.mark, "Clicked");
  const moved = describeStep({ command: "click", args: ["@e2"], results: ok("✓ Done\n"), snapshot: list, page: { url: "https://shop.example/search", title: "Results" }, previousPage: page });
  assert.equal(moved.text, 'Clicked "Search subscriptions" (search box). Now on "Results" (https://shop.example/search).');
});

test("the first copy of a repeated name in a flat read stops at the item before it, not a page header", () => {
  const header = [
    "- link \"Subscribe & Save: manage all your deliveries in one place\" [ref=e1]",
    "- searchbox \"Search subscriptions\" [ref=e2]",
    "- button \"Barley Tea\" [ref=e4]",
    "- button \"Edit\" [ref=e5]",
    "- button \"Lemon Juice\" [ref=e6]",
    "- button \"Edit\" [ref=e7]",
  ].join("\n");
  assert.equal(describeStep({ command: "click", args: ["@e5"], results: ok("✓ Done\n"), snapshot: header, page }).text, 'Clicked "Edit" (button) for "Barley Tea".');
  assert.equal(describeStep({ command: "fill", args: ["@e5", "2"], results: ok("✓ Done\n"), snapshot: header, page }).text, 'Typed "2" into "Edit" (button) for "Barley Tea".');
  assert.equal(describeStep({ command: "click", args: ["@e7"], results: ok("✓ Done\n"), snapshot: header, page }).text, 'Clicked "Edit" (button) for "Lemon Juice".');
  const trailing = [
    "- link \"Subscribe & Save: manage all your deliveries in one place\" [ref=e1]",
    "- searchbox \"Search subscriptions\" [ref=e2]",
    "- link \"Barley Tea\" [ref=e3]",
    "- button \"Edit\" [ref=e4]",
    "- button \"Skip\" [ref=e5]",
    "- link \"Lemon Juice\" [ref=e6]",
    "- button \"Edit\" [ref=e7]",
    "- button \"Skip\" [ref=e8]",
  ].join("\n");
  assert.equal(describeStep({ command: "click", args: ["@e4"], results: ok("✓ Done\n"), snapshot: trailing, page }).text, 'Clicked "Edit" (button) for "Barley Tea".', "a control after the repeated one does not stretch the walk to the header");
  assert.equal(describeStep({ command: "click", args: ["@e7"], results: ok("✓ Done\n"), snapshot: trailing, page }).text, 'Clicked "Edit" (button) for "Lemon Juice".');
  assert.equal(describeStep({ command: "click", args: ["@e5"], results: ok("✓ Done\n"), snapshot: trailing, page }).text, 'Clicked "Skip" (button) for "Barley Tea".');
});

test("a page change that lands after a click's check is not credited to the next step", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-describe-"));
  try {
    const run = new AgentBrowserRun(home);
    const next = { url: "https://shop.example/edit", title: "Edit subscription" };
    const noPicture = async () => { throw new Error("no picture"); };
    const click = run.begin("click", ["@e5"]);
    await run.complete(click, ok("✓ Done\n"), home, noPicture, undefined, false, { previousPage: page, page });
    assert.equal(click.summary!.text, "Clicked the element.");
    const press = run.begin("press", ["Escape"]);
    await run.complete(press, ok("✓ Done\n"), home, noPicture, undefined, false, { previousPage: next, page: next });
    assert.equal(press.summary!.text, "Pressed Escape.");
    const away = run.begin("press", ["Enter"]);
    await run.complete(away, ok("✓ Done\n"), home, noPicture, undefined, false, { previousPage: next, page });
    assert.equal(away.summary!.text, 'Pressed Enter. Now on "Manage Your Deliveries" (https://shop.example/subscriptions).');
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("each command gets a plain sentence, and failures keep the native error", () => {
  const text = (command: string, args: string[], stdout = "✓ Done\n") => describeStep({ command, args, results: ok(stdout), snapshot: list, page }).text;
  assert.equal(text("open", ["https://shop.example/subscriptions"], "✓ Manage Your Deliveries\n  https://shop.example/subscriptions\n"), 'Went to https://shop.example/subscriptions ("Manage Your Deliveries").');
  assert.equal(text("fill", ["@e2", "coix seed"]), 'Typed "coix seed" into "Search subscriptions" (search box).');
  assert.equal(text("press", ["Escape"]), "Pressed Escape.");
  assert.equal(text("scroll", ["down", "700"]), 'Scrolled down 700 px on "Manage Your Deliveries".');
  assert.equal(text("snapshot", ["-i"], list), 'Read the page "Manage Your Deliveries" (https://shop.example/subscriptions): 7 buttons, 1 field.');
  assert.equal(text("close", []), "Closed the Bao browser window.");
  const failed = describeStep({ command: "click", args: ["@e32"], results: [{ stdout: "", stderr: "✗ Unknown ref: e32\n", exitCode: 1 }], snapshot: list, page });
  assert.equal(failed.text, 'Could not click "Edit" (button) for "McCabe Organic Coix Seed - Job\'s Tears 2 Lbs…".');
  assert.equal(failed.error, "✗ Unknown ref: e32");
  assert.equal(describeStep({ command: "snapshot", args: [], results: [], error: "start agent-browser with open before sending commands" }).text,
    "Could not read the page.");
});

test("owner waits name the site and page, and the return names where Bao is now", () => {
  const owner = { url: "https://www.amazon.com/ap/signin?openid=1", title: "Amazon Sign-In" };
  const waiting = describeStep({ command: "wait_for_owner", args: ["60000"], results: ok(JSON.stringify({ outcome: "waiting" })), owner });
  assert.equal(waiting.text, 'Your turn: sign in to amazon.com in Bao\'s Chrome window. The page is "Amazon Sign-In" (https://www.amazon.com/ap/signin?openid=1). Bao reads only the title and address until the page changes.');
  assert.deepEqual(waiting.owner, { kind: "sign-in", site: "amazon.com", url: owner.url, title: owner.title });
  const check = describeStep({ command: "open", args: ["https://shop.example"], results: ok(JSON.stringify({ outcome: "halted" })), owner: { url: "https://shop.example/", title: "Just a moment..." } });
  assert.match(check.text, /^Your turn: clear the check on shop\.example in Bao's Chrome window\./);
  const ready = describeStep({ command: "wait_for_owner", args: [], results: ok(JSON.stringify({ outcome: "ready" })), page });
  const since = Date.UTC(2026, 10, 8, 8, 0, 0);
  const later = describeStep({ command: "wait_for_owner", args: ["60000"], results: ok(JSON.stringify({ outcome: "waiting" })), owner: { ...owner, since }, at: since + 245_000 });
  assert.equal(later.text, 'Your turn: sign in to amazon.com in Bao\'s Chrome window. The page is "Amazon Sign-In" (https://www.amazon.com/ap/signin?openid=1), waiting 4:05. Bao reads only the title and address until the page changes.');
  assert.equal(later.owner?.waitedMs, 245_000);
  const halted = describeStep({ command: "click", args: ["@e5"], results: ok(JSON.stringify({ outcome: "halted" })), owner: { ...owner, since }, at: since + 61_000 });
  assert.match(halted.text, /, waiting 1:01\. /, "a halted step counts from the same handoff start");
  assert.equal(ready.text, 'Back from sign-in: now on "Manage Your Deliveries" (https://shop.example/subscriptions).');
});

test("a read boxes only what no earlier read of the page showed since the last open", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-describe-"));
  try {
    const run = new AgentBrowserRun(home);
    const read = async (stdout: string) => {
      const step = run.begin("snapshot", ["-i"]);
      await run.complete(step, ok(stdout), home, async () => { throw new Error("no picture"); }, undefined, false, { page });
      return step.summary!;
    };
    const dialog = "- heading \"Subscription details\" [level=2, ref=e40]\n- link \"Cancel subscription\" [ref=e41]\n";
    assert.equal((await read(list)).mark, undefined, "a page's first read has nothing new");
    const opened = await read(dialog);
    assert.equal(opened.text, 'Read "Subscription details" (new heading) on "Manage Your Deliveries": 1 link.');
    assert.equal(opened.mark, "New");
    assert.equal((await read(list)).mark, undefined, "the page coming back after a dialog closes is not new");
    assert.equal((await read(dialog)).mark, undefined, "the same dialog again on the same page is not new");
    const open = run.begin("open", [page.url]);
    await run.complete(open, ok(`✓ ${page.title}\n  ${page.url}\n`), home, async () => { throw new Error("no picture"); }, undefined, false, { page });
    await read(list);
    assert.equal((await read(dialog)).mark, "New", "a fresh open starts a new page visit");
  } finally { await rm(home, { recursive: true, force: true }); }
});
