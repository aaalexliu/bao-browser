import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { describeWorkflow, originLabel, runWorkflow, searchWorkflows } from "../../src/mcp/catalog";
import { Library } from "../../src/v1/store";
import type { WorkflowV2 } from "../../src/v1/schema";

test("search returns at most five hits and each hit has an input schema", async () => {
  const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-cat-")));
  for (let i = 0; i < 8; i++) library.save(workflow(`wf-${i}`, `Search workflow ${i}`));
  const hits = await searchWorkflows(library, "search");
  assert.ok(hits.length <= 5);
  assert.ok(hits.length >= 1);
  for (const hit of hits) {
    assert.ok(Array.isArray(hit.inputs));
    assert.equal(hit.inputs[0]?.name, "query");
    assert.equal(hit.link.startsWith("bao://workflow/"), true);
    assert.equal(hit.source, "this Mac");
    assert.equal(hit.lastGreen, "Not replayed yet");
  }
});

test("source names this Mac, the other device, or the marketplace", () => {
  assert.equal(originLabel({ local: true, bucket: "mine" }), "this Mac");
  assert.equal(originLabel({ local: false, bucket: "mine", deviceName: "Mac A", thisDevice: "Mac B" }), "Mac A");
  assert.equal(originLabel({ local: true, bucket: "mine", forkedFrom: "listing-1", deviceName: "Mac A" }), "marketplace");
  assert.equal(originLabel({ local: false, bucket: "public" }), "marketplace");
});

test("describe omits secret defaults and a missing secret does not launch a browser", async () => {
  const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-cat-")));
  const doc = workflow("sign-in", "Sign in");
  doc.inputs.push({ name: "password", type: "secret", label: "Password" });
  library.save(doc);
  const described = await describeWorkflow(library, "sign-in");
  const secret = described.workflow.inputs.find((input) => input.name === "password");
  assert.equal(secret?.default, undefined);
  assert.equal(described.inputs.find((input) => input.name === "password")?.type, "secret");
  assert.equal(described.link, "bao://workflow/sign-in");
  assert.equal(described.source, "this Mac");
  assert.equal(described.lastGreen, "Not replayed yet");
  const outcome = await runWorkflow(library, { id: "sign-in", inputs: { query: "ada" } });
  assert.equal(outcome.outcome, "needs_human");
  assert.match(outcome.reason || "", /Password/);
  assert.match(outcome.resume || "", /^r_[a-f0-9]+$/);
  assert.equal(JSON.stringify(outcome).includes("SuperSecret"), false);
});

function workflow(id: string, name: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name,
    startUrl: "https://example.com",
    createdAt: 1,
    inputs: [{ name: "query", type: "text", label: "Query" }],
    steps: [{
      id: "go",
      index: 0,
      action: "key",
      key: "Enter",
      label: `${name} step`,
      surface: "dom",
      timeoutMs: 1000,
    }],
  };
}
