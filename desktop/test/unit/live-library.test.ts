import { fixtureDoc, fixtureInput } from "../support/fixture-step";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { libraryTable, runKind, runViewer, runsList, type RunSummary } from "../../src/app/views";
import { testChromium } from "../../src/test-browser";
import { blankPng, redactedPng } from "../../src/v1/redacted-png";
import { projectStep, subst, type Identity, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";

function recorded(identities: Partial<Identity>[]): WorkflowV2 {
  return fixtureDoc({
    schema: "bao.workflow/v4", version: 2, driver: "cdp-live", id: "wf-live", name: "Saved live form",
    startUrl: "https://example.test/", createdAt: 1,
    inputs: [fixtureInput({ name: "text", type: "text", default: "value" })],
    steps: identities.map((identity, index) => ({
      id: `live-${index}`, index, action: "type", label: "Saved field", surface: "dom", timeoutMs: 1000,
      identity: { surface: "dom", role: "textbox", path: [], ...identity }, input: "text", value: "{{text}}",
    })),
  });
}

async function pagePng(width: number, height: number, veiled = false): Promise<Buffer> {
  if (veiled) return redactedPng(1);
  const browser = await testChromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent('<main style="margin:15%;font:24px system-ui"><h1>App settings</h1><p>Configure the saved workflow.</p><label>App name <input value="Example" style="font:inherit"></label><p><button style="font:inherit">Continue</button></p></main>');
    return await page.screenshot({ type: "png" });
  } finally { await browser.close(); }
}

test("saved generic input tokens stay usable without a migration", () => {
  const home = mkdtempSync(path.join(tmpdir(), "bao-live-legacy-"));
  try {
    const workflow = recorded([{}]);
    projectStep(workflow.steps[0]!).identity!.label = "App name";
    const library = new Library(home);
    library.save(workflow);
    const saved = library.read(workflow.id);
    assert.equal(saved.inputs[0]?.name, "text");
    assert.equal(subst(projectStep(saved.steps[0]!).value!, { text: "existing argument" }), "existing argument");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("finished live captures show their end status without uncounted model-call claims", () => {
  const workflow = recorded([{ label: "App name" }]);
  const provisional = { workflowId: workflow.id, status: "provisional" };
  for (const status of ["passed", "needs_human", "paused", "failed", "timed-out"]) {
    for (const workflowPromotion of [undefined, provisional]) {
      for (const promotion of [undefined, provisional]) {
        const run: RunSummary = { id: "run-live", workflowId: workflow.id, kind: "capture", status, at: 1, modelCalls: 0, heals: [], steps: [], promotion };
        const kind = status === "needs_human" ? "paused" : status;
        const label = kind === "paused" ? "needs you" : kind === "timed-out" ? "stopped, timed out" : kind;
        assert.equal(runKind(run, workflowPromotion), kind);
        const list = runsList([run], []);
        assert.match(list, new RegExp(`class="run-state ${kind}">${label.charAt(0).toUpperCase() + label.slice(1)}</span>`));
        assert.doesNotMatch(list, /recording|model calls/);
        const viewer = runViewer(run, workflow);
        assert.match(viewer, new RegExp(`id="run-status"><strong>${label}</strong>`));
        assert.doesNotMatch(viewer, /recording \(|id="model-calls"/);
        const card = libraryTable([{ ...workflow, steps: workflow.steps.length }], [run], workflowPromotion ? [workflowPromotion] : []);
        assert.match(card, new RegExp(`class="status ${kind}"[\\s\\S]*?${label.charAt(0).toUpperCase() + label.slice(1)}</span>`));
        assert.match(card, /<table id="workflow-list"/);
        assert.equal(runKind({ ...run, kind: "replay" }, workflowPromotion),
          status === "timed-out" ? "timed-out" : workflowPromotion || promotion ? "provisional" : kind);
      }
    }
  }
  const replay: RunSummary = { id: "run-replay", workflowId: workflow.id, status: "passed", at: 1, modelCalls: 3, heals: [], steps: [] };
  for (const modelCalls of [1, 3]) {
    const counted = { ...replay, modelCalls };
    assert.doesNotMatch(runsList([counted], []), /model calls?/);
    assert.match(runViewer(counted, workflow), new RegExp(`id="model-calls">${modelCalls} model call${modelCalls === 1 ? "" : "s"}<`));
  }
  assert.doesNotMatch(runsList([{ ...replay, modelCalls: 0 }], []), /model calls?/);
  assert.match(runViewer({ ...replay, modelCalls: 0 }, workflow), /id="model-calls">0 model calls</);
});

test("live card posters use stored full-page workflow pictures, never crops or stripes", async () => {
  const page = await pagePng(800, 600);
  const poster = await pagePng(900, 700);
  const home = mkdtempSync(path.join(tmpdir(), "bao-live-poster-"));
  const workflow = recorded([{ label: "App name" }]);
  const library = new Library(home);
  library.save(workflow);
  const shots = path.join(home, "shots", "workflows", workflow.id);
  mkdirSync(shots, { recursive: true });
  const app = await startApp({ home, port: 0 });
  const url = `http://127.0.0.1:${app.port}/api/workflows/${workflow.id}/poster`;
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
    writeFileSync(path.join(shots, "poster.png"), poster);
    response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), poster);
    const ordinary = { ...workflow, id: "wf-ordinary", driver: "playwright" as const };
    library.save(ordinary);
    const ordinaryShots = path.join(home, "shots", "workflows", ordinary.id);
    mkdirSync(ordinaryShots, { recursive: true });
    writeFileSync(path.join(ordinaryShots, `${ordinary.steps[0]!.id}.png`), page);
    writeFileSync(path.join(ordinaryShots, "poster.png"), poster);
    const ordinaryUrl = `http://127.0.0.1:${app.port}/api/workflows/${ordinary.id}/poster`;
    response = await fetch(ordinaryUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), poster);
    for (const rejected of [blankPng(80, 40), redactedPng(1)]) {
      writeFileSync(path.join(ordinaryShots, "poster.png"), rejected);
      assert.equal((await fetch(ordinaryUrl)).status, 404, "non-live cards still require a full-page poster");
    }
  } finally { await app.close(); rmSync(home, { recursive: true, force: true }); }
});

test("live posters choose the first clear step and hide blank or privacy-veiled pictures", async () => {
  const clear = await pagePng(800, 600);
  const later = await pagePng(900, 700);
  const veiled = await pagePng(800, 600, true);
  const home = mkdtempSync(path.join(tmpdir(), "bao-clear-poster-"));
  const workflow = recorded([{ label: "First" }, { label: "Second" }, { label: "Third" }, { label: "Fourth" }]);
  new Library(home).save(workflow);
  const shots = path.join(home, "shots", "workflows", workflow.id);
  mkdirSync(shots, { recursive: true });
  const pictures = [blankPng(800, 600), veiled, clear, later];
  for (const [i, step] of workflow.steps.entries()) writeFileSync(path.join(shots, `${step.id}.png`), pictures[i]!);
  writeFileSync(path.join(shots, "poster.png"), veiled);
  const app = await startApp({ home, port: 0 });
  const url = `http://127.0.0.1:${app.port}/api/workflows/${workflow.id}/poster`;
  try {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(clear), "the first clear step must win over blank, veiled, or later pictures");
    for (const step of workflow.steps.slice(2)) rmSync(path.join(shots, `${step.id}.png`));
    assert.equal((await fetch(url)).status, 404);
  } finally { await app.close(); rmSync(home, { recursive: true, force: true }); }
});
