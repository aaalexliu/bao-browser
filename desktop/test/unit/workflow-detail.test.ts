import { targetFor, testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { testChromium } from "../../src/test-browser.js";
import { applyHermeticApp } from "../runtime";
import { workflowDetail, libraryTable, type StepCard, type RunSummary, type ShellState } from "../../src/app/views";
import { clearConflict, noteConflict } from "../../src/v1/versions";

test("Inbox workflow detail keeps selection, inputs, history, and existing actions reachable", { timeout: 60_000 }, async () => {
  const dirs = applyHermeticApp("workflow-detail");
  const app = await startApp({ home: dirs.home, extensionHost: false, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  const name = `Set up the sign-in screen for 五秒 ${"A long workflow title ".repeat(12)}`;
  app.library.save(testWorkflow({
    schema: "bao.workflow/v4", id: "detail", name, createdAt: 1,
    startUrl: "https://example.test/", summary: "Sets up the sign-in screen.",
    inputs: [{ name: "appName", type: "text", label: "App name", supply: "saved", default: "五秒" }],
    steps: [
      {
        id: "open",
        index: 0,
        timeoutMs: 100,
        caption: { text: "Open the sign-in page" },
        action: "navigate",
        url: "https://example.test/",
      },
      {
        id: "name",
        index: 1,
        timeoutMs: 100,
        caption: { text: "Type the app name", citation: { text: "App name", source: "name" } },
        action: "type",
        target: {
          locators: [{ kind: "role", role: "textbox", name: "App name" }, { kind: "text", value: "App name" }],
          hint: { role: "textbox", surface: "dom" },
        },
        text: { input: "appName" },
        check: { kind: "text", match: "Saved", timeoutMs: 100 },
      },
    ],
  }));
  app.library.save(testWorkflow({ schema: "bao.workflow/v4", id: "empty-detail", name: "Empty workflow", createdAt: 1, startUrl: "/fixture", inputs: [], steps: [] }));
  app.library.saveRun({ id: "detail-run", workflowId: "detail", status: "passed", at: Date.now(), steps: [{ id: "open", status: "passed" }], heals: [] });
  let browser: Awaited<ReturnType<typeof testChromium.launch>> | undefined;
  try {
    browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
    const fixture = await browser.newPage();
    await fixture.goto(`http://127.0.0.1:${app.port}/fixture`);
    const shots = path.join(dirs.home, "shots", "workflows", "detail");
    mkdirSync(shots, { recursive: true });
    writeFileSync(path.join(shots, "name.png"), await fixture.screenshot());
    await fixture.close();
    for (const theme of ["light", "dark"]) for (const width of [1280, 720, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 860 } });
      await page.addInitScript((theme) => localStorage.setItem("bao-theme", theme), theme);
      await page.goto(`http://127.0.0.1:${app.port}/`);
      if (width <= 1060) await page.locator("#sidebar-toggle").click();
      await page.locator("#rail [data-place=workflows]").click();
      await page.locator('[data-open-workflow="detail"]').click();
      await page.locator("#workflow-detail").waitFor();
      assert.equal(await page.locator(".wf-head h2").innerText(), name.trim());
      assert.equal(await page.locator("#screen-list").isVisible(), false);
      assert.equal(await page.locator("#workflow-detail .ph").count(), 0);
      assert.equal(await page.locator("#workflow-detail .wf-picture:visible").count(), 0);
      assert.equal(await page.locator("#workflow-step-help").count(), 1);
      assert.equal(await page.locator(".wf-steps tbody tr").count(), 2);
      assert.equal(await page.locator("#workflow-inputs h3").innerText(), "Inputs · 1, asked before each run");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const title = (await page.locator(".wf-head h2").boundingBox())!;
      assert.ok(title.x >= 0 && title.x + title.width <= width);
      await page.locator('[data-workflow-step="name"]').click();
      assert.equal(await page.locator('[data-workflow-step="name"]').getAttribute("aria-pressed"), "true");
      assert.equal(await page.locator('[data-step-panel="open"]').isVisible(), false);
      assert.equal(await page.locator('[data-step-panel="name"]').isVisible(), true);
      await page.locator('[data-step-panel="name"] .wf-picture img').waitFor();
      assert.equal(await page.locator('[data-step-panel="name"] .wf-picture img').evaluate((image) => (image as HTMLImageElement).naturalWidth > 96), true);
      assert.match(await page.locator('[data-step-panel="name"]').innerText(), /The page shows “Saved”/);
      assert.equal(await page.locator("[data-step-heal]:visible").count(), 1);
      await page.locator('[data-step-heal="name"]').selectOption("ask");
      await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('[data-step-heal="name"]')?.value === "ask");
      assert.equal(await page.locator('[data-workflow-step="name"]').getAttribute("aria-pressed"), "true");
      await page.locator("#workflow-edit-inputs").click();
      assert.equal(await page.locator("#workflow-inputs [data-edit-input]").evaluate((el) => el === document.activeElement), true);
      await page.locator("#workflow-inputs [data-edit-input]").click();
      await page.locator("#input-editor").waitFor();
      assert.equal(await page.locator('#input-editor [name="default"]').inputValue(), "五秒");
      await page.locator('#input-editor [name="default"]').fill("五秒 edited");
      await page.locator("[data-save-input]").click();
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#workflow-inputs [data-edit-input]')?.dataset.default === "五秒 edited");
      assert.equal(app.library.read("detail").inputs[0]?.default, "五秒 edited");
      await page.locator("#workflow-inputs [data-edit-input]").click();
      await page.locator('#input-editor [name="default"]').fill("五秒");
      await page.locator("[data-save-input]").click();
      await page.waitForFunction(() => document.querySelector<HTMLButtonElement>('#workflow-inputs [data-edit-input]')?.dataset.default === "五秒");
      await page.locator("#workflow-options > summary").click();
      await page.locator("#workflow-edit summary").click();
      assert.match(await page.locator("#edit-json").inputValue(), /Type the app name/);
      await page.locator('[data-testid="share-open"]').click();
      assert.equal(await page.locator('[data-testid="share-copy"]').isVisible(), true);
      await page.locator("#workflow-options > summary").click();
      assert.equal(await page.locator("[data-guide]").isVisible(), true);
      await page.locator('[data-step-panel="name"] [data-run-from]').click();
      await page.locator("#run-form").waitFor();
      assert.match(await page.locator("#run-form").innerText(), /Run from step 2/);
      await page.close();
    }
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    page.setDefaultTimeout(15_000);
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.locator("#rail [data-place=workflows]").click();
    await page.route("**/api/workflows/detail", (route) => route.fulfill({ status: 404, body: "{}" }));
    await page.locator('[data-open-workflow="detail"]').click();
    await page.getByRole("heading", { name: "This workflow can’t open" }).waitFor();
    await page.unroute("**/api/workflows/detail");
    await page.locator("#workflow-retry").click();
    await page.locator("#workflow-detail").waitFor();
    await page.locator('.wf-recent [data-open-run="detail-run"]').click();
    await page.locator("#run-receipt").waitFor();
    await page.locator("#rail [data-place=workflows]").click();
    await page.locator('[data-open-workflow="empty-detail"]').click();
    await page.getByText("No steps yet", { exact: true }).waitFor();
    assert.match(await page.locator(".wf-recent").innerText(), /No runs yet/);
    assert.equal(await page.locator("#workflow-edit-inputs").isDisabled(), true);
    await page.getByRole("button", { name: "Back to all workflows" }).click();
    await page.locator("#workflow-list").waitFor();
    await page.setViewportSize({ width: 720, height: 860 });
    await page.evaluate(() => { document.documentElement.dataset.baoNative = "true"; });
    for (const action of ["keep-mine", "keep-theirs", "keep-both"]) {
      const mine = { ...app.library.read("detail"), id: "conflicted", name: "Conflicted workflow" };
      app.library.save(mine);
      noteConflict(app.library, { mine, theirs: { ...mine, name: "Remote workflow" }, mineDevice: "This Mac", theirsDevice: "Other Mac", remoteVersion: 2 });
      await page.reload();
      await page.locator("#sidebar-toggle").click();
      await page.locator("#rail [data-place=workflows]").click();
      await page.locator('[data-open-workflow="conflicted"]').click();
      await page.getByTestId("conflict-banner").waitFor();
      assert.equal(await page.locator("#workflow-options").evaluate((element) => (element as HTMLDetailsElement).open), false);
      assert.equal(await page.getByTestId("conflict-diff").isVisible(), true);
      for (const button of ["keep-mine", "keep-theirs", "keep-both"]) assert.equal(await page.getByTestId(button).isVisible(), true);
      assert.equal(await page.locator("#versions").isVisible(), false);
      let resolved = false;
      await page.route("**/api/sync/conflict", async (route) => {
        assert.deepEqual(route.request().postDataJSON(), { id: "conflicted", action });
        clearConflict(app.library, "conflicted");
        resolved = true;
        await route.fulfill({ json: {} });
      });
      await page.getByTestId(action).click();
      await page.getByTestId("conflict-banner").waitFor({ state: "detached" });
      assert.equal(resolved, true);
      await page.unroute("**/api/sync/conflict");
      await page.getByRole("button", { name: "Back to all workflows" }).click();
    }
    await page.locator('[data-open-workflow="empty-detail"]').click();
    for (const id of ["detail", "empty-detail", "detail"]) {
      await page.locator("#workflow-search").click();
      await page.locator("#palette-input").fill(id === "detail" ? "Open Set up" : "Open Empty");
      await page.locator(`[data-command="open-${id}"]`).click();
      await page.locator(`#workflow-detail[data-workflow="${id}"]`).waitFor();
      assert.equal(await page.locator("#sidebar-toggle").count(), 1);
      await page.locator("#sidebar-toggle").click();
      await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
    }
    await page.getByRole("button", { name: "Back to all workflows" }).click();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/workflows/detail", async (route) => { await pending; await route.fulfill({ status: 404, body: "{}" }); });
    await page.locator('[data-open-workflow="detail"]').click();
    await page.getByText("Loading workflow…", { exact: true }).waitFor();
    await page.locator("#sidebar-toggle").click();
    await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
    release();
    await page.getByRole("heading", { name: "This workflow can’t open" }).waitFor();
    await page.locator("#sidebar-toggle").click();
    await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
    await page.unroute("**/api/workflows/detail");
    await page.locator("#workflow-retry").click();
    await page.locator("#workflow-detail").waitFor();
    await page.locator("#sidebar-toggle").click();
    await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
    for (const theme of ["light", "dark"]) {
      const colors = await page.evaluate((theme) => {
        localStorage.setItem("bao-theme", theme);
        document.documentElement.dataset.theme = theme;
        return {
          app: getComputedStyle(document.getElementById("app")!).backgroundColor,
          content: getComputedStyle(document.getElementById("content")!).backgroundColor,
        };
      }, theme);
      assert.equal(colors.app, colors.content);
    }
  } finally {
    await browser?.close();
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});

test("workflow loading and retry stay in the current visit across state polls", { timeout: 30_000 }, async () => {
  const dirs = applyHermeticApp("workflow-detail-polls");
  const app = await startApp({ home: dirs.home, extensionHost: false, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  app.library.save(testWorkflow({ schema: "bao.workflow/v4", id: "poll-detail", name: "Poll detail", createdAt: 1, startUrl: "/fixture", inputs: [], steps: [] }));
  let browser: Awaited<ReturnType<typeof testChromium.launch>> | undefined;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  try {
    browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
    const page = await browser.newPage();
    let revision = 0;
    await page.route("**/api/state", async (route) => {
      const response = await route.fetch();
      const state = await response.json() as ShellState;
      await route.fulfill({ json: { ...state, remote: { phase: "running", workflowName: `Background request ${revision}` } } });
    });
    let requests = 0;
    await page.route("**/api/workflows/poll-detail", async (route) => {
      requests += 1;
      await pending;
      await route.fulfill({ status: 404, body: "{}" });
    });
    await page.goto(`http://127.0.0.1:${app.port}/`);
    await page.locator("#rail [data-place=workflows]").click();
    await page.locator('[data-open-workflow="poll-detail"]').click();
    await page.getByText("Loading workflow…", { exact: true }).waitFor();
    const host = await page.locator("#workflow-host").elementHandle();
    const poll = async () => {
      revision += 1;
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await page.getByTestId("remote-running").filter({ hasText: `Background request ${revision}` }).waitFor();
    };
    await poll();
    // The remote banner proves a changed state rendered without a second workflow request.
    assert.equal(await host!.evaluate((node) => node.isConnected), true);
    assert.equal(requests, 1);
    release();
    await page.getByRole("heading", { name: "This workflow can’t open" }).waitFor();
    const retry = page.locator("#workflow-retry");
    await retry.focus();
    await poll();
    assert.equal(await retry.evaluate((node) => node === document.activeElement), true);
    assert.equal(requests, 1, "polling must not retry a failed workflow on the user's behalf");
    await page.unroute("**/api/workflows/poll-detail");
    await poll();
    await retry.click();
    await page.locator('#workflow-detail[data-workflow="poll-detail"]').waitFor();
    await poll();
    assert.equal(await page.locator('#workflow-detail[data-workflow="poll-detail"]').count(), 1);
    await page.getByRole("button", { name: "Back to all workflows" }).click();
    await page.locator("#workflow-list").waitFor();
    await page.locator('[data-open-workflow="poll-detail"]').click();
    await page.locator('#workflow-detail[data-workflow="poll-detail"]').waitFor();
  } finally {
    release();
    await browser?.close();
    await app.close();
    rmSync(path.dirname(dirs.home), { recursive: true, force: true });
  }
});

test("step facts reflect replay checks, destinations, and action-specific input use", async () => {
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const inputs = [{ name: "file", label: "Report file", type: "text" as const }];
    const cases: { step: StepCard; checks: string[] }[] = [
      { step: { id: "settled", check: { kind: "settled" } }, checks: ["The page finishes loading"] },
      { step: { id: "url", check: { kind: "url", match: "https://example.test/{{file}}" } }, checks: ["The address matches “https://example.test/” followed by the Report file input"] },
      { step: { id: "url-exact", check: { kind: "url", match: "{{file}}" } }, checks: ["The address matches the Report file input"] },
      { step: { id: "text", check: { kind: "text", match: "Saved {{file}}" } }, checks: ["The page matches “Saved ” followed by the Report file input"] },
      { step: { id: "text-exact", check: { kind: "text", match: "{{file}}" } }, checks: ["The page matches the Report file input"] },
      { step: { id: "value", check: { kind: "value", match: "{{file}}" } }, checks: ["The value matches the Report file input"] },
      { step: { id: "value-embedded", check: { kind: "value", match: "File: {{file}}!" } }, checks: ["The value matches “File: ” followed by the Report file input followed by “!”"] },
      { step: { id: "literal-label", check: { kind: "value", match: "Report file" } }, checks: ["The value shows “Report file”"] },
      { step: { id: "element", check: { kind: "element", locators: [{ role: "button", name: "Open" }] } }, checks: ["The “saved control” is on the page"] },
      { step: { id: "absent", check: { kind: "absent", locators: [{ value: "Login" }] } }, checks: ["The “saved control” is gone"] },
      { step: { id: "read-exact", readBack: { source: "value", match: "{{file}}" } }, checks: ["Reads value matching the Report file input"] },
      { step: { id: "read-embedded", readBack: { source: "text", match: "Saved {{file}}" } }, checks: ["Reads text matching “Saved ” followed by the Report file input"] },
      { step: { id: "read-literal", readBack: { source: "url", match: "https://example.test/" } }, checks: ["Reads url matching “https://example.test/”"] },
      { step: { id: "multiple", check: { kind: "text", match: "{{file}} / {{file}}" } }, checks: ["The page matches the Report file input followed by “ / ” followed by the Report file input"] },
      { step: { id: "unknown", check: { kind: "value", match: "{{missing}}" } }, checks: ["The value matches the saved input"] },
      { step: { id: "combined", check: { kind: "text", match: "Saved {{file}}" }, readBack: { source: "value", match: "{{file}}" } }, checks: ["The page matches “Saved ” followed by the Report file input", "Reads value matching the Report file input"] },
    ];
    for (const { step, checks } of cases) {
      await page.setContent(workflowDetail({ id: "facts", name: "Facts", inputs, steps: [{ ...step, action: "type", caption: { text: "Use {{file}}" } }] }));
      const facts = await page.locator(".wf-facts").innerText();
      for (const check of checks) assert.ok(facts.includes(check), facts);
      assert.equal(facts.includes("{{"), false);
      assert.equal(facts.includes("Nothing extra"), false);
      assert.equal(await page.locator("td.wf-check > span").count(), 1);
      assert.equal(await page.locator(".wf-picture").getAttribute("data-shot-alt"), "Saved page for step 1: Use Report file");
    }
    for (const [action, verb] of Object.entries({ type: "Types", digits: "Types", select: "Picks", upload: "Uploads", drop: "Drops", navigate: "Opens", click: "Uses" })) {
      const usesFile = action === "upload" || action === "drop" ? { file: { input: "file" } } : { text: { input: "file" } };
      await page.setContent(workflowDetail({ id: "verbs", name: "Verbs", inputs, startUrl: "https://example.test/start", steps: [{ id: "one", action, ...usesFile, url: "https://example.test/next" }] }));
      assert.ok((await page.locator(".wf-facts dt").allTextContents()).includes(verb));
      if (action === "navigate") assert.equal(await page.locator(".wf-facts dd").first().innerText(), "https://example.test/next");
    }
    await page.setContent(workflowDetail({ id: "fallback", name: "Fallback", startUrl: "https://example.test/start", steps: [{ id: "one", action: "navigate" }] }));
    assert.equal(await page.locator(".wf-facts dd").first().innerText(), "https://example.test/start");
    for (const status of ["passed", "failed", "paused", "timed-out", "healed", "provisional"]) {
      const run: RunSummary = { id: "run", workflowId: "glyph", status: status === "healed" || status === "provisional" ? "passed" : status, ...(status === "healed" ? { heals: [{ id: "heal" }] } : {}), ...(status === "provisional" ? { promotion: { status: "provisional" } } : {}) };
      const doc = { id: "glyph", name: "Glyph", steps: [] };
      await page.setContent(libraryTable([{ ...doc, steps: 0 }], [run]) + workflowDetail(doc, { runs: [run] }));
      const listGlyph = await page.locator("#workflow-list .workflow-status-icon").innerHTML();
      for (const glyph of await page.locator("#workflow-detail .workflow-status-icon").all()) assert.equal(await glyph.innerHTML(), listGlyph, status);
    }
  } finally {
    await browser.close();
  }
});

test("Finds names the control in words and never shows a css or xpath selector", () => {
  const finds = (step: StepCard) => workflowDetail({ id: "finds", name: "Finds", steps: [step] }).match(/<dt>Finds<\/dt><dd>([^<]*)<\/dd>/)?.[1];
  assert.equal(finds({ id: "css", action: "click", target: { locators: [{ kind: "css", value: "header > button:nth-of-type(2)" }, { kind: "role", role: "button", name: "Save" }] } }), "The “Save” button");
  assert.equal(finds({ id: "xpath", action: "click", target: { locators: [{ kind: "xpath", value: "//*[@id=\"x\"]" }, { kind: "text", value: "Continue" }] } }), "The “Continue” control");
  assert.equal(finds({ id: "cite", action: "type", caption: { text: "Type into Email", citation: { text: "Email" } }, target: { locators: [{ kind: "css", value: "#username" }], hint: { role: "textbox" } } }), "The “Email” box");
  assert.equal(finds({ id: "bare", action: "click", target: { locators: [{ kind: "css", value: "#username" }, { kind: "testid", value: "login-btn" }] } }), "No saved target");
});

test("the Inspector zooms a boxed step picture around its target and keeps the mark on it", { timeout: 60_000 }, async () => {
  const dirs = applyHermeticApp("workflow-zoom");
  const app = await startApp({ home: dirs.home, extensionHost: false, chromeProfilesRoot: path.join(dirs.home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const fixture = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await fixture.goto(`http://127.0.0.1:${app.port}/fixture`);
    await fixture.evaluate(() => {
      for (const [id, x, y] of [["top-left", 110, 140], ["center", 620, 400], ["bottom-right", 1240, 790]] as const) {
        const button = document.createElement("button");
        button.id = id;
        button.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:36px;height:20px`;
        document.body.append(button);
      }
    });
    const targets = await Promise.all(["username", "top-left", "center", "bottom-right"].map(async (id) => ({ id, box: (await fixture.locator(`#${id}`).boundingBox())! })));
    const shots = path.join(dirs.home, "shots", "workflows", "zoom");
    mkdirSync(shots, { recursive: true });
    const png = await fixture.screenshot();
    for (const { id } of targets) {
      writeFileSync(path.join(shots, `${id}.png`), png);
      writeFileSync(path.join(shots, `${id}.viewport.png`), png);
    }
    await fixture.close();
    app.library.save(testWorkflow({
      id: "zoom", name: "Zoom", startUrl: "/fixture",
      steps: targets.map(({ id, box }, index) => ({
        id, index, action: "click", timeoutMs: 100,
        caption: { text: `Click ${id}`, targetBox: { ...box, viewport: { width: 1280, height: 820 } } },
        target: targetFor({ surface: "dom", path: [], role: "button", id }),
      })),
    }));
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await page.addInitScript((theme) => localStorage.setItem("bao-theme", theme), theme);
      await page.goto(`http://127.0.0.1:${app.port}/`);
      await page.locator("#rail [data-place=workflows]").click();
      await page.locator('[data-open-workflow="zoom"]').click();
      for (const { id, box } of targets) {
        await page.locator(`[data-workflow-step="${id}"]`).click();
        const picture = page.locator(`[data-step-panel="${id}"] .wf-picture`);
        await picture.locator(".shot-box").waitFor();
        const frame = (await picture.boundingBox())!;
        const image = (await picture.locator("img").boundingBox())!;
        const mark = (await picture.locator(".shot-box").boundingBox())!;
        assert.ok(image.width > frame.width * 1.5, `the picture is not zoomed: ${image.width} in ${frame.width}`);
        assert.ok(Math.abs(frame.width / frame.height - 1280 / 820) < 0.02);
        const scale = image.width / 1280;
        if (box.width <= 36) assert.ok(scale >= 0.8, `the control is too small to read: scale ${scale}`);
        assert.deepEqual(await picture.evaluate((node) => {
          const style = getComputedStyle(node);
          return { border: style.borderTopWidth, radius: style.borderTopLeftRadius };
        }), { border: "1px", radius: "6px" }, theme);
        assert.ok(Math.abs((mark.x - image.x) / scale - box.x) < 3, `${theme} ${id}`);
        assert.ok(Math.abs((mark.y - image.y) / scale - box.y) < 3, `${theme} ${id}`);
        assert.ok(Math.abs(mark.width / scale - box.width) < 3, `${theme} ${id}`);
        assert.ok(mark.x >= frame.x && mark.x + mark.width <= frame.x + frame.width, `${theme} ${id}`);
        assert.ok(mark.y >= frame.y && mark.y + mark.height <= frame.y + frame.height, `${theme} ${id}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
    await app.close();
  }
});
