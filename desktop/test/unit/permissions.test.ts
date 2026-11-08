import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
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
  assert.equal(consequentialCopy(both), "Includes a human confirm step.");

  const submit = permissionPreview({
    startUrl: "http://127.0.0.1:9/form",
    inputs: [{ name: "password", label: "Password", type: "secret" }],
    steps: [{ action: "click", label: "Submit the form", surface: "dom", identity: { surface: "dom", text: "Submit" } }],
  });
  assert.equal(submit.driver, "browser");
  assert.equal(driverLabel(submit.driver), "Browser");
  assert.equal(submit.confirm, false);
  assert.equal(submit.submit, true);
  assert.equal(consequentialCopy(submit), "Can press submit.");
  assert.equal(submit.inputs[0]?.secret, true);

  const quiet = permissionPreview({
    startUrl: "https://example.com/search",
    inputs: [],
    steps: [{ action: "key", label: "Open the fixture", surface: "dom" }],
  });
  assert.equal(quiet.confirm, false);
  assert.equal(quiet.submit, false);
  assert.equal(consequentialCopy(quiet), "Does not press confirm or submit.");
  assert.equal(permissionPreview({
    steps: [{ action: "click", label: "submission", surface: "ax", value: "not a url" }],
  }).driver, "computer-use");
  assert.equal(driverLabel("computer-use"), "Computer use");
  assert.equal(permissionPreview({ startUrl: "https://example.com" }).driver, "browser");
});

test("run_workflow installs and runs a marketplace listing without an allow record", async () => {
  const library = new Library(mkdtempSync(path.join(tmpdir(), "bao-listing-run-")));
  let origin = "";
  let submits = 0;
  let approvalRequests = 0;
  const document = {
    schema: "bao.workflow/v4", version: 2, id: "trust-1", name: "Place Order", createdAt: 1,
    get startUrl() { return `${origin}/fixture`; },
    inputs: [],
    steps: [{ id: "send", index: 0, action: "click", label: "Submit the order", surface: "dom", timeoutMs: 1000,
      identity: { surface: "dom", role: "button", testId: "send", text: "Place Order", path: [] },
      expect: { kind: "text", match: "Order placed", timeoutMs: 2000 } }],
  };
  const server = createServer((req, res) => {
    if (req.url === "/fixture") {
      res.setHeader("content-type", "text/html");
      res.end('<h1>Local order fixture</h1><button data-testid="send" onclick="fetch(\'/sent\',{method:\'POST\'}).then(()=>document.getElementById(\'status\').textContent=\'Order placed\')">Place Order</button><p id="status">Ready</p>');
    } else if (req.url === "/sent" && req.method === "POST") {
      submits += 1;
      res.end("ok");
    } else if (req.url?.startsWith("/api/workflows/trust-1")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ document, visibility: "public", owned: false }));
    } else if (req.url?.endsWith("/allow")) {
      approvalRequests += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ allowed: false }));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  writeFileSync(path.join(library.root, "sync.json"), JSON.stringify({ server: origin, deviceToken: "device-token" }));
  writeFileSync(path.join(library.root, "settings.json"), JSON.stringify({ siteTrust: { [origin]: "ask" } }));
  try {
    const result = await runWorkflow(library, { id: "trust-1" });
    assert.equal(result.outcome, "ok", result.reason);
    assert.equal(result.source, "marketplace");
    assert.equal(submits, 1);
    assert.equal(approvalRequests, 0);
    assert.equal(library.read("trust-1").name, "Place Order");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
