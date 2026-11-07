import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { shellPlaces, shellScreen, shellScreens, type Screen } from "../../src/app/shell-navigation";
import { commandItems, rail, shellList, type ShellState } from "../../src/app/views";
import { testChromium } from "../../src/test-browser";
import type { WorkflowV2 } from "../../src/v1/schema";

const routes = [
  ["runs", "runs", "Runs"], ["live", "runs", "Live session"], ["heals", "runs", "Heals"],
  ["library", "workflows", "Library"], ["capture", "workflows", "Capture"],
  ["teach", "workflows", "Teach"], ["replay", "workflows", "Run"],
  ["settings", "settings", "Settings"], ["logins", "settings", "Logins"],
] as const;

test("three places keep all nine screens and their detail routes reachable", () => {
  assert.deepEqual(shellPlaces.map((place) => place.label), ["Runs", "Workflows", "Settings"]);
  assert.equal(Object.keys(shellScreens).length, 9);
  for (const [screen, place] of routes) {
    assert.equal(shellScreens[screen].place, place);
    assert.match(rail({}, screen), new RegExp(`data-place="${place}"[^>]*aria-current="page"`));
    if (screen === "library") assert.equal(shellList(screen, {}), "");
    else assert.match(shellList(screen, {}), new RegExp(`data-screen="${screen}"[^>]*aria-current="page"`));
    assert.ok(commandItems([]).some((item) => item.screen === screen));
  }
  for (const [screen, parent] of [["run", "runs"], ["workflow", "library"], ["import", "library"]] as const) {
    assert.equal(shellScreen(screen), parent);
  }
  assert.match(shellList("heals", { runs: [{ id: "run", workflowId: "wf", status: "passed", heals: [{ id: "heal" }] }] }), /id="heal-count">1/);
});

test("native narrow headers reserve one clearance and keep controls clickable", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-native-shell-layout-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    app.library.saveRun({ id: "native-wait", workflowId: "agent-browser", status: "paused", at: 1, steps: [], heals: [] });
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    for (const native of [false, true]) {
      for (const width of [720, 1060, 1061]) {
        await page.setViewportSize({ width, height: 820 });
        await page.goto(`http://127.0.0.1:${app.port}`);
        await page.locator("#run-receipt").waitFor();
        await page.evaluate((enabled) => {
          if (enabled) document.documentElement.dataset.baoNative = "true";
          else delete document.documentElement.dataset.baoNative;
        }, native);
        for (const screen of ["runs", "library", "settings"] as const) {
          if (screen !== "runs") {
            if (width <= 1060) await page.locator("#sidebar-toggle:visible").click();
            await page.locator(`#rail [data-screen=${screen}]`).click();
          }
          if (screen === "library") {
            await page.locator("#main .library-heading").waitFor();
            assert.equal(await page.locator("#screen-list").isVisible(), false);
            const geometry = await page.locator("#content").evaluate((content) => {
              const header = content.querySelector(".library-heading")!;
              const rect = header.getBoundingClientRect();
              const box = content.getBoundingClientRect();
              const controls = [...header.children].filter((node) => getComputedStyle(node).display !== "none");
              return {
                contentTop: box.top, contentLeft: box.left, contentRight: box.right,
                headerTop: rect.top, headerHeight: rect.height,
                contained: controls.every((node) => { const control = node.getBoundingClientRect(); return control.top >= rect.top && control.bottom <= rect.bottom && control.left >= rect.left && control.right <= rect.right; }),
              };
            });
            assert.deepEqual(geometry, { contentTop: native && width <= 1060 ? 52 : 0, contentLeft: width <= 1060 ? 0 : 212, contentRight: width, headerTop: native && width <= 1060 ? 52 : 0, headerHeight: 52, contained: true }, `Library ${width}px native=${native}`);
            for (const button of await page.locator("#main .library-heading button").all()) {
              if (await button.isVisible()) await button.click({ trial: true });
            }
          } else {
            const geometry = await page.locator("#screen-list").evaluate((list) => {
              const header = list.querySelector(".pane-bar")!;
              const rect = header.getBoundingClientRect();
              const controls = [...header.children].filter((node) => getComputedStyle(node).display !== "none");
              return {
                top: rect.top, height: rect.height,
                navTop: list.querySelector("nav")!.getBoundingClientRect().top,
                contained: controls.every((node) => { const box = node.getBoundingClientRect(); return box.top >= rect.top && box.bottom <= rect.bottom; }),
              };
            });
            assert.deepEqual(geometry, { top: native && width <= 1060 ? 52 : 0, height: 52, navTop: native && width <= 1060 ? 104 : 52, contained: true }, `${screen} ${width}px native=${native}`);
            for (const button of await page.locator("#screen-list > .pane-bar button, #screen-list > nav button").all()) {
              if (await button.isVisible()) await button.click({ trial: true });
            }
          }
        }
        if (width <= 1060) await page.locator("#sidebar-toggle:visible").click();
        await page.locator("#rail [data-place=runs]").click();
        await page.locator(".runs-record").click();
        await page.locator("#start-url").waitFor();
      }
    }
  } finally {
    await browser.close(); await app.close();
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("the running app keeps navigation, details, keyboard focus and narrow layouts working", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-shell-nav-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const workflow: WorkflowV2 = {
    schema: "bao.workflow/v2", version: 2, id: "wf-shell", name: "Read the local fixture", createdAt: 1,
    startUrl: "/fixture", inputs: [], steps: [{ id: "open", index: 0, action: "click", label: "Open fixture", surface: "dom", identity: { surface: "dom", role: "button", name: "Open fixture", path: [] }, timeoutMs: 1000 }],
  };
  app.library.save(workflow);
  app.library.saveRun({ id: "run-shell", workflowId: workflow.id, status: "passed", at: 1, steps: [], heals: [] });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const url = `http://127.0.0.1:${app.port}`;
  const accessibilityIssues: string[] = [];
  async function checkTitle(expected: string): Promise<void> {
    const title = await page.title();
    if (title !== expected) accessibilityIssues.push(`Expected title "${expected}", got "${title}"`);
  }
  async function scrollContent(): Promise<void> {
    await page.locator("#main").evaluate((element) => { element.style.minHeight = "2000px"; });
    await page.locator("#content").evaluate((element) => { element.scrollTop = 300; });
    assert.ok(await page.locator("#content").evaluate((element) => element.scrollTop) > 0);
  }
  async function checkDetailFocus(detail: string): Promise<void> {
    if (!await page.locator("#main").evaluate((element) => element === document.activeElement)) {
      accessibilityIssues.push(`${detail} did not focus #main`);
    }
    if (await page.locator("#content").evaluate((element) => element.scrollTop) !== 0) {
      accessibilityIssues.push(`${detail} did not reset #content scroll`);
    }
  }
  async function navigate(screen: Screen, place: string): Promise<void> {
    const primary = page.locator(`#rail [data-place="${place}"]`);
    await primary.waitFor({ state: "attached" });
    if (!await primary.isVisible()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    await primary.click();
    if (place === "workflows" && screen !== "library") {
      if (screen === "capture") {
        await page.getByRole("button", { name: "Record", exact: true }).click();
      } else {
        await page.keyboard.press("ControlOrMeta+k");
        await page.locator("#palette-input").fill(screen === "teach" ? "Teach" : "Replay");
        await page.locator(`#palette-list [data-command="${screen}"]`).click();
      }
    } else if (screen !== "library") await page.locator(`#screen-list [data-screen="${screen}"]`).click();
    if (screen === "capture") {
      await page.waitForResponse((response) => response.url().endsWith("/api/state"));
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
    assert.equal(await page.locator("#main").evaluate((element) => element === document.activeElement), true, `${screen} at ${page.viewportSize()?.width}px focused ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 200))}`);
  }
  try {
    await page.goto(url);
    await page.waitForSelector("#runs");
    await checkTitle("Bao");
    assert.equal(await page.locator("#rail nav button").count(), 3);
    for (const width of [1200, 720, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const listBounds = await page.locator("#screen-list").boundingBox();
      assert.equal(listBounds?.x, width === 1200 ? 212 : 0);
      assert.equal(listBounds?.width, width === 1200 ? 340 : width === 720 ? 296 : 320);
      for (const [screen, place, heading] of routes) {
        await navigate(screen, place);
        await page.waitForFunction((text) => document.querySelector("#main h2")?.textContent?.startsWith(text), screen === "library" ? "Workflows" : screen === "runs" ? workflow.name : heading);
        await checkTitle("Bao");
        assert.equal(await page.locator("#screen-list [aria-current=page]").count(), screen === "library" ? 0 : 1);
        if (screen !== "library") {
          const label = screen === "live" ? "Live" : screen === "replay" ? "Replay" : heading;
          assert.equal(await page.locator("#screen-list").getByRole("button", { name: new RegExp(`^${label}(?: |$)`) }).getAttribute("aria-current"), "page");
        }
        const bounds = await page.locator("#content").evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
        assert.ok(bounds.scroll <= bounds.width + 1, `${screen} at ${width}px overflows: ${JSON.stringify(bounds)}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        if (screen === "library") {
          await page.getByRole("button", { name: "Search workflows", exact: true }).click();
          assert.equal(await page.locator("#palette-open").evaluate((element) => {
            const label = document.createRange();
            label.selectNodeContents(element);
            const lines = [...label.getClientRects()];
            const button = element.getBoundingClientRect();
            return lines.length === 1 && lines.every((line) => line.left >= button.left && line.right <= button.right && line.top >= button.top && line.bottom <= button.bottom);
          }), true, `Library command shortcut spills outside its button at ${width}px`);
          await page.locator("#palette-open").click();
          assert.equal(await page.locator("#palette-input").evaluate((element) => element === document.activeElement), true);
          await page.keyboard.press("Escape");
        }
      }
    }
    await page.setViewportSize({ width: 1200, height: 800 });
    for (const [theme, linkColor, inputBorder, surfaceColor] of [
      ["light", "rgb(29, 29, 31)", "rgb(110, 110, 115)", "rgb(255, 255, 255)"],
      ["dark", "rgb(242, 242, 247)", "rgb(161, 161, 166)", "rgb(30, 30, 30)"],
    ] as const) {
      await page.evaluate((value) => localStorage.setItem("bao-theme", value), theme);
      await page.reload();
      await navigate("live", "runs");
      assert.equal(await page.locator("#runs [data-open-run=run-shell]").evaluate((element) => getComputedStyle(element).color), linkColor);
      await navigate("library", "workflows");
      const title = page.getByRole("button", { name: workflow.name, exact: true });
      assert.ok((await title.boundingBox())!.height < 32);
      assert.equal(await page.locator("#library-search").evaluate((element) => getComputedStyle(element).borderTopColor), inputBorder);
      assert.equal(await page.locator("#content").evaluate((element) => getComputedStyle(element).backgroundColor), surfaceColor);
      assert.equal(await page.locator("#rail").evaluate((element) => getComputedStyle(element).paddingTop), "52px");
    }
    await page.evaluate(() => localStorage.setItem("bao-theme", "light"));
    await page.reload();
    await navigate("library", "workflows");
    const search = page.locator("#library-search");
    await page.getByRole("button", { name: "Search workflows", exact: true }).click();
    await search.fill("Read");
    const searchBeforePoll = await search.elementHandle();
    let pendingHeal = false;
    await page.route("**/api/state", async (route) => {
      const response = await route.fetch();
      const state = await response.json() as ShellState & { settings: Record<string, unknown> };
      await route.fulfill({ json: { ...state, settings: { ...state.settings, promoteAfter: 99 }, runs: (state.runs || []).map((run) => run.id === "run-shell" && pendingHeal ? { ...run, heals: [{ id: "heal-shell" }] } : run) } });
    });
    await page.waitForFunction((element) => !element?.isConnected, searchBeforePoll);
    assert.equal(await search.evaluate((element) => element === document.activeElement), true);
    assert.equal(await search.inputValue(), "Read");
    await checkTitle("Bao");
    await page.getByRole("button", { name: workflow.name, exact: true }).focus();
    await scrollContent();
    await page.keyboard.press("Enter");
    await page.waitForSelector("#workflow-detail");
    await checkTitle("Bao");
    await checkDetailFocus("Workflow detail");
    await page.locator("#workflow-options > summary").click();
    await page.locator("#workflow-edit summary").click();
    await page.locator("#edit-json").focus();
    pendingHeal = true;
    await page.locator('#attention[data-count="1"]').waitFor();
    assert.equal(await page.locator("#attention-label").innerText(), "Nothing running");
    assert.equal(await page.locator("#edit-json").evaluate((element) => element === document.activeElement), true);
    await checkTitle("Bao");
    assert.equal(await page.locator("#rail [data-place=workflows]").getAttribute("aria-current"), "page");
    await navigate("runs", "runs");
    await page.locator("#run-receipt").waitFor();
    await navigate("live", "runs");
    await page.locator("[data-open-run=run-shell]").first().focus();
    await scrollContent();
    await page.keyboard.press("Enter");
    await page.waitForSelector("#run-receipt");
    await checkTitle("Bao");
    await checkDetailFocus("Run detail");
    await page.unroute("**/api/state");
    assert.deepEqual(accessibilityIssues, []);
    assert.equal(await page.locator("#rail [data-place=runs]").getAttribute("aria-current"), "page");
    await page.setViewportSize({ width: 720, height: 800 });
    await page.getByRole("button", { name: "Show sidebar", exact: true }).focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#sidebar-dialog").evaluate((element) => (element as HTMLDialogElement).open), true);
    assert.equal(await page.locator("#rail").evaluate((element) => getComputedStyle(element).paddingTop), "52px");
    await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === "sidebar-toggle");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.id === "sidebar-toggle");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Settings", exact: true }).focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.activeElement?.id === "main");
    assert.equal(await page.locator("#screen-list > .pane-bar").evaluate((element) => getComputedStyle(element).paddingInlineStart), "16px");
    await page.goto(`${url}/?screen=live`);
    await page.waitForSelector("#live-session");
    assert.equal(await page.locator("#screen-list [data-screen=live]").getAttribute("aria-current"), "page");
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.route("**/api/login-sites", (route) => route.fulfill({ json: { sites: [{ origin: "https://saved.example", probeUrl: "https://saved.example/account" }] } }));
    async function command(label: string): Promise<void> {
      await page.keyboard.press("ControlOrMeta+k");
      await page.locator("#palette-input").fill(label);
      await page.locator(`#palette-list [data-command="${label.toLowerCase()}"]`).click();
    }
    await command("Logins");
    await page.getByText("https://saved.example", { exact: true }).waitFor();
    const hostAccess = page.waitForRequest("**/api/extension/host-access");
    await command("Settings");
    await hostAccess;
    for (const entry of ["palette", "screen-list", "workflow-command"] as const) {
      await navigate("library", "workflows");
      await page.locator(`[data-open-workflow="${workflow.id}"]`).click();
      await page.locator('[data-run-from="open"]').click();
      await page.getByText("Run from step 1. Earlier steps are not re-run.", { exact: true }).waitFor();
      await navigate("runs", "runs");
      if (entry === "palette") await command("Replay");
      else if (entry === "workflow-command") {
        await page.keyboard.press("ControlOrMeta+k");
        await page.locator("#palette-input").fill(`Run ${workflow.name}`);
        await page.locator(`#palette-list [data-command="run-${workflow.id}"]`).click();
      } else await navigate("replay", "workflows");
      assert.equal(await page.locator("#run-from-note").count(), 0);
      await page.locator("#run").waitFor();
    }
    await page.route("**/api/state", async (route) => {
      const response = await route.fetch();
      const current = await response.json() as ShellState & { settings: Record<string, unknown> };
      await route.fulfill({ json: { ...current, settings: { ...current.settings, pageEngine: "dom" }, helper: { label: "helper available", platform: "darwin", accessibility: false } } });
    });
    await page.goto(url);
    await page.locator("#runs").waitFor();
    assert.equal(await page.locator("#onboarding, #perm-dot").count(), 0);
    await navigate("library", "workflows");
    assert.equal(await page.locator("#onboarding, #perm-dot").count(), 0);
    await page.unroute("**/api/state");
    for (const mode of ["record", "teach"] as const) {
      await page.route("**/api/state", async (route) => {
        const response = await route.fetch();
        const current = await response.json() as ShellState & { settings: Record<string, unknown> };
        await route.fulfill({ json: { ...current, recording: mode === "record", teach: mode === "teach" ? { phase: "live", cards: [], decisions: [] } : undefined } });
      });
      await page.goto(url);
      const bar = page.locator(mode === "record" ? "#record-bar" : "#teach-bar");
      await bar.waitFor();
      for (const button of await bar.locator("button").all()) {
        assert.equal((await button.boundingBox())!.height, 26);
      }
      await page.unroute("**/api/state");
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("Workflows list keeps long names, search recovery, warnings and actions reachable", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-workflows-list-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const longName = "Create production Google OAuth client for 五秒 in the Chinglish AI project using the shared sign-in screen";
  for (const [id, name] of [["long", longName], ["short", "Read fixture"], ["unused", "Not run"]] as const) {
    app.library.save({ schema: "bao.workflow/v2", version: 2, id, name, createdAt: 1, startUrl: "/fixture", inputs: Array.from({ length: 13 }, (_, n) => ({ name: `text${n}`, type: "text" as const })), steps: [] });
  }
  app.library.saveRun({ id: "old", workflowId: "long", status: "passed", at: 1, steps: [], heals: [] });
  app.library.saveRun({ id: "latest", workflowId: "long", status: "failed", at: 20, steps: [], heals: [] });
  app.library.saveRun({ id: "other", workflowId: "short", status: "passed", at: 10, steps: [], heals: [] });
  const damaged = path.join(home, "workflows", "damaged.json");
  await writeFile(damaged, "{");
  let page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  try {
    for (const theme of ["light", "dark"]) {
      if (theme === "dark") {
        await page.close();
        page = await browser.newPage({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
      }
      await page.addInitScript((value) => localStorage.setItem("bao-theme", value), theme);
      await page.goto(`http://127.0.0.1:${app.port}`);
      await page.locator("#rail [data-place=workflows]").click();
      await page.locator("#workflow-list").waitFor();
      assert.equal(await page.locator("#rail [data-place=workflows]").getAttribute("aria-describedby"), "workflow-warning-description");
      assert.match(await page.locator("#workflow-warning-description").textContent() || "", /One workflow can’t open/);
      assert.equal(await page.locator(".workflow-warning svg").count(), 1);
      assert.equal(await page.locator(".workflow-warning svg").evaluate((element) => getComputedStyle(element).color), theme === "light" ? "rgb(215, 0, 21)" : "rgb(255, 105, 97)");
      assert.equal(await page.locator("#workflow-list .status.passed").first().evaluate((element) => getComputedStyle(element).color), theme === "light" ? "rgb(30, 123, 52)" : "rgb(48, 209, 88)");
      assert.deepEqual(await page.locator(".workflow-row:not(.damaged-workflow-row)").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-workflow"))), ["long", "short", "unused"]);
      assert.match(await page.locator(".workflow-row").first().locator(".status").innerText(), /Failed$/);
      assert.equal(await page.locator("#library .chip, #library .thumb, #library img").count(), 0);
      for (const width of [1280, 720, 320, 640]) {
        await page.setViewportSize({ width, height: width === 640 ? 430 : 860 });
        const title = page.getByRole("button", { name: longName, exact: true });
        assert.equal(await title.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true);
        assert.equal(await title.evaluate((element) => getComputedStyle(element).whiteSpace), "normal");
        await title.focus();
        await page.keyboard.press("Tab");
        const next = page.getByRole("button", { name: "Read fixture", exact: true });
        assert.equal(await next.evaluate((element) => element === document.activeElement), true);
        assert.notEqual(await next.evaluate((element) => getComputedStyle(element).outlineStyle), "none");
        const bounds = await page.locator("#content").evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
        assert.ok(bounds.scroll <= bounds.width + 1, `${theme} ${width}px: ${JSON.stringify(bounds)}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
      await page.getByRole("button", { name: "Search workflows", exact: true }).click();
      const search = page.getByRole("searchbox", { name: "Search workflows" });
      await search.fill("no such name");
      await page.locator("#library-no-results:not([hidden])").waitFor();
      assert.equal(await page.locator("#workflow-list").isHidden(), true);
      assert.match(await page.locator("#library-search-status").innerText(), /0 matching workflows/);
      await page.getByRole("button", { name: "Clear search", exact: true }).click();
      assert.equal(await search.inputValue(), "");
      assert.equal(await search.evaluate((element) => element === document.activeElement), true);
      assert.equal(await page.locator(".workflow-row:visible").count(), 4);
      await page.getByRole("button", { name: "damaged.json", exact: true }).click();
      assert.equal(await page.locator("#library-damaged summary").evaluate((element) => element === document.activeElement), true);
      assert.match(await page.locator("#library-damaged").innerText(), /damaged.json/);
      assert.match(await page.locator("#library-damaged").innerText(), /Go to Folder/);
      await page.getByRole("button", { name: "Record", exact: true }).click();
      await page.locator("#screen-list [data-screen=library]").click();
      assert.equal(await page.locator("#library-damaged details").isHidden(), true);
      await page.route("**/api/workflows/reveal", (route) => route.fulfill({ status: 500, json: { error: "Could not open the workflow folder." } }));
      await page.getByRole("button", { name: "Show in Finder", exact: true }).click();
      await page.getByText("Could not open the workflow folder. Open File details and recovery to find its path.", { exact: true }).waitFor();
      assert.equal(await page.locator("#library-damaged details").isVisible(), true);
      await page.unroute("**/api/workflows/reveal");
      await page.getByRole("button", { name: longName, exact: true }).focus();
      await page.keyboard.press("Enter");
      await page.locator("#workflow-detail").waitFor();
      assert.equal(await page.locator("#workflow-detail h2").innerText(), longName);
      await page.getByRole("button", { name: "Run…", exact: true }).click();
      await page.locator("#run").waitFor();
      assert.equal(await page.locator("#wf").inputValue(), "long");
      await page.setViewportSize({ width: 1280, height: 860 });
    }
    for (const id of ["long", "short", "unused"]) await rm(path.join(home, "workflows", `${id}.json`));
    await page.locator("#screen-list [data-screen=library]").click();
    await page.getByText("No workflows can open", { exact: true }).waitFor();
    await rm(damaged);
    await page.getByText("No workflows yet", { exact: true }).waitFor();
    assert.equal(await page.locator(".workflow-warning").count(), 0);
    await page.getByRole("button", { name: "Record a task", exact: true }).click();
    await page.getByRole("button", { name: "Start capture", exact: true }).waitFor();
  } finally {
    await browser.close();
    await app.close();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("the palette takes focus from the modal sidebar without a queued close stealing it", { timeout: 60_000 }, async () => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-shell-palette-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  const workflow: WorkflowV2 = {
    schema: "bao.workflow/v2", version: 2, id: "wf-palette", name: "Local palette fixture", createdAt: 1,
    startUrl: "/fixture", inputs: [], steps: [],
  };
  app.library.save(workflow);
  const page = await browser.newPage({ viewport: { width: 720, height: 800 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator("#runs").waitFor();
    await page.evaluate(() => {
      document.querySelector("#sidebar-dialog")!.addEventListener("close", () => {
        document.documentElement.dataset.sidebarCloseFocus = document.activeElement?.id || document.activeElement?.tagName;
      });
    });
    const dialog = page.locator("#sidebar-dialog");
    const input = page.locator("#palette-input");
    const commands = [
      ["Settings", "settings", "#set-runs", "main"],
      [`Open ${workflow.name}`, `open-${workflow.id}`, "#workflow-detail", "main"],
      [`Run ${workflow.name}`, `run-${workflow.id}`, "#run", "main"],
      ["Toggle appearance", "theme", "#run", "BODY"],
    ] as const;
    for (const width of [1060, 720]) {
      await page.setViewportSize({ width, height: 800 });
      for (const [label, id, result, focus] of commands) {
        await page.evaluate(() => { delete document.documentElement.dataset.sidebarCloseFocus; });
        await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
        assert.equal(await dialog.evaluate((element) => (element as HTMLDialogElement).open), true);
        await page.keyboard.press("ControlOrMeta+k");
        await page.waitForFunction(() => document.documentElement.dataset.sidebarCloseFocus === "palette-input");
        assert.equal(await dialog.evaluate((element) => (element as HTMLDialogElement).open), false);
        assert.equal(await input.evaluate((element) => element === document.activeElement), true);
        await page.keyboard.type(label);
        assert.equal(await input.inputValue(), label);
        const selected = page.locator("#palette-list button.on");
        assert.equal(await selected.getAttribute("data-command"), id);
        assert.equal(await selected.isVisible(), true);
        const theme = await page.locator("html").getAttribute("data-theme");
        await page.keyboard.press("Enter");
        await page.locator(result).waitFor();
        assert.equal(await page.locator("#palette").isHidden(), true);
        assert.equal(await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName), focus);
        if (id === "theme") assert.notEqual(await page.locator("html").getAttribute("data-theme"), theme);
      }
    }
    for (const [label, , result, focus] of commands) {
      await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
      const theme = await page.locator("html").getAttribute("data-theme");
      await page.evaluate((query) => {
        delete document.documentElement.dataset.sidebarCloseFocus;
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
        const input = document.querySelector<HTMLInputElement>("#palette-input")!;
        input.value = query;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      }, label);
      await page.waitForFunction(() => document.documentElement.dataset.sidebarCloseFocus !== undefined);
      await page.locator(result).waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName), focus);
      assert.equal(await page.locator("html").getAttribute("data-sidebar-close-focus"), focus);
      assert.equal(await dialog.evaluate((element) => (element as HTMLDialogElement).open), false);
      if (label === "Toggle appearance") assert.notEqual(await page.locator("html").getAttribute("data-theme"), theme);
    }
    for (const action of ["close", "escape"] as const) {
      await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
      if (action === "close") await page.getByRole("button", { name: "Close sidebar", exact: true }).click();
      else await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement?.id === "sidebar-toggle");
    }
    await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    await page.evaluate(() => {
      delete document.documentElement.dataset.sidebarCloseFocus;
      document.querySelector<HTMLButtonElement>("#sidebar-close")!.click();
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => document.documentElement.dataset.sidebarCloseFocus === "palette-input");
    assert.equal(await input.evaluate((element) => element === document.activeElement), true);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>("#sidebar-close")!.click();
      document.querySelector<HTMLButtonElement>("#sidebar-toggle")!.click();
    });
    await page.waitForFunction(() => document.documentElement.dataset.sidebarCloseFocus === "sidebar-close");
    assert.equal(await dialog.evaluate((element) => (element as HTMLDialogElement).open), true);
    assert.equal(await page.locator("#sidebar-dialog #rail").count(), 1);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.activeElement?.id === "sidebar-toggle");
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.press("ControlOrMeta+k");
    assert.equal(await page.locator("#palette").isHidden(), true);
    await page.keyboard.press("ControlOrMeta+k");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("#palette").isHidden(), true);
    await page.keyboard.press("ControlOrMeta+k");
    await input.fill("Library");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Search workflows", exact: true }).click();
    await page.locator("#palette-open").click();
    assert.equal(await input.evaluate((element) => element === document.activeElement), true);
    assert.equal(await input.inputValue(), "");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});
