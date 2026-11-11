import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import test from "node:test";
import sharp from "sharp";
import { pidsForDataDir } from "../../src/launch";
import { reviewWorkflow, runWorkflow } from "../../src/mcp/catalog";
import type { WorkflowStep, WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { scaledMs } from "../runtime";

test("marketplace review keeps all pictures local for private-input workflows and uploads ordinary workflows", { timeout: scaledMs(60_000) }, async (t) => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const root = mkdtempSync(path.join(tmpdir(), "bao-catalog-review-"));
  const library = new Library(root);
  let review: { shots: { stepId: string; png: string }[] } | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/fixture") {
      res.setHeader("content-type", "text/html");
      res.end('<!doctype html><button data-testid="go" onclick="document.getElementById(\'status\').textContent = \'Reviewed\'">Review sample</button><p id="status">Waiting</p>');
      return;
    }
    void text(req).then((body) => {
      if (req.method === "POST" && req.url === "/api/workflows/review-shot-scope/review") {
        review = JSON.parse(body) as typeof review;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    }).catch((error: unknown) => {
      res.writeHead(500);
      res.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let resume: string | undefined;
  try {
    const file = path.join(root, "sample.txt");
    await writeFile(file, "Synthetic attachment");
    const document: WorkflowV2 = testWorkflow({
      schema: "bao.workflow/v4",
      id: "review-shot-scope",
      name: "Review synthetic samples",
      startUrl: `${origin}/fixture`,
      createdAt: 1,
      inputs: [
        { name: "password", type: "secret", label: "Synthetic password", supply: "must" },
        { name: "attachment", type: "file", label: "Synthetic attachment", supply: "must" },
      ],
      steps: [
        { id: "ordinary", text: "Review ordinary sample" },
        { id: "secret-bound", text: "Review {{password}}" },
        { id: "file-bound", text: "Review {{attachment}}" },
      ].map(({ id, text }, index): WorkflowStep => ({
        id,
        index,
        timeoutMs: 5000,
        caption: { text, citation: { text: "Review sample", source: "text" } },
        heal: "never",
        action: "click",
        target: {
          locators: [
            { kind: "role", role: "button", name: "Review sample" },
            { kind: "text", value: "Review sample" },
            { kind: "testid", value: "go" },
            { kind: "css", value: '[data-testid="go"]' },
          ],
          hint: { role: "button", surface: "dom" },
        },
        check: { kind: "text", match: "Reviewed", timeoutMs: 5000 },
      })),
    });
    library.save(document);
    library.updateSettings({ pageEngine: "old" });
    const outcome = await reviewWorkflow(library, document.id, {
      password: "synthetic-password-42",
      attachment: { name: "sample.txt", path: file },
    }, { server: origin });
    resume = outcome.resume;
    assert.equal(outcome.outcome, "ok", outcome.reason);
    assert.equal(outcome.reviewed, true, outcome.reason);
    assert.ok(review);
    assert.ok(outcome.runId);
    const local = library.readRun(outcome.runId) as { steps: { id: string; afterShot?: string }[] };
    t.diagnostic(JSON.stringify({ uploaded: review.shots.map((shot) => shot.stepId), local: local.steps.map((step) => step.id) }));
    assert.deepEqual(local.steps.map((step) => step.id), document.steps.map((step) => step.id));
    for (const step of local.steps) {
      assert.ok(step.afterShot, step.id);
      const picture = await readFile(path.join(root, "shots", "runs", outcome.runId, step.afterShot));
      const decoded = await sharp(picture).raw().toBuffer({ resolveWithObject: true });
      assert.ok(decoded.info.width > 0 && decoded.info.height > 0, step.id);
    }
    assert.deepEqual(pidsForDataDir(path.join(root, "chrome-profile")), []);
    assert.equal(review.shots.length, 0);
    library.save(testWorkflow({ ...document, inputs: [], steps: [document.steps[0]!] }));
    const ordinary = await reviewWorkflow(library, document.id, {}, { server: origin });
    resume = ordinary.resume;
    assert.equal(ordinary.outcome, "ok", ordinary.reason);
    assert.equal(ordinary.reviewed, true, ordinary.reason);
    assert.deepEqual(review.shots.map((shot) => shot.stepId), ["ordinary"]);
    const uploaded = await sharp(Buffer.from(review.shots[0]!.png, "base64")).raw().toBuffer({ resolveWithObject: true });
    assert.ok(uploaded.info.width > 0 && uploaded.info.width <= 720);
    assert.ok(uploaded.info.height > 0 && uploaded.info.height <= 480);
  } finally {
    if (resume) await runWorkflow(library, { resume, cancel: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
