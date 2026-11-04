import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Capture } from "../../src/app/capture";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { recorderSource } from "../../src/v1/recorder";
import { STRIPPED_SECRET } from "../../../shared/saved-secrets";
import { Library } from "../../src/v1/store";

const fields = [
  { id: "fieldA", autocomplete: "one-time-code", value: "683", secret: true },
  { id: "fieldB", autocomplete: "cc-name", value: "Ada Lovelace", secret: true },
  { id: "fieldC", autocomplete: "current-password", value: "current-entry", secret: true },
  { id: "fieldD", autocomplete: "new-password", value: "new-entry", secret: true },
  { id: "fieldE", autocomplete: "section-pay shipping cc-given-name", value: "Augusta", secret: true },
  { id: "fieldF", autocomplete: "section-login current-password", value: "section-entry", secret: true },
  { id: "fieldG", autocomplete: "off", type: "password", value: "native-entry", secret: true },
  { id: "fieldH", autocomplete: "name", value: "Grace Hopper", secret: false },
  { id: "fieldI", autocomplete: "off", value: "742", secret: false },
  { id: "fieldJ", autocomplete: "off", value: "Password", secret: false },
  { id: "fieldK", autocomplete: "email", value: "hello@example.com", secret: false },
];

function savedStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item: unknown) => savedStrings(item));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]: [string, unknown]) => [key, ...savedStrings(item)]);
  return [];
}

test("saved secret checks distinguish numeric metadata from bare and embedded string leaks", () => {
  assert.equal(savedStrings({ createdAt: 1_683 }).some((value) => value.includes("683")), false);
  for (const leaked of ["683", "code 683 leaked"]) {
    assert.equal(savedStrings({ nested: [{ value: leaked }] }).some((value) => value.includes("683")), true);
    assert.equal(savedStrings({ nested: [{ [leaked]: "safe" }] }).some((value) => value.includes("683")), true);
  }
});

test("capture retains field structure, saves secret slots and leaves actual page values unchanged", { timeout: 30_000 }, async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-saved-secrets-capture-"));
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
      const recorded = new Promise<void>((resolve) => { received = resolve; });
      await page.locator(`#${field.id}`).fill(field.value);
      await recorded;
      received = undefined;
      assert.equal(await page.locator(`#${field.id}`).inputValue(), field.value);
    }

    const events = capture.stop();
    assert.equal(events.length, fields.length);
    // Numeric metadata may contain the OTP digits.
    events[0]!.ts = 1_683;
    for (const [index, field] of fields.entries()) {
      const event = events[index]!;
      assert.equal(event.op, "type");
      assert.equal(event.identity?.id, field.id);
      assert.equal(event.identity?.inputType, "type" in field ? field.type : "text");
      assert.equal(event.identity?.autocomplete, field.autocomplete);
      if ("type" in field && field.type === "password") {
        assert.equal(event.sensitive, true);
        assert.equal(event.value, undefined);
      } else {
        assert.equal(event.value, field.value);
      }
    }

    const liveEvents = JSON.stringify(events);
    const workflow = interpret(events, { id: "captured", startUrl: "https://fixture.test/form" });
    assert.deepEqual(workflow.inputs.map((input) => input.type), [
      "secret", "secret", "secret", "secret", "secret", "secret", "secret", "text", "text", "text", "text",
    ]);
    library.save(workflow);
    library.saveTrail(workflow.id, events);
    assert.equal(JSON.stringify(events), liveEvents);
    const savedWorkflow = library.read(workflow.id);
    const savedTrail = library.readTrail(workflow.id) as TrailEvent[];
    assert.equal(savedWorkflow.createdAt, 1_683);
    assert.equal(savedTrail[0]?.ts, 1_683);
    const workflowBytes = readFileSync(path.join(home, "workflows", "captured.json"), "utf8");
    const trailBytes = readFileSync(path.join(home, "trails", "captured.json"), "utf8");
    const workflowStrings = savedStrings(JSON.parse(workflowBytes));
    const trailStrings = savedStrings(JSON.parse(trailBytes));
    assert.equal(savedWorkflow.steps.length, fields.length);
    assert.equal(savedTrail.length, fields.length);
    for (const [index, field] of fields.entries()) {
      const step = savedWorkflow.steps[index]!;
      const input = savedWorkflow.inputs.find((item) => item.name === step.input)!;
      assert.equal(step.action, "type");
      assert.equal(step.identity?.inputType, "type" in field ? field.type : "text");
      assert.equal(step.identity?.autocomplete, field.autocomplete);
      assert.equal(step.value, `{{${input.name}}}`);
      assert.equal(input.type, field.secret ? "secret" : "text");
      assert.equal(input.default, field.secret ? undefined : field.value);
      assert.equal(workflowStrings.some((value) => value.includes(field.value)), !field.secret, `${field.id} workflow`);
      assert.equal(trailStrings.some((value) => value.includes(field.value)), !field.secret, `${field.id} trail`);
      assert.equal(savedTrail[index]?.value, "type" in field ? undefined : field.secret ? STRIPPED_SECRET : field.value);
      assert.equal(await page.locator(`#${field.id}`).inputValue(), field.value);
    }
  } finally {
    await browser.close();
  }
});
