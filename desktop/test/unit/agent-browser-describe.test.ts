import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { CURRENT_CHROME_ENDED, describeStep, elementFor, shortName, TASK_TAB_CLOSED } from "../../src/engines/agent-browser-describe";
import { AgentBrowserRun } from "../../src/engines/agent-browser-record";

const ok = (stdout: string) => [{ stdout, stderr: "", exitCode: 0 }];
const reply = (outcome: string, instruction = "Keep this session open.") => ok(JSON.stringify({ outcome, instruction }));
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

test("a long agent value is cut on the card but kept whole in the text sentence", () => {
  const long = "Great tea. ".repeat(18) + "Would buy again.";
  assert.equal(long.length, 214);
  const fill = describeStep({ command: "fill", args: ["@e2", long], results: ok("✓ Done\n"), snapshot: list, page });
  assert.equal(fill.text, `Typed "${long}" into "Search subscriptions" (search box).`);
  const value = fill.parts.find((part): part is { value: string } => typeof part === "object" && "value" in part)!.value;
  assert.ok(value.length <= 61, `card value is ${value.length} characters`);
  assert.ok(value.endsWith("…"));
  assert.ok(long.startsWith(value.slice(0, -1)));
  const url = `https://shop.example/search?q=${"x".repeat(120)}`;
  const failed = describeStep({ command: "open", args: [url], results: [{ stdout: "", stderr: "✗ net::ERR_NAME_NOT_RESOLVED\n", exitCode: 1 }] });
  assert.equal(failed.text, `Could not open "${url}".`);
  const shown = failed.parts.find((part): part is { value: string } => typeof part === "object" && "value" in part)!.value;
  assert.ok(shown.length <= 61 && shown.endsWith("…"));
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
  assert.equal(text("open", ["https://shop.example/subscriptions"], "✓ Amazon Sign-In\n  https://shop.example/ap/signin\n"), 'Went to https://shop.example/subscriptions ("Manage Your Deliveries").',
    "after Bao's login-import retry the sentence names the page Chrome is on, not the first open's sign-in page");
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
  const waiting = describeStep({ command: "wait_for_owner", args: ["60000"], results: reply("waiting"), owner });
  assert.equal(waiting.text, 'Your turn: sign in to amazon.com in Bao\'s Chrome window. The page is "Amazon Sign-In" (https://www.amazon.com/ap/signin?openid=1). Bao reads only the title and address until the page changes.');
  assert.deepEqual(waiting.owner, { kind: "sign-in", site: "amazon.com", url: owner.url, title: owner.title });
  const check = describeStep({ command: "open", args: ["https://shop.example"], results: reply("halted"), owner: { url: "https://shop.example/", title: "Just a moment..." } });
  assert.match(check.text, /^Your turn: clear the check on shop\.example in Bao's Chrome window\./);
  const ready = describeStep({ command: "wait_for_owner", args: [], results: reply("ready"), page, owner });
  const since = Date.UTC(2026, 10, 8, 8, 0, 0);
  const later = describeStep({ command: "wait_for_owner", args: ["60000"], results: reply("waiting"), owner: { ...owner, since }, at: since + 245_000 });
  assert.equal(later.text, 'Your turn: sign in to amazon.com in Bao\'s Chrome window. The page is "Amazon Sign-In" (https://www.amazon.com/ap/signin?openid=1), waiting 4 min. Bao reads only the title and address until the page changes.');
  assert.equal(later.owner?.waitedMs, 245_000);
  const halted = describeStep({ command: "click", args: ["@e5"], results: reply("halted"), owner: { ...owner, since }, at: since + 61_000 });
  assert.match(halted.text, /, waiting 1 min\. /, "a halted step counts from the same handoff start");
  assert.equal(ready.text, 'Back from sign-in: now on "Manage Your Deliveries" (https://shop.example/subscriptions).');
  const cleared = describeStep({ command: "wait_for_owner", args: [], results: reply("ready"), page, owner: { url: "https://shop.example/", title: "Just a moment..." } });
  assert.equal(cleared.text, 'Back from the check: now on "Manage Your Deliveries" (https://shop.example/subscriptions).');
});

test("an owner wait names what the page asks and reads its time in words", () => {
  const since = Date.UTC(2026, 10, 9, 2, 59, 0);
  const wait = (url: string, title: string, ms = 0) =>
    describeStep({ command: "wait_for_owner", args: ["60000"], results: reply("waiting"), owner: { url, title, since }, at: since + ms });
  const confirm = wait("https://myaccount.nytimes.com/auth/login", "Confirm your account", (9 * 60 + 53) * 60_000 + 1000);
  assert.equal(confirm.text, 'Your turn: finish the check on myaccount.nytimes.com in Bao\'s Chrome window. The page is "Confirm your account" (https://myaccount.nytimes.com/auth/login), waiting 9 h 53 min. Bao reads only the title and address until the page changes.');
  assert.equal(confirm.owner?.kind, "other", "a device check on a sign-in address is never called a sign-in");
  assert.match(wait("https://github.com/sessions/two-factor", "Two-factor authentication").text, /^Your turn: finish the check on github\.com in /);
  assert.match(wait("https://shop.example/mfa", "Shop").text, /^Your turn: finish the check on shop\.example in /);
  assert.match(wait("https://www.nytimes.com/article/pizza.html", "The New York Times", 45_000).text,
    /^Your turn: finish the check on nytimes\.com in Bao's Chrome window\. .*, waiting 45 s\. /, "an unrecognized page is never called a sign-in");
  assert.match(wait("https://shop.example/login", "Shop", 2 * 3600_000).text, /^Your turn: sign in to shop\.example in .*, waiting 2 h\. /);
  assert.equal(describeStep({ command: "wait_for_owner", args: [], results: reply("ready"), page, owner: { url: "https://shop.example/a", title: "Verify your identity" } }).text,
    'Back from the check: now on "Manage Your Deliveries" (https://shop.example/subscriptions).');
});

test("a closed session names the browser that ended", () => {
  assert.equal(describeStep({ command: "wait_for_owner", args: [], results: reply("closed", "The owner closed the Bao window. Report that this session cannot continue.") }).text,
    "The Bao window closed. This session cannot continue.");
  assert.equal(describeStep({ command: "wait_for_owner", args: [], results: reply("closed", CURRENT_CHROME_ENDED) }).text,
    "Your Chrome session ended. This session cannot continue.");
  assert.equal(describeStep({ command: "snapshot", args: ["-i"], results: reply("closed", TASK_TAB_CLOSED), current: true }).text,
    "Bao's task tab was closed. This session cannot continue.");
});

test("steps in the owner's own Chrome name that Chrome, not a Bao window", () => {
  const owner = { url: "https://www.amazon.com/ap/signin?openid=1", title: "Amazon Sign-In" };
  const say = (command: string, results: { stdout: string; stderr: string; exitCode: number }[], more: { owner?: typeof owner } = {}) =>
    describeStep({ command, args: [], results, ...more, current: true }).text;
  assert.match(say("wait_for_owner", reply("waiting"), { owner }), /^Your turn: sign in to amazon\.com in your Chrome\. /);
  assert.match(say("open", reply("halted"), { owner: { url: "https://shop.example/", title: "Just a moment..." } }), /^Your turn: clear the check on shop\.example in your Chrome\. /);
  assert.equal(say("wait_for_owner", reply("waiting")), "Your turn: finish the check on the page in your Chrome.");
  assert.equal(say("close", ok("Disconnected from the owner's own Chrome.\n")), "Closed Bao's task tab in your Chrome.");
  assert.equal(say("close", ok("Disconnected from your Chrome. Bao's task tab may still be open.\n")), "Disconnected from your Chrome. Bao's task tab may still be open.");
  assert.equal(say("close", [{ stdout: "", stderr: "✗ failed\n", exitCode: 1 }]), "Could not close Bao's task tab.");
  assert.equal(describeStep({ command: "wait_for_owner", args: [], results: reply("waiting") }).text, "Your turn: finish the check on the page in Bao's Chrome window.");
  assert.equal(describeStep({ command: "close", args: [], results: [{ stdout: "", stderr: "✗ failed\n", exitCode: 1 }] }).text, "Could not close the window.");
});

test("a selector target is the agent's value, not page text", () => {
  const clicked = describeStep({ command: "click", args: ["button.primary"], results: ok("✓ Done\n") });
  assert.deepEqual(clicked.parts, ["Clicked ", { value: "button.primary" }]);
  assert.equal(clicked.text, 'Clicked "button.primary".');
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
