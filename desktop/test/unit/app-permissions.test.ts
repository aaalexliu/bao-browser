import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import type { HelperStatus } from "../../src/helper-capabilities";
import { MacOsHelper } from "../../src/proxy/os-macos";
import { testChromium } from "../../src/test-browser";
import { scaledMs } from "../runtime";

test("app status and UI never ask for retired Chrome helper permissions", { timeout: scaledMs(60_000) }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-permissions-"));
  const previousHome = process.env.HOME;
  const previousHelper = process.env.BAO_OS_HELPER;
  process.env.HOME = home;
  process.env.BAO_OS_HELPER = __filename;
  const calls: string[][] = [];
  t.mock.method(MacOsHelper.prototype, "exec", async (args: string[]) => {
    calls.push(args);
    return { ok: true, accessibility: false };
  });
  const app = await startApp({ home, port: 0, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const url = `http://127.0.0.1:${app.port}`;
    const state = await fetch(`${url}/api/state`).then((res) => res.json()) as { helper: HelperStatus };
    assert.equal(state.helper.label, process.platform === "darwin" ? "helper available" : "helper off");
    assert.equal(state.helper.accessibility, false);
    assert.equal(state.helper.screenCapture, false);
    assert.equal("automation" in state.helper, false);
    assert.deepEqual(state.helper.capabilities.map((row) => row.id), process.platform === "darwin" ? ["window-capture", "mcp-ax"] : []);
    const before = calls.length;
    const retired = await fetch(`${url}/api/helper/automation`, { method: "POST" });
    assert.equal(retired.status, 404);
    assert.equal(calls.length, before, "retired route must not invoke the helper");
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" });
    await page.goto(url);
    await page.waitForSelector("#rail nav");
    for (const pageEngine of ["old", "agent-browser"] as const) {
      app.library.updateSettings({ pageEngine });
      await page.reload();
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => { localStorage.setItem("bao-theme", value); }, theme);
        await page.reload();
        await page.locator('#rail [data-place="workflows"]').click();
        assert.equal(await page.locator("#onboarding, #perm-dot, #automation-ask").count(), 0);
        assert.doesNotMatch(await page.locator("#rail").innerText(), /needs permission|AX press|live Chrome|Accessibility|Automation|Screen Recording/);
        await page.locator('#rail [data-place="settings"]').click();
        const mac = page.locator("#set-perm + .settings-group");
        assert.match(await mac.innerText(), /Accessibility/);
        assert.match(await mac.innerText(), /Screen Recording/);
        assert.doesNotMatch(await mac.innerText(), /bao mcp-ax|bao remote-debugging|click and type in Chrome/);
        if (process.platform === "darwin") {
          assert.match(await mac.innerText(), /Running Chrome.*Accessibility/);
          assert.match(await mac.innerText(), /Bao profiles and Chrome copies do not need it/);
          assert.match(await mac.innerText(), /Chrome screenshots do not need it/);
          assert.match(await mac.innerText(), /Not checked/);
          assert.equal(await mac.locator('a[href^="x-apple.systempreferences:"]').count(), 1);
        } else {
          assert.match(await mac.innerText(), /does not apply on Linux/);
          assert.equal(await mac.locator("a").count(), 0);
        }
        assert.equal(await mac.locator("button").count(), 0);
        assert.equal(await page.locator("#automation-ask, #perm-dot, #onboarding").count(), 0);
      }
    }
    await page.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (new URL(target, location.href).pathname !== "/api/state") return original(input, init);
        const response = await original(input, init);
        const current = await response.json() as Record<string, unknown>;
        return new Response(JSON.stringify({
          ...current,
          helper: { label: "helper off", platform: "linux", capabilities: [] },
        }), { status: 200, headers: { "content-type": "application/json" } });
      };
    });
    await page.reload();
    await page.locator('#rail [data-place="settings"]').click();
    const linux = page.locator("#set-perm + .settings-group");
    assert.equal(await linux.getByText("Mac only", { exact: true }).count(), 2);
    assert.equal(await linux.locator("a, button").count(), 0);
    assert.doesNotMatch(await linux.innerText(), /AT-SPI|Not allowed|Open System Settings/);
    assert.equal(calls.length > 0, process.platform === "darwin");
    assert.ok(calls.every((args) => args.length === 1 && args[0] === "permissions-ax"), JSON.stringify(calls));
  } finally {
    await browser.close();
    await app.close();
    if (previousHelper === undefined) delete process.env.BAO_OS_HELPER;
    else process.env.BAO_OS_HELPER = previousHelper;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("Settings shows whether Bao can read Google Chrome's folder and offers Set up", { timeout: scaledMs(60_000), skip: process.platform !== "darwin" && "Files & Folders is a macOS setting" }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-chrome-folder-"));
  const profiles = path.join(home, "profiles");
  await mkdir(path.join(profiles, "Default"), { recursive: true });
  await writeFile(path.join(profiles, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Owner" } } } }));
  const previous = { HOME: process.env.HOME, BAO_RESPONSIBLE_EXE: process.env.BAO_RESPONSIBLE_EXE, BAO_CERT_SIGNED: process.env.BAO_CERT_SIGNED };
  Object.assign(process.env, { HOME: home, BAO_RESPONSIBLE_EXE: "/Applications/Bao.app/Contents/MacOS/bao" });
  delete process.env.BAO_CERT_SIGNED;
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
  const app = await startApp({ home: path.join(home, "library"), port: 0, extensionHost: false, chromeProfilesRoot: profiles });
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${app.port}`);
    await page.locator('#rail [data-place="settings"]').click();
    const row = page.locator(".settings-row", { hasText: "Google Chrome's folder" });
    await row.waitFor();
    assert.match(await row.innerText(), /Lets Bao import a site's sign-in from Chrome and use Running Chrome\./);
    assert.match(await row.innerText(), /✓ Allowed/);
    assert.match(await row.innerText(), /Agents use their own app's switch, such as ChatGPT for Codex\./);
    assert.doesNotMatch(await row.innerText(), /Turn on/);
    assert.equal(await row.locator(".mac-permissions-setup").innerText(), "Set up");
    assert.equal(await row.locator("#chrome-folder-settings").count(), 0);

    await chmod(profiles, 0o000);
    await page.reload();
    await page.locator('#rail [data-place="settings"]').click();
    await row.waitFor();
    assert.match(await row.innerText(), /Not allowed/);
    assert.match(await row.innerText(), /Turn on Bao > Google Chrome in Files & Folders\. If it is on, turn it off and on again: macOS ties it to one build of Bao\./);
    assert.match(await page.locator(".settings-index").innerText(), /Chrome's folder not allowed/);

    process.env.BAO_CERT_SIGNED = "1";
    await page.reload();
    await page.locator('#rail [data-place="settings"]').click();
    await row.waitFor();
    assert.match(await row.innerText(), /Agents that start Bao use this switch too\./);
    assert.doesNotMatch(await row.innerText(), /turn it off and on again/);
  } finally {
    await chmod(profiles, 0o700);
    await browser.close();
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(home, { recursive: true, force: true });
  }
});
