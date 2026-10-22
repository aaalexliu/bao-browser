import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Library } from "../../src/v1/store";
import { syncStatus } from "../../src/v1/sync";
import { assertSyncSafe, buildPushBody, SyncRejected } from "../../src/v1/sync-guard";

test("a secret-tagged param or a cookie is rejected", () => {
  assert.throws(
    () => assertSyncSafe({ inputs: [{ name: "password", type: "secret", value: "SuperSecret" }] }),
    (err: unknown) => err instanceof SyncRejected && /secret/.test(err.message),
  );
  assert.throws(
    () => assertSyncSafe({
      document: { inputs: [{ name: "password", type: "secret" }] },
      args: { password: "SuperSecret" },
    }),
    (err: unknown) => err instanceof SyncRejected && /secret/.test(err.message),
  );
  assert.throws(() => assertSyncSafe({ cookie: "session=abc" }), /cookie/);
  assert.throws(() => assertSyncSafe({ "Set-Cookie": "session=abc" }), /cookie/);
});

test("a push body drops secret values, cookies, and screenshot bytes", () => {
  const secret = "SuperSecret";
  const body = buildPushBody(
    {
      id: "wf",
      inputs: [{ name: "password", type: "secret", default: secret }],
      steps: [{ id: "pass", sensitive: true, value: secret }],
      cookie: "session=abc",
    },
    {
      baseVersion: 1,
      heal: { snapshot: { screenshot: "not-a-real-image", dom: "button" }, note: "kept" },
    },
  );
  const blob = JSON.stringify(body);
  assert.equal(blob.includes(secret), false);
  assert.equal(hasCookieKey(body), false);
  assert.equal(JSON.stringify(body.heal).includes("screenshot"), false);
  assert.equal((body.heal as { snapshot?: { dom?: string } }).snapshot?.dom, "button");
});

test("sync status does not return the device token", () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-sync-"));
  const library = new Library(root);
  writeFileSync(path.join(root, "sync.json"), JSON.stringify({
    server: "http://127.0.0.1:3000",
    deviceToken: "device-token-9f3c",
    deviceId: "dev",
    deviceName: "Ada's Mac",
    backedUp: false,
    workflows: {},
    pushedRuns: [],
    remoteDevices: [],
    remoteCategories: [],
    conflicts: [],
  }));
  const view = syncStatus(library);
  const blob = JSON.stringify(view);
  assert.equal(view.paired, true);
  assert.equal(view.deviceName, "Ada's Mac");
  assert.equal(blob.includes("deviceToken"), false);
  assert.equal(blob.includes("device-token-9f3c"), false);
  library.savePublicInputs("wf-public", { name: "ada" });
  assert.deepEqual(library.readPublicInputs("wf-public"), { name: "ada" });
  assert.equal(library.setSyncServer("http://127.0.0.1:9").syncServer, "http://127.0.0.1:9");
});

function hasCookieKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCookieKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
    /^(cookie|cookies|set-cookie|setcookie)$/i.test(key) || hasCookieKey(child)
  ));
}
