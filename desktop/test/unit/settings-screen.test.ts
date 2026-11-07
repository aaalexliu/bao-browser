import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { MacOsHelper } from "../../src/proxy/os-macos";
import { testChromium } from "../../src/test-browser";
import type { WorkflowV2 } from "../../src/v1/schema";
import { makeAsk } from "../../src/v1/human-ask";

interface StateFixture extends Record<string, unknown> {
  sync?: Record<string, unknown>;
}

async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(check(), "saved setting did not reach the Library");
}

test("main-pane navigation shows a focus ring only for keyboard input", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-settings-focus-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: false, accessibility: false }));
  const app = await startApp({ home, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const url = `http://127.0.0.1:${app.port}`;
    const workflow: WorkflowV2 = {
      schema: "bao.workflow/v2", version: 2, id: "focus-fixture", name: "Focus fixture", createdAt: 1,
      startUrl: "/fixture", inputs: [], steps: [],
    };
    app.library.save(workflow);
    app.library.saveRun({ id: "focus-run", workflowId: workflow.id, status: "passed", at: 1, steps: [], heals: [] });
    app.library.saveRun({ id: "default-run", workflowId: workflow.id, status: "passed", at: 2, steps: [], heals: [] });
    let live = false;
    let runFailure = "";
    await page.route("**/api/runs/focus-run**", async (route) => {
      const receipt = new URL(route.request().url()).pathname.endsWith("/receipt");
      if (runFailure === (receipt ? "receipt" : "run")) await route.fulfill({ status: 503, json: { error: "Fixture unavailable" } });
      else await route.continue();
    });
    await page.route("**/api/state", async (route) => {
      const response = await route.fetch();
      const state = await response.json();
      await route.fulfill({ json: { ...state, activeAsk: live ? {
        ...makeAsk({ kind: "confirm", workflowId: workflow.id, workflowName: workflow.name, stepId: "s", stepIndex: 1, stepCount: 1, label: "Continue", timeoutMs: 120_000 }), runId: "focus-run",
      } : null } });
    });
    async function checkMain(keyboard: boolean): Promise<void> {
      await page.waitForFunction(() => document.activeElement?.id === "main");
      assert.equal(await page.locator("#main").evaluate((node) => getComputedStyle(node).outlineStyle), keyboard ? "solid" : "none");
    }
    for (const theme of ["light", "dark"]) {
      await page.goto(url);
      await page.evaluate((value) => localStorage.setItem("bao-theme", value), theme);
      await page.reload();
      const settings = page.locator('#rail [data-place="settings"]');
      await settings.evaluate((button) => (button as HTMLButtonElement).click());
      await page.locator("#settings").waitFor();
      assert.equal(await page.locator("#main").evaluate((node) => getComputedStyle(node).outlineStyle), "none", `${theme}: programmatic opening has no focus box`);
      await page.reload();
      await settings.click();
      await page.locator("#settings").waitFor();
      assert.equal(await page.locator("#main").evaluate((node) => getComputedStyle(node).outlineStyle), "none", `${theme}: pointer opening has no focus box`);
      for (const key of ["Shift", "Meta", "Control", "Alt", "CapsLock", "Meta+Tab", "Meta+c", "Meta+h", "Meta+Shift+4", "Control+c", "Alt+c", "a"]) {
        await page.keyboard.press(key);
        await checkMain(false);
      }
      await page.keyboard.press("Shift+Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.matches(":focus-visible")), true);
      await settings.click();
      await page.keyboard.press("ArrowDown");
      await checkMain(true);
      await page.reload();
      await settings.focus();
      await page.keyboard.press("Enter");
      await page.locator("#settings").waitFor();
      assert.equal(await page.evaluate(() => document.activeElement?.id), "main");
      assert.equal(await page.locator("#main").evaluate((node) => node.matches(":focus-visible") && getComputedStyle(node).outlineStyle === "solid"), true, `${theme}: keyboard opening keeps a visible focus ring`);
      await page.keyboard.press("Tab");
      assert.equal(await page.locator("#heal-auto").evaluate((node) => document.activeElement === node && node.matches(":focus-visible")), true);
      assert.equal(await page.locator('label[for="heal-auto"]').evaluate((node) => getComputedStyle(node).outlineStyle), "solid");
      await page.keyboard.press("Meta+k");
      await page.locator("#palette-input").fill("Settings");
      await page.keyboard.press("Enter");
      assert.equal(await page.locator("#main").evaluate((node) => document.activeElement === node && getComputedStyle(node).outlineStyle === "solid"), true);
      await page.keyboard.press("Meta+k");
      await page.locator("#palette-input").fill("Settings");
      await page.locator('#palette-list [data-command="settings"]').click();
      assert.equal(await page.locator("#main").evaluate((node) => getComputedStyle(node).outlineStyle), "none");
      await page.setViewportSize({ width: 720, height: 860 });
      await page.locator("#sidebar-toggle").click();
      await settings.click();
      await page.waitForFunction(() => !(document.querySelector("#sidebar-dialog") as HTMLDialogElement).open);
      assert.equal(await page.locator("#main").evaluate((node) => getComputedStyle(node).outlineStyle), "none");
      await page.locator("#sidebar-toggle").focus();
      await page.keyboard.press("Enter");
      await settings.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => document.activeElement?.id === "main");
      assert.equal(await page.locator("#main").evaluate((node) => node.matches(":focus-visible") && getComputedStyle(node).outlineStyle === "solid"), true);
      await page.setViewportSize({ width: 1280, height: 860 });
      for (const keyboard of [false, true]) {
        await page.keyboard.press("Meta+k");
        await page.locator("#palette-input").fill("Open Focus fixture");
        if (keyboard) await page.keyboard.press("Enter");
        else await page.locator("#palette-list [data-command]").first().click();
        await page.locator("#workflow-detail").waitFor();
        await checkMain(keyboard);
        await page.goto(`${url}/?screen=runs`);
        const receipt = page.locator('[data-open-run="focus-run"]').first();
        if (keyboard) { await receipt.focus(); await page.keyboard.press("Enter"); }
        else await receipt.click();
        await page.locator("#run-receipt").waitFor();
        await checkMain(keyboard);
        for (const failure of ["run", "receipt"]) {
          runFailure = failure;
          await page.goto(`${url}/?screen=runs`);
          await page.locator('[data-open-run="focus-run"]').first().click();
          const retry = page.locator("#retry-run");
          await retry.waitFor();
          runFailure = "";
          if (keyboard) { await retry.focus(); await page.keyboard.press("Enter"); }
          else await retry.click();
          await page.locator("#run-receipt").waitFor();
          await checkMain(keyboard);
        }
        live = true;
        await page.goto(`${url}/?screen=live`);
        const openWorkflow = page.locator('#detail-bar [data-open-workflow="focus-fixture"]');
        await openWorkflow.waitFor();
        if (keyboard) { await openWorkflow.focus(); await page.keyboard.press("Enter"); }
        else await openWorkflow.click();
        await page.locator("#workflow-detail").waitFor();
        await checkMain(keyboard);
        live = false;
        await settings.click();
      }
    }
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("AI help saves each source and keeps API drafts across refreshes", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-settings-ai-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#rail [data-place="settings"]').click();
    const source = page.getByRole("combobox", { name: "Use AI to suggest heals" });
    await source.selectOption("cursor-account");
    await eventually(() => app.library.settings().healSource?.kind === "cursor-account");
    await page.waitForFunction(() => document.getElementById("settings-feedback")?.textContent === "Saved.");
    assert.match(await page.locator('[data-settings-jump="ai"]').innerText(), /Cursor account/);
    await source.selectOption("api-key");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "ai-key");
    await page.getByRole("button", { name: "Save API key", exact: true }).click();
    assert.equal(await page.locator("#ai-key").evaluate((el) => (el as HTMLInputElement).validity.valueMissing), true);
    assert.deepEqual(app.library.settings().healSource, { kind: "cursor-account" });
    await page.getByLabel("Provider", { exact: true }).selectOption("anthropic");
    await page.getByLabel("API key", { exact: true }).fill("fixture-ui-key");
    await page.locator("#promote-after").fill("4");
    await page.locator("#promote-after").press("Tab");
    await page.waitForFunction(() => (document.getElementById("promote-after") as HTMLInputElement)?.defaultValue === "4");
    assert.equal(await source.inputValue(), "api-key");
    assert.equal(await page.locator("#ai-key-form").isVisible(), true);
    assert.equal(await page.locator("#ai-provider").inputValue(), "anthropic");
    assert.equal(await page.locator("#ai-key").inputValue(), "fixture-ui-key");
    await page.locator("#ai-key").press("Enter");
    await eventually(() => app.library.settings().healSource?.kind === "api-key");
    await page.waitForFunction(() => document.getElementById("settings-feedback")?.textContent === "Saved.");
    assert.deepEqual(app.library.settings().healSource, { kind: "api-key", provider: "anthropic", key: "fixture-ui-key" });
    await page.reload();
    await page.locator('#rail [data-place="settings"]').click();
    assert.equal(await source.inputValue(), "api-key");
    assert.equal(await page.locator("#ai-provider").inputValue(), "anthropic");
    assert.equal(await page.locator("#ai-key").inputValue(), "fixture-ui-key");
    await page.locator("#settings-advanced > summary").click();
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width: 1280, height: 1000 });
      await page.locator("#theme").selectOption(theme);
      for (const width of [1280, 720, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.locator("#content").evaluate((el) => el.scrollWidth <= el.clientWidth), `AI controls overflow at ${width} in ${theme}`);
        assert.ok(await page.locator("#ai-key").evaluate((el) => el.getBoundingClientRect().right <= innerWidth));
      }
    }
    await source.selectOption("none");
    await eventually(() => app.library.settings().healSource?.kind === "none");
    await page.waitForFunction(() => document.getElementById("settings-feedback")?.textContent === "Saved.");
    assert.equal(await page.locator("#ai-key-form").isVisible(), false);
    assert.match(await page.locator('[data-settings-jump="ai"]').textContent() || "", /None/);
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("grouped Settings saves live controls, preserves secondary settings, opens Logins", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-settings-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const site = { origin: "https://example.test", probeUrl: "https://example.test/account", signedInSelector: "", signedInText: "", botCookies: "skip", origins: [], signedIn: false };
    await writeFile(path.join(home, "library", "login-sites.json"), JSON.stringify({ sites: [site] }));
    for (const directory of ["Default", "Profile 1"]) await mkdir(path.join(home, "profiles", directory), { recursive: true });
    await writeFile(path.join(home, "profiles", "Local State"), JSON.stringify({ profile: { info_cache: {} } }));
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const settingsWrites: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings") settingsWrites.push(request.postDataJSON() as unknown);
    });
    let syncPairOk = false;
    let relayPairOk = false;
    await page.route("**/api/state", async (route) => {
      const response = await route.fetch();
      const state = await response.json() as StateFixture;
      await route.fulfill({ response, json: { ...state, sync: { ...state.sync, paired: true, server: "https://registry-a.test", inviteSaved: syncPairOk }, relay: { paired: relayPairOk } } });
    });
    let pairRequest: Record<string, string> | undefined;
    await page.route("**/api/sync/pair", async (route) => {
      pairRequest = route.request().postDataJSON() as Record<string, string>;
      await route.fulfill({ status: syncPairOk ? 200 : 400, json: syncPairOk ? {} : { error: "Pair fixture rejected" } });
    });
    let relayRequest: unknown;
    await page.route("**/api/remote/pair", async (route) => {
      relayRequest = route.request().postDataJSON() as unknown;
      await route.fulfill({ status: relayPairOk ? 200 : 400, json: relayPairOk ? { paired: true } : { error: "Pair fixture rejected" } });
    });
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#rail [data-place="settings"]').click();
    await page.locator("#set-runs").waitFor();
    assert.deepEqual(await page.locator(".settings-heading").allTextContents(), ["Runs and heals", "Mac permissions", "Remote access", "Logins", "AI help"]);
    assert.equal(await page.getByText("Before each run", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("radio", { name: "Stop", exact: true }).count(), 1);
    assert.equal(await page.getByRole("combobox", { name: "Use AI to suggest heals" }).inputValue(), "none");
    assert.deepEqual(await page.locator("#ai-source option").allTextContents(), ["None", "Cursor account", "API key…"]);
    assert.equal(await page.locator("#save-settings").count(), 0);
    assert.equal(await page.locator("#remote-permission").count(), 0);
    assert.equal(await page.locator("[data-site-trust]").count(), 0);
    await page.locator('label[for="heal-approve"]').click();
    await eventually(() => app.library.settings().heal === "approve");
    await page.waitForFunction(() => document.getElementById("settings-feedback")?.textContent === "Saved.");
    await page.locator("#promote-after").fill("5");
    await page.locator("#promote-after").press("Tab");
    await eventually(() => app.library.settings().promoteAfter === 5);
    await page.locator("#act-minutes").selectOption("60");
    await eventually(() => app.library.settings().actTimeoutMs === 3_600_000);
    await page.locator("#act-minutes").selectOption("custom");
    await page.locator("#act-custom").fill("75");
    await page.locator("#act-custom").press("Tab");
    await eventually(() => app.library.settings().actTimeoutMs === 4_500_000);
    for (const selector of ["#promote-after", "#act-custom"]) {
      if (selector === "#act-custom") await page.locator("#act-minutes").selectOption("custom");
      const input = page.locator(selector);
      const previous = await input.inputValue();
      const key = selector === "#promote-after" ? "promoteAfter" : "actTimeoutMin";
      const writesBefore = settingsWrites.length;
      await input.fill("");
      await input.press("Tab");
      assert.equal(await input.evaluate((el) => (el as HTMLInputElement).validity.valueMissing), true);
      assert.notEqual(await page.locator("#settings-feedback").textContent(), "settings");
      await input.fill(previous);
      const [restored] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings" && (response.request().postDataJSON() as Record<string, unknown>)[key] === Number(previous)),
        input.press("Tab"),
      ]);
      assert.equal(restored.ok(), true);
      await page.waitForFunction(() => document.getElementById("settings-feedback")?.textContent === "Saved.");
      assert.deepEqual(settingsWrites.slice(writesBefore), [{ [key]: Number(previous) }]);
      assert.equal(app.library.settings().promoteAfter, 5);
      assert.equal(app.library.settings().actTimeoutMs, 4_500_000);
    }
    await page.locator("#settings-advanced > summary").click();
    assert.equal(await page.locator("#sync-server").inputValue(), "https://registry-a.test");
    const drafts = [
      ["sync-server", "https://registry-b.test"], ["pair-code", "SYNC1234"],
      ["invite-secret", "synthetic-invite"], ["device-name", "Fixture Mac"], ["relay-code", "RELAY123"],
    ] as const;
    for (const [id, value] of drafts) await page.locator(`#${id}`).fill(value);
    await page.locator("#sync-server").focus();
    await page.locator("#sync-server").press("Tab");
    await page.locator("#remote-mcp").check();
    await eventually(() => app.library.settings().remoteMcp === true);
    await page.waitForFunction(() => document.getElementById("remote-state")?.textContent === "On, not paired");
    assert.match(await page.locator('[data-settings-jump="remote"]').innerText(), /On, not paired/);
    assert.equal(await page.locator("#relay-code").isVisible(), true);
    for (const [id, value] of drafts) assert.equal(await page.locator(`#${id}`).inputValue(), value);
    await page.locator("#remote-mcp").uncheck();
    await eventually(() => app.library.settings().remoteMcp === false);
    await page.locator('[data-settings-jump="ai"]').click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), "set-ai");
    await page.locator("#page-engine").selectOption("agent-browser");
    await page.locator("#chrome-profile").selectOption("Profile 1");
    await page.locator("#chrome-profile-extensions").check();
    await page.locator("#keep-agent-browser-open").check();
    await page.locator("#circuit-limit").fill("7");
    await page.locator("#circuit-limit").press("Enter");
    await eventually(() => app.library.settings().circuitLimit === 7);
    await page.waitForFunction(() => (document.getElementById("circuit-limit") as HTMLInputElement)?.defaultValue === "7");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "circuit-limit");
    assert.equal(await page.locator("#page-engine").inputValue(), "agent-browser");
    assert.equal(await page.locator("#chrome-profile").inputValue(), "Profile 1");
    assert.equal(await page.locator("#chrome-profile").isEnabled(), true);
    assert.equal(await page.locator("#chrome-profile-extensions").isEnabled(), true);
    assert.equal(await page.locator("#chrome-profile-extensions").isChecked(), true);
    assert.equal(await page.locator("#keep-agent-browser-open").isChecked(), true);
    await page.locator("#save-engine").click();
    await eventually(() => app.library.settings().pageEngine === "agent-browser" && app.library.settings().chromeProfile === "Profile 1" && app.library.settings().chromeProfileExtensions?.["Profile 1"] === true);
    await page.waitForFunction(() => document.getElementById("engine-feedback")?.textContent === "Engine choice saved. It applies to the next run.");
    await page.locator("#save-agent-browser-lifetime").click();
    await eventually(() => app.library.settings().keepAgentBrowserOpen === true);
    assert.equal(await page.locator("#settings-advanced").evaluate((el) => (el as HTMLDetailsElement).open), true);
    for (const [id, value] of drafts) assert.equal(await page.locator(`#${id}`).inputValue(), value);
    await Promise.all([
      page.waitForResponse((response) => response.url().endsWith("/api/sync/pair")),
      page.locator("#pair").click(),
    ]);
    assert.deepEqual(pairRequest, { server: "https://registry-b.test", code: "SYNC1234", secret: "synthetic-invite", name: "Fixture Mac" });
    await page.waitForFunction(() => document.getElementById("toasts")?.textContent?.includes("Pair fixture rejected"));
    for (const id of ["pair-code", "invite-secret", "relay-code"]) assert.equal(await page.locator(`#${id}`).inputValue(), drafts.find(([key]) => key === id)?.[1]);
    syncPairOk = true;
    await page.locator("#pair").click();
    await page.waitForFunction(() => (document.getElementById("invite-secret") as HTMLInputElement)?.placeholder === "Saved on this Mac");
    assert.equal(await page.locator("#pair-code").inputValue(), "");
    assert.equal(await page.locator("#invite-secret").inputValue(), "");
    const relayInput = await page.locator("#relay-code").elementHandle();
    await page.locator("#relay-pair").click();
    await page.waitForFunction((input) => !input?.isConnected, relayInput);
    await relayInput?.dispose();
    assert.deepEqual(relayRequest, { code: "RELAY123" });
    assert.equal(await page.locator("#relay-code").inputValue(), "RELAY123");
    relayPairOk = true;
    await page.locator("#relay-pair").click();
    await page.waitForFunction(() => document.getElementById("relay-status")?.textContent?.startsWith("Connected."));
    assert.equal(await page.locator("#relay-code").inputValue(), "");
    assert.equal(settingsWrites.some((body) => body !== null && typeof body === "object" && "syncServer" in body), false);
    assert.equal(app.library.settings().syncServer, undefined);
    await page.locator("#chrome-profile-extensions").uncheck();
    await page.locator("#keep-agent-browser-open").uncheck();
    await page.locator("#page-engine").selectOption("old");
    await page.locator("#promote-after").fill("6");
    await page.locator("#promote-after").press("Tab");
    await eventually(() => app.library.settings().promoteAfter === 6);
    await page.waitForFunction(() => (document.getElementById("promote-after") as HTMLInputElement)?.defaultValue === "6");
    assert.equal(await page.locator("#page-engine").inputValue(), "old");
    assert.equal(await page.locator("#chrome-profile").isDisabled(), true);
    assert.equal(await page.locator("#chrome-profile-extensions").isDisabled(), true);
    assert.equal(await page.locator("#chrome-profile-extensions").isChecked(), false);
    assert.equal(await page.locator("#keep-agent-browser-open").isChecked(), false);
    await page.locator("#save-engine").click();
    await eventually(() => app.library.settings().pageEngine === "old" && app.library.settings().chromeProfileExtensions?.["Profile 1"] === false);
    await page.locator("#save-agent-browser-lifetime").click();
    await eventually(() => app.library.settings().keepAgentBrowserOpen === false);
    await page.locator("#act-minutes").selectOption("custom");
    await page.locator("#act-custom").fill("1");
    await page.locator("#act-custom").press("Tab");
    await eventually(() => app.library.settings().actTimeoutMs === 60_000);
    await page.waitForFunction(() => document.querySelector('#act-minutes option:checked')?.textContent === "1 minute");
    await page.locator("#theme").selectOption("dark");
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    for (const width of [1280, 720, 390, 320]) {
      await page.setViewportSize({ width, height: 820 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `page overflows at ${width}`);
      assert.ok(await page.locator("#content").evaluate((el) => el.scrollWidth <= el.clientWidth), `Settings overflows at ${width}`);
    }
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.evaluate(() => { document.documentElement.dataset.baoNative = "true"; });
    for (const width of [1200, 1060, 720]) {
      await page.setViewportSize({ width, height: 820 });
      const fits = await page.locator("#screen-list > .pane-bar").evaluate((bar) => {
        const bounds = bar.getBoundingClientRect();
        return [...bar.querySelectorAll("h1, p")].every((el) => {
          const text = el.getBoundingClientRect();
          return text.top >= bounds.top && text.bottom <= bounds.bottom;
        });
      });
      assert.equal(fits, true, `native Settings header spills at ${width}px`);
    }
    await page.evaluate(() => { delete document.documentElement.dataset.baoNative; });
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.locator('#rail [data-place="runs"]').click();
    await page.locator('#rail [data-place="settings"]').click();
    await page.locator("#set-runs").waitFor();
    assert.equal(await page.locator('[data-settings-jump="runs"]').getAttribute("aria-current"), "true");
    assert.equal(await page.locator("#settings-feedback").innerText(), "");
    page.once("dialog", (dialog) => dialog.dismiss());
    await page.locator('#settings [data-remove]').click();
    assert.equal(await page.locator('#settings [data-remove]').count(), 1);
    await page.locator('#settings [data-screen="logins"]').click();
    await page.locator("#login-site").waitFor();
    page.once("dialog", (dialog) => dialog.accept());
    await page.locator('[data-remove]').click();
    await page.waitForFunction(() => (document.getElementById("saved-logins")?.textContent || "").includes("No sites yet"));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("the first Settings visit keeps the saved Chrome profile", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-settings-profile-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  let release: (() => void) | undefined;
  const released = new Promise<void>((resolve) => { release = resolve; });
  try {
    for (const directory of ["Default", "Profile 2"]) await mkdir(path.join(home, "profiles", directory), { recursive: true });
    await writeFile(path.join(home, "profiles", "Local State"), JSON.stringify({ profile: { info_cache: {
      Default: { name: "Fixture Default" }, "Profile 2": { name: "Fixture Two", user_name: "two@example.test" },
    } } }));
    app.library.updateSettings({ pageEngine: "old", chromeProfile: "Profile 2" });
    const page = await browser.newPage();
    await page.route("**/api/chrome-profiles", async (route) => {
      const response = await route.fetch();
      await released;
      await route.fulfill({ response });
    });
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#rail [data-place="settings"]').click();
    await page.locator("#settings-advanced > summary").click();
    assert.equal(await page.locator("#chrome-profile option").count(), 1);
    release?.();
    await page.waitForFunction(() => document.querySelector<HTMLOptionElement>('#chrome-profile option[value="Profile 2"]')?.defaultSelected);
    assert.equal(await page.locator("#chrome-profile").inputValue(), "Profile 2");
    const [response] = await Promise.all([
      page.waitForResponse((item) => item.request().method() === "PUT" && new URL(item.url()).pathname === "/api/settings"),
      page.locator("#save-engine").click(),
    ]);
    assert.equal(response.ok(), true);
    assert.equal((response.request().postDataJSON() as Record<string, unknown>).chromeProfile, "Profile 2");
    assert.equal(app.library.settings().chromeProfile, "Profile 2");
    assert.equal(app.library.settings().pageEngine, "old");
    await page.waitForFunction(() => document.getElementById("engine-feedback")?.textContent === "Engine choice saved. It applies to the next run.");
    await page.locator("#page-engine").selectOption("agent-browser");
    assert.equal(await page.locator("#chrome-profile").inputValue(), "Profile 2");
    assert.equal(await page.locator("#chrome-profile-extensions").isEnabled(), true);
  } finally {
    release?.();
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("an earlier Settings save cannot erase a later numeric edit", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-settings-overlap-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const writes: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings") writes.push(request.postDataJSON() as unknown);
    });
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#rail [data-place="settings"]').click();
    await page.locator("#promote-after").waitFor();
    let hold: { arrive: () => void; released: Promise<void> } | undefined;
    await page.route("**/api/settings", async (route) => {
      const current = hold;
      hold = undefined;
      if (!current) return route.continue();
      const response = await route.fetch();
      current.arrive();
      await current.released;
      await route.fulfill({ response });
    });
    for (const pollBeforeEdit of [false, true]) for (const [policy, selector, key, value] of [
      ["approve", "#promote-after", "promoteAfter", "5"], ["auto", "#promote-after", "promoteAfter", ""],
      ["approve", "#act-custom", "actTimeoutMin", "75"], ["auto", "#act-custom", "actTimeoutMin", ""],
    ] as const) {
      let arrive: (() => void) | undefined;
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => { arrive = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      hold = { arrive: () => arrive?.(), released };
      try {
        await page.locator(`label[for="heal-${policy}"]`).click();
        await held;
        if (pollBeforeEdit) await page.waitForFunction((policy) => (document.getElementById(`heal-${policy}`) as HTMLInputElement)?.defaultChecked, policy);
        if (selector === "#act-custom") await page.locator("#act-minutes").selectOption("custom");
        const input = page.locator(selector);
        const writesBefore = writes.length;
        await input.fill(value);
        if (!value) await input.press("Tab");
        const focusAfterEdit = await page.evaluate(() => document.activeElement?.id);
        assert.ok(focusAfterEdit);
        if (!value) assert.notEqual(focusAfterEdit, selector.slice(1));
        release?.();
        await page.waitForFunction(() => document.getElementById("settings-feedback")?.textContent === "Saved.");
        assert.equal(await input.inputValue(), value);
        assert.equal(await input.evaluate((element) => (element as HTMLInputElement).validity.valueMissing), !value);
        assert.equal(await page.evaluate(() => document.activeElement?.id), focusAfterEdit);
        if (!value) {
          assert.equal(await page.locator(`${selector}-error`).isVisible(), true);
          assert.notEqual(await page.locator(`${selector}-error`).textContent(), "");
        }
        assert.equal(await input.isVisible(), true);
        assert.equal(await page.locator("#settings-feedback").textContent(), "Saved.");
        assert.deepEqual(writes.slice(writesBefore), []);
        const saved = value || "7";
        if (!value) await input.fill(saved);
        const [response] = await Promise.all([
          page.waitForResponse((item) => item.request().method() === "PUT" && new URL(item.url()).pathname === "/api/settings" && (item.request().postDataJSON() as Record<string, unknown>)[key] === Number(saved)),
          input.press("Tab"),
        ]);
        assert.equal(response.ok(), true);
        await page.waitForFunction(({ selector, saved }) => (document.querySelector(selector) as HTMLInputElement)?.defaultValue === saved && document.getElementById("settings-feedback")?.textContent === "Saved.", { selector, saved });
        assert.equal(key === "promoteAfter" ? app.library.settings().promoteAfter : app.library.settings().actTimeoutMs, Number(saved) * (key === "promoteAfter" ? 1 : 60_000));
        assert.deepEqual(writes.slice(writesBefore), [{ [key]: Number(saved) }]);
      } finally {
        release?.();
      }
    }
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("Enter commits each edited number once without waiting for blur", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-settings-enter-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const writes: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings") writes.push(request.postDataJSON() as unknown);
    });
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#rail [data-place="settings"]').click();
    await page.locator("#settings-advanced > summary").click();
    for (const [selector, key, aboveMax] of [["#promote-after", "promoteAfter", "21"], ["#act-custom", "actTimeoutMin", "1441"], ["#circuit-limit", "circuitLimit", "51"]] as const) {
      if (selector === "#act-custom") await page.locator("#act-minutes").selectOption("custom");
      const input = page.locator(selector);
      const writesBefore = writes.length;
      const saved = await input.inputValue();
      for (const [invalid, validity] of [["", "valueMissing"], ["0", "rangeUnderflow"], [aboveMax, "rangeOverflow"]] as const) {
        for (const direction of ["Tab", "Shift+Tab"]) {
          await input.fill(invalid);
          await input.press(direction);
          const target = await page.evaluate(() => document.activeElement?.id);
          assert.ok(target);
          assert.notEqual(target, selector.slice(1));
          assert.equal(await input.inputValue(), invalid);
          assert.equal(await input.evaluate((element, validity) => (element as HTMLInputElement).validity[validity], validity), true);
          assert.equal(await page.locator(`${selector}-error`).isVisible(), true);
          assert.notEqual(await page.locator(`${selector}-error`).textContent(), "");
          await page.waitForResponse((item) => new URL(item.url()).pathname === "/api/state");
          assert.equal(await page.evaluate(() => document.activeElement?.id), target);
          assert.equal(await input.inputValue(), invalid);
          assert.deepEqual(writes.slice(writesBefore), []);
        }
      }
      await input.focus();
      await input.press("ControlOrMeta+A");
      await input.pressSequentially(saved);
      await input.press("Enter");
      await input.press("Tab");
      await page.waitForResponse((item) => new URL(item.url()).pathname === "/api/state");
      assert.deepEqual(writes.slice(writesBefore), []);
      if (selector === "#act-custom") await page.locator("#act-minutes").selectOption("custom");
      await input.focus();
      await input.press("ControlOrMeta+A");
      await input.press("4");
      const [response] = await Promise.all([
        page.waitForResponse((item) => item.request().method() === "PUT" && new URL(item.url()).pathname === "/api/settings" && (item.request().postDataJSON() as Record<string, unknown>)[key] === 4),
        input.press("Enter"),
      ]);
      assert.equal(response.ok(), true);
      await page.waitForFunction((selector) => (document.querySelector(selector) as HTMLInputElement)?.defaultValue === "4" && document.getElementById("settings-feedback")?.textContent === "Saved.", selector);
      if (selector !== "#act-custom") {
        assert.equal(await page.evaluate(() => document.activeElement?.id), selector.slice(1));
        await input.press("Enter");
      }
      const refreshed = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/state");
      if (selector === "#act-custom") await page.locator("#act-minutes").focus();
      await page.keyboard.press("Tab");
      await refreshed;
      assert.deepEqual(writes.slice(writesBefore), [{ [key]: 4 }]);
    }
    assert.equal(app.library.settings().promoteAfter, 4);
    assert.equal(app.library.settings().actTimeoutMs, 240_000);
    assert.equal(app.library.settings().circuitLimit, 4);
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("a clean focused number adopts external updates without writing back", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-settings-external-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const writes: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() === "PUT" && new URL(request.url()).pathname === "/api/settings") writes.push(request.postDataJSON() as unknown);
    });
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#rail [data-place="settings"]').click();
    await page.locator("#settings-advanced > summary").click();
    for (const [selector, initial, value, patch] of [
      ["#promote-after", "3", "6", { promoteAfter: 6 }],
      ["#act-custom", "120", "60", { actTimeoutMs: 3_600_000 }],
      ["#circuit-limit", "3", "9", { circuitLimit: 9 }],
    ] as const) {
      if (selector === "#act-custom") await page.locator("#act-minutes").selectOption("custom");
      const input = page.locator(selector);
      assert.equal(await input.inputValue(), initial);
      await input.focus();
      await input.press("Tab");
      await input.focus();
      app.library.updateSettings(patch);
      await page.waitForFunction(({ selector, value }) => (document.querySelector(selector) as HTMLInputElement)?.defaultValue === value, { selector, value });
      assert.equal(await input.inputValue(), value);
      assert.equal(await page.evaluate(() => document.activeElement?.id), selector.slice(1));
      const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/state");
      await input.press("Tab");
      await refreshed;
      assert.equal(await input.inputValue(), value);
      assert.deepEqual(writes, []);
    }
    assert.equal(app.library.settings().promoteAfter, 6);
    assert.equal(app.library.settings().actTimeoutMs, 3_600_000);
    assert.equal(app.library.settings().circuitLimit, 9);
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("Settings Stop survives restart and stops a changed fixture step without a heal", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-settings-stop-"));
  const previousHome = process.env.HOME;
  const previousFixture = process.env.BAO_HEAL_FIXTURE;
  process.env.HOME = home;
  process.env.BAO_HEAL_FIXTURE = "1";
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
  const options = { home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") };
  let app = await startApp(options);
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#rail [data-place="settings"]').click();
    await page.locator('label[for="heal-never"]').click();
    await eventually(() => app.library.settings().heal === "never");
    await app.close();
    app = await startApp(options);
    assert.equal(app.library.settings().heal, "never");
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#rail [data-place="settings"]').click();
    assert.equal(await page.getByRole("radio", { name: "Stop", exact: true }).isChecked(), true);
    const workflow: WorkflowV2 = {
      schema: "bao.workflow/v2", version: 2, id: "global-never", name: "Changed button Stop",
      startUrl: `http://127.0.0.1:${app.port}/fixture`, inputs: [], createdAt: 1,
      steps: [
        { id: "changed", index: 0, action: "click", label: "Click the missing login button", surface: "dom", identity: { surface: "dom", role: "button", testId: "missing-login", path: [] }, timeoutMs: 100 },
        { id: "after-miss", index: 1, action: "note", label: "After the changed button", surface: "dom", timeoutMs: 0 },
      ],
    };
    app.library.save(workflow);
    await page.locator('#rail [data-place="workflows"]').click();
    await page.locator(`[data-open-workflow="${workflow.id}"]`).click();
    await page.locator(`#main [data-screen="replay"][data-workflow="${workflow.id}"]`).click();
    assert.match(await page.locator("#wf-heal option:checked").innerText(), /Stop/);
    const [response] = await Promise.all([
      page.waitForResponse((res) => res.url().endsWith("/api/replay") && res.request().method() === "POST"),
      page.locator("#run").click(),
    ]);
    assert.equal(response.ok(), true);
    const run = await response.json() as { runId: string; status: string; modelCalls: number; failure?: { stepId: string } };
    assert.equal(run.status, "failed");
    assert.equal(run.modelCalls, 0);
    const saved = app.library.readRun(run.runId);
    assert.equal(saved.heals.length, 0);
    assert.equal((saved.steps as { id: string; status: string }[]).find((step) => step.id === "after-miss")?.status, "pending");
    assert.equal(run.failure?.stepId, "changed");
    await page.locator('#rail [data-place="runs"]').click();
    await page.locator(`[data-open-run="${run.runId}"]`).first().click();
    await page.locator("#main").getByText("Click the missing login button", { exact: false }).first().waitFor();
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousFixture === undefined) delete process.env.BAO_HEAL_FIXTURE;
    else process.env.BAO_HEAL_FIXTURE = previousFixture;
    await rm(home, { recursive: true, force: true });
  }
});

for (const { mode, label, status, modelCalls, heals, laterStep } of [
  { mode: "auto", label: "Heal it", status: "passed", modelCalls: 1, heals: 1, laterStep: "passed" },
  { mode: "approve", label: "Ask me", status: "paused", modelCalls: 1, heals: 1, laterStep: "pending" },
  { mode: "never", label: "Stop", status: "failed", modelCalls: 0, heals: 0, laterStep: "pending" },
] as const) {
  test(`Settings ${label} saves through the UI and applies to a changed fixture step`, { timeout: 60_000 }, async (t) => {
    const home = await mkdtemp(path.join(tmpdir(), `bao-settings-${mode}-`));
    const previousHome = process.env.HOME;
    const previousFixture = process.env.BAO_HEAL_FIXTURE;
    process.env.HOME = home;
    process.env.BAO_HEAL_FIXTURE = "1";
    t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
    const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
    const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
      await page.goto(`http://127.0.0.1:${app.port}`);
      await page.locator('#rail [data-place="settings"]').click();
      for (let save = 0; save < (mode === "never" ? 2 : 1); save++) {
        const otherMode = mode === "approve" ? "auto" : "approve";
        await page.locator(`label[for="heal-${otherMode}"]`).click();
        await eventually(() => app.library.settings().heal === otherMode);
        const [savedSetting] = await Promise.all([
          page.waitForResponse((response) => response.request().method() === "PUT" && new URL(response.url()).pathname === "/api/settings" && (response.request().postDataJSON() as { heal?: string }).heal === mode),
          page.locator(`label[for="heal-${mode}"]`).click(),
        ]);
        assert.equal(savedSetting.ok(), true);
        await eventually(() => app.library.settings().heal === mode);
      }
      const workflow: WorkflowV2 = {
        schema: "bao.workflow/v2", version: 2, id: `global-${mode}`, name: `Changed button ${mode}`,
        startUrl: `http://127.0.0.1:${app.port}/fixture`, inputs: [], createdAt: 1,
        steps: [
          { id: "changed", index: 0, action: "click", label: "Click the missing login button", surface: "dom", identity: { surface: "dom", role: "button", testId: "missing-login", path: [] }, timeoutMs: 100 },
          { id: "after-miss", index: 1, action: "note", label: "After the changed button", surface: "dom", timeoutMs: 0 },
        ],
      };
      app.library.save(workflow);
      await page.locator('#rail [data-place="workflows"]').click();
      await page.locator(`[data-open-workflow="${workflow.id}"]`).click();
      await page.locator(`#main [data-screen="replay"][data-workflow="${workflow.id}"]`).click();
      assert.match(await page.locator("#wf-heal option:checked").innerText(), new RegExp(label));
      const [response] = await Promise.all([
        page.waitForResponse((res) => res.url().endsWith("/api/replay") && res.request().method() === "POST"),
        page.locator("#run").click(),
      ]);
      assert.equal(response.ok(), true);
      const run = await response.json() as { runId: string; status: string; modelCalls: number; failure?: { stepId: string } };
      assert.equal(run.status, status);
      assert.equal(run.modelCalls, modelCalls);
      const saved = app.library.readRun(run.runId);
      assert.equal(saved.heals.length, heals);
      assert.equal((saved.steps as { id: string; status: string }[]).find((step) => step.id === "after-miss")?.status, laterStep);
      if (mode === "never") {
        assert.equal(run.failure?.stepId, "changed");
        await page.locator('#rail [data-place="runs"]').click();
        await page.locator(`[data-open-run="${run.runId}"]`).first().click();
        await page.locator("#main").getByText("Click the missing login button", { exact: false }).first().waitFor();
      }
    } finally {
      await browser.close();
      await app.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousFixture === undefined) delete process.env.BAO_HEAL_FIXTURE;
      else process.env.BAO_HEAL_FIXTURE = previousFixture;
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("pending CLI imports and the Logins profile picker keep separate handlers", { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-settings-import-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
  const app = await startApp({ home: path.join(home, "library"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const profiles = [{ directory: "Default", name: "First profile" }, { directory: "Profile 1", name: "Second profile" }];
    let pendingId: string | null = null;
    const answers: unknown[] = [];
    await page.route("**/api/state", async (route) => {
      const response = await route.fetch();
      const state = await response.json() as StateFixture;
      await route.fulfill({ response, json: { ...state, pendingImport: pendingId ? { id: pendingId, phase: "pick", domain: "example.test", profiles } : null } });
    });
    await page.route("**/api/import-login/answer", async (route) => {
      answers.push(route.request().postDataJSON());
      pendingId = null;
      await route.fulfill({ json: {} });
    });
    await page.route("**/api/login-import/preview", async (route) => {
      await route.fulfill({ json: {
        site: "https://example.test", host: "example.test", botCookies: "skip", preferred: "Default", chromeFound: true, keychainNote: null,
        profiles: profiles.map((profile) => ({ ...profile, email: "", avatarDataUrl: null, avatarColor: null, matching: 1, expired: 0, botManager: 0, willImport: 1, localStorageItems: 0, indexedDbOrigins: 0, cookieDb: "network" })),
      } });
    });
    for (const screen of ["settings", "logins"]) {
      pendingId = `cli-${screen}`;
      await page.goto(`http://127.0.0.1:${app.port}`);
      await page.locator('#rail [data-place="settings"]').click();
      if (screen === "logins") {
        await page.locator('#settings [data-screen="logins"]').click();
        await page.locator("#login-site").fill("https://example.test");
        await page.locator("#show-profiles").click();
        await page.locator('#main [data-import-profile="Profile 1"]').click();
        assert.equal(await page.locator('#main [data-import-profile="Profile 1"]').getAttribute("aria-pressed"), "true");
        assert.equal(answers.length, 1);
        assert.match(await page.locator("#import-selected").innerText(), /Second profile/);
      }
      await page.locator('#act #import-pick [data-import-profile="Profile 1"]').click();
      await page.waitForFunction(() => !document.getElementById("import-pick"));
      assert.deepEqual(answers.at(-1), { id: `cli-${screen}`, accept: true, profile: "Profile 1" });
    }
    assert.equal(answers.length, 2);
  } finally {
    await browser.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});
