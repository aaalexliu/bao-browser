import { fixtureDoc, writeStep } from "../support/fixture-step";
import { projectStep } from "../../src/v1/schema";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import test from "node:test";
import sharp from "sharp";
import { publicSamples } from "../../../web/src/lib/import-sheet";
import { reviewWorkflow, runWorkflow } from "../../src/mcp/catalog";
import { privateReviewStep } from "../../src/mcp/review-step-privacy";
import { inspectRunView, openStepPictures } from "../../src/mcp/run-view";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";

const values = ["sk-reviewFixtureToken123456789", "4111111111111111", "123-45-6789", "Ada Lovelace"];

test("review samples preserve ordinary choice and fixed values", () => {
  assert.deepEqual(publicSamples({ currency: "USD", guests: "1", fixed: "standard", note: " public sample " }), {
    currency: "USD", guests: "1", fixed: "standard", note: "public sample",
  });
});

function workflow(origin: string): WorkflowV2 {
  return fixtureDoc({
    schema: "bao.workflow/v4", version: 2, id: "review-text-values", name: "Review text values",
    startUrl: `${origin}/fixture`, createdAt: 1,
    inputs: values.map((value, index) => ({ name: `sample${index}`, type: "text", default: value })),
    steps: values.map((value, index) => ({
      id: `field${index}`, index, action: "type", label: `Fill sample ${index}`, heal: "never", surface: "dom",
      input: `sample${index}`, value: `{{sample${index}}}`,
      identity: { surface: "dom", role: "textbox", testId: `field${index}`, path: [] },
      postcondition: { kind: "text", match: `Received ${value}`, timeoutMs: 5000 }, timeoutMs: 5000,
    })),
  });
}

test("review crop eligibility covers literal, default and actual run text values", () => {
  for (const source of ["literal", "default", "run"] as const) {
    const document = workflow("http://127.0.0.1");
    const run = { steps: [], inputs: {} as Record<string, string> };
    for (const [index, value] of values.entries()) {
      const step = document.steps[index]!;
      if (source !== "default") delete document.inputs[index]!.default;
      if (source === "literal") {
        delete projectStep(step).input;
        writeStep(step, { value: value });
      } else if (source === "run") run.inputs[`sample${index}`] = value;
      assert.equal(privateReviewStep(document, step, run), index < 3, `${source}: ${index}`);
    }
    assert.deepEqual(document.inputs.map((input) => input.type), ["text", "text", "text", "text"]);
  }
});

test("marketplace review withholds token card and SSN crops but retains raw local text evidence", { timeout: 60_000 }, async () => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const root = mkdtempSync(path.join(tmpdir(), "bao-review-values-"));
  const library = new Library(root);
  let review: { shots: { stepId: string; png: string }[]; samples: Record<string, string> } | undefined;
  const received: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/fixture") {
      res.setHeader("content-type", "text/html");
      res.end(`<!doctype html>${values.map((_, index) => `<label>Sample ${index}<input type="text" autocomplete="off" data-testid="field${index}" oninput="document.getElementById('status${index}').textContent = 'Received ' + this.value"></label><p id="status${index}">Waiting</p>`).join("")}`);
      return;
    }
    void text(req).then((body) => {
      if (req.method === "POST" && req.url === "/api/workflows/review-text-values/review") {
        review = JSON.parse(body) as typeof review;
        received.push(req.url);
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    }).catch((error: unknown) => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let resume: string | undefined;
  try {
    const document = workflow(origin);
    library.save(document);
    const saved = library.read(document.id);
    library.updateSettings({ pageEngine: "old" });
    const inputs = Object.fromEntries(values.map((value, index) => [`sample${index}`, value]));
    const outcome = await reviewWorkflow(library, document.id, inputs, { server: origin });
    resume = outcome.resume;
    assert.equal(outcome.outcome, "ok", outcome.reason);
    assert.equal(outcome.reviewed, true, outcome.reason);
    assert.ok(outcome.runId);
    assert.ok(review);
    assert.equal(received.length, 1);
    assert.deepEqual(review.samples, { sample3: "Ada Lovelace" });
    assert.deepEqual(review.shots.map((shot) => shot.stepId), ["field3"]);
    assert.equal(Object.hasOwn(review.shots[0]!, "redacted"), false);
    const picture = sharp(Buffer.from(review.shots[0]!.png, "base64"));
    assert.equal((await picture.metadata()).format, "jpeg");
    const { data, info } = await picture.raw().toBuffer({ resolveWithObject: true });
    assert.ok(info.width >= 2 && info.width <= 720);
    assert.ok(info.height >= 2 && info.height <= 480);
    assert.ok(data.length > 0);
    assert.equal(data.length, info.width * info.height * info.channels);
    const run = library.readRun(outcome.runId);
    assert.equal(run.modelCalls, 0);
    assert.deepEqual(run.inputs, inputs);
    assert.deepEqual(library.read(document.id), saved);
    assert.deepEqual(saved.inputs.map((input) => input.default), values);
    assert.deepEqual(saved.inputs.map((input) => input.type), ["text", "text", "text", "text"]);
    const local = inspectRunView(library, { run_id: outcome.runId });
    assert.deepEqual(local.steps.map((step) => step.id), ["field0", "field1", "field2", "field3"]);
    for (const step of local.steps) {
      assert.equal(step.picturesAllowed, true, step.id);
      assert.ok(openStepPictures(library, { run_id: outcome.runId, step_id: step.id }).pictures.length > 0, step.id);
    }
  } finally {
    if (resume) await runWorkflow(library, { resume, cancel: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
