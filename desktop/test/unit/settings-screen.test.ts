import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { MacOsHelper } from "../../src/proxy/os-macos";
import { testChromium } from "../../src/test-browser";

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
    app.library.updateSettings({ siteTrust: { "https://example.test": "allow" } });
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
    assert.equal(await page.getByRole("button", { name: "Stop", exact: true }).count(), 0);
    assert.equal(await page.getByRole("combobox", { name: "Use AI to suggest heals" }).inputValue(), "none");
    assert.deepEqual(await page.locator("#ai-source option").allTextContents(), ["None", "Cursor account", "API key…"]);
    assert.equal(await page.locator("#save-settings").count(), 0);
    assert.equal(await page.locator("#remote-permission").count(), 0);
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
    await page.locator("#circuit-limit").press("Tab");
    await eventually(() => app.library.settings().circuitLimit === 7);
    const trust = page.locator("[data-site-trust]");
    const trustId = await trust.getAttribute("id");
    assert.ok(trustId);
    await trust.focus();
    await trust.press("a");
    await trust.press("Enter");
    await page.waitForFunction(() => (document.querySelector('[data-site-trust] option[value="ask"]') as HTMLOptionElement)?.defaultSelected === true);
    await eventually(() => app.library.settings().siteTrust?.["https://example.test"] === "ask");
    assert.equal(await page.evaluate(() => document.activeElement?.id), trustId);
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
    for (const [policy, selector, key, value] of [
      ["approve", "#promote-after", "promoteAfter", "5"], ["auto", "#promote-after", "promoteAfter", ""],
      ["approve", "#act-custom", "actTimeoutMin", "75"], ["auto", "#act-custom", "actTimeoutMin", ""],
    ] as const) {
      let arrive: (() => void) | undefined;
      let release: (() => void) | undefined;
      const held = new Promise<void>((resolve) => { arrive = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      await page.route("**/api/settings", async (route) => {
        const response = await route.fetch();
        arrive?.();
        await released;
        await route.fulfill({ response });
      }, { times: 1 });
      try {
        await page.locator(`label[for="heal-${policy}"]`).click();
        await held;
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
