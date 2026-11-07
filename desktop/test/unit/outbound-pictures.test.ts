import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import test from "node:test";
import { hasPrivatePictureInput } from "../../../shared/outbound-secrets";
import { blankPng } from "../../src/v1/redacted-png";
import type { Identity, WorkflowV2 } from "../../src/v1/schema";
import { shotFile, workflowShotName } from "../../src/v1/shots";
import { Library } from "../../src/v1/store";
import { saveState, syncAll } from "../../src/v1/sync";

function workflow(id: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2", version: 2, id, name: "Synthetic picture upload", createdAt: 1,
    startUrl: "http://127.0.0.1:9/fixture", inputs: [],
    steps: [{ id: "go", index: 0, action: "click", label: "Click Pay", surface: "dom", timeoutMs: 1000 }],
  };
}

test("the shared outbound picture rule recognizes private input kinds and nested field identities", () => {
  for (const name of ["password", "card", "cc-exp", "one time code", "SSN", "CVV", "routing number", "PIN"]) {
    const doc = workflow("declaration");
    doc.inputs = [{ name: "answer", label: name, type: "text" }];
    assert.equal(hasPrivatePictureInput(doc), true, name);
    doc.inputs = [{ name, type: "text" }];
    assert.equal(hasPrivatePictureInput(doc), true, name);
  }
  const secret = workflow("secret");
  secret.inputs = [{ name: "answer", type: "secret" }];
  assert.equal(hasPrivatePictureInput(secret), true);
  const hints: Partial<Identity>[] = [
    { inputType: "password" },
    ...["current-password", "new-password", "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year", "cc-name", "one-time-code"].map((autocomplete) => ({ autocomplete })),
    { nameAttr: "ssn" }, { id: "pin" }, { label: "Routing number" }, { placeholder: "CVV" },
    { name: "Card number", nameAttr: "answer" },
  ];
  for (const hint of hints) {
    const doc = workflow("field");
    const typed = { ...doc.steps[0]!, action: "type" as const, identity: { surface: "dom" as const, role: "textbox", tag: "input", path: [], ...hint } };
    doc.steps = [typed];
    assert.equal(hasPrivatePictureInput(doc), true, JSON.stringify(hint));
    doc.steps = [{ ...doc.steps[0]!, action: "for_each", identity: undefined, forEach: { over: { kind: "input", name: "rows" }, steps: [typed] } }];
    assert.equal(hasPrivatePictureInput(doc), true, `nested ${JSON.stringify(hint)}`);
  }
  const ordinary = workflow("ordinary");
  ordinary.inputs = [{ name: "email", type: "text" }, { name: "attachment", type: "file" }];
  assert.equal(hasPrivatePictureInput(ordinary), false);
});

test("sync omits private-workflow step pictures from versions and runs without changing local crops", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-outbound-pictures-"));
  const library = new Library(root);
  const sent = new Map<string, { shots: { stepId: string; png: string }[] }>();
  const server = createServer((req, res) => {
    if (req.url === "/api/sync/snapshot") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    void text(req).then((body) => {
      if (req.method === "POST") sent.set(req.url!, JSON.parse(body));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(req.url === "/api/devices" ? { devices: [], categories: [] } : { version: 1, ok: true }));
    }).catch((error: unknown) => { res.writeHead(500); res.end(String(error)); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    saveState(root, {
      server: `http://127.0.0.1:${address.port}`, deviceToken: "fixture-token", deviceId: "fixture", deviceName: "Fixture",
      backedUp: true, workflows: {}, pushedRuns: [], remoteDevices: [], remoteCategories: [], conflicts: [],
    });
    const png = blankPng(120, 60);
    const localFiles: string[] = [];
    for (const id of ["private-declared", "private-field", "ordinary"]) {
      const doc = workflow(id);
      if (id === "private-declared") doc.inputs = [{ name: "PIN", type: "text" }];
      if (id === "private-field") doc.steps.push({
        ...doc.steps[0]!, id: "card", index: 1, action: "type",
        identity: { surface: "dom", role: "textbox", tag: "input", autocomplete: "cc-number", path: [] },
      });
      library.save(doc);
      const runId = `run-${id}`;
      library.saveRun({ id: runId, workflowId: id, status: "passed", at: 1, heals: [], steps: doc.steps.map((step) => ({ id: step.id, status: "passed" })) });
      for (const step of doc.steps) {
        const files = [
          path.join(root, "shots", "workflows", id, workflowShotName(step.id)),
          path.join(root, "shots", "runs", runId, shotFile(step.id, "after")),
        ];
        for (const file of files) {
          mkdirSync(path.dirname(file), { recursive: true });
          writeFileSync(file, png);
          localFiles.push(file);
        }
      }
    }
    await syncAll(library, "push");
    for (const id of ["private-declared", "private-field", "ordinary"]) {
      for (const suffix of ["versions", "runs"]) {
        const body = sent.get(`/api/workflows/${id}/${suffix}`);
        assert.ok(body, `${id}/${suffix}`);
        assert.deepEqual(body.shots.map((shot) => shot.stepId), id === "ordinary" ? ["go"] : [], `${id}/${suffix}`);
      }
    }
    for (const file of localFiles) assert.deepEqual(readFileSync(file), png);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
