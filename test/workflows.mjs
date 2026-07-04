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
