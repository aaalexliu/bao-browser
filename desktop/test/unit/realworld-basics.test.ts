import assert from "node:assert/strict";
import test from "node:test";
import { ACCEPT, lookup, type Identity } from "../../src/v1/identity";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { buildLocators, matchLocator, scoreLocator } from "../../src/v1/locators";
import { replay, runPassed, type Driver, type LiveTree } from "../../src/v1/replay";
import { unavailableHeal } from "../../src/v1/heal";
import type { WorkflowV2 } from "../../src/v1/schema";

function dom(partial: Partial<Identity> & { role: string }): Identity {
  return { surface: "dom", path: [], ...partial };
}

function tree(nodes: Identity[], extra: Partial<LiveTree> = {}): LiveTree {
  return { nodes, texts: [], values: [], ...extra };
}

test("exact Travel text on a link clears the threshold when a heading repeats it", () => {
  // books.toscrape: the recorder stored tag `a`, the dump stored role `link`,
  // and a heading also read "Travel", so the text locator scored 40.
  const link = dom({ role: "link", text: "Travel" });
  const heading = dom({ role: "heading", text: "Travel" });
  const nodes = [dom({ role: "link", text: "Books to Scrape" }), link, heading];
  const role = scoreLocator({ kind: "role", role: "a", name: "Travel" }, nodes);
  const text = scoreLocator({ kind: "text", value: "Travel" }, nodes);
  assert.equal(role.score, 100);
  assert.equal(text.score, 100);
  assert.ok(role.score >= ACCEPT);
  assert.equal(matchLocator({ kind: "role", role: "a", name: "Travel" }, nodes)?.index, 1);
  assert.equal(matchLocator({ kind: "text", value: "Travel" }, nodes)?.index, 1);
  const hit = lookup(dom({ role: "a", text: "Travel", name: "Travel" }), nodes);
  assert.equal(hit.ok, true);
  assert.equal(hit.index, 1);
  assert.ok((hit.score || 0) >= ACCEPT);
});

test("Wikipedia Search prefers the control over the heading and the search landmark", () => {
  // Vector skin: role button "Search" scored 0 and text "Search" scored 40
  // against the landmark and the heading. The control's accessible name is Search.
  const button = dom({ role: "button", name: "Search", text: "Search" });
  const nodes = [
    dom({ role: "link", text: "Jump to search" }),
    dom({ role: "search", id: "p-search", text: "Search" }),
    dom({ role: "heading", text: "Search" }),
    dom({ role: "textbox", name: "Search Wikipedia", id: "searchInput" }),
    button,
  ];
  const text = scoreLocator({ kind: "text", value: "Search" }, nodes);
  assert.equal(text.score, 100);
  assert.equal(matchLocator({ kind: "text", value: "Search" }, nodes)?.index, nodes.indexOf(button));
  const hit = lookup(dom({ role: "button", name: "Search", text: "Search" }), nodes);
  assert.equal(hit.ok, true);
  assert.equal(hit.index, nodes.indexOf(button));
  const dupes = [
    dom({ role: "button", text: "Search", testId: "a" }),
    dom({ role: "button", text: "Search", testId: "b" }),
  ];
  assert.equal(scoreLocator({ kind: "text", value: "Search" }, dupes).score, 40);
  assert.equal(matchLocator({ kind: "text", value: "Search" }, dupes), undefined);
});

test("Book now matches the link by accessible name, not a nearby heading", () => {
  const link = dom({ role: "link", name: "Book now", text: "Book now" });
  const nodes = [
    dom({ role: "heading", text: "Book This Room" }),
    dom({ role: "heading", text: "Book now" }),
    link,
    dom({ role: "button", id: "doReservation", text: "Reserve Now" }),
  ];
  const scored = scoreLocator({ kind: "role", role: "a", name: "Book now" }, nodes);
  assert.equal(scored.score, 100);
  assert.equal(matchLocator({ kind: "role", role: "a", name: "Book now" }, nodes)?.index, 2);
  assert.equal(matchLocator({ kind: "text", value: "Book now" }, nodes)?.index, 2);
});

test("type name and lastName clear on an exact accessible name and a stable id", () => {
  const name = dom({ role: "textbox", nameAttr: "name", label: "Name", name: "Name" });
  const nameHeading = dom({ role: "heading", text: "Name" });
  const nameHit = lookup(dom({ role: "input", nameAttr: "name", label: "Name" }), [nameHeading, name]);
  assert.equal(nameHit.ok, true);
  assert.equal(nameHit.index, 1);
  assert.ok((nameHit.score || 0) >= ACCEPT);
  const css = scoreLocator({ kind: "css", value: 'input[name="name"]' }, [nameHeading, name]);
  assert.equal(css.score, 100);

  const lastName = dom({ role: "textbox", id: "lastName", label: "Last Name", name: "Last Name" });
  const lastHeading = dom({ role: "heading", text: "Last Name" });
  const lastLabel = dom({ role: "label", text: "Last Name" });
  const lastHit = lookup(dom({ role: "input", id: "lastName", label: "Last Name" }), [lastHeading, lastLabel, lastName]);
  assert.equal(lastHit.ok, true);
  assert.equal(lastHit.index, 2);
  assert.ok((lastHit.score || 0) >= ACCEPT);
  assert.equal(scoreLocator({ kind: "css", value: "#lastName" }, [lastHeading, lastLabel, lastName]).score, 100);
});

test("a recording opens on the URL the capture began on", () => {
  const events: TrailEvent[] = [
    { id: "open", ts: 1, kind: "act", op: "navigate", beforeUrl: "https://books.toscrape.com/", afterUrl: "https://books.toscrape.com/" },
    { id: "go", ts: 2, kind: "act", op: "click", identity: dom({ role: "link", text: "Travel", name: "Travel" }), beforeUrl: "https://books.toscrape.com/", afterUrl: "https://books.toscrape.com/catalogue/category/books/travel_2/index.html" },
  ];
  const doc = interpret(events, { id: "wf-open", name: "Open", startUrl: "https://books.toscrape.com/" });
  assert.equal(doc.startUrl, "https://books.toscrape.com/");
  assert.equal(doc.steps[0]?.action, "navigate");
  assert.equal(doc.steps[0]?.value, "https://books.toscrape.com/");
  assert.equal(doc.steps[1]?.action, "click");
});

test("radios, checkboxes, and selects are check and select steps", () => {
  const events: TrailEvent[] = [
    { id: "r", ts: 1, kind: "act", op: "check", checked: true, value: "Male", identity: dom({ role: "radio", id: "gender-radio-1", nameAttr: "gender", name: "Male", label: "Male" }) },
    { id: "c", ts: 2, kind: "act", op: "check", checked: true, identity: dom({ role: "checkbox", id: "hobbies-checkbox-1", name: "Sports", label: "Sports" }) },
    { id: "s", ts: 3, kind: "act", op: "select", value: "January", identity: dom({ role: "listbox", id: "months", name: "Month", label: "Month" }) },
  ];
  const doc = interpret(events, { id: "wf-form", name: "Form", startUrl: "https://demoqa.com/automation-practice-form" });
  assert.deepEqual(doc.steps.map((step) => step.action), ["check", "check", "select"]);
  assert.equal(doc.steps[0]?.checked, true);
  assert.equal(doc.steps[2]?.value, "{{months}}");
  assert.equal(doc.inputs.find((input) => input.name === "months")?.default, "January");
  assert.equal(doc.steps.some((step) => step.action === "type"), false);
});

test("a shared name loses to the recorded css path, test id, and href", () => {
  const signup = dom({ role: "textbox", tag: "input", nameAttr: "email", testId: "signup-email", cssPath: "form:nth-of-type(2) > input:nth-of-type(2)" });
  const login = dom({ role: "textbox", tag: "input", nameAttr: "email", cssPath: "form:nth-of-type(1) > input:nth-of-type(1)" });
  const fields = [login, signup];
  assert.equal(scoreLocator({ kind: "css", value: 'input[name="email"]' }, fields).score, 40);
  assert.equal(scoreLocator({ kind: "testid", value: "signup-email" }, fields).score, 100);
  assert.equal(matchLocator({ kind: "css", value: signup.cssPath || "" }, fields)?.index, 1);
  const first = dom({ role: "link", tag: "a", text: "Book now", name: "Book now", href: "/reservation/1", cssPath: "section:nth-of-type(1) > a:nth-of-type(1)" });
  const second = dom({ role: "link", tag: "a", text: "Book now", name: "Book now", href: "/reservation/2", cssPath: "section:nth-of-type(2) > a:nth-of-type(1)" });
  const rooms = [first, second];
  assert.equal(scoreLocator({ kind: "role", role: "link", name: "Book now" }, rooms).score, 40);
  assert.equal(matchLocator({ kind: "css", value: 'a[href="/reservation/1"]' }, rooms)?.index, 0);
  const locs = buildLocators(first, rooms);
  assert.equal(locs.some((item) => item.kind === "css" && item.value === 'a[href="/reservation/1"]'), true);
  assert.equal(locs.some((item) => item.value === first.cssPath), true);
  assert.equal(locs.some((item) => item.kind === "role" && item.name === ""), false);
});

test("the real signup-email tie is broken by the recorded test id and css path", async () => {
  // find-debug wf-1792674880957-2: login and signup are both name="email".
  // Role and input[name=email] scored 40. Both nameAttr scores were 70, a tie.
  const login = dom({
    role: "textbox",
    tag: "input",
    nameAttr: "email",
    cssPath: "#form > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(1) > form:nth-of-type(1) > input:nth-of-type(2)",
  });
  const signup = dom({
    role: "textbox",
    tag: "input",
    nameAttr: "email",
    testId: "signup-email",
    cssPath: "#form > div:nth-of-type(1) > div:nth-of-type(1) > div:nth-of-type(3) > div:nth-of-type(1) > form:nth-of-type(1) > input:nth-of-type(3)",
  });
  const fields = [login, signup];
  const tied = lookup(dom({ role: "textbox", nameAttr: "email" }), fields);
  assert.equal(tied.ok, false);
  assert.equal(scoreLocator({ kind: "role", role: "textbox", name: "" }, fields).score, 40);
  assert.equal(scoreLocator({ kind: "css", value: 'input[name="email"]' }, fields).score, 40);
  const recorded = interpret([
    {
      id: "e",
      ts: 1,
      kind: "act",
      op: "type",
      value: "bao-beta@example.com",
      identity: signup,
    },
  ], { id: "wf-tie", name: "Tie", startUrl: "https://automationexercise.com/login" });
  const step = recorded.steps[0]!;
  assert.equal(step.locators?.some((item) => item.kind === "testid" && item.value === "signup-email"), true);
  assert.equal(step.locators?.some((item) => item.kind === "css" && item.value === signup.cssPath), true);
  assert.equal(scoreLocator({ kind: "testid", value: "signup-email" }, fields).score, 100);
  assert.equal(matchLocator({ kind: "css", value: signup.cssPath || "" }, fields)?.index, 1);
  delete step.expect;
  delete step.postcondition;
  const filled: string[] = [];
  const live = tree(fields, { url: "https://automationexercise.com/login" });
  const driver: Driver = {
    tree: async () => live,
    snapshot: async () => ({ dom: [] }),
    click: async () => {},
    fill: async (node) => { filled.push(node.testId || node.cssPath || ""); },
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
  };
  const result = await replay(recorded, { username: "bao-beta@example.com" }, driver, { heal: unavailableHeal() });
  assert.equal(result.modelCalls, 0);
  assert.equal(result.locatorHits[0]?.kind, "testid");
  assert.deepEqual(filled, ["signup-email"]);
  assert.equal(result.steps[0]?.status, "passed");
});

test("Reserve Now is a confirm step and a prompt keeps the text it returned", () => {
  const events: TrailEvent[] = [
    { id: "r", ts: 1, kind: "act", op: "click", identity: dom({ role: "button", text: "Reserve Now", name: "Reserve Now" }) },
    { id: "p", ts: 2, kind: "act", op: "click", dialogType: "prompt", dialogValue: "proof-prompt", dialogDecision: "accept", afterText: "You entered: proof-prompt", identity: dom({ role: "button", text: "Click for JS Prompt" }) },
  ];
  const doc = interpret(events, { id: "wf-gate", name: "Gate", startUrl: "https://example.test/" });
  assert.equal(doc.steps[0]?.action, "confirm");
  assert.equal(doc.steps[0]?.human, true);
  assert.equal(doc.steps[0]?.confirm, true);
  assert.equal(doc.steps[0]?.gate, "confirm");
  assert.equal(doc.steps[1]?.action, "click");
  assert.equal(doc.steps[1]?.value, "{{prompt}}");
  assert.equal(doc.inputs.find((input) => input.name === "prompt")?.default, "proof-prompt");
  assert.equal(doc.steps[1]?.expect?.match, "You entered: {{prompt}}");
  assert.equal(doc.steps[1]?.postcondition?.match, "You entered: {{prompt}}");
});

test("Place Order, Buy, Pay, Submit order, and Reserve pause; Submit and JS Confirm stay clicks", () => {
  const pause = ["Place Order", "Buy", "Buy now", "Pay", "Pay now", "Submit order", "Reserve", "Reserve Now"];
  for (const name of pause) {
    const doc = interpret([
      { id: name, ts: 1, kind: "act", op: "click", identity: dom({ role: "button", text: name, name }) },
    ], { id: "wf-buy", name: "Buy", startUrl: "https://example.test/" });
    assert.equal(doc.steps[0]?.action, "confirm", name);
    assert.equal(doc.steps[0]?.confirm, true, name);
    assert.equal(doc.steps[0]?.human, true, name);
    assert.equal(doc.steps[0]?.gate, "confirm", name);
  }
  for (const name of ["Submit", "Click for JS Confirm", "Add to Cart"]) {
    const doc = interpret([
      { id: name, ts: 1, kind: "act", op: "click", identity: dom({ role: "button", text: name, name }) },
    ], { id: "wf-click", name: "Click", startUrl: "https://example.test/" });
    assert.equal(doc.steps[0]?.action, "click", name);
    assert.equal(doc.steps[0]?.confirm, undefined, name);
  }
  const tab = interpret([
    { id: "tab-pay", ts: 1, kind: "act", op: "click", identity: dom({ role: "tab", text: "Pay", name: "Pay" }) },
  ], { id: "wf-tab", name: "Tab", startUrl: "https://example.test/" });
  assert.equal(tab.steps[0]?.action, "click");
  assert.equal(tab.steps[0]?.confirm, undefined);
});

test("zero executed steps and a failed final check are not passes", () => {
  assert.equal(runPassed([]), false);
  assert.equal(runPassed([{ status: "pending" }]), false);
  assert.equal(runPassed([{ status: "passed", reason: "other branch" }]), false);
  assert.equal(runPassed([{ status: "passed" }], true), false);
  assert.equal(runPassed([{ status: "passed" }]), true);
});

test("a click inside an open shadow root is recorded on the inner control", async () => {
  const { chromium } = await import("playwright");
  const { recorderSource } = await import("../../src/v1/recorder.js");
  const { dumpPage } = await import("../../src/v1/dom-page.js");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const events: Array<{ op?: string; text?: string; name?: string; value?: string; checked?: boolean; target?: { role?: string } }> = [];
  try {
    const context = await browser.newContext();
    await context.exposeBinding("__baoRecord", async (_source: unknown, payload: { op?: string; identity?: { role?: string; text?: string; name?: string }; value?: string; checked?: boolean }) => {
      events.push({
        op: payload.op,
        text: payload.identity?.text,
        name: payload.identity?.name,
        value: payload.value,
        checked: payload.checked,
        target: { role: payload.identity?.role },
      });
    });
    await context.addInitScript(recorderSource());
    const page = await context.newPage();
    const html = `<!doctype html><shop-app></shop-app>
      <input id="closed" style="display:none" value="">
      <input id="place-order" type="button" value="Place Order">
      <input data-qa="signup-email" name="email">
      <label>Gender<input id="gender-radio-1" type="radio" name="gender" value="Male"></label>
      <select id="months"><option>January</option><option>February</option></select>
      <script>
        class Shop extends HTMLElement {
          constructor() {
            super();
            const root = this.attachShadow({ mode: "open" });
            root.innerHTML = '<a id="ladies" href="#ladies">Ladies Outerwear</a><a id="deep" href="#deep"><inner-pic></inner-pic>Deep link</a><select id="shade"><option>S</option><option>M</option></select>';
          }
        }
        class InnerPic extends HTMLElement {
          constructor() {
            super();
            const root = this.attachShadow({ mode: "open" });
            root.innerHTML = '<img alt="pic">';
          }
        }
        customElements.define("inner-pic", InnerPic);
        customElements.define("shop-app", Shop);
      </script>`;
    await page.goto(`data:text/html,${encodeURIComponent(html)}`);
    await page.evaluate(() => document.getElementById("closed")?.dispatchEvent(new Event("change", { bubbles: true })));
    const dumped = await page.evaluate(dumpPage);
    const ladies = dumped.nodes.find((node) => node.text === "Ladies Outerwear");
    assert.equal(ladies?.role, "link");
    assert.equal(ladies?.href, "#ladies");
    const email = dumped.nodes.find((node) => node.nameAttr === "email");
    assert.equal(email?.testId, "signup-email");
    assert.ok(email?.cssPath);
    await page.locator("#place-order").click();
    await page.locator("shop-app").locator("#ladies").click();
    await page.locator("#gender-radio-1").check();
    await page.locator("#months").selectOption({ label: "February" });
    await page.waitForTimeout(80);
    const place = events.find((event) => event.op === "click" && event.name === "Place Order");
    assert.equal(place?.target?.role, "button");
    const click = events.find((event) => event.op === "click" && event.text === "Ladies Outerwear");
    assert.equal(click?.target?.role, "link");
    const radio = events.find((event) => event.op === "check");
    assert.equal(radio?.checked, true);
    assert.equal(events.some((event) => event.op === "type"), false);
    const selected = events.find((event) => event.op === "select");
    assert.equal(selected?.value, "February");
    assert.equal(selected?.target?.role, "listbox");
    await page.locator("shop-app").locator("inner-pic").locator("img").click();
    await page.locator("shop-app").locator("#shade").selectOption({ label: "M" });
    await page.waitForTimeout(80);
    const deep = events.find((event) => event.op === "click" && (event.text || "").includes("Deep link"));
    assert.equal(deep?.target?.role, "link");
    const shaded = events.filter((event) => event.op === "select");
    assert.equal(shaded.at(-1)?.value, "M");
  } finally {
    await browser.close();
  }
});

test("replay of an empty workflow is not passed", async () => {
  const workflow: WorkflowV2 = {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf-empty",
    name: "Empty",
    startUrl: "https://example.test/",
    createdAt: 1,
    inputs: [],
    steps: [],
  };
  let trees = 0;
  const driver: Driver = {
    tree: async () => {
      trees += 1;
      return tree([], { url: "https://example.test/", texts: [] });
    },
    snapshot: async () => ({ dom: [] }),
    click: async () => {},
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
  };
  const result = await replay(workflow, {}, driver, { heal: unavailableHeal() });
  assert.equal(result.status, "failed");
  assert.match(result.failure?.reason || "", /no steps executed/);
  assert.equal(trees >= 0, true);
});
