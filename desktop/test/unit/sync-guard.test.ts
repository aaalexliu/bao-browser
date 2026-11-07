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
import { fitPictureBody } from "../../../web/src/lib/sync-pictures";
import sharp from "sharp";
import type { WorkflowV2 } from "../../src/v1/schema";

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
      params: { token: "sk-ownerFixtureToken", email: "bag@fixture.test" },
      email: "ada@fixture.test", phone: "+1 415-555-0123", file: "/Users/ada/note.txt",
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
  assert.equal(blob.includes("bag@fixture.test"), false);
  assert.equal("args" in (body.document as object), false);
  assert.equal("params" in (body.document as object), false);
  assert.equal(blob.includes("ada@fixture.test"), true);
  assert.equal(blob.includes("+1 415-555-0123"), true);
  assert.equal(blob.includes("/Users/ada/note.txt"), true);
  assert.equal(JSON.stringify(body.heal).includes("not-a-real-image"), true);
  assert.equal((body.heal as { snapshot?: { dom?: string } }).snapshot?.dom, "button");
});

for (const build of [buildPushBody]) {
  test("workflow pushes omit typed token, card and SSN crops only", () => {
    const values = ["sk-FixtureCropToken123", "4111111111111111", "123-45-6789", "ordinary text"];
    const doc: WorkflowV2 = {
      schema: "bao.workflow/v2", version: 2, id: "crop-values", name: "Crop values", createdAt: 1,
      startUrl: "https://example.test/", inputs: values.map((value, index) => ({ name: `text${index}`, type: "text" as const, default: value })),
      steps: values.flatMap((value, index) => [
        { id: `bound${index}`, index: index * 2, action: "type" as const, label: "Type", surface: "dom" as const, timeoutMs: 1000,
          input: `text${index}`, value: `{{text${index}}}` },
        { id: `literal${index}`, index: index * 2 + 1, action: "type" as const, label: "Type", surface: "dom" as const, timeoutMs: 1000, value },
      ]),
    };
    const original = structuredClone(doc);
    const png = tinyPng(32, 24);
    const body = build(doc, { baseVersion: 0, crops: doc.steps.map((step) => ({ stepId: step.id, png })) });
    assert.deepEqual(body.shots.map((shot) => shot.stepId), ["bound3", "literal3"]);
    assert.deepEqual(doc, original);
    assert.ok(doc.inputs.every((input) => input.type === "text"));
    assert.ok(doc.steps.every((step) => !step.sensitive));
  });

  test("push accepts saved passwords that also occur in metadata", () => {
    for (const password of ["password", "secret", "test", "pass", "admin", "8000", "5000"]) {
      const doc: WorkflowV2 = {
        schema: "bao.workflow/v2", version: 2, id: "sync-password", name: "Password test", createdAt: 1,
        startUrl: "https://example.test/admin",
        inputs: [{ name: "password", type: "secret", default: password }],
        steps: [
          { id: "pass", index: 0, action: "type", label: "Type password", surface: "dom", timeoutMs: 8000,
            input: "password", value: "{{password}}", identity: { surface: "dom", role: "textbox", testId: "password", path: [] } },
          { id: "echo", index: 1, action: "type", label: "Echo", surface: "dom", timeoutMs: 5000, value: password },
        ],
      };
      const pushed = build(doc, { baseVersion: 0 }).document as WorkflowV2;
      assert.equal(pushed.inputs[0]!.default, undefined);
      assert.equal(pushed.inputs[0]!.name, "password");
      assert.equal(pushed.inputs[0]!.type, "secret");
      assert.equal(pushed.steps[0]!.value, "{{password}}");
      assert.equal(pushed.steps[0]!.identity!.testId, "password");
      assert.equal(pushed.steps[0]!.timeoutMs, 8000);
      assert.equal(pushed.steps[1]!.timeoutMs, 5000);
      assert.equal(pushed.steps[1]!.value, "[secret stripped]");
      assert.equal(pushed.startUrl, doc.startUrl);
      assert.equal(doc.inputs[0]!.default, password);
    }
    const document = { inputs: [{ name: "password", type: "secret" }] };
    const heal = { args: { password: "still-refused" } };
    const projected = build(document, { baseVersion: 0, heal });
    assert.deepEqual(projected.heal, {});
    assert.deepEqual(projected.document, document);
  });
}

test("workflow pictures skip private steps and retain control crops without markers", () => {
  const crop = tinyPng(320, 180);
  const sent = buildPushBody(
    {
      inputs: [{ name: "password", type: "secret" }],
      steps: [{ id: "go" }, { id: "pass", sensitive: true }, { id: "api", input: "password" }],
    },
    { baseVersion: 1, crops: [{ stepId: "go", png: crop }, { stepId: "pass", png: crop }, { stepId: "api", png: crop }] },
  );
  assert.equal(sent.shots.length, 1);
  assert.deepEqual(sent.shots.map((shot) => shot.stepId), ["go"]);
  assert.equal("redacted" in sent.shots[0]!, false);
  assert.deepEqual(Buffer.from(sent.shots[0]!.png, "base64"), crop);
  assert.equal(isElementCrop(crop), true);
  const run = buildRunBody({ id: "run", status: "passed", at: 1, steps: [{ id: "pass" }] }, { crops: [{ stepId: "pass", png: crop }] });
  assert.deepEqual(run.shots, [{ stepId: "pass", png: crop.toString("base64") }]);
  const stripe = buildPushBody(
    { steps: [{ id: "go" }] },
    { baseVersion: 0, crops: [{ stepId: "go", png: redactedPng(1) }] },
  );
  assert.equal(stripe.shots.length, 0);
  assert.deepEqual(buildPushBody({ steps: [{ id: "bad" }] }, { baseVersion: 0, crops: [{ stepId: "bad", png: Buffer.from("not an image") }] }).shots, []);
});

test("known-secret values strip without refusing or corrupting metadata and bindings", () => {
  const body = buildPushBody({
    inputs: [{ name: "password", type: "secret", default: "pass" }],
    steps: [{ id: "pass", input: "password", value: "{{password}}" }],
    args: { password: "pass" },
  }, { baseVersion: 0 });
  const document = body.document as { steps: { id: string; input: string; value: string }[]; args?: unknown };
  assert.equal(document.args, undefined);
  assert.deepEqual(document.steps, [{ id: "pass", input: "password", value: "{{password}}" }]);
});

test("picture sizing preserves samples, nested data and sealed references", async () => {
  const reference = `sha256:${"a".repeat(64)}`;
  const source = {
    shots: [],
    samples: { screenshot: "941031234", png: "021000021" },
    document: { screenshot: "not an image", nested: { png: "owner value" } },
    heal: { screenshot: reference, nested: { screenshot: "kept" } },
  };
  const fitted = await fitPictureBody(source);
  assert.deepEqual(fitted.body, source);
  assert.equal(fitted.omittedPictures, 0);
  const pressured = await fitPictureBody({ ...source, padding: "x".repeat(4_000_000) });
  assert.equal(pressured.tooLarge, true);
  assert.deepEqual(pressured.body.samples, source.samples);
  assert.deepEqual(pressured.body.heal, source.heal);
  assert.equal(pressured.omittedPictures, 0);
});

test("many-picture workflow, run and review bodies obey transport limits", async () => {
  const pixels = Buffer.alloc(720 * 480 * 3);
  let seed = 1;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const png = await sharp(pixels, { raw: { width: 720, height: 480, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
  const steps = Array.from({ length: 60 }, (_, i) => ({ id: `step-${i}` }));
  const crops = steps.map((step) => ({ stepId: step.id, png }));
  const sources = [
    buildPushBody({ steps }, { baseVersion: 0, crops }),
    buildRunBody({ id: "long-run", status: "passed", at: 1, steps }, { crops }),
    { documentHash: "review", shots: crops.map((crop) => ({ stepId: crop.stepId, png: crop.png.toString("base64") })) },
  ];
  for (const source of sources) {
    const fitted = await fitPictureBody(source);
    assert.equal(fitted.tooLarge, false);
    assert.ok(Buffer.byteLength(JSON.stringify(fitted.body)) < 4_000_000);
    assert.ok(fitted.omittedPictures > 0);
    assert.ok(fitted.body.shots.length > 0);
    for (const shot of fitted.body.shots) {
      const meta = await sharp(Buffer.from(shot.png, "base64")).metadata();
      assert.equal(meta.format, "jpeg");
      assert.ok(meta.width! <= 720 && meta.height! <= 480);
    }
  }
  assert.deepEqual((await fitPictureBody({ shots: [{ stepId: "broken", png: "broken" }] })).body.shots, []);
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
