import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv from "ajv/dist/2020";
import { WORKFLOW_SCHEMA_ID } from "../../src/v1/schema";
import { workflowJsonSchema } from "../../src/v1/workflow-json-schema";

const published = JSON.parse(readFileSync("schema/workflow.schema.json", "utf8"));

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
