import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { pauseIsExpected, scoreBotWall } from "../../src/proof/task-expect";

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
  return workflow.steps.map((step) => `${step.label || ""} ${step.identity?.text || ""} ${step.identity?.name || ""}`).join("\n");
}

test("every proof task declares completed or needs_human", () => {
  const tasks = load<{ id: string; expect: string }[]>("tasks.json");
  assert.equal(tasks.length, 14);
  for (const task of tasks) {
    assert.ok(task.expect === "completed" || task.expect === "needs_human", task.id);
  }
  const expectOf = (id: string) => tasks.find((task) => task.id === id)?.expect;
  assert.equal(expectOf("p3"), "needs_human");
  assert.equal(expectOf("p5"), "completed");
  assert.equal(expectOf("p9"), "needs_human");
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

test("p9 still pauses as needs_human at Place Order", () => {
  const workflow = load<SavedWorkflow>("workflows/p9.json");
  const confirm = workflow.steps.some((step) =>
    step.action === "confirm" && step.confirm === true && /place order/i.test(`${step.label || ""} ${step.identity?.name || ""} ${step.identity?.text || ""}`));
  const pressed = workflow.steps.some((step) => step.action === "click" && /place order/i.test(step.label || ""));
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
