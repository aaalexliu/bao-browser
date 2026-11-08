import { stepQuery } from "../../src/v1/schema";
import { fixtureDoc, fixtureStep } from "../support/fixture-step";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import sharp from "sharp";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ExtensionDriver } from "../../src/extension/driver";
import { testChromium } from "../../src/test-browser.js";
import { BrowserDriver } from "../../src/v1/browser-driver";
import type { ExtensionLink } from "../../src/extension/link";
import { replay, type Driver } from "../../src/v1/replay";
import { shotFormat, workflowShotName } from "../../src/v1/shots";
import { Library } from "../../src/v1/store";
import { syncAll } from "../../src/v1/sync";
import type { WorkflowV2 } from "../../src/v1/schema";

const workflow: WorkflowV2 = fixtureDoc({
  schema: "bao.workflow/v4", version: 2, id: "wf-shots", name: "Run pictures",
  startUrl: "http://127.0.0.1/fixture", createdAt: 1, inputs: [], driver: "extension",
  steps: [fixtureStep({ id: "step", index: 0, action: "note", label: "Fixture", surface: "dom", timeoutMs: 1000 })],
});

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

test("workflow sync keeps the recorded control crop after a replay navigates away", async () => {
  let pushedPicture: Buffer | undefined;
  const server = createServer((req, res) => {
    if (req.url === "/fixture" || req.url === "/next") {
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/fixture"
        ? '<body style="background:#ffe0e0"><a id="login" href="/next" style="display:inline-block;padding:20px">Continue</a></body>'
        : '<body style="background:#0011ff"><h1>Signed in</h1></body>');
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/versions") && req.method === "POST") {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { shots: { png: string }[] };
        pushedPicture = body.shots[0] ? Buffer.from(body.shots[0].png, "base64") : undefined;
        res.writeHead(201);
        res.end(JSON.stringify({ version: 1 }));
      } else if (req.url === "/api/sync/snapshot") {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
      } else res.end(JSON.stringify({ devices: [], categories: [] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const home = mkdtempSync(path.join(tmpdir(), "bao-navigation-crop-"));
  const library = new Library(home);
  const browser = await testChromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`${origin}/fixture`);
    const driver = new BrowserDriver(page);
    const doc: WorkflowV2 = fixtureDoc({
      ...workflow, driver: "playwright", startUrl: `${origin}/fixture`,
      steps: [fixtureStep({ id: "login", index: 0, action: "click", label: "Click Continue", surface: "dom", timeoutMs: 3000,
        identity: { surface: "dom", role: "link", name: "Continue", id: "login", path: [] },
        postcondition: { kind: "url", match: "/next", timeoutMs: 3000 } })],
    });
    library.save(doc);
    const crop = await driver.shot({ identity: stepQuery(doc.steps[0]!) });
    assert.ok(crop);
    const recorded = await sharp(crop).metadata();
    assert.ok(recorded.width! < 720 && recorded.height! < 480);
    const recordedDir = path.join(home, "shots", "workflows", doc.id);
    mkdirSync(recordedDir, { recursive: true });
    writeFileSync(path.join(recordedDir, workflowShotName("login")), crop);
    const shotDir = path.join(home, "shots", "runs", "navigation-run");
    const run = await replay(doc, {}, driver, { runId: "navigation-run", shotDir });
    assert.equal(run.status, "passed");
    assert.equal(page.url(), `${origin}/next`);
    assert.ok(run.steps[0]!.afterShot);
    const after = await sharp(readFileSync(path.join(shotDir, run.steps[0]!.afterShot!))).metadata();
    assert.equal(after.width, 1280);
    assert.equal(after.height, 800);
    library.saveRun({ ...run, id: run.runId, workflowId: doc.id, at: Date.now() });
    writeFileSync(path.join(home, "sync.json"), JSON.stringify({ server: origin, deviceToken: "fixture", backedUp: true }));
    await syncAll(library, "push");
    assert.ok(pushedPicture);
    const pushed = await sharp(pushedPicture).metadata();
    assert.equal(pushed.format, "jpeg");
    assert.equal(pushed.width, recorded.width);
    assert.equal(pushed.height, recorded.height);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
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
