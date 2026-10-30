// Trail-based recording for live sessions. The unit tests build workflows from
// trail events. The end-to-end test drives the Instacart fixture in the pinned
// test browser through createLiveHost, with the calls an agent's MCP client
// makes, then checks the trail, the saved workflow, and a model-free replay of
// it. Nothing here touches the daily Chrome or the real site.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before, describe, it } from "node:test";
import Ajv from "ajv/dist/2020";
import { openLiveWindow } from "../../src/cdp-live/driver";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { createLiveHost } from "../../src/cdp-live/live-host";
import {
  appearedLeaf,
  cartAddItem,
  cartAddSkip,
  clickEffect,
  inCartMarker,
  isCartAdd,
  LIVE_TRAIL_SOURCE,
  liveTrailFile,
  pageItem,
  refusedStepLabels,
  trailIdentity,
  workflowFromTrail,
  type LiveSide,
} from "../../src/cdp-live/live-trail";
import { COMMIT_FLOOR, guardPreset } from "../../src/cdp-live/presets";
import { connectCdp } from "../../src/cdp-live/socket";
import { unavailableHeal } from "../../src/v1/heal";
import { withoutPrice } from "../../src/v1/identity";
import { locatorsFromIdentity, matchLabeledControl } from "../../src/v1/locators";
import type { TrailEvent } from "../../src/v1/interpret";
import { pageShows, replay, type Driver } from "../../src/v1/replay";
import { validateWorkflow, type Identity, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { fakeChromeHelper } from "../fake-helper";
import { launchFixtureBrowser, type FixtureBrowser } from "../instacart/browser";
import { TARGET, startInstacartFixture, type InstacartFixture } from "../instacart/fixture";

const instacart = guardPreset("instacart");
const generic = guardPreset("generic");
const validateSchema = new Ajv({ allErrors: true, strict: false })
  .compile(JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow-v2.schema.json"), "utf8")));

const STOREFRONT = "https://www.instacart.com/store/costco/storefront";
const RESULTS = "https://www.instacart.com/store/costco/s?k=blueberries";
const ADD = `Add 1 ct ${TARGET.name}`;
const MARKER = `Increment quantity of ${TARGET.name}`;

function dom(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

const SEARCH = dom({ role: "input", name: "Search Costco", label: "Search Costco", nameAttr: "k", testId: "search-input", tag: "input" });

function blueberryTrail(): TrailEvent[] {
  const source = { ...LIVE_TRAIL_SOURCE };
  return [
    { id: "live-1", ts: 1, kind: "act", source, op: "type", identity: SEARCH, value: "blueberries", literal: true, beforeUrl: STOREFRONT, afterUrl: STOREFRONT },
    { id: "live-2", ts: 2, kind: "act", source, op: "key", key: "Enter", identity: SEARCH, beforeUrl: STOREFRONT, afterUrl: RESULTS },
    { id: "live-3", ts: 3, kind: "act", source, op: "scroll", detail: "down", beforeUrl: RESULTS, afterUrl: RESULTS },
    {
      id: "live-4",
      ts: 4,
      kind: "act",
      source,
      op: "click",
      identity: dom({ name: ADD, label: ADD, text: "Add", tag: "button" }),
      beforeUrl: RESULTS,
      afterUrl: RESULTS,
      subtreeBefore: "",
      subtreeAfter: "1 ct",
      skipWhen: MARKER,
    },
  ];
}

function build(events: TrailEvent[], guard = instacart): WorkflowV2 {
  return workflowFromTrail({
    id: "wf-put-costco-blueberries",
    name: "put costco blueberries into the cart at instacart",
    intent: "put costco blueberries into the cart at instacart",
    startUrl: STOREFRONT,
    createdAt: 10,
    savedAt: 20,
    events,
    guard,
  });
}

/** Keys anywhere in a JSON document. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((item) => keysOf(item, out));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.add(key);
      keysOf(item, out);
    }
  }
  return out;
}

/** Assertion D of the plan: a valid, local cdp-live workflow with no secret keys and no refused label. */
function assertClean(workflow: WorkflowV2): void {
  assert.deepEqual(validateWorkflow(workflow), []);
  assert.equal(validateSchema(workflow), true, JSON.stringify(validateSchema.errors));
  assert.equal(workflow.driver, "cdp-live");
  assert.equal(new URL(workflow.startUrl).host, "www.instacart.com");
  const keys = [...keysOf(workflow)];
  assert.deepEqual(keys.filter((key) => /cookie|storage/i.test(key)), []);
  for (const step of workflow.steps) {
    for (const source of [instacart.deny, instacart.commit, COMMIT_FLOOR]) {
      assert.equal(new RegExp(source, "i").test(step.label), false, `${step.label} matches ${source}`);
    }
  }
}

test("a live trail condenses into a valid cdp-live workflow that types the recorded search text, with no input", () => {
  const workflow = build(blueberryTrail());
  assertClean(workflow);
  assert.equal(workflow.version, 2);
  assert.equal(workflow.createdAt, 10);
  assert.equal(workflow.updatedAt, 20);
  assert.equal(workflow.intent, "put costco blueberries into the cart at instacart");
  assert.deepEqual(workflow.inputs, []);
  assert.deepEqual(workflow.steps.map((step) => step.action), ["type", "key", "click"]);
  const [typed, enter, add] = workflow.steps;
  assert.equal(typed?.input, undefined);
  assert.equal(typed?.value, "blueberries");
  assert.equal(typed?.label, "Type into \"Search Costco\"", "the label names the field, not the search text");
  assert.equal(typed?.identity?.testId, "search-input");
  assert.equal(enter?.key, "Enter");
  assert.equal(enter?.expect?.match, "/store/costco/s");
  assert.equal(add?.label, `Click "${ADD}"`);
  assert.deepEqual(add?.when, { absent: MARKER });
  assert.equal(add?.expect?.match, "1 ct");
  assert.equal(add?.human, undefined);
  assert.equal(JSON.stringify(workflow).includes("{{"), false, "no step reads an input");
  assert.equal(JSON.stringify(build(blueberryTrail())), JSON.stringify(workflow), "the same trail builds the same workflow");
});

test("a search for text that matches a deny word saves, and its step names the field", () => {
  const source = { ...LIVE_TRAIL_SOURCE };
  const add = "Add 1 ct Q-tips Original Cotton Swabs, 500 ct";
  const found = "https://www.instacart.com/store/costco/s?k=q+tip";
  const workflow = build([
    { id: "live-1", ts: 1, kind: "act", source, op: "type", identity: SEARCH, value: "q tip", literal: true, beforeUrl: STOREFRONT, afterUrl: STOREFRONT },
    { id: "live-2", ts: 2, kind: "act", source, op: "key", key: "Enter", identity: SEARCH, beforeUrl: STOREFRONT, afterUrl: found },
    {
      id: "live-3",
      ts: 3,
      kind: "act",
      source,
      op: "click",
      identity: dom({ name: add, label: add, text: "Add", tag: "button" }),
      beforeUrl: found,
      afterUrl: found,
      subtreeBefore: "",
      subtreeAfter: "1 ct",
    },
  ]);
  assertClean(workflow);
  const typed = workflow.steps[0];
  assert.deepEqual([typed?.action, typed?.value, typed?.input, typed?.label], ["type", "q tip", undefined, "Type into \"Search Costco\""]);
  assert.deepEqual(refusedStepLabels(workflow, instacart), []);
});

test("a typed field that is not a search box keeps the name interpret gives it", () => {
  const workflow = build([{
    id: "live-1",
    ts: 1,
    kind: "act",
    op: "type",
    identity: dom({ role: "textbox", name: "Delivery instructions", nameAttr: "note", tag: "textarea" }),
    value: "leave at the door",
    beforeUrl: STOREFRONT,
    afterUrl: STOREFRONT,
  }]);
  assert.deepEqual(workflow.inputs.map((input) => [input.name, input.default]), [["note", "leave at the door"]]);
});

test("a purchase control on the trail becomes a gate a person confirms", () => {
  const workflow = build([{
    id: "live-1",
    ts: 1,
    kind: "act",
    op: "click",
    identity: dom({ name: "Reserve", text: "Reserve", tag: "button" }),
    beforeUrl: "https://shop.example/table",
    afterUrl: "https://shop.example/table/done",
  }], generic);
  assert.equal(workflow.steps[0]?.action, "confirm");
  assert.equal(workflow.steps[0]?.human, true);
  assert.deepEqual(validateWorkflow(workflow), []);
});

test("a step label the preset refuses fails the save instead of reaching the library", () => {
  const checkout: TrailEvent = {
    id: "live-1",
    ts: 1,
    kind: "act",
    op: "click",
    identity: dom({ role: "link", name: "Go to checkout", tag: "a" }),
    beforeUrl: RESULTS,
    afterUrl: "https://www.instacart.com/store/costco/cart",
  };
  assert.throws(() => build([checkout]), /refused label in step: Click "Go to checkout"/);
  assert.deepEqual(refusedStepLabels(build(blueberryTrail()), instacart), []);
});

test("a cart add names its item, and the control it revealed marks the item as in the cart", () => {
  assert.equal(cartAddItem(ADD), TARGET.name);
  assert.equal(cartAddItem("Add Fresh Blueberries to cart"), "Fresh Blueberries");
  assert.equal(cartAddItem("Add"), "");
  assert.equal(cartAddItem("Add to cart"), "");
  assert.deepEqual([ADD, "Add to cart", "add  to cart"].map(isCartAdd), [true, true, true]);
  assert.deepEqual(
    ["Add", "Add to bag", "Add item", "Add to list", "Address", "Save", "View Cart. Items in cart: 1"].map(isCartAdd),
    [false, false, false, false, false, false, false],
    "a bare Add and Add to bag are not plain cart adds",
  );
  const before = [dom({ name: ADD }), dom({ name: "View Cart. Items in cart: 0" })];
  const after = [
    dom({ name: "View Cart. Items in cart: 1" }),
    dom({ role: "group", name: `${TARGET.name}, quantity 1` }),
    dom({ name: `Remove ${TARGET.name}` }),
    dom({ name: MARKER }),
  ];
  assert.equal(inCartMarker(TARGET.name, before, after), MARKER);
  assert.equal(inCartMarker(TARGET.name, before, after.slice(0, 3)), `Remove ${TARGET.name}`);
  assert.equal(inCartMarker(TARGET.name, before, after.slice(0, 2)), "", "a count beside the item changes with the next add");
  assert.equal(inCartMarker(TARGET.name, [...before, dom({ name: MARKER })], after.slice(0, 2).concat(dom({ name: MARKER }))), "");
  assert.equal(inCartMarker("", before, after), "");
  assert.deepEqual(cartAddSkip(ADD, before, after, "1 ct"), { text: MARKER, anyCount: false });
  assert.equal(cartAddSkip(ADD, before, after.slice(0, 2), "1 in cart"), undefined, "an Add that names its item needs a control that names it");
  assert.equal(cartAddSkip("Save", before, after, "Saved"), undefined);
});

test("a product page's Add to cart, on a page with one h1, is skipped while the page shows {n} in cart", () => {
  const heading = dom({ role: "heading", tag: "h1", text: TARGET.name });
  const page = [
    dom({ name: "View Cart. Items in cart: 0" }),
    heading,
    dom({ text: "Add to cart", testId: "add-to-cart-button" }),
    dom({ role: "status", tag: "p" }),
    dom({ name: "Add 1 ct Kirkland Signature Organic Hemp Hearts, 32 oz" }),
  ];
  assert.equal(pageItem(page), TARGET.name);
  assert.equal(pageItem([heading, dom({ role: "heading", tag: "h1", text: "Items to add next" })]), "", "two top headings name no one item");
  assert.equal(pageItem([dom({ role: "heading", tag: "h2", text: TARGET.name })]), "");

  const added = [dom({ name: "View Cart. Items in cart: 1" }), heading, page[2]!, dom({ role: "status", tag: "p", text: "1 in cart" }), page[4]!];
  assert.deepEqual(cartAddSkip("Add to cart", page, added, "1 in cart"), { text: "1 in cart", anyCount: true });
  assert.deepEqual(cartAddSkip("Add to cart", page, added, "2 in cart"), { text: "2 in cart", anyCount: true });
  assert.equal(cartAddSkip("Add to cart", page, added, "1 in your cart"), undefined, "only the product page's {n} in cart marks it");
  for (const bare of ["Add", "Add to bag"]) {
    assert.equal(cartAddSkip(bare, page, added, "1 in cart"), undefined, `${bare} is not a product page's Add to cart`);
  }
  const toast = [...added, dom({ role: "status", name: `Added ${TARGET.name} to cart` })];
  assert.deepEqual(cartAddSkip("Add to cart", page, toast, "1 in cart"), { text: "1 in cart", anyCount: true }, "a toast that names the item is not the mark");
  assert.equal(cartAddSkip("Add to cart", page, added, "Added"), undefined, "an effect that is not a count in the cart marks nothing");
  assert.equal(cartAddSkip("Add to cart", page.filter((node) => node !== heading), added, "1 in cart"), undefined, "a page with no one item marks nothing");
});

test("a recorded control's name, text, and label drop prices when the price-free name stays unique, and keep the href", () => {
  assert.equal(withoutPrice(`Current price: $9.89 $989 ${TARGET.name} 3 lb`), `${TARGET.name} 3 lb`);
  assert.equal(withoutPrice("Original price: $12.99 Sale price: $9.89 Fresh Blueberries"), "Fresh Blueberries");
  assert.equal(withoutPrice("Add to cart"), "Add to cart");
  assert.equal(withoutPrice("View Cart. Items in cart: 1"), "View Cart. Items in cart: 1");
  const href = "/products/2001-kirkland-signature-organic-blueberries-3-lb-3-lb?retailerSlug=costco";
  const shownLink = dom({ role: "link", tag: "a", text: `Current price: $9.89 $989 ${TARGET.name} 3 lb`, href });
  const results = [
    dom({ role: "link", tag: "a", name: TARGET.name, href }),
    shownLink,
    dom({ role: "heading", tag: "h3", text: TARGET.name }),
    dom({ name: ADD, label: ADD, text: "Add", tag: "button" }),
    dom({ role: "link", tag: "a", text: "Current price: $4.99 $499 Fresh Blueberries 1 pint", href: "/products/3001-fresh-blueberries" }),
  ];
  const link = trailIdentity(shownLink, results);
  assert.deepEqual([link?.name, link?.text, link?.label, link?.href], [undefined, `${TARGET.name} 3 lb`, undefined, href]);
  const tip = trailIdentity(dom({ role: "radio", tag: "input", name: "$5", label: "$5", nameAttr: "tip" }), []);
  assert.deepEqual([tip?.name, tip?.label], ["$5", "$5"], "a price that is all a control shows stays its name");
  const workflow = build([{
    id: "live-1",
    ts: 1,
    kind: "act",
    op: "click",
    identity: link,
    beforeUrl: RESULTS,
    afterUrl: "https://www.instacart.com/products/2001-kirkland-signature-organic-blueberries-3-lb-3-lb?retailerSlug=costco",
  }]);
  const open = workflow.steps[0];
  assert.equal(open?.label, `Click "${TARGET.name} 3 lb"`);
  assert.deepEqual(open?.locators?.find((locator) => locator.kind === "role"), { kind: "role", role: "link", name: `${TARGET.name} 3 lb` });
  assert.ok(open?.locators?.some((locator) => locator.kind === "css" && locator.value === `a[href="${href}"]`));
  assert.equal(JSON.stringify(workflow).includes("$"), false, "no price anywhere in the step");
});

test("replay finds the recorded product link by its price-free name at a new price, after the results reorder", async () => {
  const href = "/products/2001-kirkland-signature-organic-blueberries-3-lb-3-lb?retailerSlug=costco";
  const productUrl = new URL(href, RESULTS).href;
  const slot = (n: number) => `main > ul > li:nth-of-type(${n}) > a:nth-of-type(2)`;
  const workflow = build([{
    id: "live-1",
    ts: 1,
    kind: "act",
    op: "click",
    identity: trailIdentity(dom({ role: "link", tag: "a", text: `Current price: $9.89 $989 ${TARGET.name} 3 lb`, href, cssPath: slot(1) }), []),
    beforeUrl: RESULTS,
    afterUrl: productUrl,
  }]);
  const target = `Current price: $10.49 $1049 ${TARGET.name} 3 lb`;
  const nodes = [
    dom({ role: "link", tag: "a", text: "Current price: $4.99 $499 Fresh Blueberries 1 pint", href: "/products/3001-fresh-blueberries", cssPath: slot(1) }),
    dom({ role: "link", tag: "a", href, cssPath: "main > ul > li:nth-of-type(2) > div > a" }),
    dom({ role: "link", tag: "a", text: target, href, cssPath: slot(2) }),
  ];
  let url = RESULTS;
  const clicks: string[] = [];
  const driver: Driver = {
    tree: async () => ({ nodes: url === RESULTS ? nodes : [], url, texts: [], values: [] }),
    snapshot: async () => ({ dom: [] }),
    click: async (node) => {
      clicks.push(node.text || "");
      url = new URL(node.href || "", RESULTS).href;
    },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
  };
  const result = await replay(workflow, {}, driver, { heal: unavailableHeal(), siteTrust: "allow", holdForPerson: false });
  assert.equal(result.status, "passed", JSON.stringify(result.failure));
  assert.deepEqual(clicks, [target]);
  assert.equal(result.locatorHits.find((hit) => hit.stepId === workflow.steps[0]?.id)?.kind, "role");
});

test("controls that differ only by price keep their prices, and replay picks the recorded one after the page reorders", async () => {
  const slot = (n: number) => `main > div > button:nth-of-type(${n})`;
  const ten = dom({ text: "Donate $10", tag: "button", cssPath: slot(1) });
  const twentyFive = dom({ text: "Donate $25", tag: "button", cssPath: slot(2) });
  const recorded = trailIdentity(twentyFive, [dom({ role: "heading", tag: "h1", text: "Give" }), ten, twentyFive]);
  assert.equal(recorded?.text, "Donate $25");
  const workflow = build([{
    id: "live-1",
    ts: 1,
    kind: "act",
    op: "click",
    identity: recorded,
    beforeUrl: "https://give.example/",
    afterUrl: "https://give.example/thanks",
  }], generic);
  const donate = workflow.steps[0];
  assert.equal(donate?.label, 'Click "Donate $25"');
  assert.deepEqual(donate?.locators?.find((locator) => locator.kind === "role"), { kind: "role", role: "button", name: "Donate $25" });

  const reordered = [
    dom({ text: "Donate $25", tag: "button", cssPath: slot(1) }),
    dom({ text: "Donate $50", tag: "button", cssPath: slot(2) }),
    dom({ text: "Donate $10", tag: "button", cssPath: slot(3) }),
  ];
  let url = "https://give.example/";
  const clicks: string[] = [];
  const driver: Driver = {
    tree: async () => ({ nodes: url === "https://give.example/" ? reordered : [], url, texts: [], values: [] }),
    snapshot: async () => ({ dom: [] }),
    click: async (node) => {
      clicks.push(node.text || "");
      url = "https://give.example/thanks";
    },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
  };
  const result = await replay(workflow, {}, driver, { heal: unavailableHeal(), siteTrust: "allow", holdForPerson: false });
  assert.equal(result.status, "passed", JSON.stringify(result.failure));
  assert.deepEqual(clicks, ["Donate $25"]);
});

test("checkable inputs that differ only by price keep their priced labels, and the label picks the recorded one", () => {
  const two = dom({ role: "radio", tag: "input", nameAttr: "tip", label: "Tip $2" });
  const five = dom({ role: "radio", tag: "input", nameAttr: "tip", label: "Tip $5" });
  const recorded = trailIdentity(five, [two, five]);
  assert.equal(recorded?.label, "Tip $5");
  const locators = locatorsFromIdentity(recorded) || [];
  assert.equal(matchLabeledControl(locators, recorded, [{ ...five }, { ...two }])?.index, 0);
  assert.equal(matchLabeledControl(locators, recorded, [{ ...two }, { ...five }])?.index, 1);
});

test("a click's effect is new page text, else its own text, and a url change is enough by itself", () => {
  const side = (partial: Partial<LiveSide>): LiveSide => ({ url: RESULTS, leaves: {}, text: "", value: "", missing: false, ...partial });
  const cart = { "HEADER:1/BUTTON:1/SPAN:2": "0", "MAIN:1/LI:1/BUTTON:1/SPAN:1": "Add" };
  const added = { "HEADER:1/BUTTON:1/SPAN:2": "1", "MAIN:1/LI:1/DIV:1/SPAN:1": "1 ct" };
  assert.deepEqual(clickEffect(side({ leaves: cart, text: "Add" }), side({ leaves: added, missing: true })), { subtreeBefore: "", subtreeAfter: "1 ct" });
  assert.deepEqual(appearedLeaf({ a: "Add", b: "Shop" }, { b: "Add", c: "Shop" }), undefined, "text that only moved is not new");
  assert.deepEqual(clickEffect(side({ text: "Add" }), side({ missing: true })), { subtreeBefore: "Add", subtreeAfter: "" });
  assert.deepEqual(clickEffect(side({ text: "" }), side({ missing: true })), { subtreeBefore: "", subtreeAfter: "\u0000" });
  assert.deepEqual(clickEffect(side({ text: "Save" }), side({ text: "Save" })), {});
  assert.deepEqual(clickEffect(side({ url: STOREFRONT, leaves: cart }), side({ leaves: added })), {});
  assert.deepEqual(
    clickEffect(side({ leaves: { a: "Total $0.00" } }), side({ leaves: { a: "Total $9.89" } })),
    {},
    "a price is scrubbed before the diff",
  );
});

test("when.absent is valid alone or with anyCount, and not beside present or a route input, and anyCount needs absent", () => {
  const base = build(blueberryTrail());
  const withWhen = (when: NonNullable<WorkflowV2["steps"][number]["when"]>): WorkflowV2 => ({
    ...base,
    steps: base.steps.map((step, index) => (index === 2 ? { ...step, when } : step)),
  });
  assert.deepEqual(validateWorkflow(withWhen({ absent: MARKER })), []);
  assert.deepEqual(validateWorkflow(withWhen({ absent: "1 in cart", anyCount: true })), []);
  assert.equal(validateSchema(withWhen({ absent: "1 in cart", anyCount: true })), true, JSON.stringify(validateSchema.errors));
  assert.deepEqual(validateWorkflow(withWhen({ anyCount: true })), [`when ${base.steps[2]?.id}`]);
  assert.deepEqual(validateWorkflow(withWhen({ present: "1 in cart", anyCount: true })), [`when ${base.steps[2]?.id}`]);
  assert.equal(validateSchema(withWhen({ present: "1 in cart", anyCount: true })), false, "anyCount does not go with present");
  assert.deepEqual(validateWorkflow(withWhen({ absent: MARKER, present: "Cart" })), [`when ${base.steps[2]?.id}`]);
  assert.deepEqual(validateWorkflow(withWhen({ absent: MARKER, input: "query", value: "x" })), [`when ${base.steps[2]?.id}`]);
  assert.deepEqual(validateWorkflow(withWhen({ absent: "  " })), [`when ${base.steps[2]?.id}`]);
});

test("anyCount lets each number in the text match any number, and nothing else", () => {
  const tree = (texts: string[], names: string[] = []) => ({ nodes: names.map((name) => dom({ name })), url: RESULTS, texts, values: [] });
  assert.equal(pageShows(tree(["3 in cart"]), "1 in cart", true), true);
  assert.equal(pageShows(tree(["12 in cart"]), "1 in cart", true), true);
  assert.equal(pageShows(tree(["3 in cart"]), "1 in cart"), false, "without anyCount the number must match");
  assert.equal(pageShows(tree([], ["View Cart. Items in cart: 3"]), "1 in cart", true), false, "the header's count is not a count in front of the text");
  assert.equal(pageShows(tree(["in cart"]), "1 in cart", true), false);
  assert.equal(pageShows(tree(["Total (2.5 lb)"]), "Total (1.5 lb)", true), true, "the rest of the text matches as written");
  assert.equal(pageShows(tree(["Total 2.5 lb"]), "Total (1.5 lb)", true), false);
});

test("replay skips a step whose result the page already shows, and runs it otherwise", async () => {
  const workflow = build(blueberryTrail());
  const add = { ...workflow, inputs: [], steps: [{ ...workflow.steps[2]!, index: 0, expect: undefined, postcondition: undefined }] };
  const run = async (names: string[], doc: WorkflowV2 = add, texts: string[] = []) => {
    const clicks: string[] = [];
    const driver: Driver = {
      tree: async () => ({ nodes: names.map((name) => dom({ name, tag: "button" })), url: RESULTS, texts, values: [] }),
      snapshot: async () => ({ dom: [] }),
      click: async (node) => { clicks.push(node.name || ""); },
      fill: async () => {},
      key: async () => {},
      upload: async () => {},
      drop: async () => {},
      digits: async () => {},
      check: async () => {},
      notify: async () => {},
      sleep: async () => {},
    };
    const result = await replay(doc, {}, driver, { heal: unavailableHeal(), siteTrust: "allow", holdForPerson: false });
    return { result, clicks };
  };
  const inCart = await run([`Remove ${TARGET.name}`, MARKER]);
  assert.equal(inCart.result.status, "passed");
  assert.deepEqual(inCart.result.steps.map((step) => step.reason), ["already done"]);
  assert.deepEqual(inCart.clicks, []);
  const empty = await run([ADD]);
  assert.equal(empty.result.status, "passed", JSON.stringify(empty.result.failure));
  assert.deepEqual(empty.clicks, [ADD]);

  // A product page's Add to cart, skipped while the page shows any count of the item in the cart.
  const plain = {
    ...add,
    steps: [{
      ...add.steps[0]!,
      label: "Click \"Add to cart\"",
      identity: dom({ text: "Add to cart", tag: "button" }),
      locators: [{ kind: "text" as const, value: "Add to cart" }],
      when: { absent: "1 in cart", anyCount: true },
    }],
  };
  for (const count of [1, 2]) {
    const held = await run(["Add to cart", "View Cart. Items in cart: 3"], plain, [`${count} in cart`]);
    assert.deepEqual(held.result.steps.map((step) => step.reason), ["already done"], `${count} in cart`);
    assert.deepEqual(held.clicks, []);
  }
  const none = await run(["Add to cart", "View Cart. Items in cart: 3"], plain, [""]);
  assert.equal(none.result.status, "passed", JSON.stringify(none.result.failure));
  assert.deepEqual(none.clicks, ["Add to cart"]);
});

interface LiveBody {
  outcome?: { kind?: string; reason?: string };
  session?: string;
  view?: {
    path?: string;
    controls: { ref: string; label: string; kind: string }[];
    stopBeforeConfirm: { label: string }[];
  } | null;
}

function refOf(body: LiveBody, label: string): string {
  const ref = body.view?.controls.find((item) => item.label === label)?.ref || "";
  assert.ok(ref, `${label} in ${(body.view?.controls || []).map((item) => item.label).join(", ")}`);
  return ref;
}

describe("an agent's live session on the Instacart fixture", { timeout: 180_000 }, () => {
  let fixture: InstacartFixture;
  let browser: FixtureBrowser;

  before(async () => {
    fixture = await startInstacartFixture();
    browser = await launchFixtureBrowser(fixture);
  });

  after(async () => {
    await browser?.close();
    await fixture?.close();
  });

  it("records each act on the trail, saves a workflow when the agent disconnects, and that workflow replays with no model", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "bao-live-recording-"));
    fixture.reset();
    const host = createLiveHost({
      home,
      lockFile: path.join(home, "lock"),
      target: { kind: "throwaway", portFile: browser.portFile },
      helper: () => fakeChromeHelper().helper,
      openProfile: async () => {
        throw new Error("a throwaway Chrome has no profile window");
      },
      idleMs: 0,
    });
    const call = (body: Record<string, unknown>) => host.call(body) as Promise<LiveBody>;
    let workflow: WorkflowV2;
    try {
      const started = await call({
        op: "live_session_start",
        intent: "put costco blueberries into the cart at instacart",
        url: fixture.url("/store/costco/storefront"),
        client: "mock-user",
      });
      assert.equal(started.outcome?.kind, "applied", JSON.stringify(started.outcome));
      assert.equal(started.session, "wf-put-costco-blueberries-into-the-cart");
      const typed = await call({ op: "live_type", ref: refOf(started, "Search Costco"), text: "blueberries" });
      assert.equal(typed.outcome?.kind, "applied", JSON.stringify(typed.outcome));
      const searched = await call({ op: "live_key", key: "Enter", ref: refOf(typed, "Search Costco") });
      assert.equal(searched.outcome?.kind, "applied", JSON.stringify(searched.outcome));
      assert.equal(searched.view?.path, "/store/costco/s");
      const scrolled = await call({ op: "live_scroll", direction: "down" });
      assert.equal(scrolled.outcome?.kind, "applied", JSON.stringify(scrolled.outcome));
      assert.ok(scrolled.view?.stopBeforeConfirm.some((item) => item.label === "Checkout"));
      const epoch = scrolled.view?.controls[0]?.ref.split(".")[0] || "";
      const shown = new Set((scrolled.view?.controls || []).map((item) => item.ref));
      const hidden = Array.from({ length: 80 }, (_, index) => `${epoch}.c${index}`).find((ref) => !shown.has(ref)) || "";
      const refused = await call({ op: "live_click", ref: hidden });
      assert.equal(refused.outcome?.kind, "refused", JSON.stringify(refused.outcome));
      const added = await call({ op: "live_click", ref: refOf(scrolled, ADD) });
      assert.equal(added.outcome?.kind, "applied", JSON.stringify(added.outcome));
      assert.ok(added.view?.controls.some((item) => item.label === MARKER));
      const ended = await call({ op: "live_disconnect", client: "mock-user" });
      assert.equal(ended.outcome?.kind, "stopped", JSON.stringify(ended.outcome));

      const lines = readFileSync(liveTrailFile(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as TrailEvent);
      assert.deepEqual(lines.map((event) => event.op), ["type", "key", "scroll", "click"], "one line per act, none for the refused click");
      assert.equal(lines.every((event) => event.kind === "act" && event.source?.agent === "live-model" && event.source.adapter === "cdp-live"), true);
      const [type, key, scroll, click] = lines;
      assert.equal(type?.value, "blueberries");
      assert.equal(type?.literal, true, "search text replays as typed");
      assert.equal(type?.parameter, undefined);
      assert.equal(type?.identity?.testId, "search-input");
      assert.equal(type?.identity?.nameAttr, "k");
      assert.ok(type?.identity?.cssPath && type.identity.xpath, "the full identity from tree()");
      assert.equal(type?.identity?.value, undefined, "a field's text is not its identity");
      assert.equal(key?.key, "Enter");
      assert.equal(key?.identity?.name, "Search Costco");
      assert.equal(key?.beforeUrl, STOREFRONT);
      assert.equal(key?.afterUrl, RESULTS);
      assert.equal(scroll?.detail, "down");
      assert.equal(click?.identity?.name, ADD);
      assert.equal(click?.identity?.tag, "button");
      assert.equal(click?.skipWhen, MARKER);
      assert.equal(click?.subtreeAfter, "1 ct");

      workflow = new Library(home).read(started.session || "");
      assertClean(workflow);
      assert.deepEqual(workflow.inputs, []);
      assert.deepEqual(workflow.steps.map((step) => step.action), ["type", "key", "click"]);
      assert.equal(workflow.steps[0]?.value, "blueberries");
      assert.deepEqual(workflow.steps[2]?.when, { absent: MARKER });
      assert.deepEqual(fixture.state().carts.costco.map((line) => [line.productId, line.qty]), [[TARGET.id, 1]]);
      assert.deepEqual(fixture.state().traps, []);
    } finally {
      await host.close();
    }

    const endpoint = await readDevToolsActivePort(browser.portFile);
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 10_000 });
    const replayOnce = async () => {
      const driver = await openLiveWindow(cdp, ["www.instacart.com", "instacart.com"]);
      try {
        await driver.goto(workflow.startUrl);
        return await replay(workflow, {}, driver, { heal: unavailableHeal(), siteTrust: "allow", holdForPerson: false });
      } finally {
        await driver.end().catch(() => undefined);
      }
    };
    try {
      const writes = () => fixture.state().writes.map((write) => [write.op, write.productId, write.after]);
      const inCart = await replayOnce();
      assert.equal(inCart.status, "passed", JSON.stringify(inCart.failure));
      assert.equal(inCart.modelCalls, 0);
      assert.deepEqual(inCart.steps.map((step) => step.reason ?? ""), ["", "", "already done"]);
      assert.deepEqual(writes(), [["add", TARGET.id, 1]], "the item was already in the cart, so replay added nothing");

      fixture.reset();
      const empty = await replayOnce();
      assert.equal(empty.status, "passed", JSON.stringify(empty.failure));
      assert.equal(empty.modelCalls, 0);
      assert.deepEqual(writes(), [["add", TARGET.id, 1]]);
      assert.deepEqual(fixture.state().traps, []);
    } finally {
      cdp.close();
    }
  });
});
