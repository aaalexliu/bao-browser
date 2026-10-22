// Teach the fixture once, correct it, replay twice, splice a failed step, and blur secrets.
// The capture browser is the local fixture page. No vendor network.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright";
import { startApp } from "../../src/app/server";
import { blurSensitiveFields, unblurSensitiveFields } from "../../src/v1/dom-page";
import type { Identity, WorkflowV2 } from "../../src/v1/schema";

process.env.BAO_DRIVE = "1";

const secret = "SuperSecretPassword!";

async function post(port: number, pathname: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? "{}" : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) as { error?: string } : {};
  if (!res.ok) throw new Error(`${pathname} ${res.status} ${json.error || text}`);
  return json;
}

async function state(port: number): Promise<{
  teach: {
    phase: string;
    blurredShots: number;
    blur: boolean;
    cards: { id: string; intent: string; action: string; narrator: string; outcome: string; values: { role: string; name: string }[] }[];
    decisions: { kind: string; detail: string }[];
    review?: { workflow: { steps: { intent?: string; action?: string }[] }; raw: { kind?: string; op?: string }[] };
  };
  activeAsk?: { kind?: string };
}> {
  return await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
}

test("teach the fixture, correct three cards, replay twice, and splice a fix", { timeout: 180000 }, async () => {
  delete process.env.BAO_HEAL_FIXTURE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.BAO_TEACH_FIXTURE;
  const home = mkdtempSync(path.join(tmpdir(), "bao-teach-"));
  const file = path.join(home, "note.txt");
  writeFileSync(file, "hello bao\n");
  const app = await startApp({ home, port: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await post(app.port, "/api/sessions", { url: `http://127.0.0.1:${app.port}/fixture`, teach: true });
    await post(app.port, "/api/sessions/pause");
    await post(app.port, "/api/sessions/drive", { click: "#save-note" });
    assert.equal((await state(app.port)).teach.cards.length, 0);
    await post(app.port, "/api/sessions/pause");

    await post(app.port, "/api/sessions/drive", { click: "#note-input" });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#note-input", value: "ship the notes" } });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#password", value: secret } });
    await post(app.port, "/api/sessions/drive", { drop: { selector: "#drop", name: "note.txt", path: file } });
    await post(app.port, "/api/sessions/drive", { click: "#apply-btn" });
    await post(app.port, "/api/teach/check");

    const live = await state(app.port);
    assert.equal(live.teach.phase, "live");
    assert.equal(live.teach.blur, true);
    assert.ok(live.teach.blurredShots >= 1, "password screenshot was not blurred");
    assert.ok(live.teach.cards.every((card) => card.narrator === "heuristic"));
    const note = live.teach.cards.find((card) => card.action === "type" && card.values.some((value) => value.name === "note"));
    const apply = live.teach.cards.find((card) => card.action === "click" && /apply/i.test(card.intent));
    const stray = live.teach.cards.find((card) => card.action === "click" && card.id !== apply?.id);
    assert.ok(note && apply && stray, JSON.stringify(live.teach.cards));
    assert.equal(note.intent, "type the note");
    assert.equal(note.narrator, "heuristic");

    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.waitForSelector("#teach-panel");
    const panel = await page.locator("#teach-panel").innerText();
    assert.match(panel, /type the note/);
    assert.match(panel, /heuristic/);
    assert.match(panel, /Sensitive fields blurred/);
    assert.match(panel, /Add check/);
    assert.match(panel, /You do this/);

    await post(app.port, "/api/teach/correct", { kind: "drop", cardId: stray.id });
    await post(app.port, "/api/teach/correct", { kind: "note", cardId: note.id, note: "type the note" });
    await post(app.port, "/api/teach/correct", { kind: "human", cardId: apply.id });

    const review = await post(app.port, "/api/teach/stop") as { phase: string; review: { workflow: { steps: { action?: string; intent?: string; human?: boolean }[] } } };
    assert.equal(review.phase, "review");
    await page.reload();
    await page.click("button[data-screen=teach]");
    await page.waitForSelector("#teach-review");
    const reviewText = await page.locator("#teach-review").innerText();
    assert.match(reviewText, /Workflow/);
    assert.match(reviewText, /Raw trail/);
    assert.match(reviewText, /type the note/);

    const saved = await post(app.port, "/api/teach/save", { name: "Fixture teach" }) as {
      id: string;
      inputs: { name: string; type: string }[];
      steps: { action: string; intent?: string; human?: boolean; input?: string; postcondition?: { match?: string } }[];
    };
    const savedBlob = JSON.stringify(saved);
    assert.equal(savedBlob.includes(secret), false);
    assert.equal(savedBlob.includes(file), false);
    assert.equal(saved.steps.find((step) => step.input === "note")?.intent, "type the note");
    assert.equal(saved.steps.some((step) => step.action === "confirm" && step.human), true);
    assert.equal(saved.steps.find((step) => step.action === "verify")?.postcondition?.match, "Applied");
    const pair = app.library.readIntentEval(saved.id) as {
      decisions: { kind: string; detail: string }[];
      workflow: { steps: { intent?: string }[] };
      rawTrail: { kind?: string }[];
      baseline: { steps: unknown[] };
    };
    assert.equal(pair.decisions.filter((decision) => decision.kind !== "check").length, 3);
    assert.ok(pair.decisions.some((decision) => decision.detail === "note became intent"));
    assert.ok(pair.decisions.some((decision) => decision.kind === "drop"));
    assert.ok(pair.decisions.some((decision) => decision.kind === "human"));
    assert.equal(JSON.stringify(pair).includes(secret), false);
    const trail = app.library.readTrail(saved.id) as { kind?: string; decision?: string }[];
    const firstDecision = trail.findIndex((event) => event.kind === "decision");
    assert.ok(firstDecision > 0);
    assert.ok(trail.slice(0, firstDecision).every((event) => event.kind !== "decision"));
    assert.ok(trail.slice(firstDecision).every((event) => event.kind === "decision"));

    const secretInput = saved.inputs.find((input) => input.type === "secret");
    const fileInput = saved.inputs.find((input) => input.type === "file");
    const noteInput = saved.inputs.find((input) => input.name === "note");
    assert.ok(secretInput && fileInput && noteInput);
    for (const [noteText, password, fileName] of [["alpha note", "alpha-secret-value", "alpha.txt"], ["beta note", "beta-secret-value", "beta.txt"]] as const) {
      const pending = post(app.port, "/api/replay", {
        id: saved.id,
        args: {
          [noteInput.name]: noteText,
          [secretInput.name]: password,
          [fileInput.name]: { name: fileName, path: file },
        },
      });
      const started = Date.now();
      let asked = false;
      while (Date.now() - started < 15000) {
        const current = await state(app.port);
        if (current.activeAsk?.kind === "confirm") {
          asked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(asked, true);
      await post(app.port, "/api/replay/press", { name: "Apply" });
      const run = await pending as { status: string; failure?: { reason: string; stepId: string } };
      assert.equal(run.status, "passed", JSON.stringify(run.failure));
      assert.equal(JSON.stringify(run).includes(password), false);
    }

    await page.goto(`http://127.0.0.1:${app.port}/fixture`);
    await page.fill("#password", secret);
    const blurred = await page.evaluate(blurSensitiveFields);
    assert.ok(blurred >= 1);
    assert.match(await page.locator("#password").evaluate((el) => getComputedStyle(el).filter), /blur/);
    assert.equal(await page.locator("[data-bao-blur]").count(), blurred);
    await page.evaluate(unblurSensitiveFields);
    assert.equal(await page.locator("[data-bao-blur]").count(), 0);

    const broken: WorkflowV2 = {
      schema: "bao.workflow/v2",
      version: 2,
      id: "wf-broken",
      name: "Broken apply",
      startUrl: `http://127.0.0.1:${app.port}/fixture`,
      createdAt: 1,
      inputs: [],
      steps: [{
        id: "bad",
        index: 0,
        action: "click",
        label: "Click missing",
        surface: "dom",
        timeoutMs: 400,
        identity: { surface: "dom", role: "button", testId: "missing-apply", path: [] } satisfies Identity,
      }],
    };
    app.library.save(broken);
    const failed = await post(app.port, "/api/replay", { id: broken.id, args: {} }) as { status: string };
    assert.equal(failed.status, "failed");
    await post(app.port, "/api/sessions", { teach: true, fix: { workflowId: broken.id, stepId: "bad" } });
    await post(app.port, "/api/sessions/drive", { click: "#apply-btn" });
    await post(app.port, "/api/teach/stop");
    const fixed = await post(app.port, "/api/teach/save") as { id: string; steps: { identity?: { id?: string; testId?: string } }[] };
    assert.equal(fixed.id, broken.id);
    assert.equal(fixed.steps.some((step) => step.identity?.id === "apply-btn" || step.identity?.testId === "apply"), true);
    assert.equal(fixed.steps.some((step) => step.identity?.testId === "missing-apply"), false);
    const fixedRun = await post(app.port, "/api/replay", { id: broken.id, args: {} }) as { status: string; failure?: unknown };
    assert.equal(fixedRun.status, "passed", JSON.stringify(fixedRun.failure));

    await post(app.port, "/api/sessions", { url: `http://127.0.0.1:${app.port}/fixture`, teach: true });
    await post(app.port, "/api/sessions/drive", { click: "#save-note" });
    await post(app.port, "/api/teach/discard");
    assert.equal((await state(app.port)).teach.phase, "idle");
    assert.equal(app.library.list().some((workflow) => workflow.name === "Taught workflow" && workflow.steps.length === 1), false);
  } finally {
    await browser.close();
    await app.close();
  }
});
