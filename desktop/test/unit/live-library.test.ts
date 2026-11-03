import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { libraryTable, runKind, runViewer, runsList, type RunSummary } from "../../src/app/views";
import { LIVE_TRAIL_SOURCE, workflowFromTrail } from "../../src/cdp-live/live-trail";
import { guardPreset } from "../../src/cdp-live/presets";
import type { TrailEvent } from "../../src/v1/interpret";
import { dumpPage } from "../../src/v1/dom-page";
import { testChromium } from "../../src/test-browser";
import { blankPng, redactedPng } from "../../src/v1/redacted-png";
import { subst, type Identity } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";

function recorded(identities: Partial<Identity>[], op: "type" | "select" = "type") {
  const events: TrailEvent[] = identities.map((identity, i) => ({
    id: `live-${i}`, ts: i + 1, kind: "act", op, source: LIVE_TRAIL_SOURCE,
    identity: { surface: "dom", role: "textbox", tag: "input", path: [], ...identity },
    value: `value-${i}`, beforeUrl: "https://example.test/", afterUrl: "https://example.test/",
  }));
  return workflowFromTrail({ id: "wf-live", name: "Live form", intent: "Fill a form", startUrl: "https://example.test/", createdAt: 1, savedAt: 2, events, guard: guardPreset("generic") });
}

test("live inputs use field labels, placeholders and names with safe unique tokens", () => {
  const workflow = recorded([
    { label: "App name", nameAttr: "app", id: "_generated" },
    { label: "App name" },
    { placeholder: "Authorized domain 1" },
    { nameAttr: "redirect-uri" },
    { label: "Support email" },
    {},
    { label: "!!!", nameAttr: "fallback" },
    { label: "1st café" },
  ]);
  assert.deepEqual(workflow.inputs.map(input => input.name), ["app_name", "app_name2", "authorized_domain_1", "redirect_uri", "support_email", "text", "fallback", "field_1st_cafe"]);
  for (const step of workflow.steps.filter(step => step.action === "type")) {
    assert.equal(subst(step.value || "", { [step.input!]: "replacement" }), "replacement");
  }
});

for (const op of ["type", "select"] as const) {
  test(`live ${op} inputs separate numbered field labels from duplicate counters`, () => {
    const workflow = recorded([
      { label: "App name" },
      { label: "App name" },
      { label: "URIs 1" },
      { label: "URIs 1" },
      { label: "URIs 1" },
      { label: "URIs 12" },
      { label: "URIs 12" },
      { label: "URIs 1 2" },
    ], op);
    assert.deepEqual(workflow.inputs.map(input => input.name), [
      "app_name", "app_name2", "uris_1", "uris_1_2", "uris_1_3", "uris_12", "uris_12_2", "uris_1_2_2",
    ]);
    for (const step of workflow.steps.filter(step => step.action === op)) {
      assert.equal(subst(step.value || "", { [step.input!]: "replacement" }), "replacement");
    }
    const occupied = recorded([{ label: "URIs 1" }, { label: "URIs 1 2" }, { label: "URIs 1" }], op);
    assert.deepEqual(occupied.inputs.map(input => input.name), ["uris_1", "uris_1_2", "uris_1_3"]);
  });
}

test("live field metadata comes from the page, not the typed value", async () => {
  const browser = await testChromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<label>App name<input value="Personal text"></label><input placeholder="Redirect URI" value="Private value"><input name="support-email">');
    const tree = await page.evaluate(dumpPage);
    const fields = tree.nodes.filter(node => node.tag === "input");
    assert.equal(fields[1]?.placeholder, "Redirect URI");
    assert.deepEqual(recorded(fields).inputs.map(input => input.name), ["app_name", "redirect_uri", "support_email"]);
  } finally { await browser.close(); }
});

test("live textarea and select tokens exclude control text from every label source", async () => {
  const browser = await testChromium.launch();
  try {
    const page = await browser.newPage();
    for (const source of ["wrapping", "for", "aria-labelledby"] as const) {
      for (const tag of ["textarea", "select"] as const) {
        const label = tag === "textarea" ? "Quarterly revenue notes" : "Apple choice";
        const value = tag === "textarea" ? "quarterly revenue" : "Apple";
        const contents = tag === "textarea" ? value : "<option>Apple</option><option>Banana</option>";
        const control = `<${tag} id="field"${source === "aria-labelledby" ? ' aria-labelledby="caption extra"' : ""}>${contents}</${tag}>`;
        const markup = source === "wrapping" ? `<label><span>${label}</span>${control}</label>`
          : source === "for" ? `<label for="field"><span>${label}</span>${control}</label>`
            : `<div id="caption"><span>${label}</span>${control}</div><span id="extra">Details</span>`;
        await page.setContent(markup);
        const originalText = await page.locator("#field").textContent();
        const tree = await page.evaluate(dumpPage);
        const field = tree.nodes.find(node => node.id === "field");
        assert.ok(field);
        const expectedLabel = label + (source === "aria-labelledby" ? " Details" : "");
        assert.equal(field.label, expectedLabel);
        assert.equal(field.name, expectedLabel);
        assert.equal(await page.locator("#field").textContent(), originalText);
        assert.equal(await page.locator("#field").inputValue(), value);
        const workflow = workflowFromTrail({
          id: "wf-label", name: "Labeled form", intent: "Fill a form", startUrl: "https://example.test/", createdAt: 1, savedAt: 2,
          events: [{ id: "event", ts: 1, kind: "act", op: tag === "select" ? "select" : "type", source: LIVE_TRAIL_SOURCE,
            identity: field, value, beforeUrl: "https://example.test/", afterUrl: "https://example.test/" }],
          guard: guardPreset("generic"),
        });
        const token = expectedLabel.toLowerCase().replace(/ /g, "_");
        assert.deepEqual(workflow.inputs.map(input => input.name), [token]);
        assert.equal(workflow.steps[0]?.input, token);
        assert.equal(subst(workflow.steps[0]?.value || "", { [token]: "replacement" }), "replacement");
      }
    }
  } finally { await browser.close(); }
});

test("saved generic input tokens stay usable without a migration", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-live-legacy-"));
  try {
    const workflow = recorded([{}]);
    workflow.steps[0]!.identity!.label = "App name";
    const library = new Library(home);
    library.save(workflow);
    const saved = library.read(workflow.id);
    assert.equal(saved.inputs[0]?.name, "text");
    assert.equal(subst(saved.steps[0]!.value!, { text: "existing argument" }), "existing argument");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("finished live captures show their end status without uncounted model-call claims", () => {
  const workflow = recorded([{ label: "App name" }]);
  for (const status of ["passed", "needs_human", "failed", "timed-out"]) {
    const run: RunSummary = { id: "run-live", workflowId: workflow.id, kind: "capture", status, at: 1, modelCalls: 0, heals: [], steps: [] };
    assert.equal(runKind(run), status === "needs_human" ? "paused" : status);
    assert.doesNotMatch(runsList([run], []), /recording|model calls/);
    assert.doesNotMatch(runViewer(run, workflow), /recording \(|id="model-calls"/);
    assert.doesNotMatch(libraryTable([{ ...workflow, steps: workflow.steps.length }], [run]), />recording</);
  }
  const replay: RunSummary = { id: "run-replay", workflowId: workflow.id, status: "passed", at: 1, modelCalls: 3, heals: [], steps: [] };
  for (const modelCalls of [1, 3]) {
    const counted = { ...replay, modelCalls };
    assert.doesNotMatch(runsList([counted], []), /model calls?/);
    assert.match(runViewer(counted, workflow), new RegExp(`id="model-calls">${modelCalls} model call${modelCalls === 1 ? "" : "s"}<`));
  }
  assert.match(runsList([{ ...replay, modelCalls: 0 }], []), /0 model calls/);
});

test("live card posters use stored full-page workflow pictures, never crops or stripes", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-live-poster-"));
  const workflow = recorded([{ label: "App name" }]);
  const library = new Library(home);
  library.save(workflow);
  const shots = path.join(home, "shots", "workflows", workflow.id);
  mkdirSync(shots, { recursive: true });
  const app = await startApp({ home, port: 0 });
  const url = `http://127.0.0.1:${app.port}/api/workflows/${workflow.id}/poster`;
  const page = blankPng(800, 600);
  try {
    assert.equal((await fetch(url)).status, 404);
    writeFileSync(path.join(shots, `${workflow.steps[0]!.id}.png`), page);
    let response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), page);
    writeFileSync(path.join(shots, `${workflow.steps[0]!.id}.png`), blankPng(80, 40));
    assert.equal((await fetch(url)).status, 404);
    writeFileSync(path.join(shots, `${workflow.steps[0]!.id}.png`), redactedPng(1));
    assert.equal((await fetch(url)).status, 404);
    writeFileSync(path.join(shots, `${workflow.steps[0]!.id}.png`), page);
    for (const rejected of [blankPng(80, 40), redactedPng(1)]) {
      writeFileSync(path.join(shots, "poster.png"), rejected);
      response = await fetch(url);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), page);
    }
    const poster = blankPng(900, 700);
    writeFileSync(path.join(shots, "poster.png"), poster);
    response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), poster);
    library.save({ ...workflow, driver: "playwright" });
    response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), poster);
    for (const rejected of [blankPng(80, 40), redactedPng(1)]) {
      writeFileSync(path.join(shots, "poster.png"), rejected);
      assert.equal((await fetch(url)).status, 404, "non-live cards still require a full-page poster");
    }
  } finally { await app.close(); rmSync(home, { recursive: true, force: true }); }
});
