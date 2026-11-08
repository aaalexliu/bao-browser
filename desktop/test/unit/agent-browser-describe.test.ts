import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { describeStep, elementFor, shortName } from "../../src/engines/agent-browser-describe";
import { AgentBrowserRun } from "../../src/engines/agent-browser-record";

const ok = (stdout: string) => [{ stdout, stderr: "", exitCode: 0 }];
const page = { url: "https://shop.example/subscriptions", title: "Manage Your Deliveries" };

// The shape of a real full snapshot: each product card is a generic container whose last button is a bare "Edit".
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

// The same items as named list items, with uneven numbers of controls.
const items = [
  "- heading \"Your Subscriptions\" [level=1, ref=e1]",
  "- list",
  "  - listitem \"McCabe Organic Coix Seed - Job's Tears 2 Lbs| High Protein and Fiber | USDA and CCOF Certified\"",
  "    - link \"McCabe Organic Coix Seed - Job's Tears 2 Lbs| High Protein and Fiber | USDA and CCOF Certified\" [ref=e28]",
  "    - button \"Next delivery: Nov 8\" [ref=e30]",
  "    - button \"1 unit every 6 weeks\" [ref=e31]",
  "    - button \"Edit\" [ref=e32]",
  "  - listitem \"365 by Whole Foods Market Organic Lemon Juice\"",
  "    - button \"Edit\" [ref=e35]",
  "    - link \"365 by Whole Foods Market Organic Lemon Juice\" [ref=e33]",
  "- searchbox \"Search subscriptions\" [ref=e2]",
].join("\n");
// List items with no name of their own, each with a leading control before its title.
const unnamed = [
  "- list",
  "  - listitem",
  "    - button \"Skip\" [ref=e3]",
  "    - button \"Edit\" [ref=e4]",
  "    - link \"Barley Tea\" [ref=e5]",
  "  - listitem",
  "    - button \"Skip\" [ref=e6]",
  "    - button \"Edit\" [ref=e7]",
  "    - link \"Lemon Juice\" [ref=e8]",
].join("\n");

test("a click quotes the element's own name and names its item only when the page structure shows the item", () => {
  const click = (ref: string, snapshot: string) => describeStep({ command: "click", args: [ref], results: ok("✓ Done\n"), snapshot, page, previousPage: page });
  assert.equal(click("@e5", flat).text, 'Clicked "Edit" (button).', "a flat read has no item edge, so no item is named");
  assert.equal(click("@e7", flat).text, 'Clicked "Edit" (button).');
  assert.equal(click("@e32", list).text, 'Clicked "Edit" (button).', "a generic container is not an item");
  const first = click("@e32", items);
  assert.equal(first.text, 'Clicked "Edit" (button) for "McCabe Organic Coix Seed - Job\'s Tears 2 Lbs…".');
  assert.deepEqual(first.parts, ["Clicked ", { cite: "Edit" }, " (button)", " for ", { cite: "McCabe Organic Coix Seed - Job's Tears 2 Lbs…" }]);
  assert.equal(first.mark, "Clicked");
  assert.equal(click("@e35", items).text, 'Clicked "Edit" (button) for "365 by Whole Foods Market Organic Lemon Juice".');
  assert.equal(click("@e7", unnamed).text, 'Clicked "Edit" (button).', "an item with no name of its own names nothing, never a sibling control");
  assert.equal(click("@e6", unnamed).text, 'Clicked "Skip" (button).');
  const groups = [
    "- group \"Barley Tea subscription\"",
    "  - button \"Edit\" [ref=e5]",
    "- group \"Lemon Juice subscription\"",
    "  - button \"Edit\" [ref=e7]",
  ].join("\n");
  assert.equal(click("@e7", groups).text, 'Clicked "Edit" (button) for "Lemon Juice subscription".');
  assert.equal(describeStep({ command: "fill", args: ["@e5", "2"], results: ok("✓ Done\n"), snapshot: groups, page }).text, 'Typed "2" into "Edit" (button) for "Barley Tea subscription".');
  assert.equal(describeStep({ command: "click", args: ["@e5"], results: [{ stdout: "", stderr: "✗ Element not visible\n", exitCode: 1 }], snapshot: groups, page }).text,
    'Could not click "Edit" (button) for "Barley Tea subscription".');
  assert.equal(elementFor("@e2", items)?.context, undefined, "a unique name needs no item");
  assert.equal(elementFor("@e320", list), undefined, "a ref prefix never matches a longer ref");
  assert.equal(shortName("McCabe Organic Coix Seed - Job's Tears 2 Lbs| High Protein and Fiber | USDA and CCOF Certified"), "McCabe Organic Coix Seed - Job's Tears 2 Lbs…");
  const moved = describeStep({ command: "click", args: ["@e2"], results: ok("✓ Done\n"), snapshot: list, page: { url: "https://shop.example/search", title: "Results" }, previousPage: page });
  assert.equal(moved.text, 'Clicked "Search subscriptions" (search box). Now on "Results" (https://shop.example/search).');
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
  const failed = describeStep({ command: "click", args: ["@e32"], results: [{ stdout: "", stderr: "✗ Unknown ref: e32\n", exitCode: 1 }], snapshot: items, page });
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
