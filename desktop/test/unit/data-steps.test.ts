// Extract, for_each, and outputs.

import { stepText, testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { testChromium as chromium } from "../../src/test-browser.js";
import { dataCases } from "../../src/eval/data/cases";
import { installDataPage } from "../../src/v1/data-page";
import { bindStep, materializeOutputs, outputCsv, outputsHtml, parseCsv, performDataStep, specFromProposal, validateDataSteps, type ExtractSpec, type PageProposal } from "../../src/v1/data-steps";
import { interpret } from "../../src/v1/interpret";
import { checkMatch, stepCheck, validateWorkflow, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";

test("a saved workflow is schema v4 and validates", () => {
  const raw = JSON.parse(readFileSync("examples/workflows/browser-form.json", "utf8")) as WorkflowV2;
  assert.equal(raw.schema, "bao.workflow/v4");
  assert.equal(validateWorkflow(raw).length, 0);
  assert.deepEqual(validateDataSteps(raw), []);
});

test("an extract step and its table output validate", () => {
  const doc = workflow();
  doc.steps = [{
    id: "extract-1",
    index: 0,
    timeoutMs: 8000,
    caption: { text: "extract-1" },
    heal: "never",
    action: "extract",
    extract: {
      mode: "list",
      as: "books",
      locators: [{ kind: "css", value: "article.product_pod" }],
      columns: [{ name: "title", type: "text", read: "title", locators: [{ kind: "css", value: "h3 > a" }] }],
    },
  }];
  doc.outputs = [{ name: "books", type: "table", from: "books", columns: [{ name: "title", type: "text" }] }];
  assert.deepEqual(validateWorkflow(doc), []);
});

test("csv, column choices, and the run table", () => {
  const rows = parseCsv('name,note\nAda,"hello, world"\nGrace,plain\n');
  assert.deepEqual(rows, [
    { name: "Ada", note: "hello, world" },
    { name: "Grace", note: "plain" },
  ]);
  const proposal: PageProposal = {
    mode: "list",
    count: 2,
    locators: [{ kind: "css", value: "article.product_pod" }],
    columns: [
      { id: "title", name: "title", read: "title", type: "text", locators: [{ kind: "css", value: "h3 > a" }], samples: ["Alpha"] },
      { id: "price_color", name: "price_color", read: "text", type: "text", locators: [{ kind: "css", value: "p.price_color" }], samples: ["£10.00"] },
      { id: "stock", name: "stock", read: "text", type: "text", locators: [{ kind: "css", value: "p.instock" }], samples: ["In stock"] },
    ],
    next: [{ kind: "css", value: "li.next a" }],
  };
  const spec = specFromProposal(proposal, { names: { price_color: "price" }, drop: ["stock"], maxPages: 3, as: "books" });
  assert.deepEqual(spec.columns.filter((column) => !column.dropped).map((column) => column.name), ["title", "price"]);
  assert.equal(spec.pagination?.maxPages, 3);
  const bound = bindStep({
    id: "row-0",
    index: 0,
    timeoutMs: 8000,
    caption: { text: "row-0" },
    action: "type",
    target: { locators: [{ kind: "role", role: "button", name: "row-0" }] },
    text: { literal: "{{row.note}}" },
    check: { kind: "value", match: "{{row.note}}", timeoutMs: 4000 },
  }, { note: "hello, world" }, 0);
  assert.deepEqual(stepText(bound), { literal: "hello, world" });
  assert.equal(checkMatch(stepCheck(bound)), "hello, world");
  const outputs = materializeOutputs(
    { outputs: [{ name: "books", type: "table", from: "books", columns: [{ name: "title", type: "text" }] }] },
    new Map([["books", [{ title: "Alpha" }]]]),
  );
  assert.equal(outputCsv(outputs), "title\nAlpha\n");
  const html = outputsHtml("run-1", outputs);
  assert.match(html, /id="run-outputs"/);
  assert.match(html, /id="output-csv"/);
  assert.match(html, /id="output-json"/);
  assert.match(html, /data-rows="1"/);
});

test("the published schema accepts data steps", () => {
  const published = JSON.parse(readFileSync("schema/workflow.schema.json", "utf8")) as {
    properties: {
      outputs: unknown;
      version?: unknown;
      inputs: { items: { properties: { type: { enum: string[] } } } };
      steps: { items: { oneOf: { properties: { action: { const: string } }; required?: string[] }[] } };
    };
  };
  assert.equal(published.properties.version, undefined);
  assert.ok(published.properties.inputs.items.properties.type.enum.includes("table"));
  const actions = published.properties.steps.items.oneOf.map((step) => step.properties.action.const);
  for (const action of ["extract", "for_each"]) assert.ok(actions.includes(action));
  assert.ok(published.properties.outputs);
  const extract = published.properties.steps.items.oneOf.find((step) => step.properties.action.const === "extract");
  assert.ok(extract?.required?.includes("extract"));
});

test("interpret proposes extract and for_each, and leaves an ordinary trail plain", () => {
  for (const item of dataCases) {
    const doc = interpret(item.events, { id: item.id, name: item.name, startUrl: "https://books.toscrape.com/" });
    const blob = JSON.stringify(doc);
    if (item.expect === "plain") {
      assert.equal(doc.outputs, undefined);
      assert.equal(doc.steps.some((step) => step.action === "extract" || step.action === "for_each"), false);
      continue;
    }
    assert.equal(validateWorkflow(doc).join(", "), "", item.id);
    if (item.expect === "extract") {
      assert.equal(doc.steps[0]?.action, "extract");
      assert.equal(doc.outputs?.[0]?.type, "table");
      assert.equal(blob.includes("Alpha"), false);
      assert.equal(blob.includes("£10.00"), false);
    } else {
      const loop = doc.steps.find((step) => step.action === "for_each");
      assert.ok(loop?.forEach);
      assert.equal(loop?.forEach?.over.kind, "input");
      assert.ok(doc.inputs.some((input) => input.type === "table"));
      const values = (loop?.forEach?.steps ?? []).map((step) => {
        const text = stepText(step);
        return text && "literal" in text ? text.literal : "";
      });
      assert.ok(values.includes("{{row.name}}"), values.join(" "));
      assert.ok(values.includes("{{row.email}}"), values.join(" "));
      assert.equal(blob.includes("ada@example.com"), false);
      assert.equal(blob.includes("Ada Lovelace"), false);
    }
  }
});

test("extract paginates until next is gone and for_each binds each row", async () => {
  const spec: ExtractSpec = {
    mode: "list",
    as: "books",
    locators: [{ kind: "css", value: "article.product_pod" }],
    columns: [{ name: "title", type: "text", read: "text", locators: [{ kind: "css", value: "h3 > a" }] }],
    pagination: { next: [{ kind: "css", value: "li.next a" }], maxPages: 3 },
  };
  let page = 0;
  const tables = new Map<string, Record<string, string>[]>();
  const extracted = await performDataStep({
    id: "extract-1",
    index: 0,
    timeoutMs: 8000,
    caption: { text: "extract-1" },
    heal: "never",
    action: "extract",
    extract: spec,
  }, {}, tables, {
    async readList() {
      page += 1;
      return { rows: [{ title: `Page ${page}` }], nextVisible: page < 2 };
    },
    async activate() { return true; },
    async waitIdle() {},
  }, false, async () => ({ ok: true }));
  assert.equal(extracted.ok && extracted.detail, "2 rows");
  assert.equal(page, 2);
  const seen: string[] = [];
  const loop: WorkflowStep = {
    id: "each",
    index: 0,
    timeoutMs: 8000,
    caption: { text: "each" },
    heal: "never",
    action: "for_each",
    forEach: {
      over: { kind: "input", name: "people" },
      steps: [{
        id: "row-0",
        index: 0,
        timeoutMs: 8000,
        caption: { text: "row-0" },
        action: "type",
        target: { locators: [{ kind: "role", role: "button", name: "row-0" }] },
        text: { literal: "{{row.email}}" },
      }],
    },
  };
  const walked = await performDataStep(loop, {
    people: "email\nada@example.com\ngrace@example.com\nlinus@example.com\n",
  }, tables, {}, false, async (nested) => {
    const text = stepText(nested);
    seen.push(text && "literal" in text ? text.literal : "");
    return { ok: true };
  });
  assert.equal(walked.ok && walked.detail, "3 rows");
  assert.deepEqual(seen, ["ada@example.com", "grace@example.com", "linus@example.com"]);
});

test("picking one card proposes the list and reads every row", async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><ol class="row">
      <li><article class="product_pod"><p class="star-rating Three">Three</p><h3><a href="a.html" title="Alpha Book">Alpha</a></h3><p class="price_color">£10.00</p></article></li>
      <li><article class="product_pod"><p class="star-rating Five">Five</p><h3><a href="b.html" title="Beta Book">Beta</a></h3><p class="price_color">£20.00</p></article></li>
    </ol><li class="next"><a href="p2.html">next</a></li>`);
    await page.evaluate(installDataPage);
    const proposal = await page.evaluate(() => {
      const host = window as unknown as { __baoPropose?: (arg: { selector: string }) => PageProposal };
      return host.__baoPropose?.({ selector: "article.product_pod" });
    });
    assert.equal(proposal?.mode, "list");
    assert.equal(proposal?.count, 2);
    assert.ok(proposal?.next?.length);
    const names = Object.fromEntries((proposal?.columns ?? []).map((column) => [column.id, column.name]));
    const spec = specFromProposal(proposal!, { names, maxPages: 2, as: "books" });
    const read = await page.evaluate((payload) => {
      const host = window as unknown as { __baoReadList?: (spec: unknown) => { rows: Record<string, string>[]; nextVisible: boolean } };
      return host.__baoReadList?.(payload);
    }, spec);
    assert.equal(read?.rows.length, 2);
    assert.equal(read?.nextVisible, true);
    assert.equal(read?.rows[0]?.title, "Alpha Book");
    assert.equal(read?.rows[0]?.price_color, "£10.00");
    assert.equal(read?.rows[0]?.rating, "Three");
  } finally {
    await browser.close();
  }
});

test("picking a card taller than the viewport still reads the list", async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage({ viewport: { width: 756, height: 413 } });
    await page.setContent(`<!doctype html><style>.product_pod { height: 500px; }</style>
    <div class="page_inner"><div class="row"><h1>Catalogue</h1></div><div class="row"><ol class="products">
      <li class="card"><article class="product_pod"><h3><a title="Alpha Book">Alpha</a></h3><p class="price_color">£10.00</p></article></li>
      <li class="card"><article class="product_pod"><h3><a title="Beta Book">Beta</a></h3><p class="price_color">£20.00</p></article></li>
      <li class="card"><article class="product_pod"><h3><a title="Gamma Book">Gamma</a></h3><p class="price_color">£30.00</p></article></li>
    </ol></div></div>`);
    await page.evaluate(installDataPage);
    const proposal = await page.evaluate(() => {
      const host = window as unknown as { __baoPropose: (arg: { selector: string }) => PageProposal };
      return host.__baoPropose({ selector: "article.product_pod" });
    });
    assert.equal(proposal.mode, "list");
    assert.equal(proposal.count, 3);
    const spec = specFromProposal(proposal, { as: "books" });
    const read = await page.evaluate((payload) => {
      const host = window as unknown as { __baoReadList: (spec: unknown) => { rows: Record<string, string>[] } };
      return host.__baoReadList(payload);
    }, spec);
    assert.deepEqual(read.rows.map((row) => row.title), ["Alpha Book", "Beta Book", "Gamma Book"]);
    assert.deepEqual(read.rows.map((row) => row.price_color), ["£10.00", "£20.00", "£30.00"]);
  } finally {
    await browser.close();
  }
});

test("picking a title in a row of repeated cells reads the story rows", async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><table><tbody>
      <tr class="athing submission"><td class="title"><span class="rank">1.</span></td><td class="title"><span class="titleline"><a href="a.html">Alpha Story</a></span></td><td class="score">10 points</td></tr>
      <tr class="athing submission"><td class="title"><span class="rank">2.</span></td><td class="title"><span class="titleline"><a href="b.html">Beta Story</a></span></td><td class="score">20 points</td></tr>
      <tr class="athing submission"><td class="title"><span class="rank">3.</span></td><td class="title"><span class="titleline"><a href="c.html">Gamma Story</a></span></td><td class="score">30 points</td></tr>
    </tbody></table>`);
    await page.evaluate(installDataPage);
    const proposal = await page.evaluate(() => {
      const host = window as unknown as { __baoPropose: (arg: { selector: string }) => PageProposal };
      return host.__baoPropose({ selector: "span.titleline a" });
    });
    assert.equal(proposal.mode, "list");
    assert.equal(proposal.count, 3);
    const spec = specFromProposal(proposal, { as: "stories" });
    const read = await page.evaluate((payload) => {
      const host = window as unknown as { __baoReadList: (spec: unknown) => { rows: Record<string, string>[] } };
      return host.__baoReadList(payload);
    }, spec);
    assert.deepEqual(read.rows.map((row) => row.link), ["Alpha Story", "Beta Story", "Gamma Story"]);
    assert.deepEqual(read.rows.map((row) => row.score), ["10 points", "20 points", "30 points"]);
  } finally {
    await browser.close();
  }
});

function workflow(): WorkflowV2 {
  return testWorkflow({
    schema: "bao.workflow/v4",
    id: "wf-data",
    name: "Data",
    startUrl: "https://books.toscrape.com/",
    inputs: [],
    steps: [],
    createdAt: 1,
  });
}

