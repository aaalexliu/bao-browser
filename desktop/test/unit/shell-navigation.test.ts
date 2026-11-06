import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    assert.match(shellList(screen, {}), new RegExp(`data-screen="${screen}"[^>]*aria-current="page"`));
    assert.ok(commandItems([]).some((item) => item.screen === screen));
  }
  for (const [screen, parent] of [["run", "runs"], ["workflow", "library"], ["import", "library"]] as const) {
    assert.equal(shellScreen(screen), parent);
  }
  assert.match(shellList("heals", { runs: [{ id: "run", workflowId: "wf", status: "passed", heals: [{ id: "heal" }] }] }), /id="heal-count">1/);
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
    await page.locator("#screen-list nav").waitFor();
    if (!await primary.isVisible()) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
    await primary.click();
    await page.locator(`#screen-list [data-screen="${screen}"]`).click();
    assert.equal(await page.locator("#main").evaluate((element) => element === document.activeElement), true);
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
        await page.waitForFunction((text) => document.querySelector("#main h2")?.textContent?.startsWith(text), heading);
        await checkTitle("Bao");
        assert.equal(await page.locator("#screen-list [aria-current=page]").count(), 1);
        const bounds = await page.locator("#content").evaluate((element) => ({ width: element.clientWidth, scroll: element.scrollWidth }));
        assert.ok(bounds.scroll <= bounds.width + 1, `${screen} at ${width}px overflows: ${JSON.stringify(bounds)}`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
    }
    await page.setViewportSize({ width: 1200, height: 800 });
    for (const [theme, linkColor, inputBorder, cardColor] of [
      ["light", "rgb(0, 113, 227)", "rgb(210, 210, 215)", "rgb(255, 255, 255)"],
      ["dark", "rgb(10, 132, 255)", "rgb(58, 58, 60)", "rgb(44, 44, 46)"],
    ] as const) {
      await page.evaluate((value) => localStorage.setItem("bao-theme", value), theme);
      await page.reload();
      await navigate("runs", "runs");
      assert.equal(await page.locator("[data-open-run=run-shell]").evaluate((element) => getComputedStyle(element).color), linkColor);
      await navigate("library", "workflows");
      const title = page.getByRole("button", { name: workflow.name, exact: true });
      assert.ok((await title.boundingBox())!.height < 32);
      assert.equal(await page.locator("#library-search").evaluate((element) => getComputedStyle(element).borderTopColor), inputBorder);
      assert.equal(await page.locator(".wf-card").evaluate((element) => getComputedStyle(element).backgroundColor), cardColor);
      assert.equal(await page.locator("#rail").evaluate((element) => getComputedStyle(element).paddingTop), "10px");
    }
    await page.evaluate(() => localStorage.setItem("bao-theme", "light"));
    await page.reload();
    await navigate("library", "workflows");
    const search = page.locator("#library-search");
    await search.fill("Read");
    const searchBeforePoll = await search.elementHandle();
    await page.route("**/api/state", async (route) => {
      const response = await route.fetch();
      const state = await response.json() as ShellState & { settings: Record<string, unknown> };
      await route.fulfill({ json: { ...state, settings: { ...state.settings, promoteAfter: 99 } } });
    });
    await page.waitForFunction((element) => !element?.isConnected, searchBeforePoll);
    assert.equal(await search.evaluate((element) => element === document.activeElement), true);
    assert.equal(await search.inputValue(), "Read");
    await checkTitle("Bao");
    await page.unroute("**/api/state");
    await page.getByRole("button", { name: workflow.name, exact: true }).focus();
    await scrollContent();
    await page.keyboard.press("Enter");
    await page.waitForSelector("#workflow-detail");
    await checkTitle("Bao");
    await checkDetailFocus("Workflow detail");
    await page.locator("#workflow-edit summary").click();
    await page.locator("#edit-json").focus();
    await page.route("**/api/state", async (route) => {
      const response = await route.fetch();
      const state = await response.json() as ShellState & { settings: Record<string, unknown> };
      await route.fulfill({ json: { ...state, settings: { ...state.settings, promoteAfter: 99 } } });
    });
    await page.waitForRequest("**/api/state");
    await page.waitForRequest("**/api/state");
    assert.equal(await page.locator("#edit-json").evaluate((element) => element === document.activeElement), true);
    await checkTitle("Bao");
    await page.unroute("**/api/state");
    assert.equal(await page.locator("#rail [data-place=workflows]").getAttribute("aria-current"), "page");
    await navigate("runs", "runs");
    await page.locator("[data-open-run=run-shell]").focus();
    await scrollContent();
    await page.keyboard.press("Enter");
    await page.waitForSelector("#run-viewer");
    await checkTitle("Bao");
    await checkDetailFocus("Run detail");
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
      const current = await response.json();
      await route.fulfill({ json: { ...current, settings: { ...current.settings, pageEngine: "dom" }, helper: { platform: "darwin", accessibility: false, automation: { state: "granted" } } } });
    });
    await page.goto(url);
    await page.locator("#runs").waitFor();
    await page.locator("#onboarding").waitFor();
    await navigate("library", "workflows");
    await page.locator("#onboarding").waitFor();
    await navigate("runs", "runs");
    await page.locator("#onboarding summary").click();
    await page.locator("#onboard-done").click();
    assert.equal(await page.locator("#onboarding").count(), 0);
    await navigate("library", "workflows");
    assert.equal(await page.locator("#onboarding").count(), 0);
    await page.unroute("**/api/state");
    for (const mode of ["record", "teach"] as const) {
      await page.route("**/api/state", async (route) => {
        const response = await route.fetch();
        const current = await response.json();
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
