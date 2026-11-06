import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { testChromium as chromium } from "../../src/test-browser.js";
import { startApp } from "../../src/app/server";
import { desktopMcpFile } from "../../src/app/desktop-mcp-config";

test("Settings previews and confirms desktop config changes on an isolated HOME", { timeout: 90_000 }, async () => {
  assert.ok(process.env.BAO_TEST_BROWSER, "Run with laneChildEnv so Chromium is pinned");
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-install-ui-")));
  const previousHome = process.env.HOME;
  const previousBao = process.env.BAO_HOME;
  process.env.HOME = home;
  const app = await startApp({ home: path.join(home, "bao"), extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const origin = `http://127.0.0.1:${app.port}`;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.BAO_TEST_BROWSER, args: ["--use-mock-keychain", "--password-store=basic"] });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    for (const requestOrigin of [undefined, "https://example.test", "null"]) {
      const response = await fetch(`${origin}/api/desktop-mcp/preview`, {
        method: "POST", headers: { "content-type": "application/json", ...(requestOrigin ? { origin: requestOrigin } : {}) }, body: JSON.stringify({ client: "claude" }),
      });
      assert.equal(response.status, 403);
    }
    const claude = desktopMcpFile(home, 'claude');
    const chatgpt = desktopMcpFile(home, 'chatgpt');
    await page.goto(origin);
    await page.locator('[data-screen="settings"]').click();
    let releasePreview!: () => void;
    const previewReady = new Promise<void>((resolve) => { releasePreview = resolve; });
    await page.route('**/api/desktop-mcp/preview', async (route) => { await previewReady; await route.continue(); });
    await page.getByRole('button', { name: 'Add to Claude', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-desktop-mcp]')).every((button) => button.disabled));
    assert.equal(await page.getByRole('button', { name: 'Add to ChatGPT', exact: true }).isDisabled(), true);
    releasePreview();
    await page.waitForSelector('#desktop-mcp-confirm[open]');
    await page.unroute('**/api/desktop-mcp/preview');
    assert.match(await page.locator('#desktop-mcp-confirm').innerText(), /Add Bao to Claude Desktop\?/);
    assert.match(await page.locator('pre[aria-label="Exact config diff"]').innerText(), /bao-mcp/);
    const contrast = await page.evaluate(() => {
      const original = document.documentElement.dataset.theme;
      document.documentElement.dataset.theme = 'dark';
      const luminance = (rgb: string): number => {
        const [r, g, b] = rgb.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((n) => n / 255).map((n) => n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4);
        return r * 0.2126 + g * 0.7152 + b * 0.0722;
      };
      const ratio = (a: string, b: string): number => {
        const x = luminance(a), y = luminance(b);
        return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
      };
      const button = getComputedStyle(document.getElementById('desktop-mcp-write')!);
      const dialog = getComputedStyle(document.getElementById('desktop-mcp-confirm')!);
      const result = { text: ratio(button.color, button.backgroundColor), boundary: ratio(button.backgroundColor, dialog.backgroundColor) };
      if (original === undefined) delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = original;
      return result;
    });
    assert.ok(contrast.text >= 4.5, `primary text contrast ${contrast.text}`);
    assert.ok(contrast.boundary >= 3, `primary boundary contrast ${contrast.boundary}`);
    assert.equal(existsSync(claude), false);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#desktop-mcp-confirm', { state: 'detached' });
    assert.equal(existsSync(claude), false);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-desktop-mcp')), 'claude');

    await page.getByRole('button', { name: 'Add to Claude', exact: true }).click();
    await page.locator('#desktop-mcp-write').click();
    await page.waitForSelector('#desktop-mcp-confirm', { state: 'detached' });
    assert.match(await page.locator('#desktop-mcp-feedback').innerText(), /Restart Claude Desktop/);
    const claudeText = readFileSync(claude, 'utf8');
    assert.match(claudeText, /bao-mcp/);
    await page.getByRole('button', { name: 'Add to Claude', exact: true }).click();
    await page.waitForSelector('#desktop-mcp-confirm[open]');
    assert.match(await page.locator('#desktop-mcp-confirm').innerText(), /already set up/);
    assert.equal(await page.locator('#desktop-mcp-write').count(), 0);
    await page.locator('#desktop-mcp-cancel').click();
    await page.waitForSelector('#desktop-mcp-confirm', { state: 'detached' });
    assert.equal(readdirSync(path.dirname(claude)).length, 1);

    mkdirSync(path.dirname(chatgpt), { recursive: true });
    const before = '# fixture only\nmodel="keep"\n[mcp_servers.bao]\ncommand="old"\ndefault_tools_approval_mode="approve"\n';
    writeFileSync(chatgpt, before);
    await page.getByRole('button', { name: 'Add to ChatGPT', exact: true }).click();
    await page.waitForSelector('#desktop-mcp-confirm[open]');
    assert.match(await page.locator('#desktop-mcp-confirm').innerText(), /Update Bao in ChatGPT\?/);
    assert.match(await page.locator('#desktop-mcp-confirm').innerText(), /shared Codex config/);
    await page.getByRole('button', { name: 'Leave unchanged' }).click();
    await page.waitForSelector('#desktop-mcp-confirm', { state: 'detached' });
    assert.equal(readFileSync(chatgpt, 'utf8'), before);
    await page.getByRole('button', { name: 'Add to ChatGPT', exact: true }).click();
    await page.locator('#desktop-mcp-write').click();
    await page.waitForSelector('#desktop-mcp-confirm', { state: 'detached' });
    assert.match(readFileSync(chatgpt, 'utf8'), /default_tools_approval_mode="prompt"/);
    const backup = readdirSync(path.dirname(chatgpt)).find((file) => file.includes('.bao-backup-'));
    assert.ok(backup);
    assert.equal(readFileSync(path.join(path.dirname(chatgpt), backup), 'utf8'), before);

    writeFileSync(chatgpt, before);
    await page.getByRole('button', { name: 'Add to ChatGPT', exact: true }).click();
    await page.waitForSelector('#desktop-mcp-confirm[open]');
    writeFileSync(chatgpt, before + '# changed after preview\n');
    await page.locator('#desktop-mcp-write').click();
    await page.waitForFunction(() => !!document.getElementById('desktop-mcp-write-error')?.textContent);
    assert.match(await page.locator('#desktop-mcp-write-error').innerText(), /changed since this preview/);
    assert.equal(await page.locator('#desktop-mcp-write').isDisabled(), true);
    await page.locator('#desktop-mcp-cancel').click();
    await page.waitForSelector('#desktop-mcp-confirm', { state: 'detached' });
    assert.ok(readFileSync(chatgpt, 'utf8').endsWith('# changed after preview\n'));

    await page.setViewportSize({ width: 320, height: 800 });
    await page.getByRole('button', { name: 'Add to ChatGPT', exact: true }).click();
    await page.waitForSelector('#desktop-mcp-confirm[open]');
    assert.equal(await page.evaluate(() => {
      const dialog = document.querySelector('dialog')!;
      return dialog.scrollWidth <= dialog.clientWidth && document.documentElement.scrollWidth <= innerWidth;
    }), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'desktop-mcp-cancel');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'desktop-mcp-write');
    assert.equal(await page.locator('#desktop-mcp-write').evaluate((button) => getComputedStyle(button).outlineStyle), 'solid');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#desktop-mcp-confirm', { state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-desktop-mcp')), 'chatgpt');

    writeFileSync(chatgpt, 'bad = [');
    await page.getByRole('button', { name: 'Add to ChatGPT', exact: true }).click();
    await page.waitForFunction(() => !!document.getElementById('desktop-mcp-error')?.textContent);
    assert.match(await page.locator('#desktop-mcp-error').innerText(), /Nothing was written.*preview again/s);
    assert.equal(readFileSync(chatgpt, 'utf8'), 'bad = [');
  } finally {
    await browser?.close();
    await app.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousBao === undefined) delete process.env.BAO_HOME; else process.env.BAO_HOME = previousBao;
    rmSync(home, { recursive: true, force: true });
  }
});
