import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ExtensionDriver } from "../../src/extension/driver";
import { testChromium } from "../../src/test-browser.js";
import { BrowserDriver } from "../../src/v1/browser-driver";
import type { ExtensionLink } from "../../src/extension/link";
import { replay, type Driver } from "../../src/v1/replay";
import { shotFormat } from "../../src/v1/shots";
import type { WorkflowV2 } from "../../src/v1/schema";

const workflow: WorkflowV2 = {
  schema: "bao.workflow/v2", version: 2, id: "wf-shots", name: "Run pictures",
  startUrl: "http://127.0.0.1/fixture", createdAt: 1, inputs: [], driver: "extension",
  steps: [{ id: "step", index: 0, action: "note", label: "Fixture", surface: "dom", timeoutMs: 1000 }],
};

// The native-messaging byte contract, before image decoding in the UI.
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32), Buffer.from([0xff, 0xd9])]);

function extensionShot(bytes: Buffer): ExtensionDriver {
  return new ExtensionDriver({ command: async (op: string) => op === "shot"
    ? { jpeg: `data:image/jpeg;base64,${bytes.toString("base64")}` }
    : {} } as ExtensionLink);
}

test("Library replay saves the extension's before and after JPEG bytes", async () => {
  const shotDir = mkdtempSync(path.join(tmpdir(), "bao-jpeg-shots-"));
  try {
    const driver = extensionShot(jpeg);
    assert.deepEqual(await driver.pageShot(), jpeg);
    const run = await replay(workflow, {}, driver, { runId: "run-jpeg", shotDir });
    assert.equal(run.status, "passed");
    assert.equal(readdirSync(shotDir).length, 2, "both JPEGs must reach the run's shot folder");
    for (const ref of [run.steps[0]?.beforeShot, run.steps[0]?.afterShot]) {
      assert.ok(ref, "the run must keep a picture reference");
      assert.match(ref, /\.jpg$/);
      assert.deepEqual(readFileSync(path.join(shotDir, ref)), jpeg);
    }
  } finally {
    rmSync(shotDir, { recursive: true, force: true });
  }
});

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8V8AAAAASUVORK5CYII=", "base64");

test("PNG drivers keep PNG filenames, including steps whose guard is already done", async () => {
  const shotDir = mkdtempSync(path.join(tmpdir(), "bao-png-shots-"));
  try {
    const driver = extensionShot(jpeg);
    driver.shot = async () => png;
    const guarded = { ...workflow, steps: [{ ...workflow.steps[0]!, when: { absent: "Done" } }] };
    driver.tree = async () => ({ nodes: [], texts: ["Done"], values: [] });
    const run = await replay(guarded, {}, driver, { shotDir });
    assert.equal(run.steps[0]?.reason, "already done");
    assert.equal(readdirSync(shotDir).length, 2);
    for (const ref of [run.steps[0]?.beforeShot, run.steps[0]?.afterShot]) {
      assert.ok(ref);
      assert.match(ref, /\.png$/);
      assert.equal(shotFormat(readFileSync(path.join(shotDir, ref))), "png");
    }
  } finally {
    rmSync(shotDir, { recursive: true, force: true });
  }
});

for (const [name, shot, reason] of [
  ["unsupported driver", undefined, "This driver cannot take page pictures."],
  ["empty capture", async () => undefined, "Chrome returned no picture."],
  ["invalid capture", async () => Buffer.from("not a picture"), "Chrome returned an unsupported picture format."],
  ["capture timeout", async () => { throw new Error("screenshot timed out: private page details"); }, "Chrome timed out taking this picture."],
] as const) {
  test(`${name} records a safe reason for each missing picture`, async () => {
    const shotDir = mkdtempSync(path.join(tmpdir(), "bao-shot-error-"));
    try {
      const driver: Driver = extensionShot(jpeg);
      driver.shot = shot;
      driver.pageShot = shot;
      const run = await replay(workflow, {}, driver, { shotDir });
      assert.equal(run.status, "passed");
      assert.equal(run.steps[0]?.beforeShotError, reason);
      assert.equal(run.steps[0]?.afterShotError, reason);
      assert.equal(run.steps[0]?.beforeShot, undefined);
      assert.equal(run.steps[0]?.afterShot, undefined);
    } finally {
      rmSync(shotDir, { recursive: true, force: true });
    }
  });
}

test("Playwright saves the whole page when a step has no crop target", async () => {
  const shotDir = mkdtempSync(path.join(tmpdir(), "bao-page-shots-"));
  const browser = await testChromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<h1>Fixture page</h1>");
    const run = await replay({ ...workflow, driver: "playwright" }, {}, new BrowserDriver(page), { shotDir });
    assert.equal(run.status, "passed");
    assert.equal(readdirSync(shotDir).length, 2);
    for (const ref of [run.steps[0]?.beforeShot, run.steps[0]?.afterShot]) {
      assert.ok(ref);
      assert.equal(shotFormat(readFileSync(path.join(shotDir, ref))), "png");
    }
  } finally {
    await browser.close();
    rmSync(shotDir, { recursive: true, force: true });
  }
});

test("a disk failure records why the pictures could not be saved", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-shot-disk-"));
  try {
    const shotDir = path.join(dir, "not-a-directory");
    writeFileSync(shotDir, "occupied");
    const run = await replay(workflow, {}, extensionShot(jpeg), { shotDir });
    assert.equal(run.status, "passed");
    assert.equal(run.steps[0]?.beforeShotError, "The picture could not be saved.");
    assert.equal(run.steps[0]?.afterShotError, "The picture could not be saved.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
