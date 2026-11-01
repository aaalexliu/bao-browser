// Extract, for_each, and outputs. Old workflows stay version 2.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { testChromium as chromium } from "../../src/test-browser.js";
import { dataCases } from "../../src/eval/data/cases";
import { installDataPage } from "../../src/v1/data-page";
import {
  bindStep,
  materializeOutputs,
  migrateDataSteps,
  outputCsv,
  outputsHtml,
  parseCsv,
  performDataStep,
  specFromProposal,
  validateDataSteps,
  type ExtractSpec,
  type PageProposal,
} from "../../src/v1/data-steps";
import { interpret } from "../../src/v1/interpret";
import { migrate, validateWorkflow, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";

test("a version 2 workflow is unchanged by the data migration", () => {
  const raw = JSON.parse(readFileSync("examples/workflows/browser-form.json", "utf8")) as WorkflowV2;
  const migrated = migrate(raw);
  assert.equal(migrated, raw);
  assert.equal(migrated.version, 2);
  assert.equal(validateWorkflow(migrated).length, 0);
  assert.deepEqual(validateDataSteps(migrated), []);
});

test("extract on a version 2 document migrates to version 3", () => {
  const doc = workflow();
  doc.version = 2;
  doc.steps = [extractStep()];
  doc.outputs = [{ name: "books", type: "table", from: "books", columns: [{ name: "title", type: "text" }] }];
  const migrated = migrateDataSteps(doc);
  assert.equal(migrated.version, 3);
  assert.notEqual(migrated, doc);
  assert.deepEqual(validateWorkflow(migrated), []);
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
    ...clickStep("row-0"),
    action: "type",
    value: "{{row.note}}",
    postcondition: { kind: "value", match: "{{row.note}}", timeoutMs: 4000 },
  }, { note: "hello, world" }, 0);
  assert.equal(bound.value, "hello, world");
  assert.equal(bound.postcondition?.match, "hello, world");
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

test("the published schema keeps version 2 and adds the data names", () => {
  const published = JSON.parse(readFileSync("schema/workflow-v2.schema.json", "utf8")) as {
    properties: { version: { enum: number[] }; outputs: unknown };
    $defs: { input: { properties: { type: { enum: string[] } } }; step: { properties: { action: { enum: string[] }; extract: unknown; forEach: unknown } }; extractSpec: { required: string[] }; forEachSpec: unknown; workflowOutput: unknown };
  };
  const fragment = JSON.parse(readFileSync("schema/data-steps.schema.json", "utf8")) as {
    actions: string[];
    inputTypes: string[];
    version: { enum: number[] };
    $defs: Record<string, { required?: string[] }>;
  };
  assert.deepEqual(published.properties.version.enum, [2, 3]);
  assert.deepEqual(fragment.version.enum, [2, 3]);
  assert.ok(published.$defs.input.properties.type.enum.includes("table"));
  assert.ok(fragment.inputTypes.includes("table"));
  for (const action of fragment.actions) assert.ok(published.$defs.step.properties.action.enum.includes(action));
  assert.ok(published.properties.outputs);
  assert.ok(published.$defs.step.properties.extract);
  assert.ok(published.$defs.step.properties.forEach);
  assert.deepEqual(published.$defs.extractSpec.required, fragment.$defs.extractSpec?.required);
});

test("interpret proposes extract and for_each, and leaves an ordinary trail on version 2", () => {
  for (const item of dataCases) {
    const doc = interpret(item.events, { id: item.id, name: item.name, startUrl: "https://books.toscrape.com/" });
    const blob = JSON.stringify(doc);
    if (item.expect === "plain") {
      assert.equal(doc.version, 2, item.id);
      assert.equal(doc.outputs, undefined);
      assert.equal(doc.steps.some((step) => step.action === "extract" || step.action === "for_each"), false);
      continue;
    }
    assert.equal(doc.version, 3, item.id);
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
      const values = (loop?.forEach?.steps ?? []).map((step) => step.value);
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
  const extracted = await performDataStep(extractStep(spec), {}, tables, {
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
    ...clickStep("each"),
    action: "for_each",
    heal: "never",
    forEach: {
      over: { kind: "input", name: "people" },
      steps: [{ ...clickStep("row-0"), action: "type", value: "{{row.email}}" }],
    },
  };
  const walked = await performDataStep(loop, {
    people: "email\nada@example.com\ngrace@example.com\nlinus@example.com\n",
  }, tables, {}, false, async (nested) => {
    seen.push(nested.value || "");
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

function workflow(): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf-data",
    name: "Data",
    startUrl: "https://books.toscrape.com/",
    inputs: [],
    steps: [],
    createdAt: 1,
  };
}

function clickStep(id: string): WorkflowStep {
  return { id, index: 0, action: "click", label: id, surface: "dom", timeoutMs: 8000 };
}

function extractStep(spec?: ExtractSpec): WorkflowStep {
  const extract = spec ?? {
    mode: "list" as const,
    as: "books",
    locators: [{ kind: "css" as const, value: "article.product_pod" }],
    columns: [{ name: "title", type: "text" as const, read: "title" as const, locators: [{ kind: "css" as const, value: "h3 > a" }] }],
  };
  return { ...clickStep("extract-1"), action: "extract", heal: "never", locators: extract.locators, extract };
}
