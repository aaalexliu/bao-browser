import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { Library } from "../../src/v1/store";
import { syncStatus } from "../../src/v1/sync";
import { isElementCrop, redactedPng } from "../../src/v1/redacted-png";
import { buildPushBody, buildRunBody } from "../../../web/src/lib/guard";

test("a push retains owner data and screenshots while stripping credentials", () => {
  const secret = "SuperSecret";
  const body = buildPushBody(
    {
      id: "wf",
      inputs: [{ name: "password", type: "secret", default: secret }],
      steps: [{ id: "pass", sensitive: true, value: secret }],
      cookie: "session=abc",
      authorization: "Bearer fixture-token",
      args: { password: secret },
      params: { token: "sk-ownerFixtureToken", email: "ada@fixture.test", phone: "+1 415-555-0123", file: "/Users/ada/note.txt" },
    },
    {
      baseVersion: 1,
      heal: { snapshot: { screenshot: "not-a-real-image", dom: "button" }, note: "kept" },
    },
  );
  const blob = JSON.stringify(body);
  assert.equal(blob.includes(secret), false);
  assert.equal(hasCookieKey(body), false);
  assert.equal(blob.includes("fixture-token"), false);
  assert.equal(blob.includes("sk-ownerFixtureToken"), false);
  assert.equal(blob.includes("ada@fixture.test"), true);
  assert.equal(blob.includes("+1 415-555-0123"), true);
  assert.equal(blob.includes("/Users/ada/note.txt"), true);
  assert.equal(JSON.stringify(body.heal).includes("not-a-real-image"), true);
  assert.equal((body.heal as { snapshot?: { dom?: string } }).snapshot?.dom, "button");
});

test("push and run payloads retain secret-step pictures and full-page pictures without redaction markers", () => {
  const crop = tinyPng(1200, 900);
  const sent = buildPushBody(
    {
      inputs: [{ name: "password", type: "secret" }],
      steps: [{ id: "go" }, { id: "pass", sensitive: true, input: "password" }],
    },
    { baseVersion: 1, crops: [{ stepId: "go", png: crop }, { stepId: "pass", png: crop }] },
  );
  assert.equal(sent.shots.length, 2);
  assert.deepEqual(sent.shots.map((shot) => shot.stepId), ["go", "pass"]);
  assert.equal("redacted" in sent.shots[0]!, false);
  assert.deepEqual(Buffer.from(sent.shots[0]!.png, "base64"), crop);
  assert.equal(isElementCrop(crop), false);
  const run = buildRunBody({ id: "run", status: "passed", at: 1, steps: [{ id: "pass" }] }, { crops: [{ stepId: "pass", png: crop }] });
  assert.deepEqual(run.shots, [sent.shots[1]]);
  const stripe = buildPushBody(
    { steps: [{ id: "go" }] },
    { baseVersion: 0, crops: [{ stepId: "go", png: redactedPng(1) }] },
  );
  assert.equal(stripe.shots.length, 1);
  assert.deepEqual(buildPushBody({ steps: [{ id: "bad" }] }, { baseVersion: 0, crops: [{ stepId: "bad", png: Buffer.from("not an image") }] }).shots, []);
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
