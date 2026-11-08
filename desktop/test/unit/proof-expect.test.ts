import { projectStep } from "../../src/v1/schema";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pauseIsExpected, scoreBotWall } from "../../src/proof/task-expect";
import { recordP3, recordP9, scoreP3, scoreP9, type ScoreInput } from "../../src/proof/realworld";

interface SavedRun {
  replay: {
    status?: string;
    pausedKind?: string;
    ask?: { kind?: string; instruction?: string };
    failure?: { reason?: string };
    heals?: unknown[];
    modelCalls?: number;
    steps?: { snapshot?: { ax?: string } }[];
  };
  page: { title?: string; text?: string };
}

interface SavedWorkflow {
  steps: { action?: string; confirm?: boolean; label?: string; identity?: { text?: string; name?: string } }[];
}

function load<T = SavedRun>(name: string): T {
  return JSON.parse(readFileSync(`docs/proof/realworld/${name}`, "utf8")) as T;
}

function stepText(workflow: SavedWorkflow): string {
  return workflow.steps.map((step) => `${projectStep(step).label || ""} ${projectStep(step).identity?.text || ""} ${projectStep(step).identity?.name || ""}`).join("\n");
}

test("every proof task declares completed or needs_human", () => {
  const tasks = load<{ id: string; expect: string }[]>("tasks.json");
  assert.equal(tasks.length, 14);
  for (const task of tasks) {
    assert.ok(task.expect === "completed" || task.expect === "needs_human", task.id);
  }
  const expectOf = (id: string) => tasks.find((task) => task.id === id)?.expect;
  assert.equal(expectOf("p3"), "completed");
  assert.equal(expectOf("p5"), "completed");
  assert.equal(expectOf("p9"), "completed");
  assert.equal(expectOf("p13"), "completed");
  assert.equal(expectOf("p14"), "needs_human");
});

test("p14's bot-wall pause counts as needs_human, with 0 heals and 0 captcha clicks", () => {
  const workflow = load<SavedWorkflow>("workflows/p14.json");
  const steps = stepText(workflow);
  assert.doesNotMatch(steps, /cloudflare|turnstile|verify you are human|i am not a robot|checkbox/i);
  for (const name of ["runs/p14-r1.json", "runs/p14-r2.json"]) {
    const saved = load(name);
    const scored = scoreBotWall({
      expect: "needs_human",
      replay: saved.replay,
      pageText: `${saved.page.title} ${saved.page.text}`,
      stepText: steps,
    });
    assert.equal(scored.pass, true, `${name}: ${scored.detail}`);
    assert.equal(scored.detail, "needs human: bot check, 0 heals, 0 captcha clicks");
    assert.equal(saved.replay.status, "paused");
    assert.equal(saved.replay.pausedKind, "wall");
    assert.equal((saved.replay.heals || []).length, 0);
    assert.equal(saved.replay.modelCalls, 0);
    assert.equal(pauseIsExpected("needs_human", saved.replay), true);
    assert.equal(pauseIsExpected("completed", saved.replay), false);
  }
});

test("the same bot wall fails when the task expects a completed run", () => {
  const saved = load("runs/p14-r1.json");
  const scored = scoreBotWall({
    expect: "completed",
    replay: saved.replay,
    pageText: `${saved.page.title} ${saved.page.text}`,
    stepText: "Open https://practicesoftwaretesting.com/",
  });
  assert.equal(scored.pass, false);
  assert.match(scored.detail, /not needs_human/);
  assert.match(scored.detail, /heals 0/);
});

test("proof recordings stop before booking and checkout submission", async () => {
  for (const guestForm of [false, true]) {
    const calls: Record<string, unknown>[] = [];
    await recordP3({
      open: async () => {},
      waitFor: async () => ({}),
      view: async () => ({ text: guestForm ? "First name" : "Choose dates" }),
      drive: async (body) => { calls.push(body); },
    });
    assert.deepEqual(calls.filter((body) => body.click).map((body) => body.click), [
      "a[href*='/reservation/1']",
      "button:text-is('Next')",
    ]);
    assert.equal(calls.filter((body) => body.drag).length, 1);
    assert.equal(calls.filter((body) => body.fill).length, guestForm ? 3 : 0);
  }
  const calls: Record<string, unknown>[] = [];
  await recordP9({
    open: async () => {},
    waitFor: async () => ({}),
    drive: async (body) => { calls.push(body); },
  });
  assert.deepEqual(calls.filter((body) => body.click).map((body) => body.click), [
    "shop-app >> a[href*='YouTube+Organic']",
    "shop-app >> shop-detail >> button:has-text('Add to Cart')",
    "shop-app >> #viewCartAnchor",
    "shop-app >> shop-cart >> text=Checkout",
  ]);
  assert.deepEqual(calls.at(-1), { fill: { selector: "shop-app >> #ccName", value: "Bao" } });
});

test("p3 and p9 score completed preparation, not final clicks or pauses", () => {
  for (const run of [1, 2] as const) {
    for (const id of ["p3", "p9"] as const) {
      const nights = run === 1 ? 2 : 3;
      const input: ScoreInput = {
        run,
        expect: "completed",
        replay: { status: "passed", modelCalls: 0 },
        workflow: { ...load<ScoreInput["workflow"]>(`workflows/${id}.json`), steps: [] },
        page: { text: id === "p3"
          ? `£100 x ${nights} nights £${100 * nights} Fees £10 Total £${100 * nights + 10}`
          : `YouTube Organic Cotton $29.50 ${run === 1 ? "2 Market" : "3 Market"}` },
        args: {},
        files: { recordFile: "", replayFile: ["", ""], recordImage: "", replayImage: ["", ""] },
        openUrl: "",
      };
      const score = id === "p3" ? scoreP3 : scoreP9;
      assert.equal(score(input).pass, true, `${id} run ${run}`);
      assert.equal(score({ ...input, replay: { status: "paused", pausedKind: "confirm" } }).pass, false);
      assert.equal(score({ ...input, expect: "needs_human" }).pass, false);
      assert.equal(score({ ...input, page: { text: "Wrong booking or empty cart" } }).pass, false);
      const label = id === "p3" ? "Reserve Now" : "Place Order";
      assert.equal(score({ ...input, workflow: { ...input.workflow, steps: [{ id: "submit", index: 0, action: "click", label, surface: "dom", timeoutMs: 1000 }] } }).pass, false);
    }
  }
});

test("historical p9 saved workflows retain their confirm pause", () => {
  const workflow = load<SavedWorkflow>("workflows/p9.json");
  const confirm = workflow.steps.some((step) =>
    step.action === "confirm" && step.confirm === true && /place order/i.test(`${projectStep(step).label || ""} ${projectStep(step).identity?.name || ""} ${projectStep(step).identity?.text || ""}`));
  const pressed = workflow.steps.some((step) => step.action === "click" && /place order/i.test(projectStep(step).label || ""));
  assert.equal(confirm, true);
  assert.equal(pressed, false);
  const runs = [["runs/p9-r1.json", "2 Market"], ["runs/p9-r2.json", "3 Market"]] as const;
  for (const [name, ship] of runs) {
    const saved = load(name);
    const text = [saved.page.title || "", saved.page.text || "", ...(saved.replay.steps || []).map((step) => step.snapshot?.ax || "")].join("\n");
    assert.equal(pauseIsExpected("needs_human", saved.replay), true, name);
    assert.equal(saved.replay.status, "paused");
    assert.equal(saved.replay.pausedKind, "confirm");
    assert.match(saved.replay.ask?.instruction || "", /place order/i);
    assert.match(text, /needs you/i);
    assert.match(text, /YouTube Organic Cotton/);
    assert.match(text, /\$29\.50/);
    assert.ok(text.includes(ship), `${name} address`);
    assert.equal(saved.replay.modelCalls, 0);
    assert.equal((saved.replay.heals || []).length, 0);
  }
});
