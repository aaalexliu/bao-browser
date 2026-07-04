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
    headless: !process.env.HEADED,
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
