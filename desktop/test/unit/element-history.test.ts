import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv/dist/2020";
import { runViewer, versionsPanel } from "../../src/app/views";
import { rollbackTo } from "../../src/v1/element-history";
import { keepPatch, revertPatch, type HealProposal } from "../../src/v1/heal";
import { replay, type Driver, type LiveTree } from "../../src/v1/replay";
import { validateWorkflow, type Identity, type WorkflowStep, type WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { formatClock } from "../../src/v1/time";
import { draftVersion, listVersions, restoreVersion, versionDocument } from "../../src/v1/versions";

const schema = JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow-v2.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function ident(partial: Partial<Identity>): Identity {
  return { surface: "dom", role: "button", path: [], ...partial };
}

function step(partial: Partial<WorkflowStep> & Pick<WorkflowStep, "id" | "action">): WorkflowStep {
  return {
    index: 0,
    label: partial.label || partial.action,
    surface: "dom",
    timeoutMs: 0,
    ...partial,
  };
}

function doc(steps: WorkflowStep[], id = "wf"): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name: "Fixture",
    startUrl: "http://127.0.0.1/fixture",
    createdAt: 1_700_000_000_000,
    inputs: [],
    steps: steps.map((item, index) => ({ ...item, index })),
  };
}

function tree(nodes: Identity[]): LiveTree {
  return { nodes, texts: [], values: [] };
}

function fake(pages: LiveTree[]): Driver & { clicks: string[] } {
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
  };
}

const throwingHeal = {
  available: () => true,
  propose: async () => {
    throw new Error("model should not be called");
  },
};

test("heal twice, roll back to the recorded version, and replay with no model call", async () => {
  const recordedAt = 1_700_000_000_000;
  const original = ident({ testId: "save", text: "Save" });
  let workflow = doc([
    step({ id: "save", action: "click", label: "Click Save", identity: original }),
  ]);
  workflow.createdAt = recordedAt;
  const patch = (text: string, testId: string): HealProposal["patch"] => ({ identity: ident({ text, testId }) });
  workflow = keepPatch(workflow, "save", patch("Save v2", "save-v2"), { at: recordedAt + 60_000, runId: "run-1", score: 100 });
  workflow = keepPatch(workflow, "save", patch("Save v3", "save-v3"), { at: recordedAt + 120_000, runId: "run-2", score: 88 });
  const history = workflow.steps[0]?.history || [];
  assert.equal(history.length, 3);
  assert.equal(history[0]?.source, "recorded");
  assert.equal(history[1]?.source, "heal");
  assert.equal(history[1]?.runId, "run-1");
  assert.equal(history[1]?.score, 100);
  assert.ok(history[1]?.changed.includes("testId"));
  assert.equal(history[2]?.runId, "run-2");
  const snap = structuredClone(history[0]);
  const rolled = rollbackTo(workflow.steps[0]!, history[0]!.id, { at: recordedAt + 180_000, recordedAt });
  assert.equal(rolled.history?.length, 4);
  assert.deepEqual(rolled.history?.[0], snap);
  assert.deepEqual(history[0], snap);
  assert.equal(rolled.history?.[3]?.source, "rollback");
  assert.equal(rolled.identity?.text, "Save");
  assert.equal(rolled.identity?.testId, "save");
  assert.notEqual(rolled.history?.[3]?.id, history[0]?.id);
  workflow = { ...workflow, steps: [{ ...rolled, index: 0 }] };
  const reverted = revertPatch(workflow, workflow.steps[0]!, { at: recordedAt + 200_000, runId: "run-3" });
  assert.equal(reverted.steps[0]?.history?.at(-1)?.source, "revert");
  assert.equal(reverted.steps[0]?.history?.[0]?.id, snap?.id);
  assert.deepEqual(reverted.steps[0]?.history?.[0], snap);
  workflow = { ...workflow, steps: [rolled] };
  assert.deepEqual(validateWorkflow(workflow), []);
  assert.equal(validate(workflow), true, ajv.errorsText(validate.errors));
  const result = await replay(workflow, {}, fake([tree([original])]), { heal: throwingHeal });
  assert.equal(result.status, "passed");
  assert.equal(result.heals.length, 0);
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(result.steps.map((item) => item.status), ["passed"]);
});

test("a cookie banner is dismissed for this run and the workflow file is unchanged", async () => {
  const workflow = doc([
    step({ id: "apply", action: "click", label: "Click Apply", identity: ident({ testId: "apply", text: "Apply" }) }),
  ], "wf-banner");
  const home = mkdtempSync(path.join(tmpdir(), "bao-banner-"));
  const library = new Library(home);
  library.save(workflow);
  const file = path.join(home, "workflows", "wf-banner.json");
  const hash = () => createHash("md5").update(readFileSync(file)).digest("hex");
  const before = hash();
  const saved = structuredClone(workflow);
  const banner = tree([
    ident({ role: "dialog", testId: "cookie-banner", text: "We use cookies" }),
    ident({ role: "button", testId: "accept-cookies", text: "Accept" }),
  ]);
  const open = tree([ident({ role: "button", testId: "apply", text: "Apply" })]);
  let proposed = 0;
  const result = await replay(workflow, {}, fake([banner, open]), {
    heal: { available: () => true, propose: async () => { proposed += 1; return null; } },
  });
  assert.equal(result.status, "passed");
  assert.equal(result.steps[0]?.reason, "recovered: cookie banner");
  assert.equal(result.heals.length, 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(proposed, 0);
  assert.equal(hash(), before);
  assert.deepEqual(workflow, saved);
});

test("captcha, a 5xx response, and a signed-out page stay failures", async () => {
  const workflow = doc([
    step({ id: "apply", action: "click", label: "Click Apply", identity: ident({ testId: "apply", text: "Apply" }) }),
  ]);
  let proposed = 0;
  const heal = { available: () => true, propose: async () => { proposed += 1; return null; } };
  const captcha = await replay(workflow, {}, fake([tree([ident({ role: "button", text: "Verify you are human", testId: "captcha" })])]), { heal });
  assert.equal(captcha.status, "failed");
  assert.equal(captcha.failure?.reason, "captcha");
  assert.equal(captcha.heals.length, 0);
  const driver = fake([tree([ident({ role: "button", text: "Elsewhere", testId: "other" })])]);
  driver.trace = () => ({ console: [], network: [{ url: "http://127.0.0.1/fixture", status: 503 }] });
  const down = await replay(workflow, {}, driver, { heal });
  assert.equal(down.status, "failed");
  assert.match(down.failure?.reason || "", /5xx/);
  const signedOut = await replay(workflow, {}, fake([tree([ident({ role: "heading", text: "You are signed out" })])]), { heal });
  assert.equal(signedOut.status, "failed");
  assert.equal(signedOut.failure?.reason, "signed-out");
  const login = await replay(workflow, {}, fake([tree([ident({ role: "button", testId: "login", text: "Log in" })])]), { heal });
  assert.notEqual(login.failure?.reason, "signed-out");
  assert.equal(proposed, 1);
  assert.equal(captcha.heals.length + down.heals.length + signedOut.heals.length, 0);
});

test("the fourth obstruction is a failure and is not healed", async () => {
  let cleared = true;
  let dismissals = 0;
  const clicks: string[] = [];
  const banner = tree([
    ident({ role: "dialog", testId: "cookie-banner", text: "We use cookies" }),
    ident({ role: "button", testId: "accept-cookies", text: "Accept" }),
  ]);
  const open = tree([ident({ role: "button", testId: "apply", text: "Apply" })]);
  const driver: Driver = {
    markStep: () => { cleared = false; },
    tree: async () => (cleared ? open : banner),
    snapshot: async () => ({ dom: "fixture" }),
    click: async (node) => {
      clicks.push(node.testId || node.text || node.role);
      if (node.testId === "accept-cookies") {
        cleared = true;
        dismissals += 1;
      }
    },
    fill: async () => {},
    key: async () => {},
    upload: async () => {},
    drop: async () => {},
    digits: async () => {},
    check: async () => {},
    notify: async () => {},
    sleep: async () => {},
  };
  const workflow = doc([1, 2, 3, 4].map((n) => step({
    id: `apply-${n}`,
    action: "click",
    label: "Click Apply",
    identity: ident({ testId: "apply", text: "Apply" }),
  })));
  let proposed = 0;
  const result = await replay(workflow, {}, driver, {
    heal: { available: () => true, propose: async () => { proposed += 1; return null; } },
  });
  assert.equal(dismissals, 3);
  assert.equal(proposed, 0);
  assert.equal(result.heals.length, 0);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.status, "failed");
  assert.deepEqual(result.steps.map((item) => item.status), ["passed", "passed", "passed", "failed"]);
  assert.equal(result.steps[3]?.reason, "cookie banner");
  assert.equal(result.steps[0]?.reason, "recovered: cookie banner");
});

test("the versions panel holds the locator versions and the run viewer keeps the recovered row", async () => {
  const at = Date.now() - 120_000;
  const home = mkdtempSync(path.join(tmpdir(), "bao-versions-locators-"));
  const library = new Library(home);
  let workflow = doc([
    step({ id: "apply", action: "click", label: "Click Apply", identity: ident({ testId: "apply", text: "Apply" }) }),
  ], "wf-history");
  workflow.createdAt = at;
  library.save(workflow);
  const once = keepPatch(workflow, "apply", { identity: ident({ testId: "apply-2", text: "Apply now" }) }, { at: at + 1000, runId: "run-1", score: 100 });
  draftVersion(library, once, "heal");
  const twice = keepPatch(once, "apply", { identity: ident({ testId: "apply-3", text: "Continue" }) }, { at: at + 2000, runId: "run-2", score: 88 });
  draftVersion(library, twice, "heal");
  const reverted = revertPatch(twice, {
    ...workflow.steps[0]!,
    history: twice.steps[0]?.history,
  }, { at: at + 3000, runId: "run-2" });
  draftVersion(library, reverted, "restore");
  const recorded = twice.steps[0]?.history?.[0];
  const rolled = {
    ...twice,
    steps: [rollbackTo(twice.steps[0]!, recorded!.id, { at: at + 4000, recordedAt: at })],
  };
  draftVersion(library, rolled, "restore");
  const html = versionsPanel(listVersions(library, "wf-history"));
  assert.match(html, /id="versions"/);
  assert.equal(html.includes("element-history"), false);
  assert.match(html, /data-locator-source="recorded"/);
  assert.match(html, /data-locator-source="heal"/);
  assert.match(html, /data-locator-source="revert"/);
  assert.match(html, /data-locator-source="rollback"/);
  assert.match(html, /data-score="100"/);
  assert.match(html, /data-score="88"/);
  assert.match(html, /run-1/);
  assert.match(html, /testId/);
  assert.ok(html.includes(formatClock(at + 1000)));
  assert.match(html, /Restore as draft/);
  const snap = structuredClone(versionDocument(library, "wf-history", 1));
  const restored = restoreVersion(library, "wf-history", 1);
  assert.deepEqual(versionDocument(library, "wf-history", 1), snap);
  assert.notEqual(restored.n, 1);
  assert.equal(restored.document.steps[0]?.identity?.testId, "apply");
  const result = await replay(restored.document, {}, fake([tree([ident({ testId: "apply", text: "Apply" })])]), { heal: throwingHeal });
  assert.equal(result.status, "passed");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.heals.length, 0);
  assert.equal(library.read("wf-history").steps[0]?.identity?.testId, "apply");
  const viewer = runViewer({
    id: "run-banner",
    workflowId: "wf-history",
    status: "passed",
    at,
    steps: [{ id: "apply", status: "passed", label: "Click Apply", reason: "recovered: cookie banner", startedAt: at, endedAt: at + 400 }],
  }, { name: "Fixture", steps: workflow.steps }, "apply");
  assert.equal(viewer.includes("element-history"), false);
  assert.match(viewer, /id="recovered-row">recovered: cookie banner</);
});
