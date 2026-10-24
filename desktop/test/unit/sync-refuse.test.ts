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

test("a secret-tagged value is refused on push and never sent", async () => {
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
  library.noteHealPromotion("secret-push", { args: { password: planted } });
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
    assert.match(view.lastResult || "", /Push refused: secret param/);
    assert.equal(seen.some((line) => line.includes(planted)), false);
    assert.equal(seen.some((line) => line.startsWith("POST /api/workflows/secret-push")), false);
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
