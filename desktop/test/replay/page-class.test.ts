import { testWorkflow } from "../support/workflow";
// The page class is decided before a heal. Each class is a fixture, and a
// wall stops the run with no heal and no model call.

import assert from "node:assert/strict";
import test from "node:test";
import { actBar, healInbox, runViewer, type RunSummary, type WorkflowSummary } from "../../src/app/views";
import { makeAsk } from "../../src/v1/human-ask";
import { type PageSignals } from "../../src/v1/page-class";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import type { Identity, WorkflowStep, WorkflowV2 } from "../../src/v1/schema";

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function doc(startUrl: string, steps: WorkflowStep[]): WorkflowV2 {
  return testWorkflow({
    schema: "bao.workflow/v4",
    id: "wf",
    name: "Fixture",
    startUrl,
    createdAt: 1,
    inputs: [],
    steps: steps.map((item, index) => ({ ...item, index })),
  });
}

function tree(nodes: Identity[]): LiveTree {
  return { nodes, texts: [], values: [] };
}

function fake(pages: LiveTree[], signals?: PageSignals): Driver & { clicks: string[] } {
  let n = 0;
  const clicks: string[] = [];
  const current = () => pages[Math.min(n, pages.length - 1)]!;
  return {
    clicks,
    tree: async () => current(),
    snapshot: async () => ({ dom: "fixture" }),
    click: async (node) => {
      clicks.push(node.testId || node.id || node.text || node.role);
      n += 1;
    },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
    pageSignals: signals ? async () => signals : undefined,
  };
}

const clickApply: WorkflowStep = {
  id: "apply",
  index: 0,
  timeoutMs: 0,
  caption: { text: "Click Apply", citation: { text: "Apply", source: "text" } },
  action: "click",
  target: {
    locators: [
      { kind: "role", role: "button", name: "Apply" },
      { kind: "text", value: "Apply" },
      { kind: "testid", value: "apply" },
      { kind: "css", value: "[data-testid=\"apply\"]" },
    ],
    hint: { role: "button", surface: "dom" },
  },
};

function countingHeal() {
  let proposed = 0;
  return {
    proposed: () => proposed,
    heal: {
      available: () => true,
      propose: async () => {
        proposed += 1;
        return null;
      },
    },
  };
}

test("a bot wall and a login wall stop before the step, and clutter retries once", async () => {
  const quiet = countingHeal();
  const botDriver = fake(
    [tree([ident({ role: "button", text: "Verify you are human", testId: "captcha" })])],
    { iframeSrcs: ["https://www.google.com/recaptcha/enterprise/anchor"], texts: ["I'm not a robot"] },
  );
  const bot = await replay(doc("https://shop.example/cart", [clickApply]), {}, botDriver, { heal: quiet.heal });
  assert.equal(bot.status, "paused");
  assert.equal(bot.pausedKind, "wall");
  assert.equal(bot.pageClasses.at(-1)?.class, "bot_wall");
  assert.equal(bot.pageClasses.at(-1)?.vendor, "reCAPTCHA");
  assert.equal(bot.heals.length, 0);
  assert.equal(bot.modelCalls, 0);
  assert.equal(botDriver.clicks.length, 0);
  assert.match(bot.ask?.instruction || "", /bot check/);
  assert.match(bot.ask?.instruction || "", /Continue/);
  const adsDriver = fake(
    [tree([ident({ testId: "apply", text: "Apply" })])],
    { iframeSrcs: ["https://www.google.com/recaptcha/api2/aframe"], texts: ["Web Tables"], widgets: [{ src: "https://www.google.com/recaptcha/api2/aframe", w: 0, h: 0 }] },
  );
  const ads = await replay(doc("https://demoqa.com/webtables", [clickApply]), {}, adsDriver, { heal: quiet.heal });
  assert.equal(ads.status, "passed");
  assert.deepEqual(adsDriver.clicks, ["apply"]);

  const loginDriver = fake(
    [tree([ident({ testId: "apply", text: "Apply" })])],
    {
      url: "https://usa.experian.com/login/index?refUrl=%2Fmember",
      responses: [{ method: "POST", url: "https://usa.experian.com/api/router/graphql", status: 403 }],
    },
  );
  const login = await replay(doc("https://usa.experian.com/member", [clickApply]), {}, loginDriver, { heal: quiet.heal });
  assert.equal(login.status, "paused");
  assert.equal(login.pausedKind, "wall");
  assert.equal(login.pageClasses.at(-1)?.class, "login_wall");
  assert.match(login.pageClasses.at(-1)?.evidence.map((item) => item.detail).join("\n") || "", /POST \/api\/router\/graphql 403/);
  assert.equal(login.heals.length, 0);
  assert.equal(login.modelCalls, 0);
  assert.equal(loginDriver.clicks.length, 0);
  assert.equal(login.ask?.instruction, "Sign in in the Bao window, then press Continue.");
  assert.equal(quiet.proposed(), 0);

  const clutter = countingHeal();
  const clutterDriver = fake([
    tree([
      ident({ role: "heading", text: "This is a modal window" }),
      ident({ role: "button", text: "Close" }),
    ]),
    tree([ident({ testId: "apply", text: "Apply" })]),
  ]);
  const cleared = await replay(doc("https://shop.example/home", [clickApply]), {}, clutterDriver, { heal: clutter.heal });
  assert.equal(cleared.status, "passed");
  assert.equal(cleared.steps[0]?.reason, "recovered: clutter");
  assert.equal(cleared.pageClasses.at(-1)?.class, "clutter");
  assert.equal(cleared.heals.length, 0);
  assert.equal(cleared.modelCalls, 0);
  assert.equal(clutter.proposed(), 0);
  assert.deepEqual(clutterDriver.clicks, ["Close", "apply"]);

  const changed = countingHeal();
  const missed = await replay(
    doc("https://shop.example/home", [clickApply]),
    {},
    fake([tree([ident({ role: "button", text: "Somewhere else", testId: "other" })])]),
    { heal: changed.heal },
  );
  assert.equal(missed.pageClasses.at(-1)?.class, "changed");
  assert.equal(changed.proposed(), 1);
  assert.equal(missed.heals.length, 1);
  assert.equal(missed.modelCalls, 0);
});

test("the run page and the heals list show the class, the line, and zero calls", () => {
  const line = "Experian is showing a bot check. Complete the check in the Bao window, then press Continue.";
  const ask = makeAsk({
    kind: "wall",
    wall: "bot",
    workflowId: "experian",
    workflowName: "Experian",
    stepId: "open",
    stepIndex: 1,
    stepCount: 1,
    label: "Open account",
    site: "usa.experian.com",
    timeoutMs: 0,
    runId: "run-wall",
  });
  assert.equal(ask.instruction, line);
  const bar = actBar({ activeAsk: ask }, 1_000);
  assert.match(bar, /id="act-bar"/);
  assert.match(bar, /id="act-continue"/);
  assert.match(bar, /Continue/);
  assert.match(bar, /Experian is showing a bot check/);
  const run: RunSummary = {
    id: "run-wall",
    workflowId: "experian",
    status: "needs_human",
    at: 1,
    heals: [],
    modelCalls: 0,
    steps: [{ id: "open", status: "paused", reason: "bot_wall", label: "Open account" }],
    envelope: { status: "needs_human", ask: line, reason: line, step: "open", run_id: "run-wall" },
    pageClasses: [{
      stepId: "open",
      class: "bot_wall",
      reason: "bot check",
      vendor: "Imperva",
      line,
      evidence: [{ source: "iframe", detail: "/_Incapsula_Resource" }],
    }],
  };
  const html = runViewer(run, { name: "Experian", steps: [{ id: "open", label: "Open account" }] });
  assert.match(html, /id="page-class"/);
  assert.match(html, /data-class="bot_wall"/);
  assert.match(html, /bot check/);
  assert.match(html, /Imperva/);
  assert.match(html, /0 heals · 0 model calls/);
  assert.match(html, /needs_human/);
  assert.match(html, /waiting on step 1, Open account · no timeout/);
  assert.match(html, /Step 1 &#39;Open account&#39; stopped at an Imperva bot check\. bao didn&#39;t try to fix it, since bot checks need a person\./);
  assert.equal(html.includes("Phase the step"), false);
  assert.equal(html.includes("cheap repair"), false);
  const envelope = html.slice(html.indexOf('id="run-envelope"'), html.indexOf('id="run-actions"'));
  assert.equal((envelope.match(/Experian is showing a bot check/g) || []).length, 1);
  assert.match(envelope, /id="envelope-details"/);
  assert.equal(envelope.includes('id="envelope-reason"'), false);
  const workflow: WorkflowSummary = { id: "experian", name: "Experian", steps: 1 };
  const inbox = healInbox([run], [workflow], "pending");
  assert.match(inbox, /data-page-class="bot_wall"/);
  assert.match(inbox, /Experian/);
  assert.match(inbox, /0 heals · 0 model calls/);
  assert.equal(inbox.includes("Nothing pending"), false);
});
