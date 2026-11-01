// Teach the fixture once, correct it, replay twice, and blur secrets.
// A later test teaches the interstitial fix and merges a login route.
// The capture browser is the local fixture page. No vendor network.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { testChromium as chromium } from "../../src/test-browser.js";
import { startApp } from "../../src/app/server";
import { loadTeachIntentCases } from "../../src/eval/intent/teach-cases";
import { blurSensitiveFields, unblurSensitiveFields } from "../../src/v1/dom-page";
import type { WorkflowV2 } from "../../src/v1/schema";

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
    assert.equal(note.intent, "Type {{note}} into Note");
    assert.equal(note.narrator, "heuristic");
    assert.match(apply.intent, /^Click /);

    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.waitForSelector("#teach-panel");
    const box = await page.locator("#teach-panel").boundingBox();
    assert.ok(box && box.width <= 380 && box.width >= 340, `panel width ${box?.width}`);
    await page.locator(`#teach-panel [data-card="${note.id}"] .teach-row`).click();
    const panel = await page.locator("#teach-panel").innerText();
    assert.match(panel, /Type \{\{note\}\}/);
    assert.match(panel, /heuristic/);
    assert.match(panel, /Sensitive fields blurred/);
    assert.match(panel, /Add check/);
    assert.match(panel, /You do this/);
    assert.equal(await page.locator("#teach-panel .teach-card.on").count(), 1);

    await post(app.port, "/api/teach/correct", { kind: "drop", cardId: stray.id });
    await post(app.port, "/api/teach/correct", { kind: "note", cardId: note.id, note: "type the note" });
    await post(app.port, "/api/teach/correct", { kind: "human", cardId: apply.id });
    const cases = loadTeachIntentCases(path.join(home, "evals", "intent", "cases"));
    assert.ok(cases.length >= 3, `cases ${cases.length}`);
    assert.ok(cases.every((item) => item.schema === "bao.intent-case/v1" && item.events.length > 0 && item.workflow.steps.length > 0));
    assert.equal(JSON.stringify(cases).includes(secret), false);
    await post(app.port, "/api/sessions/mark");

    const review = await post(app.port, "/api/teach/stop") as { phase: string; review: { summary?: { line: string }; workflow: { steps: { action?: string; intent?: string; human?: boolean }[] } } };
    assert.match(review.review.summary?.line || "", /^\d+ events → \d+ steps, \d+ inputs found, \d+ dropped$/);
    assert.equal(review.phase, "review");
    await page.reload();
    await page.click("button[data-screen=teach]");
    await page.waitForSelector("#teach-review");
    const reviewText = await page.locator("#teach-review").innerText();
    assert.match(reviewText, /Raw trail/);
    assert.match(reviewText, /type the note/);
    assert.match(reviewText, /edited/);
    assert.match(reviewText, /Dropped \(1\)/);
    assert.match(reviewText, /\d+ events → \d+ steps, \d+ inputs found, \d+ dropped/);
    assert.match(reviewText, /mark/);

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

test("teach the interstitial fix as a guarded branch", { timeout: 180000 }, async () => {
  delete process.env.BAO_HEAL_FIXTURE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.BAO_TEACH_FIXTURE;
  const home = mkdtempSync(path.join(tmpdir(), "bao-fix-"));
  const app = await startApp({ home, port: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await post(app.port, "/api/sessions", { url: `http://127.0.0.1:${app.port}/fixture`, teach: true });
    await post(app.port, "/api/sessions/drive", { click: "#apply-btn" });
    await post(app.port, "/api/teach/stop");
    const taught = await post(app.port, "/api/teach/save", { name: "Apply the note" }) as WorkflowV2;
    const recorded = app.library.read(taught.id);
    recorded.startUrl = `http://127.0.0.1:${app.port}/fixture?interstitial=1`;
    app.library.save(recorded);
    const failed = await post(app.port, "/api/replay", { id: recorded.id, args: {} }) as {
      runId: string;
      status: string;
      modelCalls: number;
      failure?: { stepId?: string; reason?: string };
    };
    assert.equal(failed.status, "failed", JSON.stringify(failed.failure));
    assert.equal(failed.modelCalls, 0);
    const stepId = failed.failure?.stepId || recorded.steps[0]?.id || "";
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.click('button[data-screen="runs"]');
    await page.click(`[data-open-run="${failed.runId}"]`);
    await page.waitForSelector("#teach-fix");
    assert.equal(await page.locator("#teach-fix").innerText(), "Teach this step");
    assert.match(await page.locator("#why-stopped").innerText(), /No steps ran/);
    await page.click("#teach-fix");
    const clicked = Date.now();
    let taughtLive = false;
    while (Date.now() - clicked < 20000) {
      const current = await state(app.port);
      if (current.teach.phase === "live") {
        taughtLive = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.equal(taughtLive, true);
    await post(app.port, "/api/sessions/drive", { click: "#interstitial-go" });
    const stopped = await post(app.port, "/api/teach/stop") as { review?: { summary?: { line: string } } };
    assert.match(stopped.review?.summary?.line || "", /^\d+ events → \d+ steps, \d+ inputs found, \d+ dropped$/);
    const fixed = await post(app.port, "/api/teach/save") as WorkflowV2;
    assert.equal(fixed.steps[0]?.when?.present, "Review notice");
    assert.equal(fixed.steps[0]?.identity?.id, "interstitial-go");
    assert.equal(fixed.steps[1]?.identity?.id, "apply-btn");
    assert.equal(fixed.steps[1]?.when, undefined);
    const withNotice = await post(app.port, "/api/replay", { id: fixed.id, args: {} }) as {
      status: string;
      modelCalls: number;
      steps: { reason?: string }[];
      failure?: unknown;
    };
    assert.equal(withNotice.status, "passed", JSON.stringify(withNotice.failure));
    assert.equal(withNotice.modelCalls, 0);
    assert.notEqual(withNotice.steps[0]?.reason, "other branch");
    assert.notEqual(withNotice.steps[1]?.reason, "other branch");

    const plain: WorkflowV2 = {
      ...app.library.read(fixed.id),
      id: `${fixed.id}-plain`,
      startUrl: `http://127.0.0.1:${app.port}/fixture`,
    };
    app.library.save(plain);
    const without = await post(app.port, "/api/replay", { id: plain.id, args: {} }) as {
      status: string;
      modelCalls: number;
      steps: { reason?: string }[];
      failure?: unknown;
    };
    assert.equal(without.status, "passed", JSON.stringify(without.failure));
    assert.equal(without.modelCalls, 0);
    assert.equal(without.steps[0]?.reason, "other branch");
    assert.notEqual(without.steps[1]?.reason, "other branch");
  } finally {
    await browser.close();
    await app.close();
  }
});

test("a logged-in demo and a login demo merge into one route", { timeout: 180000 }, async () => {
  delete process.env.BAO_HEAL_FIXTURE;
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.BAO_TEACH_FIXTURE;
  const home = mkdtempSync(path.join(tmpdir(), "bao-route-"));
  const app = await startApp({ home, port: 0 });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    await post(app.port, "/api/sessions", { url: `${base}/fixture`, teach: true });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#username", value: "demo" } });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#password", value: "demo-pass" } });
    await post(app.port, "/api/sessions/drive", { click: "#login-btn" });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#note-input", value: "alpha note" } });
    await post(app.port, "/api/sessions/drive", { click: "#apply-btn" });
    await post(app.port, "/api/teach/stop");
    const login = await post(app.port, "/api/teach/save", { name: "Log in first" }) as WorkflowV2;

    await post(app.port, "/api/sessions", { url: `${base}/fixture?signedin=1`, teach: true });
    await post(app.port, "/api/sessions/drive", { fill: { selector: "#note-input", value: "alpha note" } });
    await post(app.port, "/api/sessions/drive", { click: "#apply-btn" });
    await post(app.port, "/api/teach/stop");
    const signed = await post(app.port, "/api/teach/save", { name: "Already signed in" }) as WorkflowV2;

    const merged = await post(app.port, "/api/teach/merge", {
      ids: [login.id, signed.id],
      name: "Note either way",
    }) as WorkflowV2;
    const route = merged.inputs.find((input) => input.type === "choice");
    assert.deepEqual(route?.choices, ["Log in first", "Already signed in"]);
    assert.ok(merged.steps.some((step) => step.when?.value === "Log in first"));
    assert.equal(merged.steps.find((step) => step.identity?.id === "apply-btn")?.when, undefined);
    await page.goto(`${base}/`);
    await page.click('button[data-screen="library"]');
    await page.click(`[data-open-workflow="${merged.id}"]`);
    await page.waitForSelector("#route-branch");
    const branch = (await page.locator("#route-branch").innerText()).replace(/\s+/g, " ").trim();
    assert.equal(branch, "Routes: Log in first / Already signed in");
    assert.equal(await page.locator("#workflow-detail").innerText().then((text) => text.includes("{{route}}")), false);
    assert.equal(await page.locator('[data-testid="deeplink"]').count(), 0);
    assert.equal(await page.locator('[data-testid="share-menu"]').count(), 1);
    assert.equal(await page.locator('[data-route="Log in first"]').count() > 0, true);
    const shotDirs = [login.id, signed.id, merged.id].map((id) => {
      const dir = path.join(home, "shots", "workflows", id);
      return { id, files: existsSync(dir) ? readdirSync(dir) : [] };
    });
    await page.waitForTimeout(1500);
    const cards = await page.evaluate(() => [...document.querySelectorAll("#workflow-steps .step-card")].map((card) => {
      const thumb = card.querySelector(".thumb");
      const img = thumb?.querySelector("img") as HTMLImageElement | null;
      return {
        label: card.querySelector("strong")?.textContent || "",
        shot: thumb?.getAttribute("data-shot") || "",
        has: thumb?.classList.contains("has-shot") === true,
        w: img?.naturalWidth || 0,
        h: img?.naturalHeight || 0,
      };
    }));
    const typed = cards.filter((card) => /^(type|click)/i.test(card.label));
    const realCrop = (card: { has: boolean; w: number; h: number }) => card.has && card.w > 96 && card.h > 20 && !(card.w === 96 && card.h === 54);
    assert.ok(typed.length > 0 && typed.every(realCrop), JSON.stringify({ shotDirs, cards }, null, 2));

    const loginRun = await post(app.port, "/api/replay", {
      id: merged.id,
      args: { [route!.name]: "Log in first", username: "demo", password: "demo-pass", note: "alpha note" },
    }) as { runId: string; status: string; modelCalls: number; failure?: unknown };
    assert.equal(loginRun.status, "passed", JSON.stringify(loginRun.failure));
    assert.equal(loginRun.modelCalls, 0);
    await page.goto(`${base}/`);
    await page.click('button[data-screen="runs"]');
    await page.click(`[data-open-run="${loginRun.runId}"]`);
    await page.waitForSelector("#route-ran");
    assert.equal(await page.locator("#route-ran").getAttribute("data-route"), "Log in first");

    const signedRun = await post(app.port, "/api/replay", {
      id: merged.id,
      args: { [route!.name]: "Already signed in", note: "beta note" },
    }) as { runId: string; status: string; modelCalls: number; failure?: unknown };
    assert.equal(signedRun.status, "passed", JSON.stringify(signedRun.failure));
    assert.equal(signedRun.modelCalls, 0);
    await page.goto(`${base}/`);
    await page.click('button[data-screen="runs"]');
    await page.click(`[data-open-run="${signedRun.runId}"]`);
    await page.waitForSelector("#route-ran");
    assert.equal(await page.locator("#route-ran").getAttribute("data-route"), "Already signed in");
  } finally {
    await browser.close();
    await app.close();
  }
});
