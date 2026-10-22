// Two Macs edit one workflow against a local `vercel dev`. No deploy.
// Run: node --test desktop/dist/desktop/test/live/sync-conflict.test.js

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Page } from "playwright";
import { startApp } from "../../src/app/server";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { loadState, pairDevice, syncAll } from "../../src/v1/sync";

const shots = "/opt/cursor/artifacts/screenshots";

test("two Macs conflict on one workflow, and an offline edit pushes on reconnect", { timeout: 600_000 }, async () => {
  process.env.TZ = "America/New_York";
  const root = mkdtempSync(path.join(tmpdir(), "bao-conflict-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs: string[] = [];
  const env = devEnv(root);
  let web = startWeb(port, env, logs);
  const browser = await chromium.launch({ channel: "chrome", args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  let app: { port: number; close(): Promise<void> } | undefined;
  try {
    const health = await waitHealth(origin, logs);
    assert.equal(health.driver, "pglite");
    const cookie = await signIn(origin, "owner@bao.local");
    const homeAda = path.join(root, "ada");
    const homeHome = path.join(root, "home");
    const ada = new Library(homeAda);
    const home = new Library(homeHome);
    const doc = workflow("shared-note");
    ada.save(doc);

    await pairDevice(ada, { code: await pairCode(origin, cookie), server: origin, name: "Ada's Mac" });
    await pairDevice(home, { code: await pairCode(origin, cookie), server: origin, name: "Home Mac" });
    await syncAll(ada, "push");
    await syncAll(home, "pull");

    ada.save(relabel(ada.read("shared-note"), "one", "Open Ada"));
    await syncAll(ada, "push");
    home.save(relabel(home.read("shared-note"), "two", "Save at home"));
    const conflicted = await syncAll(home);
    assert.match(conflicted.lastResult || "", /conflicts 1/);
    assert.equal(home.read("shared-note").steps[1]?.label, "Save at home");
    assert.equal(home.read("shared-note").steps[0]?.label, "Open");

    const token = JSON.parse(readFileSync(path.join(homeHome, "sync.json"), "utf8")).deviceToken as string;
    const head = await fetch(`${origin}/api/workflows/shared-note`, { headers: { authorization: `Bearer ${token}` } });
    const headBody = await head.json() as { version: number; document: WorkflowV2; deviceName?: string; parentVersion?: number | null };
    assert.equal(head.ok, true, JSON.stringify(headBody));
    assert.equal(headBody.document.steps[0]?.label, "Open Ada");
    assert.equal(headBody.document.steps[1]?.label, "Save");
    assert.equal(headBody.deviceName, "Ada's Mac");
    assert.equal(headBody.parentVersion, 1);
    const listed = await fetch(`${origin}/api/workflows/shared-note/versions`, { headers: { authorization: `Bearer ${token}` } });
    const versions = await listed.json() as { versions: { version: number; parent_version: number | null; kind: string; device_name: string | null }[] };
    const accepted = versions.versions.filter((row) => row.kind === "version");
    const draft = versions.versions.find((row) => row.kind === "conflict");
    assert.equal(accepted[0]?.device_name, "Ada's Mac");
    assert.equal(accepted[0]?.parent_version, null);
    assert.equal(accepted[1]?.parent_version, 1);
    assert.equal(accepted[1]?.device_name, "Ada's Mac");
    assert.ok(draft, JSON.stringify(versions.versions));
    assert.equal(draft?.parent_version, 1);
    assert.equal(draft?.device_name, "Home Mac");

    app = await startApp({ home: homeHome });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(`http://127.0.0.1:${app.port}/`, { waitUntil: "domcontentloaded" });
    await openConflict(page);
    await page.locator("#versions").screenshot({ path: path.join(shots, "conflict-light.png") });
    await page.evaluate(() => localStorage.setItem("bao-theme", "dark"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await openConflict(page);
    await page.locator("#versions").screenshot({ path: path.join(shots, "conflict-dark.png") });
    const webContext = await browser.newContext({ viewport: { width: 1100, height: 900 }, timezoneId: "America/New_York" });
    await webContext.addCookies([{ name: "bao_session", value: cookie.split("=")[1] || "", url: origin }]);
    const webPage = await webContext.newPage();
    await webPage.goto(`${origin}/workflows/shared-note`, { waitUntil: "domcontentloaded" });
    await webPage.getByTestId("conflict-badge").waitFor();
    const conflictText = await webPage.getByTestId("conflict-devices").innerText();
    assert.match(conflictText, /Changed on Ada's Mac and Home Mac/);
    const versionList = await webPage.getByTestId("version-list").innerText();
    assert.match(versionList, /v1[\s\S]*Ada's Mac/);
    assert.match(versionList, /v2[\s\S]*Ada's Mac/);
    assert.match(versionList, /v3[\s\S]*Conflict[\s\S]*Home Mac/);
    assert.match(versionList, /EDT|EST/);
    assert.equal(await webPage.getByText("element crop").count(), 0);
    await webPage.getByTestId("keep-mine").waitFor();
    await webPage.getByTestId("keep-theirs").waitFor();
    await webPage.getByTestId("keep-both").waitFor();
    await webPage.locator("main").screenshot({ path: path.join(shots, "conflict-web-light.png") });
    await webPage.evaluate(() => {
      localStorage.setItem("bao-theme", "dark");
      document.documentElement.setAttribute("data-theme", "dark");
    });
    await webPage.locator("main").screenshot({ path: path.join(shots, "conflict-web-dark.png") });
    await webContext.close();
    await page.getByTestId("keep-mine").click();
    await page.getByTestId("conflict-banner").waitFor({ state: "detached" });
    const kept = await fetch(`${origin}/api/workflows/shared-note`, { headers: { authorization: `Bearer ${token}` } });
    const keptBody = await kept.json() as { document: WorkflowV2; deviceName?: string | null };
    assert.equal(keptBody.document.steps[1]?.label, "Save at home");
    assert.equal(keptBody.deviceName, "Home Mac");
    await page.close();
    await app.close();
    app = undefined;

    await stop(web);
    ada.save(workflow("offline-note"));
    await assert.rejects(() => syncAll(ada), /offline|fetch failed|ECONNREFUSED/i);
    assert.equal(loadState(homeAda).outbox?.some((item) => item.id === "offline-note"), true);
    web = startWeb(port, env, logs);
    await waitHealth(origin, logs);
    await syncAll(ada);
    assert.equal(loadState(homeAda).outbox?.some((item) => item.id === "offline-note") ?? false, false);
    await syncAll(home, "pull");
    assert.equal(home.read("offline-note").name, "Offline note");
  } finally {
    await app?.close().catch(() => undefined);
    await browser.close();
    await stop(web);
  }
});

function workflow(id: string): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name: id === "offline-note" ? "Offline note" : "Shared note",
    startUrl: "https://example.com/fixture",
    createdAt: Date.now(),
    inputs: [],
    steps: [
      step("one", "Open", "open"),
      step("two", "Save", "save"),
    ],
  };
}

function step(id: string, label: string, testId: string): WorkflowV2["steps"][number] {
  return {
    id,
    index: id === "one" ? 0 : 1,
    action: "click",
    label,
    surface: "dom",
    identity: { surface: "dom", role: "button", path: [], testId },
    timeoutMs: 1000,
  };
}

function relabel(doc: WorkflowV2, stepId: string, label: string): WorkflowV2 {
  return {
    ...doc,
    updatedAt: Date.now(),
    steps: doc.steps.map((item) => item.id === stepId ? { ...item, label } : item),
  };
}

async function openConflict(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Shared note" }).click();
  await page.getByTestId("conflict-banner").waitFor();
  assert.match(await page.getByTestId("conflict-banner").innerText(), /Changed on Ada's Mac and Home Mac/);
  assert.match(await page.getByTestId("conflict-diff").innerText(), /Open Ada/);
  assert.match(await page.getByTestId("conflict-diff").innerText(), /Save at home/);
  assert.match(await page.locator("#versions").innerText(), /2 steps/);
  const numbers = await page.locator('[data-testid="version"]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-version")));
  assert.deepEqual(numbers, ["1", "2", "3"]);
  assert.match(await page.locator('[data-version="1"]').innerText(), /Ada's Mac/);
  assert.match(await page.locator('[data-version="2"]').innerText(), /Ada's Mac/);
  assert.match(await page.locator('[data-version="3"]').innerText(), /Conflict/);
  assert.match(await page.locator('[data-version="3"]').innerText(), /Home Mac/);
  const sides = page.locator('[data-testid="conflict-diff"] li');
  assert.equal(await sides.count(), 4);
  for (const side of await sides.all()) assert.equal(await side.getAttribute("data-changed"), "true");
  await page.getByTestId("keep-mine").waitFor();
  await page.getByTestId("keep-theirs").waitFor();
  await page.getByTestId("keep-both").waitFor();
}

function devEnv(root: string): NodeJS.ProcessEnv {
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
  return env;
}

function startWeb(port: number, env: NodeJS.ProcessEnv, logs: string[]): ChildProcess {
  const web = spawn(
    "npx",
    ["--yes", "vercel@65.0.0", "dev", "--local", "--yes", "--non-interactive", "--listen", `127.0.0.1:${port}`],
    { cwd: path.join(process.cwd(), "web"), env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  web.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  web.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  return web;
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
