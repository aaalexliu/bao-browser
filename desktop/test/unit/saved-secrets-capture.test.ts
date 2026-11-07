import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Capture } from "../../src/app/capture";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { recorderSource } from "../../src/v1/recorder";
import { pagePoster } from "../../src/v1/browser-driver";
import { cleanSaveField, saveIntentPrompt } from "../../src/v1/save-intent";
import { projectTeach } from "../../src/v1/teach";
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
      assert.equal(input.default, field.id === "otp" ? undefined : field.value, field.id);
      assert.equal(input.type, field.secret ? "secret" : "text", field.id);
      assert.equal(trail.filter((event) => event.identity?.id === field.id).at(-1)!.value, field.value);
    }
  } finally {
    await browser.close();
  }
});

test("sequential password prefixes do not turn Guests into a secret or erase ordinary naming", { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-password-prefix-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const library = new Library(home);
  const capture = new Capture();
  capture.start();
  const { testChromium: chromium } = await import("../../src/test-browser.js");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    let received: ((event: TrailEvent) => void) | undefined;
    await context.exposeBinding("__baoRecord", async (_source, event: TrailEvent) => {
      assert.equal(capture.push(event), true);
      received?.(event);
    });
    await context.addInitScript(recorderSource());
    const page = await context.newPage();
    await page.goto(`data:text/html,${encodeURIComponent('<!doctype html><label>Password<input id="password" type="password"></label><label>Guests<input id="guests" type="text" autocomplete="off"></label><label>New password<input id="next-password" type="password"></label><label>Code<input id="otp" autocomplete="one-time-code"></label>')}`);
    assert.ok(await pagePoster(page));
    assert.equal(await page.locator("input").count(), 4);
    assert.equal(await page.locator("#password").evaluate((el) => getComputedStyle(el).filter), "none");
    for (const [id, value] of [["password", "1qaz2wsx"], ["guests", "1"], ["next-password", "Book!password"], ["otp", "683742"]] as const) {
      const recorded = new Promise<void>((resolve) => {
        received = (event) => { if (event.identity?.id === id && event.value === value) resolve(); };
      });
      await page.locator(`#${id}`).pressSequentially(value);
      await recorded;
      received = undefined;
      assert.equal(await page.locator(`#${id}`).inputValue(), value);
    }
    const events = capture.stop();
    const original = structuredClone(events);
    assert.ok(events.some((event) => event.identity?.id === "password" && event.value === "1"));
    assert.ok(events.some((event) => event.identity?.id === "next-password" && event.value === "Book"));
    const meta = { id: "prefix-capture", startUrl: "https://fixture.test/booking" };
    const document = interpret(events, meta);
    library.save(document);
    library.saveTrail(document.id, events);
    const saved = library.read(document.id);
    const taught = projectTeach(events, [], meta).workflow;
    for (const workflow of [saved, taught, interpret(events, { ...meta, preserveActions: true })]) {
      const guests = workflow.steps.find((step) => step.identity?.id === "guests")!;
      assert.ok(guests);
      const input = workflow.inputs.find((input) => input.name === guests.input)!;
      assert.equal(input.type, "text");
      assert.equal(input.default, "1");
      assert.notEqual(guests.sensitive, true);
      assert.equal(guests.gate, undefined);
      assert.ok(guests.postcondition);
    }
    for (const [id, value] of [["password", "1qaz2wsx"], ["next-password", "Book!password"]] as const) {
      const step = saved.steps.find((step) => step.identity?.id === id)!;
      const input = saved.inputs.find((input) => input.name === step.input)!;
      assert.equal(input.type, "secret");
      assert.equal(input.default, value);
    }
    const otp = saved.steps.find((step) => step.identity?.id === "otp")!;
    assert.equal(saved.inputs.find((input) => input.name === otp.input)!.default, undefined);
    assert.equal(cleanSaveField("Book a table", 80), "Book a table");
    const prompt = saveIntentPrompt({ floorTitle: "Book a table", steps: [{ id: "guests", action: "type", label: "Book a table" }] });
    assert.ok(prompt.includes("guests | type | - | Book a table"));
    assert.deepEqual(events, original);
    assert.equal(JSON.stringify(library.readTrail(document.id)), JSON.stringify(original));
  } finally {
    await browser.close();
  }
});
