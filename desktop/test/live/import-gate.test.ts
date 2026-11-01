// Import sheet and the clean publish replay. Fixture pages only.
// Run after `tsc -p tsconfig.desktop.json`. Chrome needs BAO_CHROME_NO_SANDBOX=1.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { testChromium as chromium } from "../../src/test-browser.js";
import { pinTestBrowser } from "../../src/launch";
import { prepareImport } from "../../../web/src/lib/import-sheet";
import { releaseHash } from "../../../web/src/lib/publish";
import { testArtifacts } from "../artifacts";

process.env.TZ = "America/New_York";
process.env.BAO_CHROME_NO_SANDBOX = "1";
const TEST_BROWSER = pinTestBrowser();

const shots = testArtifacts("import-gate");

test("import sheet and a blocked publish", { timeout: 300_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bao-gate-live-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const fixture = `${origin}/fixture.html`;
  const logs: string[] = [];
  const webDir = path.join(process.cwd(), "web");
  execFileSync("npm", ["run", "build"], {
    cwd: webDir,
    env: { ...process.env, BAO_AUTH_STUB: "1", TZ: "America/New_York" },
    stdio: "pipe",
  });
  const web = spawn("npm", ["run", "start", "--", "--port", String(port), "-H", "127.0.0.1"], {
    detached: true,
    cwd: webDir,
    env: {
      ...process.env,
      TZ: "America/New_York",
      BAO_PG_DIR: path.join(root, "pglite"),
      BAO_BLOB_DIR: path.join(root, "blobs"),
      BAO_AUTH_STUB: "1",
      BAO_CHROME_NO_SANDBOX: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  web.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  web.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  const browser = await chromium.launch({ executablePath: TEST_BROWSER, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  try {
    await waitHealth(origin, logs);
    const author = await signIn(origin, "author@bao.local");
    const reader = await signIn(origin, "reader@bao.local");
    const imported = await push(origin, author, sheetWorkflow(fixture));
    assert.equal(imported.status, 201, await imported.text());
    const shared = await fetch(`${origin}/api/workflows/import-mail/share`, {
      method: "POST",
      headers: { cookie: author, "content-type": "application/json" },
      body: JSON.stringify({ permission: "fork" }),
    });
    const createdShare = await shared.json() as { token?: string; error?: string };
    assert.equal(shared.ok, true, JSON.stringify(createdShare));
    const shareRes = await fetch(`${origin}/api/share/${createdShare.token}`);
    const share = await shareRes.json() as { token: string; document: unknown; questions: { name: string; cleared?: string }[] };
    assert.equal(shareRes.ok, true, JSON.stringify(share));
    const text = JSON.stringify(share.document);
    assert.equal(text.includes("@"), false, text);
    assert.equal(text.includes("/home/ada"), false, text);
    assert.equal(text.includes("Ada Lovelace"), false, text);
    for (const name of ["email", "who", "note", "desk"]) {
      assert.ok(share.questions.some((question) => question.name === name), name);
    }
    assert.equal(share.questions.find((question) => question.name === "email")?.cleared, "email");
    const before = await fetch(`${origin}/api/workflows`, { headers: { cookie: reader } });
    const library = await before.json() as { workflows: { title?: string }[] };
    assert.equal(before.ok, true, JSON.stringify(library));
    assert.equal((library.workflows || []).some((item) => (item.title || "").startsWith("Fork of")), false);

    mkdirSync(shots, { recursive: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, timezoneId: "America/New_York" });
    await context.addCookies([{ name: "bao_session", value: reader.split("=")[1] || "", url: origin }]);
    const page = await context.newPage();
    await page.goto(`${origin}/share/${share.token}`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("import-sheet").waitFor();
    await page.getByRole("heading", { name: "Import" }).waitFor();
    const sheet = await page.getByTestId("import-sheet").innerText();
    assert.match(await page.locator("article").innerText(), /Nothing is saved until you answer these/);
    assert.match(sheet, /Email to use/);
    assert.match(sheet, /The sharer's email was removed/);
    assert.match(sheet, /Which file/);
    assert.match(sheet, /The sharer's file was removed/);
    assert.match(sheet, /For example, front/);
    assert.equal(sheet.includes("What email should"), false);
    assert.equal(sheet.includes("Cleared email"), false);
    assert.equal(sheet.includes("What should Desk"), false);
    const steps = await page.getByTestId("step-preview").innerText();
    assert.match(steps, /Click Log in/);
    const html = await page.content();
    assert.equal(html.includes("ada@acme.com"), false);
    assert.equal(html.includes("/home/ada"), false);
    assert.equal(html.includes("Ada Lovelace"), false);
    await page.screenshot({ path: path.join(shots, "import-sheet.png"), fullPage: true });
    await setTheme(page, "dark");
    await page.screenshot({ path: path.join(shots, "import-sheet-dark.png"), fullPage: true });
    await setTheme(page, "light");

    const installed = await fetch(`${origin}/api/share/${share.token}/install`, {
      method: "POST",
      headers: { cookie: reader, "content-type": "application/json" },
      body: JSON.stringify({ answers: { email: "ada@other.com", who: "front desk", note: "inbox", desk: "west" } }),
    });
    const created = await installed.json() as { id?: string; error?: string };
    assert.equal(installed.status, 200, JSON.stringify(created));
    const copy = await fetch(`${origin}/api/workflows/${created.id}`, { headers: { cookie: reader } });
    const copyText = await copy.text();
    assert.equal(copy.ok, true, copyText);
    assert.equal(copyText.includes("@"), false);
    assert.equal(copyText.includes("/home/ada"), false);
    assert.match(copyText, /west/);

    const missing = await push(origin, author, blockedWorkflow(fixture));
    assert.equal(missing.status, 201, await missing.text());
    const preview = prepareImport(blockedWorkflow(fixture));
    const reviewed = await fetch(`${origin}/api/workflows/bao-missing/review`, {
      method: "POST",
      headers: { cookie: author, "content-type": "application/json" },
      body: JSON.stringify({ documentHash: releaseHash(preview.document), shots: [] }),
    });
    assert.equal(reviewed.status, 200, await reviewed.text());
    const blocked = await fetch(`${origin}/api/workflows/bao-missing/publish`, {
      method: "POST",
      headers: { cookie: author, "content-type": "application/json" },
    });
    const blockedBody = await blocked.json() as { error?: string; stepLabel?: string; reason?: string };
    assert.equal(blocked.status, 409, JSON.stringify(blockedBody));
    assert.match(blockedBody.stepLabel || "", /Click the missing control/);
    await context.clearCookies();
    await context.addCookies([{ name: "bao_session", value: author.split("=")[1] || "", url: origin }]);
    await page.goto(`${origin}/workflows/bao-missing/publish`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("blocked-publish").waitFor();
    assert.match(await page.getByTestId("gate-step").innerText(), /Click the missing control/);
    assert.match(await page.getByTestId("last-green").innerText(), /Not replayed yet/);
    assert.equal(await page.getByTestId("list-it").isDisabled(), true);
    assert.match(await page.getByTestId("gate-reason").innerText(), /bao couldn't find this control/);
    assert.equal(await page.getByTestId("replay-again").isEnabled(), true);
    assert.match(await page.getByTestId("byline").innerText(), /^By \S+$/);
    const blockedHtml = await page.content();
    assert.equal(blockedHtml.includes("below-threshold"), false);
    assert.equal(blockedHtml.includes("Author author"), false);
    await page.screenshot({ path: path.join(shots, "blocked-publish.png"), fullPage: true });
    await setTheme(page, "dark");
    await page.screenshot({ path: path.join(shots, "blocked-publish-dark.png"), fullPage: true });
    await setTheme(page, "light");

    const passing = await push(origin, author, passingWorkflow(fixture));
    assert.equal(passing.status, 201, await passing.text());
    const greenPreview = prepareImport(passingWorkflow(fixture));
    const greenReview = await fetch(`${origin}/api/workflows/bao-fixture-ok/review`, {
      method: "POST",
      headers: { cookie: author, "content-type": "application/json" },
      body: JSON.stringify({ documentHash: releaseHash(greenPreview.document), shots: [] }),
    });
    assert.equal(greenReview.status, 200, await greenReview.text());
    const listed = await fetch(`${origin}/api/workflows/bao-fixture-ok/publish`, {
      method: "POST",
      headers: { cookie: author, "content-type": "application/json" },
    });
    assert.equal(listed.status, 200, await listed.text());
    await page.goto(`${origin}/marketplace/bao-fixture-ok`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("replay-verified").waitFor();
    assert.match(await page.getByTestId("last-green").innerText(), /Publisher replayed green:.*[A-Z][a-z]{2} \d+, \d+:\d{2} (AM|PM) (EDT|EST)/);
    assert.equal(await page.getByTestId("import-link").getAttribute("data-copy"), "bao://import/bao-fixture-ok");
    assert.equal(await page.getByTestId("deeplink").getAttribute("data-copy"), "bao://workflow/bao-fixture-ok");
    assert.equal((await page.getByTestId("workflow").innerText()).includes("bao://"), false);
    await context.close();
  } catch (err) {
    throw new Error(`${err instanceof Error ? err.stack : err}\n${logs.slice(-30).join("")}`);
  } finally {
    await browser.close();
    await stop(web);
  }
});

function sheetWorkflow(startUrl: string) {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "import-mail",
    name: "Mail the desk",
    startUrl,
    createdAt: 1710000000000,
    inputs: [
      { name: "email", type: "text", label: "Email", required: true, default: "ada@acme.com" },
      { name: "who", type: "text", label: "Name", required: true, default: "Ada Lovelace" },
      { name: "note", type: "text", label: "Note", required: true, default: "/home/ada/note.txt" },
      { name: "desk", type: "text", label: "Desk", required: true, default: "front", askOnImport: true },
    ],
    steps: [click("see", "Click Log in", { id: "login-btn", testId: "login", role: "button", text: "Log in", tag: "button" }, "Missing credentials")],
  };
}

function blockedWorkflow(startUrl: string) {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "bao-missing",
    name: "Missing control",
    startUrl,
    createdAt: 1710000000000,
    inputs: [],
    steps: [click("missing", "Click the missing control", { role: "button", name: "This control is not on the page", text: "This control is not on the page" }, "never shown")],
  };
}

function passingWorkflow(startUrl: string) {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "bao-fixture-ok",
    name: "Read the fixture",
    startUrl,
    createdAt: 1710000000000,
    inputs: [],
    steps: [click("see", "Click Log in", { id: "login-btn", testId: "login", role: "button", text: "Log in", tag: "button" }, "Missing credentials")],
  };
}

function click(id: string, label: string, identity: Record<string, unknown>, match: string) {
  return {
    id,
    index: 0,
    action: "click",
    label,
    surface: "dom",
    timeoutMs: 8000,
    identity: { surface: "dom", path: [], ...identity },
    postcondition: { kind: "text", match, timeoutMs: 8000 },
  };
}

async function push(origin: string, cookie: string, document: { id: string }) {
  return fetch(`${origin}/api/workflows/${document.id}/versions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ baseVersion: 0, document }),
  });
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

async function waitHealth(origin: string, logs: string[]): Promise<void> {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < 120_000) {
    try {
      const res = await fetch(`${origin}/api/health`);
      last = await res.text();
      if (res.ok) return;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`web did not start: ${last}\n${logs.join("").slice(-4000)}`);
}

async function setTheme(page: { evaluate: (fn: (theme: string) => void, theme: string) => Promise<void>; reload: (opts: { waitUntil: "domcontentloaded" }) => Promise<unknown>; waitForFunction: (fn: (theme: string) => boolean, theme: string) => Promise<unknown> }, theme: "light" | "dark"): Promise<void> {
  await page.evaluate((next) => localStorage.setItem("bao-theme", next), theme);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction((next) => document.documentElement.getAttribute("data-theme") === next, theme);
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
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}
