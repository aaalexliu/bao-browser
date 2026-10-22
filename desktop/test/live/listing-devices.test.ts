// Marketplace listing and Devices against a local `vercel dev`. No deploy.
// Run: node --test desktop/test/live/listing-devices.test.ts

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { isElementCrop } from "../../../web/src/lib/png";
import { prepareImport } from "../../../web/src/lib/import-sheet";
import { releaseHash } from "../../../web/src/lib/publish";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { pairDevice, syncAll } from "../../src/v1/sync";

const shots = "/opt/cursor/artifacts/screenshots";

test("listing page and devices against local vercel dev", { timeout: 600_000 }, async () => {
  process.env.TZ = "America/New_York";
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  const root = mkdtempSync(path.join(tmpdir(), "bao-listing-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TZ: "America/New_York",
    BAO_PG_DIR: path.join(root, "pglite"),
    BAO_BLOB_DIR: path.join(root, "blobs"),
    BAO_AUTH_STUB: "1",
    BAO_CHROME_NO_SANDBOX: "1",
  };
  delete env.DATABASE_URL;
  delete env.POSTGRES_URL;
  delete env.BLOB_READ_WRITE_TOKEN;
  delete env.BLOB_STORE_ID;
  delete env.VERCEL_OIDC_TOKEN;

  const web = spawn(
    "npx",
    ["--yes", "vercel@65.0.0", "dev", "--local", "--yes", "--non-interactive", "--listen", `127.0.0.1:${port}`],
    { cwd: path.join(process.cwd(), "web"), env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  web.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  web.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));

  const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    const health = await waitHealth(origin, logs);
    assert.equal(health.driver, "pglite");
    const cookie = await signIn(origin, "owner@bao.local");
    const doc = workflow(origin);
    const home = path.join(root, "mac-a");
    const library = new Library(home);
    library.save(doc);

    const shotContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const shotPage = await shotContext.newPage();
    await shotPage.goto(`${origin}/fixture.html`, { waitUntil: "domcontentloaded" });
    const button = shotPage.locator("#login-btn");
    await button.evaluate((el) => {
      el.style.outline = "2px solid #d4532b";
      el.style.outlineOffset = "2px";
    });
    const box = await button.boundingBox();
    if (!box) throw new Error("login button missing");
    const png = await shotPage.screenshot({
      type: "png",
      clip: {
        x: Math.max(0, box.x - 24),
        y: Math.max(0, box.y - 24),
        width: Math.min(480, box.width + 48),
        height: Math.min(280, box.height + 48),
      },
    });
    await shotContext.close();
    assert.equal(isElementCrop(png), true);
    const shotDir = path.join(home, "shots", "workflows", doc.id);
    mkdirSync(shotDir, { recursive: true });
    writeFileSync(path.join(shotDir, "see.png"), png);

    await pairDevice(library, { code: await pairCode(origin, cookie), server: origin, name: "Ada's Mac" });
    const pushed = await syncAll(library, "push");
    assert.match(pushed.lastResult || "", /pushed 1/);

    const preview = prepareImport(doc);
    const reviewed = await fetch(`${origin}/api/workflows/${doc.id}/review`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        documentHash: releaseHash(preview.document),
        shots: [{ stepId: "see", png: png.toString("base64"), redacted: true }],
      }),
    });
    assert.equal(reviewed.status, 200, await reviewed.text());
    const listed = await fetch(`${origin}/api/workflows/${doc.id}/publish`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
    });
    assert.equal(listed.status, 200, await listed.text());

    mkdirSync(shots, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "America/New_York" });
    await context.addCookies([{ name: "bao_session", value: cookie.split("=")[1] || "", url: origin }]);
    const page = await context.newPage();

    await page.goto(`${origin}/marketplace`, { waitUntil: "domcontentloaded" });
    const card = page.locator(`[data-testid=listing][data-id="${doc.id}"]`);
    await card.waitFor();
    const cardText = await card.innerText();
    assert.match(cardText, /Verified by 1 replay/);
    assert.equal(cardText.includes("0 runs"), false);
    await shoot(page, "marketplace-stat-light.png");
    await chooseTheme(page, "dark");
    await shoot(page, "marketplace-stat-dark.png");
    await chooseTheme(page, "light");

    await page.goto(`${origin}/marketplace/${doc.id}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("workflow").waitFor();
    const steps = page.getByTestId("steps");
    await steps.waitFor();
    assert.match(await steps.innerText(), /Click Log in/);
    const crop = steps.locator("img");
    await crop.waitFor();
    const src = await crop.getAttribute("src");
    if (!src) throw new Error("step crop missing");
    const bytes = Buffer.from(await (await fetch(new URL(src, origin))).arrayBuffer());
    assert.equal(isElementCrop(bytes), true);
    const inputs = page.getByTestId("inputs");
    assert.match(await inputs.innerText(), /Note/);
    assert.equal(await page.locator("h2", { hasText: /^Inputs$/ }).count(), 1);
    assert.equal((await page.getByTestId("workflow").innerText()).includes("Inputs on this account"), false);
    assert.equal((await page.getByTestId("workflow").innerText()).includes("bao://"), false);
    assert.match(await page.getByTestId("perm-sites").innerText(), /127\.0\.0\.1/);
    assert.equal(await page.getByTestId("domains").count(), 0);
    const versions = await page.getByTestId("versions").innerText();
    assert.match(versions, /v1/);
    assert.match(versions, /EDT|EST/);
    await page.getByTestId("allow").click();
    await page.getByTestId("install").waitFor();
    assert.equal(await page.getByTestId("install").getAttribute("href"), `bao://import/${doc.id}`);
    await page.getByTestId("share-open").click();
    assert.equal(await page.getByTestId("import-link").getAttribute("data-copy"), `bao://import/${doc.id}`);
    assert.equal(await page.getByTestId("deeplink").getAttribute("data-copy"), `bao://workflow/${doc.id}`);
    assert.equal((await page.getByTestId("import-link").innerText()).includes("bao://"), false);
    assert.match(await page.getByTestId("report").innerText(), /Report a problem/);
    await shoot(page, "listing-detail-light.png");
    await chooseTheme(page, "dark");
    await shoot(page, "listing-detail-dark.png");
    await chooseTheme(page, "light");

    await page.goto(`${origin}/pair`, { waitUntil: "domcontentloaded" });
    const lead = await page.locator("main p").first().innerText();
    assert.match(lead, /Settings > Sync/);
    assert.equal(/bao sync/.test(lead), false);
    assert.match(await page.getByTestId("pair-cli").innerText(), /bao sync pair CODE --server THIS_ORIGIN/);
    await page.getByRole("button", { name: "New code" }).click();
    await page.getByTestId("pair-code").waitFor();
    const device = page.getByTestId("device");
    await device.waitFor();
    const deviceText = await device.innerText();
    assert.match(deviceText, /Ada's Mac/);
    assert.match(deviceText, /Last synced/);
    assert.match(deviceText, /EDT|EST/);
    assert.match(deviceText, /1 workflow/);
    await page.getByTestId("unpair").waitFor();
    await shoot(page, "devices-light.png");
    await chooseTheme(page, "dark");
    await shoot(page, "devices-dark.png");

    await page.getByTestId("unpair").click();
    await page.getByText("No devices paired yet").waitFor();
    const token = JSON.parse(readFileSync(path.join(home, "sync.json"), "utf8")).deviceToken as string;
    const again = await fetch(`${origin}/api/devices`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(again.status, 401);
    await context.close();
  } finally {
    await browser.close();
    await stop(web);
  }
});

function workflow(origin: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "listing-crop",
    name: "Read the fixture",
    startUrl: `${origin}/fixture.html`,
    createdAt: 1,
    inputs: [{ name: "note", type: "text", label: "Note", required: false, askOnImport: true }],
    steps: [{
      id: "see",
      index: 0,
      action: "click",
      label: "Click Log in",
      surface: "dom",
      timeoutMs: 8000,
      identity: { surface: "dom", path: [], id: "login-btn", testId: "login", role: "button", text: "Log in", tag: "button" },
      postcondition: { kind: "text", match: "Missing credentials", timeoutMs: 8000 },
    }],
  };
}

async function shoot(page: Page, file: string): Promise<void> {
  await page.locator("main").screenshot({ path: path.join(shots, file) });
}

async function chooseTheme(page: Page, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((value) => {
    localStorage.setItem("bao-theme", value);
    if (value === "dark") document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  }, theme);
}

async function signIn(origin: string, email: string): Promise<string> {
  const sent = await fetch(`${origin}/api/auth/magic`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = await sent.json() as { verifyUrl?: string; error?: string };
  if (!body.verifyUrl) throw new Error(body.error || "no verify link");
  const verified = await fetch(`${origin}${body.verifyUrl}`, { redirect: "manual" });
  const match = verified.headers.get("set-cookie")?.match(/bao_session=([^;]+)/);
  if (!match) throw new Error("no session cookie");
  return `bao_session=${match[1]}`;
}

async function pairCode(origin: string, cookie: string): Promise<string> {
  const res = await fetch(`${origin}/api/pair`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
  });
  const body = await res.json() as { code?: string; error?: string };
  if (!body.code) throw new Error(body.error || `no pair code (${res.status})`);
  return body.code;
}

async function waitHealth(origin: string, logs: string[]): Promise<{ ok?: boolean; driver?: string }> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 300_000) {
    try {
      const res = await fetch(`${origin}/api/health`);
      last = await res.text();
      if (res.ok) return JSON.parse(last) as { ok?: boolean; driver?: string };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`vercel dev did not start: ${last}\n${logs.join("").slice(-8000)}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 800));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
