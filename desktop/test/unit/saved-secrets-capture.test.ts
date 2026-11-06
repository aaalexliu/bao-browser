import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Capture } from "../../src/app/capture";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { recorderSource } from "../../src/v1/recorder";
import { Library } from "../../src/v1/store";

const fields = [
  { id: "otp", autocomplete: "one-time-code", value: "683", secret: true },
  { id: "cardName", autocomplete: "cc-name", value: "Ada Lovelace", secret: true },
  { id: "current", autocomplete: "current-password", value: "current-entry", secret: true },
  { id: "new", autocomplete: "new-password", value: "new-entry", secret: true },
  { id: "section", autocomplete: "section-login current-password", value: "section-entry", secret: true },
  { id: "password", autocomplete: "off", type: "password", value: "native-entry", secret: true },
  { id: "name", autocomplete: "name", value: "Grace Hopper", secret: false },
  { id: "short", autocomplete: "off", value: "742", secret: false },
  { id: "card", autocomplete: "off", value: "4111111111111111", secret: false },
  { id: "token", autocomplete: "off", value: "sk-localFixtureToken", secret: false },
];

test("browser capture retains password changes and ordinary fields in Library defaults and trails", { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-input-capture-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const capture = new Capture();
  capture.start();
  const { testChromium: chromium } = await import("../../src/test-browser.js");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    let received: (() => void) | undefined;
    await context.exposeBinding("__baoRecord", async (_source, payload: TrailEvent) => {
      assert.equal(capture.push(payload), true);
      received?.();
    });
    await context.addInitScript(recorderSource());
    const page = await context.newPage();
    const body = fields.map((field) => `<input id="${field.id}" type="${"type" in field ? field.type : "text"}" autocomplete="${field.autocomplete}">`).join("");
    await page.goto(`data:text/html,${encodeURIComponent(`<!doctype html>${body}`)}`);
    for (const field of fields) {
      for (const value of field.id === "password" ? ["first-password", field.value] : [field.value]) {
        const recorded = new Promise<void>((resolve) => { received = resolve; });
        await page.locator(`#${field.id}`).fill(value);
        await recorded;
        received = undefined;
      }
      assert.equal(await page.locator(`#${field.id}`).inputValue(), field.value);
    }
    const events = capture.stop();
    const original = structuredClone(events);
    const doc = interpret(events, { id: "captured", startUrl: "https://fixture.test/form" });
    library.save(doc);
    library.saveTrail(doc.id, events);
    assert.deepEqual(events, original);
    const saved = library.read(doc.id);
    assert.equal(saved.steps.length, fields.length);
    const trail = library.readTrail(doc.id) as TrailEvent[];
    for (const field of fields) {
      const step = saved.steps.find((step) => step.identity?.id === field.id)!;
      const input = saved.inputs.find((input) => input.name === step.input)!;
      assert.equal(step.action, "type");
      assert.equal(step.identity?.autocomplete, field.autocomplete);
      assert.equal(input.default, field.value, field.id);
      assert.equal(input.type, field.secret ? "secret" : "text", field.id);
      assert.equal(trail.filter((event) => event.identity?.id === field.id).at(-1)!.value, field.value);
    }
  } finally {
    await browser.close();
  }
});
