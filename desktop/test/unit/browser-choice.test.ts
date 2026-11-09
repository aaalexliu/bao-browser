import { testWorkflow } from "../support/workflow";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { BROWSER_CHOICES, BROWSER_OPTIONS, DEFAULT_BROWSER, browserChoice } from "../../src/browser-choice";
import { startApp } from "../../src/app/server";
import { TOOLS } from "../../src/mcp/server";
import { openWorkflowBrowser, navigateWorkflowBrowser } from "../../src/engines/workflow-browser";
import * as currentChrome from "../../src/cdp-live/current-chrome";
import * as profiles from "../../src/engines/chrome-profile-copy";
import { launchOwnedChrome, launchOwnedChromeEndpoint, pidsForDataDir, pinTestBrowser } from "../../src/launch";
import { chromeProfiles, fakeTaskTab } from "../support/chrome-profiles";
import { connectCdp } from "../../src/cdp-live/socket";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { testChromium } from "../../src/test-browser";
import type { WorkflowV2 } from "../../src/v1/schema";

const workflow = (startUrl: string, id = "choice"): WorkflowV2 => (testWorkflow({ schema: "bao.workflow/v4", id, name: "Read account", startUrl, inputs: [], createdAt: 1,
  steps: [{
    id: "account",
    index: 0,
    timeoutMs: 1000,
    caption: { text: "Check the signed-in account" },
    action: "verify",
    check: { kind: "text", match: "Signed in as fixture", timeoutMs: 1000 },
  }],
}));

test("agent and workflow tools offer the same named browser choices and Bao default", () => {
  assert.equal(browserChoice(undefined), "bao");
  assert.equal(DEFAULT_BROWSER, "bao");
  for (const choice of BROWSER_CHOICES) assert.equal(browserChoice(choice), choice);
  assert.throws(() => browserChoice("other"), /browser=bao.*browser=copy.*browser=current/);
  for (const name of ["agent_browser", "run_workflow"]) {
    const tool = TOOLS.find((entry) => entry.name === name)!;
    const schema = tool.inputSchema as { properties: { browser: { enum: readonly string[]; default: string; description: string } } };
    assert.deepEqual(schema.properties.browser.enum, BROWSER_CHOICES);
    assert.equal(schema.properties.browser.default, "bao");
    for (const value of Object.values(BROWSER_OPTIONS)) {
      assert.ok(tool.description.includes(value.description));
      assert.ok(schema.properties.browser.description.includes(value.description));
    }
  }
});

test("replay copies drop only saved tabs in the selected profile; agent copies keep them", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-choice-copy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["Default", "Profile 1"]) {
    const sourceRoot = path.join(root, directory);
    const profile = path.join(sourceRoot, directory);
    const home = path.join(root, `home-${directory}`);
    await mkdir(path.join(profile, "Sessions"), { recursive: true });
    await mkdir(path.join(profile, "Local Storage"), { recursive: true });
    await mkdir(path.join(profile, "Session Storage"), { recursive: true });
    await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { [directory]: { name: "Fixture" } } } }));
    await writeFile(path.join(profile, "Preferences"), JSON.stringify({ session: { restore_on_startup: 5 } }));
    const saved = ["Sessions/Session_1", "Current Session", "Current Tabs", "Last Session", "Last Tabs"];
    const kept = ["Cookies", "Local Storage/account", "Session Storage/token"];
    for (const file of [...saved, ...kept]) await writeFile(path.join(profile, file), file);
    const agent = await profiles.copyChromeProfile({ sourceRoot, directory, home });
    try {
      for (const file of [...saved, ...kept]) assert.equal(await readFile(path.join(agent.userDataDir, directory, file), "utf8"), file);
    } finally { await agent.close(); }
    const replay = await profiles.copyChromeProfile({ sourceRoot, directory, home, restoreTabs: false });
    try {
      for (const file of saved) await assert.rejects(readFile(path.join(replay.userDataDir, directory, file)), { code: "ENOENT" });
      for (const file of kept) assert.equal(await readFile(path.join(replay.userDataDir, directory, file), "utf8"), file);
      const prefs = JSON.parse(await readFile(path.join(replay.userDataDir, directory, "Preferences"), "utf8")) as { session: { restore_on_startup: number } };
      assert.equal(prefs.session.restore_on_startup, 1, "the startup preference still keeps session cookies");
      for (const file of saved) assert.equal(await readFile(path.join(profile, file), "utf8"), file, "the owner's source stays unchanged");
    } finally { await replay.close(); }
  }
});

test("the running app marks Bao default, keeps the chosen browser, and replays with lasting sign-ins", { timeout: 150_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-choice-ui-"));
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Fixture" } } } }));
  const priorHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome; });
  const fixture = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url === "/signin") res.setHeader("Set-Cookie", "session=fixture; Path=/; Max-Age=3600");
    const account = req.headers.cookie?.includes("session=fixture") ? "Signed in as fixture" : "Signed out";
    const heading = req.url?.startsWith("/fresh") ? "Fresh fixture ready" : account;
    res.end(`<title>Account fixture</title><h1>${heading}</h1><p id="visits"></p><script>const n = Number(localStorage.visits || 0) + 1; localStorage.visits = n; document.getElementById('visits').textContent = 'Visit ' + n;</script>`);
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => fixture.close(() => resolve())));
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const site = `http://127.0.0.1:${address.port}/`;
  const home = path.join(root, "bao");
  const app = await startApp({ home, port: 0, extensionHost: false, chromeProfilesRoot: sourceRoot });
  let appClosed = false;
  t.after(async () => {
    if (appClosed) return;
    await fetch(`http://127.0.0.1:${app.port}/api/replay/cancel`, { method: "POST", signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    await app.close();
  });
  const post = async (route: string, body: unknown, method = "POST") => {
    const response = await fetch(`http://127.0.0.1:${app.port}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ status?: string; opened?: boolean; site?: { signedIn: boolean } }>;
  };
  assert.equal((await post("/api/login-import/sign-in", { site, consent: true, probeUrl: `${site}signin`, signedInText: "Signed in as fixture" })).opened, true);
  await post("/api/login-sites", { origin: site, probeUrl: site, signedInText: "Signed in as fixture" }, "PUT");
  assert.equal((await post("/api/login-sites/recheck", { origin: site })).site?.signedIn, true);
  app.library.save(workflow(site));
  const browser = await testChromium.launch({ executablePath: process.env.BAO_TEST_BROWSER, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  await page.goto(`http://127.0.0.1:${app.port}`);
  await page.locator('#rail [data-place="workflows"]').click();
  await page.getByRole("button", { name: "Read account", exact: true }).click();
  await page.getByRole("button", { name: "Run…", exact: true }).click();
  const choices = page.getByRole("group", { name: "Browser for this run" });
  assert.match(await choices.innerText(), /Bao's own Chrome profile with your Login sites/);
  assert.match(await choices.innerText(), /different keychains/);
  assert.equal(await choices.getByRole("radio").count(), 3);
  assert.equal(await choices.getByRole("radio", { name: "Bao profile (default)" }).isChecked(), true);
  await choices.getByRole("radio", { name: "Fresh Chrome copy" }).check();
  await page.waitForTimeout(1100);
  assert.equal(await choices.getByRole("radio", { name: "Fresh Chrome copy" }).isChecked(), true);
  await choices.getByRole("radio", { name: "Bao profile (default)" }).check();
  const request = page.waitForRequest((request) => request.url().endsWith("/api/replay") && request.method() === "POST");
  const response = page.waitForResponse((response) => response.url().endsWith("/api/replay") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Run", exact: true }).click();
  assert.equal(((await request).postDataJSON() as { browser: string }).browser, "bao");
  assert.equal((await (await response).json() as { status: string }).status, "passed");
  const replay = await openWorkflowBrowser({ browser: "copy", home: path.join(root, "copy-home"), site, sourceRoot });
  try {
    await navigateWorkflowBrowser(replay, site);
    assert.equal(await replay.page.locator("h1").innerText(), "Signed out", "a fresh source copy must not inherit the Bao-only login");
  } finally { await replay.close(); }
  await page.locator('#rail [data-place="settings"]').click();
  const mac = page.locator("#set-perm + .settings-group");
  if (process.platform === "darwin") {
    assert.match(await mac.innerText(), /Running Chrome.*Accessibility/);
    assert.match(await mac.innerText(), /Bao profiles and Chrome copies do not need it/);
    assert.match(await mac.innerText(), /No Chrome option needs Automation or Screen Recording/);
  }
  const agent = await openWorkflowBrowser({ browser: "bao", home, site, sourceRoot });
  t.after(() => agent.close());
  await navigateWorkflowBrowser(agent, site);
  assert.equal(await agent.page.locator("h1").innerText(), "Signed out", "an agent opens after an app run without sharing app sign-ins or leases");
  await agent.context.addCookies([{ name: "agent-only", value: "fixture", url: site, expires: Date.now() / 1000 + 3600 }]);
  assert.equal((await post("/api/replay", { id: "choice", browser: "bao", args: {} })).status, "passed", "an active agent does not block the app's saved-login probe or run");
  if (agent.kind === "owned") await agent.keepOpen?.();
  await post("/api/login-sites", { origin: site }, "DELETE");
  app.library.save(workflow(site, "guide"));
  app.library.save(workflow(site, "after-guide"));
  assert.equal((await post("/api/replay", { id: "guide", guide: true, args: {} })).status, "passed");
  assert.equal((await post("/api/replay", { id: "after-guide", browser: "bao", args: {} })).status, "passed", "an ungated Bao run reuses the app's Guide profile");
  assert.equal(agent.page.isClosed(), false, "app runs do not reclaim even a retained agent window");
  await post("/api/login-sites", { origin: site, probeUrl: site, signedInText: "Signed in as fixture" }, "PUT");
  for (const id of ["before-window-close", "after-window-close"]) {
    app.library.save(workflow(site, id));
    assert.equal((await post("/api/replay", { id, browser: "bao", args: {} })).status, "passed");
    const endpoint = await readDevToolsActivePort(path.join(home, "chrome-profile", "DevToolsActivePort"));
    const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    try { await cdp.send("Browser.close").catch(() => undefined); } finally { cdp.close(); }
  }
  for (let run = 0; run < 2; run++) {
    const fresh = workflow(`${site}fresh`, `fresh-copy-${run}`);
    fresh.steps[0] = { ...fresh.steps[0]!, action: "verify", check: { kind: "text", match: "Visit 1", timeoutMs: 1000 } };
    app.library.save(fresh);
    const response = await fetch(`http://127.0.0.1:${app.port}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: fresh.id, browser: "copy", args: {} }), signal: AbortSignal.timeout(20_000) });
    const result = await response.json() as { status: string };
    assert.equal(result.status, "passed", "each copy run starts from source state, not the last replay's localStorage");
  }
  const signedOut = await launchOwnedChrome({ userDataDir: path.join(home, "chrome-profile"), headless: true });
  await signedOut.clearCookies();
  await signedOut.close();
  assert.equal((await post("/api/replay", { id: "choice", browser: "bao", args: {} })).status, "needs-sign-in", "Bao app runs still honor the saved-login gate");
  await post("/api/login-import/sign-in", { site, consent: true, probeUrl: `${site}signin` });
  await post("/api/login-sites/recheck", { origin: site });
  await app.close();
  appClosed = true;
  await agent.close();
  const reopened = await launchOwnedChrome({ userDataDir: path.join(home, "chrome-profile"), headless: true });
  try {
    const account = reopened.pages()[0] || await reopened.newPage();
    await account.goto(site);
    assert.equal(await account.locator("h1").innerText(), "Signed in as fixture", "app tools and later app sessions keep their own lasting sign-in");
    assert.equal((await reopened.cookies(site)).some((cookie) => cookie.name === "agent-only"), false, "agent sign-ins do not reach the app profile");
  } finally { await reopened.close(); }
  const reopenedAgent = await openWorkflowBrowser({ browser: "bao", home, site, sourceRoot });
  try {
    assert.equal((await reopenedAgent.context.cookies(site)).some((cookie) => cookie.name === "agent-only" && cookie.value === "fixture"), true, "app runs leave the agent profile's saved state intact");
  } finally { await reopenedAgent.close(); }
  await browser.close();
  await rm(root, { recursive: true, force: true });
});

test("a retained Bao session closes gracefully before reopening its saved sign-in", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-retained-reopen-"));
  const profile = path.join(root, "agent-browser-profile");
  await chromeProfiles(path.join(root, "source"));
  const session = await openWorkflowBrowser({ browser: "bao", home: root, site: "http://127.0.0.1/", sourceRoot: path.join(root, "source") });
  const kill = ChildProcess.prototype.kill;
  // A browser busy flushing its profile may not finish on SIGTERM.
  const slowSignal = t.mock.method(ChildProcess.prototype, "kill", function (this: ChildProcess, signal?: NodeJS.Signals | number) {
    if (signal === "SIGTERM" && this.spawnargs.includes(`--user-data-dir=${profile}`)) return true;
    return kill.call(this, signal);
  });
  try {
    await session.context.addCookies([{ name: "saved-login", value: "fixture", url: "http://127.0.0.1/", expires: Date.now() / 1000 + 3600 }]);
    if (session.kind === "owned") await session.keepOpen?.();
    await session.close();
    assert.deepEqual(pidsForDataDir(profile), [], "explicit close must release the retained profile before returning");
    const reopened = await openWorkflowBrowser({ browser: "bao", home: root, site: "http://127.0.0.1/", sourceRoot: path.join(root, "source") });
    try {
      assert.ok((await reopened.context.cookies("http://127.0.0.1/")).some((cookie) => cookie.name === "saved-login" && cookie.value === "fixture"));
    } finally { await reopened.close(); }
  } finally {
    slowSignal.mock.restore();
    if (pidsForDataDir(profile).length) {
      const endpoint = await readDevToolsActivePort(path.join(profile, "DevToolsActivePort"));
      const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
      try { await cdp.send("Browser.close").catch(() => undefined); }
      finally { cdp.close(); }
      const deadline = Date.now() + 5000;
      while (pidsForDataDir(profile).length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await session.close();
    assert.deepEqual(pidsForDataDir(profile), [], "test must leave no owned Chrome processes");
    await rm(root, { recursive: true, force: true });
  }
});

test("copy and current runs leave the app Sign in window open", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-choice-signin-"));
  const home = path.join(root, "bao");
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Fixture" } } } }));
  const priorHome = process.env.HOME;
  const priorHeadless = process.env.BAO_SIGNIN_HEADLESS;
  process.env.HOME = root;
  process.env.BAO_SIGNIN_HEADLESS = "1";
  const fixture = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<title>Sign in fixture</title><h1>Ready</h1>");
  });
  let app: Awaited<ReturnType<typeof startApp>> | undefined;
  let owner: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let signIn: Awaited<ReturnType<typeof connectCdp>> | undefined;
  let current: Awaited<ReturnType<typeof connectCdp>> | undefined;
  t.after(async () => {
    try {
      await app?.close();
      signIn?.close();
      current?.close();
      await owner?.close();
      await new Promise<void>((resolve) => fixture.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    } finally {
      if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
      if (priorHeadless === undefined) delete process.env.BAO_SIGNIN_HEADLESS; else process.env.BAO_SIGNIN_HEADLESS = priorHeadless;
    }
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const address = fixture.address();
  assert.ok(address && typeof address !== "string");
  const site = `http://127.0.0.1:${address.port}/`;
  app = await startApp({ home, port: 0, extensionHost: false, chromeProfilesRoot: sourceRoot });
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${app!.port}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
    assert.equal(response.status, 200);
    return response.json() as Promise<{ opened?: boolean; status?: string }>;
  };
  assert.equal((await post("/api/login-import/sign-in", { site, consent: true })).opened, true);
  const signInEndpoint = await readDevToolsActivePort(path.join(home, "chrome-profile", "DevToolsActivePort"));
  signIn = await connectCdp(signInEndpoint.port, signInEndpoint.browserPath);
  const before = await signIn.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets");
  const target = before.targetInfos.find((target) => target.url === site);
  assert.ok(target, "the app's Sign in window is open before either run");
  owner = await launchOwnedChromeEndpoint({ userDataDir: path.join(root, "current"), headless: true });
  const endpoint = await readDevToolsActivePort(owner.portFile);
  current = await connectCdp(endpoint.port, endpoint.browserPath);
  const connection = current;
  t.mock.method(profiles, "chromeProfilesRoot", () => sourceRoot);
  fakeTaskTab(t);
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({ pid: 1, executable: pinTestBrowser(), root: sourceRoot, endpoint, cdp: connection,
    closed: connection.disconnected, isClosed: () => !connection.isOpen,
    detach: () => {},
  }));
  const doc = workflow(site, "signin-independent");
  doc.steps[0] = { ...doc.steps[0]!, action: "verify", check: { kind: "text", match: "Ready", timeoutMs: 1000 } };
  app.library.save(doc);
  for (const browser of ["copy", "current"]) {
    assert.equal((await post("/api/replay", { id: doc.id, browser, args: {} })).status, "passed");
    assert.equal(signIn.isOpen, true, `${browser} must not close the independent Sign in browser`);
    const after = await signIn.send<{ targetInfos: { targetId: string; url: string }[] }>("Target.getTargets");
    assert.ok(after.targetInfos.some((entry) => entry.targetId === target.targetId && entry.url === site), `${browser} leaves the original Sign in page in place`);
  }
});

test("current workflow replay closes its task tab and leaves the attached Chrome and the owner's tabs open", { timeout: 30_000 }, async (t) => {
  const root = await chromeProfiles(await realpath(await mkdtemp(path.join(tmpdir(), "bao-choice-current-"))));
  const owner = await launchOwnedChromeEndpoint({ userDataDir: root, headless: true, args: ["--no-startup-window"] });
  t.after(async () => { await owner.close(); await rm(root, { recursive: true, force: true }); });
  const endpoint = await readDevToolsActivePort(owner.portFile);
  const cdp = await connectCdp(endpoint.port, endpoint.browserPath);
  t.after(() => cdp.close());
  const original = await cdp.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  let detached = 0;
  t.mock.method(profiles, "chromeProfilesRoot", () => root);
  t.mock.method(currentChrome, "openCurrentChrome", async () => ({ pid: 1, executable: pinTestBrowser(), root, endpoint, cdp,
    closed: cdp.disconnected, isClosed: () => !cdp.isOpen,
    detach: () => { detached++; },
  }));
  const session = await openWorkflowBrowser({ browser: "current", home: root, site: "about:blank", sourceRoot: root });
  assert.equal(session.kind, "current");
  assert.equal("profile" in session, false, "attached sessions never expose an owned profile to cleanup");
  await session.close();
  // Target.closeTarget answers before Chrome destroys the tab.
  let pages: string[] = [];
  for (const deadline = Date.now() + 3000; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
    pages = (await cdp.send<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets")).targetInfos.filter((target) => target.type === "page").map((target) => target.targetId);
    if (pages.length === 1) break;
  }
  assert.deepEqual(pages, [original.targetId], "only the run's task tab closes");
  assert.equal(detached, 1);
});
