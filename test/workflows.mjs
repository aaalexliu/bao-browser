// T14 regression: IR alignment + named workflows.
// A recording becomes a first-class Workflow {id,name,version,startUrl,variables,steps}
// with per-step id/index. Save two named workflows, list them, then replay the SECOND
// by id — from a tab parked on a DIFFERENT page, so the run must navigate to the
// workflow's startUrl first, then drive its steps. Delete removes one.
//
// Run: npm run test:workflows   (or: node test/workflows.mjs)
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const FIXTURE = pathToFileURL(resolve(__dirname, "fixture.html")).href;

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  const ctx = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: !process.env.HEADED && !process.argv.includes("--headed") && !process.argv.includes("-H"),
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`],
  });

  async function liveSw() {
    for (const sw of ctx.serviceWorkers()) {
      try { await sw.evaluate(() => 1); return sw; } catch (_) {}
    }
    return ctx.waitForEvent("serviceworker", { timeout: 10_000 });
  }
  const swEval = async (fn, arg) => (await liveSw()).evaluate(fn, arg);
  const sendToContent = (sw, tabId, msg) =>
    sw.evaluate(([id, m]) => chrome.tabs.sendMessage(id, m), [tabId, msg]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitForPhase(phases, timeout = 15_000) {
    const start = Date.now();
    for (;;) {
      const run = await swEval(() => self.baoRunStatus());
      if (run && phases.includes(run.phase)) return run;
      if (Date.now() - start > timeout) return run;
      await sleep(200);
    }
  }

  try {
    const sw = await liveSw();
    const page = await ctx.newPage();
    await page.goto(FIXTURE);
    await page.waitForLoadState("domcontentloaded");
    const tabId = await swEval(async (url) => {
      const [t] = await chrome.tabs.query({ url });
      return t?.id ?? null;
    }, FIXTURE);
    check("fixture tab found", tabId != null, `tabId=${tabId}`);

    // ---- Record + save Workflow A (email only) ----
    await sendToContent(sw, tabId, { cmd: "start-record" });
    await page.fill("#email", "ada@example.com");
    const { steps: stepsA } = await sendToContent(sw, tabId, { cmd: "stop-record" });
    const saveA = await swEval(({ steps }) =>
      self.baoSaveWorkflow("Sign in", steps.find((s) => s.frame?.url)?.frame?.url || "", steps),
      { steps: stepsA });
    check("workflow A saved with an id", !!saveA?.id, saveA?.id);

    // ---- Record + save Workflow B (bio + submit) ----
    await sendToContent(sw, tabId, { cmd: "start-record" });
    await page.fill("#bio", "Hello from workflow B");
    await page.click('[data-testid="submit-btn"]');
    const { steps: stepsB } = await sendToContent(sw, tabId, { cmd: "stop-record" });
    const saveB = await swEval(({ steps }) =>
      self.baoSaveWorkflow("Post bio", steps.find((s) => s.frame?.url)?.frame?.url || "", steps),
      { steps: stepsB });
    check("workflow B saved with an id", !!saveB?.id, saveB?.id);

    // ---- List: two named workflows, IR-shaped ----
    const list = await swEval(() => self.baoListWorkflows());
    check("two workflows listed", list?.length === 2, JSON.stringify(list?.map((w) => w.name)));
    check("names + counts present", list?.some((w) => w.name === "Sign in") &&
      list?.some((w) => w.name === "Post bio" && w.count === 2), JSON.stringify(list));
    // The stored workflow carries the IR wrapper + per-step id/index.
    const wfB = await swEval((id) => (async () => {
      const all = (await chrome.storage.local.get("baoWorkflows")).baoWorkflows;
      return all[id];
    })(), saveB.id);
    check("workflow B is IR-shaped (version/startUrl/variables)",
      wfB?.version === 1 && typeof wfB?.startUrl === "string" && Array.isArray(wfB?.variables),
      JSON.stringify({ version: wfB?.version, startUrl: wfB?.startUrl, variables: wfB?.variables }));
    check("steps gained id + index", wfB?.steps?.every((s, i) => s.index === i && !!s.id),
      JSON.stringify(wfB?.steps?.map((s) => ({ id: s.id, index: s.index }))));

    // ---- Replay B BY ID from a tab parked elsewhere → must navigate to startUrl first ----
    await page.goto("about:blank");
    await page.waitForLoadState("domcontentloaded");
    const runRes = await swEval(({ id, tabId }) => self.baoRunWorkflow(tabId, id), { id: saveB.id, tabId });
    check("run started", runRes?.ok === true && !!runRes?.runId, JSON.stringify(runRes));

    const run = await waitForPhase(["done", "failed"]);
    check("workflow B run completed", run?.phase === "done", JSON.stringify(run?.lastError || run?.phase));
    check("navigated back to the workflow's startUrl", page.url().startsWith(FIXTURE.split("#")[0]) ||
      page.url().endsWith("fixture.html"), page.url());
    check("B's steps applied on the right page (bio filled)",
      (await page.inputValue("#bio")) === "Hello from workflow B", await page.inputValue("#bio"));
    check("B's submit click fired", (await page.evaluate(() =>
      (window.__events || []).some((e) => e.detail === "submit-btn"))) === true);

    // ---- Delete A → only B remains ----
    await swEval((id) => self.baoDeleteWorkflow(id), saveA.id);
    const after = await swEval(() => self.baoListWorkflows());
    check("delete removed workflow A", after?.length === 1 && after[0].name === "Post bio",
      JSON.stringify(after?.map((w) => w.name)));

    // ============================ T15 — SW/protocol ============================
    // ---- bao-wf-get returns the full workflow (steps included) ----
    const full = await swEval((id) => self.baoGetWorkflow(id), saveB.id);
    check("bao-wf-get returns full steps", full?.id === saveB.id && full?.steps?.length === 2,
      JSON.stringify({ id: full?.id, steps: full?.steps?.length }));
    check("bao-wf-get miss returns null", (await swEval(() => self.baoGetWorkflow("wf-nope"))) === null);

    // ---- bao-wf-update: rename + pin round-trip; createdAt immutable ----
    const upd = await swEval((id) => self.baoUpdateWorkflow(id, { name: "Post bio v2", pinned: true }), saveB.id);
    const updated = await swEval((id) => self.baoGetWorkflow(id), saveB.id);
    check("rename + pin round-trip", upd?.ok === true && updated?.name === "Post bio v2" &&
      updated?.pinned === true && typeof updated?.updatedAt === "number",
      JSON.stringify({ name: updated?.name, pinned: updated?.pinned, updatedAt: updated?.updatedAt }));
    check("createdAt immutable on update", updated?.createdAt === full?.createdAt);
    const listPinned = await swEval(() => self.baoListWorkflows());
    check("summary mirrors pinned + updatedAt", listPinned?.some((w) =>
      w.id === saveB.id && w.pinned === true && typeof w.updatedAt === "number"), JSON.stringify(listPinned));
    check("update on unknown id is not ok",
      (await swEval(() => self.baoUpdateWorkflow("wf-nope", { name: "x" })))?.ok === false);

    // ---- bao-wf-import: fresh id every time, pinned stripped ----
    const imp1 = await swEval((wf) => self.baoImportWorkflow(wf), updated);
    const imp2 = await swEval((wf) => self.baoImportWorkflow(wf), updated);
    check("import assigns fresh ids (same payload twice → two ids)",
      imp1?.ok === true && imp2?.ok === true && imp1.id !== imp2.id && imp1.id !== saveB.id,
      JSON.stringify({ imp1: imp1?.id, imp2: imp2?.id }));
    const imported = await swEval((id) => self.baoGetWorkflow(id), imp1.id);
    check("import strips pinned + re-derives step ids", imported?.pinned === undefined &&
      imported?.steps?.every((s, i) => s.index === i && s.id?.startsWith(imp1.id)),
      JSON.stringify({ pinned: imported?.pinned, ids: imported?.steps?.map((s) => s.id) }));

    // ---- auto-save on stop (the data-loss fix): record via the SW rec state ----
    await swEval((id) => self.baoRecStart(id), tabId);
    await page.fill("#email", "auto@example.com");
    await page.click('[data-testid="submit-btn"]');
    await sleep(600); // let the streamed bao-step messages land in session storage
    const stopRes = await swEval(() => self.baoRecStop());
    check("stop auto-saved a workflow", stopRes?.workflow?.id != null && stopRes.workflow.count === 2,
      JSON.stringify(stopRes?.workflow));
    check("generated name (file:// has no hostname → Recording — …)",
      /^Recording — /.test(stopRes?.workflow?.name || ""), stopRes?.workflow?.name);
    check("auto-saved startUrl comes from the first step's frame",
      (stopRes?.workflow?.startUrl || "").endsWith("fixture.html"), stopRes?.workflow?.startUrl);
    const listAuto = await swEval(() => self.baoListWorkflows());
    check("auto-saved workflow persisted", listAuto?.some((w) => w.id === stopRes.workflow.id));

    // ---- zero-step stop saves nothing ----
    await swEval((id) => self.baoRecStart(id), tabId);
    const stopEmpty = await swEval(() => self.baoRecStop());
    check("zero-step stop returns no workflow", stopEmpty?.workflow === null && stopEmpty?.steps?.length === 0,
      JSON.stringify(stopEmpty));
    const listFinal = await swEval(() => self.baoListWorkflows());
    check("zero-step stop persisted nothing", listFinal?.length === listAuto?.length,
      `${listFinal?.length} vs ${listAuto?.length}`);

    // ============================ T16 — run history ============================
    // The workflow-B run near the top should have persisted a durable RunRecord (the
    // only run executed so far). It snapshots the name at run time — which was "Post
    // bio", BEFORE the rename to "Post bio v2" — proving history survives a rename.
    const runsList = await swEval(() => self.baoListRuns());
    check("run history recorded the completed run", runsList?.length === 1,
      JSON.stringify(runsList?.map((r) => r.outcome)));
    const brec = runsList?.[0];
    check("record attributed to B, outcome passed, one result per step",
      brec?.workflowId === saveB.id && brec?.outcome === "passed" && brec?.results?.length === 2,
      JSON.stringify({ wf: brec?.workflowId, outcome: brec?.outcome, results: brec?.results?.length }));
    check("record snapshots steps + a frame slot per step",
      brec?.steps?.length === 2 && brec?.frames?.length === 2,
      JSON.stringify({ steps: brec?.steps?.length, frames: brec?.frames?.length }));
    check("record id matches the run id", brec?.id === runRes.runId, `${brec?.id} vs ${runRes.runId}`);
    check("name denormalized at run time (survives the later rename)", brec?.workflowName === "Post bio",
      brec?.workflowName);
    const got = await swEval((id) => self.baoGetRun(id), runRes.runId);
    check("baoGetRun round-trips the record", got?.id === runRes.runId);
    check("baoListRuns filters by workflowId",
      (await swEval((id) => self.baoListRuns(id), saveB.id))?.length === 1 &&
      (await swEval(() => self.baoListRuns("wf-nope")))?.length === 0);

    // A failing ad-hoc run persists too, with outcome "failed" and an empty workflowId.
    await page.goto(FIXTURE);
    await page.waitForLoadState("domcontentloaded");
    const badStep = { action: "click", label: "nope", ts: Date.now(),
      target: { selectors: [{ type: "css", value: "#definitely-not-here", score: 1 }], reach: "light", unique: true } };
    const badRun = await swEval(({ id, step }) => self.baoRunStart(id, [step]), { id: tabId, step: badStep });
    await waitForPhase(["failed"]);
    const badRec = await swEval((id) => self.baoGetRun(id), badRun.runId);
    check("failed run persisted with outcome failed", badRec?.outcome === "failed",
      JSON.stringify({ outcome: badRec?.outcome }));
    check("ad-hoc run has empty workflowId + a generated name",
      badRec?.workflowId === "" && typeof badRec?.workflowName === "string", badRec?.workflowName);

    // Delete one record, then clear all.
    await swEval((id) => self.baoDeleteRun(id), runRes.runId);
    check("baoDeleteRun removes the record",
      (await swEval((id) => self.baoGetRun(id), runRes.runId)) === null);
    await swEval(() => self.baoClearRuns());
    check("baoClearRuns empties history", (await swEval(() => self.baoListRuns()))?.length === 0);

    // ============================ T16 — light step editing ============================
    // bao-wf-update-steps: delete + reorder only, ids are identity, index re-derived,
    // and only value/assert may change. saveB has 2 steps: [input(bio), click(submit)].
    const wfEdit = await swEval((id) => self.baoGetWorkflow(id), saveB.id);
    const [inStep, clickStep] = wfEdit.steps; // inStep = input, clickStep = submit click
    const baseVersion = wfEdit.version;

    // Reorder → ids preserved, index re-derived from position, version bumped.
    const r1 = await swEval(({ id, steps }) => self.baoUpdateWorkflowSteps(id, steps),
      { id: saveB.id, steps: [clickStep, inStep] });
    const reordered = await swEval((id) => self.baoGetWorkflow(id), saveB.id);
    check("reorder preserves ids + re-derives index",
      r1?.ok === true && reordered.steps[0].id === clickStep.id && reordered.steps[1].id === inStep.id &&
      reordered.steps.every((s, i) => s.index === i),
      JSON.stringify(reordered.steps.map((s) => ({ id: s.id, index: s.index }))));
    check("version bumped on a step edit", reordered.version === baseVersion + 1);

    // Value edit on the input step; the click's action/target are copied from storage.
    const edited = reordered.steps.map((s) => (s.id === inStep.id ? { ...s, value: "EDITED", action: "navigate" } : s));
    await swEval(({ id, steps }) => self.baoUpdateWorkflowSteps(id, steps), { id: saveB.id, steps: edited });
    const afterEdit = await swEval((id) => self.baoGetWorkflow(id), saveB.id);
    check("value edit persists on the input step",
      afterEdit.steps.find((s) => s.id === inStep.id)?.value === "EDITED");
    check("action is copied from storage, not the payload (tamper ignored)",
      afterEdit.steps.find((s) => s.id === inStep.id)?.action === "input");

    // Rejections: fabricated id, duplicate id, unknown workflow.
    check("fabricated step id rejected",
      (await swEval((id) => self.baoUpdateWorkflowSteps(id,
        [{ id: "nope", action: "click", label: "x", ts: 1 }]), saveB.id))?.ok === false);
    check("duplicate step id rejected",
      (await swEval(({ id, s }) => self.baoUpdateWorkflowSteps(id, [s, s]),
        { id: saveB.id, s: afterEdit.steps[0] }))?.ok === false);
    check("update-steps on unknown workflow not ok",
      (await swEval(() => self.baoUpdateWorkflowSteps("wf-nope", [])))?.ok === false);

    // Delete → the new list is the kept subset, index re-derived.
    await swEval(({ id, s }) => self.baoUpdateWorkflowSteps(id, [s]),
      { id: saveB.id, s: afterEdit.steps[0] });
    const afterDel = await swEval((id) => self.baoGetWorkflow(id), saveB.id);
    check("delete reduces to the kept subset",
      afterDel.steps.length === 1 && afterDel.steps[0].id === afterEdit.steps[0].id && afterDel.steps[0].index === 0,
      JSON.stringify(afterDel.steps.map((s) => s.id)));
  } finally {
    await ctx.close();
  }
}

main()
  .then(() => {
    console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error("\n✗ harness error:", e);
    process.exit(1);
  });
