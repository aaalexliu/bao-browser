import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { Library } from "../../src/v1/store";
import { syncStatus } from "../../src/v1/sync";
import { isElementCrop, redactedPng } from "../../src/v1/redacted-png";
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

test("a push sends the element crop and leaves the stripe fixture behind", () => {
  const crop = tinyPng(32, 24);
  const sent = buildPushBody(
    {
      inputs: [{ name: "password", type: "secret" }],
      steps: [{ id: "go" }, { id: "pass", sensitive: true, input: "password" }],
    },
    { baseVersion: 1, crops: [{ stepId: "go", png: crop }, { stepId: "pass", png: crop }] },
  );
  assert.equal(sent.shots.length, 1);
  assert.equal(sent.shots[0]?.stepId, "go");
  assert.equal(sent.shots[0]?.redacted, true);
  assert.equal(isElementCrop(Buffer.from(sent.shots[0]?.png || "", "base64")), true);
  const stripe = buildPushBody(
    { steps: [{ id: "go" }] },
    { baseVersion: 0, crops: [{ stepId: "go", png: redactedPng(1) }] },
  );
  assert.equal(stripe.shots.length, 0);
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

function tinyPng(width: number, height: number): Buffer {
  const raw = Buffer.alloc((1 + width * 3) * height);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    let c = ~0;
    for (const byte of body) {
      c ^= byte;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(~c >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function hasCookieKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCookieKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
    /^(cookie|cookies|set-cookie|setcookie)$/i.test(key) || hasCookieKey(child)
  ));
}
