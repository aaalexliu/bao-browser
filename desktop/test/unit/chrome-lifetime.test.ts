import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { connectCdp, type CdpSocket } from "../../src/cdp-live/socket";
import { launchOwnedChrome, launchOwnedChromeEndpoint, pidsForDataDir, pinTestBrowser } from "../../src/launch";

pinTestBrowser();

async function appendedLaunchDiagnostics(appended: string): Promise<number[]> {
  const sourcePath = path.resolve("desktop/src/launch.ts");
  const original = await readFile(sourcePath, "utf8");
  const configPath = path.resolve("tsconfig.desktop.json");
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(configFile.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
  const host = ts.createCompilerHost(parsed.options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (path.resolve(fileName) === sourcePath) {
      const version = typeof languageVersion === "number" ? languageVersion : ts.ScriptTarget.ES2022;
      return ts.createSourceFile(fileName, `${original}\n${appended}\n`, version, true, ts.ScriptKind.TS);
    }
    return getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  const program = ts.createProgram([sourcePath], parsed.options, host);
  return ts.getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file !== undefined && path.resolve(diagnostic.file.fileName) === sourcePath && (diagnostic.start ?? 0) >= original.length)
    .map((diagnostic) => diagnostic.code);
}

test("endpoint lifecycle rejects retained completion and closing without completion", async () => {
  assert.deepEqual(await appendedLaunchDiagnostics('const value: OwnedEndpointState = { phase: "retained" }; void value;'), []);
  assert.deepEqual(await appendedLaunchDiagnostics('const value: OwnedEndpointState = { phase: "closing", completion: Promise.resolve() }; void value;'), []);
  assert.ok((await appendedLaunchDiagnostics('const value: OwnedEndpointState = { phase: "retained", completion: Promise.resolve() }; void value;')).includes(2353));
  assert.ok((await appendedLaunchDiagnostics('const value: OwnedEndpointState = { phase: "closing" }; void value;')).includes(2322));
});

test("retaining the endpoint keeps Chrome alive after its control socket disconnects", { timeout: 20_000 }, async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "bao-lifetime-retain-"));
  let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  try {
    chrome = await launchOwnedChromeEndpoint({ userDataDir, headless: true });
    let closed = false;
    void chrome.closed.then(() => { closed = true; });
    await chrome.keepOpen();
    await chrome.keepOpen();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(closed, false);
    assert.equal(chrome.isClosed(), false);
    assert.ok(pidsForDataDir(userDataDir).length > 0);
    await chrome.close();
    await chrome.closed;
    assert.equal(closed, true);
    assert.equal(chrome.isClosed(), true);
    assert.deepEqual(pidsForDataDir(userDataDir), []);
  } finally {
    await chrome?.close();
    assert.deepEqual(pidsForDataDir(userDataDir), [], "test must leave no owned Chrome processes");
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("concurrent close callers share completion before and after shutdown", { timeout: 20_000 }, async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "bao-lifetime-close-"));
  let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  try {
    chrome = await launchOwnedChromeEndpoint({ userDataDir, headless: true });
    const completion = chrome.close();
    assert.equal(chrome.isClosed(), true);
    assert.equal(chrome.close(), completion);
    await chrome.keepOpen();
    await completion;
    await chrome.closed;
    assert.equal(chrome.close(), completion);
    assert.deepEqual(pidsForDataDir(userDataDir), []);
  } finally {
    await chrome?.close();
    assert.deepEqual(pidsForDataDir(userDataDir), [], "test must leave no owned Chrome processes");
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("closing an owned context finishes when Chrome disconnects before it answers Browser.close", { timeout: 20_000 }, async (t) => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "bao-lifetime-unanswered-"));
  const context = await launchOwnedChrome({ userDataDir, headless: true });
  try {
    const browser = context.browser()!;
    const newBrowserCDPSession = browser.newBrowserCDPSession.bind(browser);
    t.mock.method(browser, "newBrowserCDPSession", async () => {
      const session = await newBrowserCDPSession();
      const send = session.send.bind(session);
      t.mock.method(session, "send", async (method: "Browser.close") => {
        await send(method);
        return new Promise(() => {});
      });
      return session;
    });
    await context.close();
    assert.deepEqual(pidsForDataDir(userDataDir), []);
  } finally {
    await context.close();
    assert.deepEqual(pidsForDataDir(userDataDir), [], "test must leave no owned Chrome processes");
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("closing the last page releases the endpoint's owned Chrome", { timeout: 20_000 }, async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "bao-lifetime-page-"));
  let chrome: Awaited<ReturnType<typeof launchOwnedChromeEndpoint>> | undefined;
  let cdp: CdpSocket | undefined;
  try {
    chrome = await launchOwnedChromeEndpoint({ userDataDir, headless: true });
    const endpoint = await readDevToolsActivePort(chrome.portFile);
    cdp = await connectCdp(endpoint.port, endpoint.browserPath);
    const { targetInfos } = await cdp.send<{ targetInfos: { type: string; targetId: string }[] }>("Target.getTargets");
    const pages = targetInfos.filter((target) => target.type === "page");
    assert.ok(pages.length > 0, "the browser must have a page to close");
    for (const page of pages) await cdp.send("Target.closeTarget", { targetId: page.targetId });
    await chrome.closed;
    assert.equal(chrome.isClosed(), true);
    assert.deepEqual(pidsForDataDir(userDataDir), []);
  } finally {
    cdp?.close();
    await chrome?.close();
    assert.deepEqual(pidsForDataDir(userDataDir), [], "test must leave no owned Chrome processes");
    await rm(userDataDir, { recursive: true, force: true });
  }
});
