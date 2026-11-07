import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { syncAll } from "../../src/v1/sync";

const planted = "SuperSecretValue99";

for (const refused of [false, true]) test(`other sync categories continue when a workflow push ${refused ? "is refused" : "strips credentials"}`, async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${Buffer.concat(chunks).toString("utf8")}`);
      if (req.url === "/api/devices") {
        res.end(JSON.stringify({ devices: [], categories: [] }));
        return;
      }
      if (refused && req.url?.endsWith("/versions")) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid workflow" }));
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ version: 1 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const home = mkdtempSync(path.join(tmpdir(), "bao-secret-push-"));
  const library = new Library(home);
  library.save(secretWorkflow());
  library.noteHealPromotion("secret-push", { args: { password: planted, email: "ada@fixture.test", file: "/Users/ada/note.txt" } });
  library.saveRun({ id: "owner-run", workflowId: "secret-push", status: "passed", at: 1, steps: [], heals: [] });
  writeFileSync(path.join(home, "sync.json"), JSON.stringify({
    server: `http://127.0.0.1:${port}`,
    deviceToken: "device-token",
    backedUp: true,
    workflows: {},
    pushedRuns: [],
    remoteDevices: [],
    remoteCategories: [],
    conflicts: [],
  }));
  try {
    const view = await syncAll(library, "push");
    assert.match(view.lastResult || "", refused ? /Push refused: invalid workflow/ : /pushed 1/);
    assert.equal(seen.some((line) => line.includes(planted)), false);
    const pushed = seen.find((line) => line.startsWith("POST /api/workflows/secret-push/versions"));
    assert.ok(pushed);
    assert.equal(pushed.includes("ada@fixture.test"), true);
    assert.equal(pushed.includes("/Users/ada/note.txt"), true);
    assert.equal(seen.some((line) => line.startsWith("POST /api/workflows/secret-push/runs")), true);
    assert.equal(seen.some((line) => line.startsWith("POST /api/sync/settings")), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function secretWorkflow(): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "secret-push",
    name: "Secret push",
    startUrl: "http://127.0.0.1/fixture.html",
    inputs: [{ name: "password", type: "secret", label: "Password", required: true }],
    createdAt: 1,
    steps: [{
      id: "pass",
      index: 0,
      action: "type",
      label: "Type the password",
      surface: "dom",
      timeoutMs: 4000,
      input: "password",
      value: "{{password}}",
      sensitive: true,
      identity: { surface: "dom", role: "password", path: [] },
    }],
  };
}
