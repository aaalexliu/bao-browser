import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { consequentialCopy, driverLabel, permissionPreview } from "../../../web/src/lib/permissions";
import { runWorkflow } from "../../src/mcp/catalog";
import { Library } from "../../src/v1/store";

test("a permissions preview names sites, secrets, the driver, and confirm or submit", () => {
  const both = permissionPreview({
    startUrl: "https://pay.example/checkout",
    inputs: [
      { name: "note", type: "text", label: "Note" },
      { name: "password", type: "secret", label: "Password" },
    ],
    steps: [
      { action: "click", label: "Open", surface: "dom", value: "https://pay.example/checkout" },
      { action: "click", label: "Save the note", surface: "os" },
      { action: "confirm", label: "you press Confirm", surface: "dom", gate: "confirm" },
    ],
  });
  assert.deepEqual(both.sites, ["https://pay.example"]);
  assert.deepEqual(both.inputs.map((input) => [input.name, input.secret]), [["note", false], ["password", true]]);
  assert.equal(both.driver, "browser and computer-use");
  assert.equal(driverLabel(both.driver), "Browser and computer use");
  assert.equal(both.confirm, true);
  assert.equal(both.submit, false);
  assert.equal(both.trust, "ask");
  assert.equal(consequentialCopy(both), "Can press confirm. Always ask.");

  const submit = permissionPreview({
    startUrl: "http://127.0.0.1:9/form",
    inputs: [{ name: "password", label: "Password", type: "secret" }],
    steps: [{ action: "click", label: "Submit the form", surface: "dom", identity: { surface: "dom", text: "Submit" } }],
  });
  assert.equal(submit.driver, "browser");
  assert.equal(driverLabel(submit.driver), "Browser");
  assert.equal(submit.confirm, false);
  assert.equal(submit.submit, true);
  assert.equal(submit.trust, "ask");
  assert.equal(consequentialCopy(submit), "Can press submit. Always ask.");
  assert.equal(submit.inputs[0]?.secret, true);

  const quiet = permissionPreview({
    startUrl: "https://example.com/search",
    inputs: [],
    steps: [{ action: "key", label: "Open the fixture", surface: "dom" }],
  });
  assert.equal(quiet.confirm, false);
  assert.equal(quiet.submit, false);
  assert.equal(quiet.trust, "allow");
  assert.equal(consequentialCopy(quiet), "Does not press confirm or submit.");
  assert.equal(permissionPreview({
    steps: [{ action: "click", label: "submission", surface: "ax", value: "not a url" }],
  }).driver, "computer-use");
  assert.equal(driverLabel("computer-use"), "Computer use");
  assert.equal(permissionPreview({ startUrl: "https://example.com" }).driver, "browser");
});

test("run_workflow on an un-allowed listing returns needs_approval and does not install", async () => {
  const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-allow-")));
  const document = {
    schema: "bao.workflow/v2",
    version: 2,
    id: "trust-1",
    name: "Pay",
    startUrl: "https://pay.example/checkout",
    createdAt: 1,
    inputs: [{ name: "password", type: "secret", label: "Password" }],
    steps: [{
      id: "send",
      index: 0,
      action: "click",
      label: "Submit the form",
      surface: "dom",
      timeoutMs: 1000,
    }],
  };
  const server = createServer((req, res) => {
    const url = req.url || "";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/api/workflows/trust-1")) {
      res.end(JSON.stringify({ document, visibility: "public", owned: false }));
      return;
    }
    if (url.startsWith("/api/marketplace/trust-1/allow")) {
      res.end(JSON.stringify({ allowed: false }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeFileSync(path.join(library.root, "sync.json"), JSON.stringify({
    server: `http://127.0.0.1:${port}`,
    deviceToken: "device-token",
  }));
  mkdirSync(path.join(library.root, "allows"), { recursive: true });
  writeFileSync(path.join(library.root, "allows", "trust-1.json"), "{}");
  try {
    const blocked = await runWorkflow(library, { id: "trust-1", inputs: {} });
    assert.equal(blocked.outcome, "needs_approval");
    assert.equal(blocked.status, "needs_approval");
    assert.equal(blocked.source, "marketplace");
    assert.equal(blocked.workflowId, "trust-1");
    assert.equal(blocked.reason, "Allow this listing before it can run.");
    assert.equal(blocked.link, "bao://workflow/trust-1");
    assert.deepEqual(blocked.receipts, []);
    assert.equal(blocked.permissions?.driver, "browser");
    assert.equal(blocked.permissions?.submit, true);
    assert.equal(blocked.permissions?.confirm, false);
    assert.equal(blocked.permissions?.trust, "ask");
    assert.equal(blocked.permissions?.inputs[0]?.secret, true);
    assert.deepEqual(blocked.permissions?.sites, ["https://pay.example"]);
    assert.throws(() => library.read("trust-1"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
