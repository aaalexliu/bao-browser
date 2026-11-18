import { targetElementId } from "../../../shared/step-read";
import { stepTarget, checkMatch, stepInputName, stepCheck } from "../../src/v1/schema";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Capture } from "../../src/app/capture";
import { McpClient } from "../../src/eval/mcp-client";
import { describeWorkflow } from "../../src/mcp/catalog";
import { testChromium as chromium } from "../../src/test-browser";
import { interpret, type TrailEvent } from "../../src/v1/interpret";
import { recorderSource } from "../../src/v1/recorder";
import { Library } from "../../src/v1/store";
import { laneChildEnv, scaledMs } from "../runtime";

test("describe omits a generated token check while retaining local data and explicit checks", { timeout: scaledMs(30_000) }, async () => {
  const token = "sk-DerivedFixtureToken123456789";
  const explicit = "sk-ExplicitFixtureToken987654321";
  const home = mkdtempSync(path.join(tmpdir(), "bao-describe-derived-"));
  const library = new Library(path.join(home, "library"));
  const capture = new Capture();
  capture.start();
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><label>Guests<input id="guests" autocomplete="off"></label><button id="generate" onclick="document.getElementById('generated').textContent='${token}'">Generate API key</button><p id="generated">Waiting for key</p><button id="ordinary" onclick="document.getElementById('status').textContent='Saved ordinary fixture'">Complete</button><p id="status">Waiting for save</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let client: McpClient | undefined;
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    let received: ((event: TrailEvent) => void) | undefined;
    await context.exposeBinding("__baoRecord", (_source, event: TrailEvent) => {
      assert.equal(capture.push(event), true);
      received?.(event);
    });
    await context.addInitScript(recorderSource());
    const page = await context.newPage();
    await page.goto(origin);
    for (const id of ["guests", "generate", "ordinary"]) {
      const recorded = new Promise<void>((resolve) => {
        received = (event) => { if (event.identity?.id === id && event.op === (id === "guests" ? "type" : "click")) resolve(); };
      });
      if (id === "guests") await page.locator(`#${id}`).fill("2");
      else await page.locator(`#${id}`).click();
      await recorded;
      received = undefined;
    }
    capture.note(explicit);
    capture.check(explicit);
    const events = capture.stop();
    const raw = structuredClone(events);
    const document = interpret(events, { id: "derived-check", name: "Generate API key", startUrl: origin });
    library.save(document);
    library.saveTrail(document.id, events);
    const saved = library.read(document.id);
    const trail = JSON.stringify(library.readTrail(document.id));
    const generated = saved.steps.find((step) => targetElementId(stepTarget(step)) === "generate");
    assert.ok(generated);
    assert.equal(checkMatch(stepCheck(generated)), token);
    assert.equal(checkMatch(stepCheck(generated)), token);
    const guests = saved.steps.find((step) => targetElementId(stepTarget(step)) === "guests");
    assert.ok(guests);
    assert.equal(saved.inputs.find((input) => input.name === stepInputName(guests))?.default, "2");
    assert.ok(events.some((event) => event.op === "type" && event.value === "2"));
    assert.ok(events.some((event) => event.op === "click" && event.subtreeAfter === token));
    const described = await describeWorkflow(library, document.id);
    const projected = described.workflow.steps.find((step) => step.id === generated.id);
    assert.ok(projected);
    assert.equal(stepCheck(projected), undefined);
    assert.equal(stepCheck(projected), undefined);
    const ordinary = described.workflow.steps.find((step) => targetElementId(stepTarget(step)) === "ordinary");
    assert.equal(checkMatch(ordinary == null ? undefined : stepCheck(ordinary)), "Saved ordinary fixture");
    assert.equal(checkMatch(ordinary == null ? undefined : stepCheck(ordinary)), "Saved ordinary fixture");
    assert.ok(described.workflow.steps.some((step) => step.caption.text === explicit));
    assert.equal(checkMatch(described.workflow.steps.find((step) => step.action === "verify") ? stepCheck(described.workflow.steps.find((step) => step.action === "verify")!) : undefined), explicit);
    const env = laneChildEnv("hermetic", process.env);
    env.HOME = path.join(home, "user");
    env.BAO_HOME = library.root;
    env.BAO_AGENT_BROWSER_PROFILE_ROOT = path.join(home, "profiles");
    mkdirSync(env.HOME);
    mkdirSync(env.BAO_AGENT_BROWSER_PROFILE_ROOT);
    client = McpClient.start(env);
    assert.ok((await client.handshake()).includes("describe_workflow"));
    const result = await client.call("describe_workflow", { id: document.id });
    assert.equal(result.isError, false, result.text);
    assert.equal(result.text.includes(token), false);
    assert.equal(result.text.includes("Saved ordinary fixture"), true);
    assert.equal(result.text.includes(explicit), true);
    assert.deepEqual(library.read(document.id), saved);
    assert.equal(JSON.stringify(library.readTrail(document.id)), trail);
    assert.deepEqual(events, raw);
  } finally {
    await client?.close();
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(home, { recursive: true, force: true });
  }
});
