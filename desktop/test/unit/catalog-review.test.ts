import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import test from "node:test";
import { pidsForDataDir } from "../../src/launch";
import { reviewWorkflow, runWorkflow } from "../../src/mcp/catalog";
import { inspectRunView, openStepPictures } from "../../src/mcp/run-view";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";

test("marketplace review keeps private step crops local while uploading ordinary crops", { timeout: 60_000 }, async (t) => {
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const root = mkdtempSync(path.join(tmpdir(), "bao-catalog-review-"));
  const library = new Library(root);
  let review: { shots: { stepId: string; png: string; redacted: boolean }[] } | undefined;
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
    const document: WorkflowV2 = {
      schema: "bao.workflow/v2",
      version: 2,
      id: "review-shot-scope",
      name: "Review synthetic samples",
      startUrl: `${origin}/fixture`,
      createdAt: 1,
      inputs: [
        { name: "password", type: "secret", label: "Synthetic password" },
        { name: "attachment", type: "file", label: "Synthetic attachment" },
      ],
      steps: [
        { id: "ordinary", label: "Review ordinary sample" },
        { id: "secret-bound", label: "Review {{password}}" },
        { id: "file-bound", label: "Review {{attachment}}" },
        { id: "sensitive", label: "Review marked sample", sensitive: true },
      ].map((step, index) => ({
        ...step,
        index,
        action: "click",
        heal: "never",
        surface: "dom",
        identity: { surface: "dom", role: "button", testId: "go", text: "Review sample", path: [] },
        postcondition: { kind: "text", match: "Reviewed", timeoutMs: 5000 },
        timeoutMs: 5000,
      })),
    };
    library.save(document);
    library.updateSettings({ pageEngine: "old", siteTrust: { [origin]: "allow" } });
    const outcome = await reviewWorkflow(library, document.id, {
      password: "synthetic-password-42",
      attachment: { name: "sample.txt", path: file },
    }, { server: origin });
    resume = outcome.resume;
    assert.equal(outcome.outcome, "ok", outcome.reason);
    assert.equal(outcome.reviewed, true, outcome.reason);
    assert.ok(review);
    assert.ok(outcome.runId);
    const local = inspectRunView(library, { run_id: outcome.runId });
    t.diagnostic(JSON.stringify({ uploaded: review.shots.map((shot) => shot.stepId), local: local.steps.map((step) => step.id) }));
    assert.deepEqual(local.steps.map((step) => step.id), document.steps.map((step) => step.id));
    for (const step of local.steps) {
      assert.equal(step.picturesAllowed, true, step.id);
      assert.ok(openStepPictures(library, { run_id: outcome.runId, step_id: step.id }).pictures.length > 0, step.id);
    }
    assert.deepEqual(pidsForDataDir(path.join(root, "chrome-profile")), []);
    assert.deepEqual(review.shots.map((shot) => shot.stepId), ["ordinary"]);
    assert.equal(review.shots[0]?.redacted, true);
    assert.deepEqual(Buffer.from(review.shots[0]!.png, "base64").subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  } finally {
    if (resume) await runWorkflow(library, { resume, cancel: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
