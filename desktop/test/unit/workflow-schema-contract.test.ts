import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv from "ajv/dist/2020";
import { specFromProposal, type PageProposal } from "../../src/v1/data-steps";
import { interpret } from "../../src/v1/interpret";
import { validateWorkflow, WORKFLOW_SCHEMA_ID, type WorkflowV2 } from "../../src/v1/schema";
import { workflowJsonSchema } from "../../src/v1/workflow-json-schema";

const published: unknown = JSON.parse(readFileSync("schema/workflow.schema.json", "utf8"));

test("the published schema is the desktop contract and accepts a saved click", () => {
  assert.deepEqual(published, workflowJsonSchema());
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(published);
  const saved = {
    schema: WORKFLOW_SCHEMA_ID,
    id: "row",
    name: "Pick a row",
    startUrl: "https://example.test/",
    createdAt: 1,
    inputs: [{ name: "row", type: "text", label: "Row", supply: "must" }],
    steps: [{
      id: "row",
      index: 0,
      action: "click",
      caption: { text: "Click the row named {{row}}" },
      timeoutMs: 8000,
      target: { locators: [{ kind: "css", value: "[data-testid=row]" }] },
      selection: { by: "text", input: "row" },
      dialog: { input: "choice" },
      optional: "dismiss",
    }],
  };
  assert.equal(validate(saved), true, ajv.errorsText(validate.errors));
});

test("the published schema accepts an extract workflow with column labels", () => {
  const proposal: PageProposal = {
    mode: "list",
    count: 1,
    locators: [{ kind: "css", value: "article" }],
    columns: [{ id: "title", name: "Title", read: "text", type: "text", locators: [{ kind: "css", value: "h3 a" }], samples: ["Alpha"] }],
  };
  const spec = specFromProposal(proposal, { as: "books" });
  const doc = interpret([{
    id: "read", ts: 1, kind: "act", op: "extract", extract: spec,
  }], { id: "books", name: "Books", startUrl: "https://books.example/" });
  const column = doc.steps[0]?.action === "extract" ? doc.steps[0].extract.columns[0] : undefined;
  assert.equal(column?.label, "Title");
  assert.equal(validateWorkflow(doc).join("\n"), "");
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(published);
  assert.equal(validate(doc), true, ajv.errorsText(validate.errors));
});

test("the published schema rejects a document the desktop rejects", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(published);
  const base = {
    schema: WORKFLOW_SCHEMA_ID,
    id: "bad",
    name: "Bad",
    startUrl: "https://example.test/",
    createdAt: 1,
    steps: [{ id: "type", index: 0, action: "type", caption: { text: "Type" }, timeoutMs: 8000, target: { locators: [{ kind: "css", value: "input" }] }, text: { input: "q" } }],
  };
  const emptyText = { ...base, inputs: [], steps: [{ ...base.steps[0], text: {} }] };
  const savedWithoutDefault = { ...base, inputs: [{ name: "q", type: "text", label: "Query", supply: "saved" }] };
  for (const doc of [emptyText, savedWithoutDefault]) {
    assert.equal(validate(doc), false);
    assert.ok(validateWorkflow(doc as WorkflowV2).length > 0);
  }
});
