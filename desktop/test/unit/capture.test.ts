import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Capture } from "../../src/app/capture";
import { startApp } from "../../src/app/server";
import { BrowserDriver, elementShot, pagePoster } from "../../src/v1/browser-driver";
import { interpret } from "../../src/v1/interpret";
import { replay, type Driver } from "../../src/v1/replay";
import { checkMatch, stepTitle, stepCheck, validateWorkflow } from "../../src/v1/schema";

test("idle capture stays unpaused and rejects recording input", () => {
  const capture = new Capture();
  capture.pause();
  capture.resume();
  assert.equal(capture.recording, false);
  assert.equal(capture.paused, false);
  assert.equal(capture.push({ kind: "act", op: "click" }), false);
  capture.handoff("Waiting for a person");
  assert.deepEqual(capture.events, []);
  assert.deepEqual(capture.steps, []);
  assert.throws(() => capture.note("A note"), /not recording/);
  assert.throws(() => capture.check("A check"), /not recording/);
});

test("paused capture keeps handoffs, notes and checks while dropping UI events", () => {
  const capture = new Capture();
  capture.start();
  capture.pause();
  capture.pause();
  assert.equal(capture.recording, true);
  assert.equal(capture.paused, true);
  assert.equal(capture.push({ kind: "act", op: "click" }), false);
  capture.handoff("  Waiting   for a person  ");
  capture.handoff("   ");
  assert.equal(capture.steps.length, 0);
  capture.note("Wait for the banner");
  assert.equal(capture.steps.length, 0);
  const check = capture.check("Welcome");
  assert.equal(check.label, "Check: Welcome");
  assert.equal(check.note, "Wait for the banner");
  assert.deepEqual(capture.events.map((event) => [event.op, event.afterText]), [
    ["note", "Waiting for a person"],
    ["note", "Wait for the banner"],
    ["expect", "Welcome"],
  ]);
  capture.resume();
  capture.resume();
  assert.equal(capture.recording, true);
  assert.equal(capture.paused, false);
  assert.equal(capture.push({ kind: "act", op: "click" }), true);
  assert.deepEqual(capture.steps.map((step) => step.label), ["Check: Welcome", "Click"]);
});

for (const paused of [false, true]) {
  test(`stop retains capture data and returns to idle from ${paused ? "paused" : "recording"}`, () => {
    const capture = new Capture();
    capture.start();
    capture.push({ kind: "act", op: "click" });
    if (paused) capture.pause();
    capture.note("Keep this note");
    const events = structuredClone(capture.events);
    const steps = structuredClone(capture.steps);
    const stopped = capture.stop();
    assert.equal(capture.recording, false);
    assert.equal(capture.paused, false);
    assert.equal(stopped, capture.events);
    assert.equal(capture.stop(), stopped);
    capture.pause();
    capture.resume();
    assert.equal(capture.paused, false);
    assert.equal(capture.push({ kind: "act", op: "click" }), false);
    capture.handoff("Do not keep this");
    assert.throws(() => capture.note("Do not keep this"), /not recording/);
    assert.throws(() => capture.check("Do not keep this"), /not recording/);
    assert.deepEqual(capture.events, events);
    assert.deepEqual(capture.steps, steps);
  });
}

test("discard clears paused capture data", () => {
  const capture = new Capture();
  capture.start();
  capture.push({ kind: "act", op: "click" });
  capture.pause();
  capture.note("Discard this note");
  capture.check("Discard this check");
  capture.discard();
  assert.equal(capture.recording, false);
  assert.equal(capture.paused, false);
  assert.deepEqual(capture.events, []);
  assert.deepEqual(capture.steps, []);
  assert.deepEqual(capture.stop(), []);
});

for (const phase of ["recording", "paused", "stopped"] as const) {
  test(`start resets capture data and pending notes from ${phase}`, () => {
    const capture = new Capture();
    capture.start();
    capture.note("Do not carry this note");
    capture.handoff("Do not carry this handoff");
    if (phase === "paused") capture.pause();
    if (phase === "stopped") capture.stop();
    capture.start();
    assert.equal(capture.recording, true);
    assert.equal(capture.paused, false);
    assert.equal(capture.events.length, 0);
    assert.equal(capture.steps.length, 0);
    assert.equal(capture.push({ kind: "act", op: "click" }), true);
    assert.deepEqual(capture.steps, [{ id: capture.events[0]?.id, label: "Click" }]);
    capture.start();
    assert.deepEqual(capture.events, []);
    assert.deepEqual(capture.steps, []);
  });
}

test("pause drops UI events while notes retain typed values", () => {
  const capture = new Capture();
  assert.equal(capture.push({ kind: "act", op: "click" }), false);
  capture.start();
  assert.equal(capture.push({ kind: "act", op: "click", identity: { surface: "dom", role: "button", name: "Open", path: [] } }), true);
  capture.pause();
  assert.equal(capture.push({ kind: "act", op: "click", identity: { surface: "dom", role: "button", name: "Frozen", path: [] } }), false);
  capture.resume();
  const note = capture.note("wait for the banner");
  const check = capture.check("Welcome");
  assert.equal(note.note, "wait for the banner");
  assert.equal(note.label, "Click Open");
  assert.equal(check.label, "Check: Welcome");
  assert.equal(capture.note("123-45-6789").note, "123-45-6789");
  assert.equal(capture.events.some((event) => event.op === "note" && event.afterText === "123-45-6789"), true);
  assert.equal(capture.steps.map((step) => step.label).join("|"), "Click Open|Check: Welcome");
  assert.equal(capture.steps[0]?.note, "wait for the banner");
  assert.equal(capture.steps[1]?.note, "123-45-6789");
  const kept = capture.stop();
  assert.equal(capture.recording, false);
  assert.equal(kept.length, 4);
  const doc = interpret(kept, { id: "wf-cap-note", name: "Fixture capture", startUrl: "http://127.0.0.1/fixture" });
  assert.equal(doc.steps.length, 2);
  assert.equal(doc.steps[0]?.action, "click");
  assert.equal((doc.steps[0] == null ? undefined : doc.steps[0].caption.text), "wait for the banner");
  assert.equal(doc.steps[1]?.action, "verify");
  capture.discard();
  assert.equal(capture.events.length, 0);
  assert.equal(capture.steps.length, 0);
});

test("a note replays without touching the page and a check becomes a verify step", async () => {
  const capture = new Capture();
  capture.start();
  const early = capture.note("wait for the banner");
  assert.equal(early.label, "Note: wait for the banner");
  assert.equal(capture.steps.length, 0);
  capture.check("Welcome");
  assert.equal(capture.steps.length, 1);
  assert.equal(capture.steps[0]?.note, "wait for the banner");
  const doc = interpret(capture.stop(), { id: "wf-cap", name: "Fixture capture", startUrl: "http://127.0.0.1/fixture" });
  assert.equal(validateWorkflow(doc).length, 0);
  assert.equal(doc.steps.length, 1);
  assert.equal(doc.steps[0]?.action, "verify");
  assert.equal((doc.steps[0] == null ? undefined : doc.steps[0].caption.text), "wait for the banner");
  assert.equal((doc.steps[0] == null ? undefined : stepTitle(doc.steps[0])), "wait for the banner");
  assert.equal(checkMatch(doc.steps[0] == null ? undefined : stepCheck(doc.steps[0])), "Welcome");
  let looked = 0;
  const driver: Driver = {
    tree: async () => {
      looked += 1;
      return { nodes: [], texts: ["Welcome"], values: [] };
    },
    snapshot: async () => { throw new Error("snapshot"); },
    click: async () => { throw new Error("click"); },
    fill: async () => { throw new Error("fill"); },
    key: async () => { throw new Error("key"); },
    upload: async () => { throw new Error("upload"); },
    drop: async () => { throw new Error("drop"); },
    digits: async () => { throw new Error("digits"); },
    check: async () => { throw new Error("check"); },
    notify: async () => { throw new Error("notify"); },
  };
  const result = await replay(doc, {}, driver, { heal: { available: () => false, propose: async () => null } });
  assert.equal(result.status, "passed");
  assert.equal(result.steps.every((step) => step.status === "passed"), true);
  // The check reads the tree for the auth gate and the text. The run reads it once more
  // to confirm the final check. The note does not.
  assert.equal(looked, 4);
});

test("pictures and snapshots retain password controls and native pixels without Bao overlays", async () => {
  const { testChromium: chromium } = await import("../../src/test-browser.js");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><label>Password<input type="password" id="password" name="password" value="fixture-secret"></label><input id="pin" autocomplete="one-time-code" value="482731"><input id="name" value="ada">`);
    const original = page.screenshot.bind(page);
    page.screenshot = async (opts?: Parameters<typeof page.screenshot>[0]) => {
      assert.equal(await page.locator("#password").evaluate((el) => getComputedStyle(el).filter), "none");
      assert.equal(await page.locator("#pin").evaluate((el) => getComputedStyle(el).filter), "none");
      assert.equal(await page.locator("[data-bao-mask], [data-bao-blur], [data-bao-blur-cover], [data-bao-guide-shot]").count(), 0);
      return original(opts);
    };
    const native = await original({ type: "png" });
    const driver = new BrowserDriver(page);
    assert.deepEqual(await driver.pageShot(), native);
    assert.deepEqual(await pagePoster(page), native);
    const tree = await driver.tree();
    assert.ok(tree.nodes.some((node) => node.id === "password"));
    assert.ok(tree.values.some((row) => row.identity.id === "password" && row.value === "fixture-secret"));
    const step = await driver.captureStep();
    assert.ok(step.dom?.some((node) => node.id === "password"));
    assert.match(step.ax || "", /Password/);
    const snapshot = await driver.snapshot();
    assert.deepEqual(Buffer.from(snapshot.screenshot!, "base64"), native);
    assert.match(String(snapshot.ax || ""), /Password/);
    assert.ok(await elementShot(page, { identity: tree.nodes.find((node) => node.id === "pin") }));
    assert.equal(await page.locator("#password").inputValue(), "fixture-secret");
    assert.equal(await page.locator("#pin").inputValue(), "482731");
    assert.equal(await page.locator("[data-bao-shot-outline]").count(), 0);
  } finally {
    await browser.close();
  }
});

test("capture routes stay idle and do not open the bar", async () => {
  const prev = process.env.BAO_CAPTURE_BAR;
  delete process.env.BAO_CAPTURE_BAR;
  const home = mkdtempSync(path.join(tmpdir(), "bao-cap-"));
  const app = await startApp({ home });
  try {
    const state = await (await fetch(`http://127.0.0.1:${app.port}/api/state`)).json() as {
      recording: boolean;
      capture: { recording: boolean; paused: boolean; steps: string[] };
    };
    assert.equal(state.recording, false);
    assert.equal(state.capture.paused, false);
    assert.deepEqual(state.capture.steps, []);
    const note = await fetch(`http://127.0.0.1:${app.port}/api/sessions/note`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "wait for the banner" }),
    });
    assert.equal(note.status, 409);
    const paused = await (await fetch(`http://127.0.0.1:${app.port}/api/sessions/pause`, { method: "POST" })).json() as { paused: boolean };
    assert.equal(paused.paused, false);
    assert.equal(app.recording, false);
  } finally {
    await app.close();
    if (prev === undefined) delete process.env.BAO_CAPTURE_BAR;
    else process.env.BAO_CAPTURE_BAR = prev;
  }
});
