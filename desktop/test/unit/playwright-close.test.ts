import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import { openWorkflowBrowser } from "../../src/engines/workflow-browser";
import { closeRetainedChrome, launchOwnedChrome, pidsForDataDir, pinTestBrowser } from "../../src/launch";
import { chromeProfiles } from "../support/chrome-profiles";

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

test("playwright close rejects a running completion and a closing phase without one", async () => {
  assert.deepEqual(await appendedLaunchDiagnostics('const value: PlaywrightOwned = { phase: "running" }; void value;'), []);
  assert.deepEqual(await appendedLaunchDiagnostics('const value: PlaywrightOwned = { phase: "closing", completion: Promise.resolve() }; void value;'), []);
  assert.deepEqual(await appendedLaunchDiagnostics('const value: PlaywrightOwned = { phase: "settled", completion: Promise.resolve() }; void value;'), []);
  assert.ok((await appendedLaunchDiagnostics('const value: PlaywrightOwned = { phase: "running", completion: Promise.resolve() }; void value;')).includes(2353));
  assert.ok((await appendedLaunchDiagnostics('const value: PlaywrightOwned = { phase: "closing" }; void value;')).includes(2322));
  assert.ok((await appendedLaunchDiagnostics('const value: PlaywrightOwned = { phase: "retained" }; void value;')).includes(2322));
});

test("a disconnect followed by context.close runs one shutdown", { timeout: 20_000 }, async (t) => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), "bao-playwright-close-"));
  const context = await launchOwnedChrome({ userDataDir, headless: true });
  const browser = context.browser();
  assert.ok(browser);
  const logs: string[] = [];
  const error = console.error;
  t.mock.method(console, "error", (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
    error.apply(console, args);
  });
  const kill = ChildProcess.prototype.kill;
  let sigterms = 0;
  let holdKill = true;
  t.mock.method(ChildProcess.prototype, "kill", function (this: ChildProcess, signal?: NodeJS.Signals | number) {
    if (holdKill && signal === "SIGTERM") {
      sigterms += 1;
      return true;
    }
    return kill.call(this, signal);
  });
  try {
    await browser.close();
    const started = Date.now() + 2000;
    while (sigterms < 1 && Date.now() < started) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(sigterms, 1, "disconnect must start one shutdown");
    const closing = context.close();
    assert.equal(context.close(), closing, "disconnect and close share one completion");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(sigterms, 1, "context.close after disconnect must not start a second shutdown");
    holdKill = false;
    await closing;
    assert.equal(logs.filter((line) => line.includes("bao shutdown")).length, 1);
    assert.deepEqual(pidsForDataDir(userDataDir), []);
  } finally {
    holdKill = false;
    await context.close().catch(() => undefined);
    if (pidsForDataDir(userDataDir).length) await closeRetainedChrome(userDataDir);
    assert.deepEqual(pidsForDataDir(userDataDir), [], "test must leave no owned Chrome processes");
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test("a Playwright disconnect after keep-open leaves the retained Chrome up", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-playwright-retain-"));
  const sourceRoot = await chromeProfiles(path.join(root, "source"));
  const session = await openWorkflowBrowser({ browser: "bao", home: root, site: "about:blank", sourceRoot });
  assert.equal(session.kind, "owned");
  try {
    await session.keepOpen?.();
    const browser = session.context.browser();
    assert.ok(browser);
    const disconnected = new Promise<void>((resolve) => browser.once("disconnected", () => resolve()));
    await browser.close();
    await disconnected;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(pidsForDataDir(session.profile).length > 0, "keep-open must survive a Playwright disconnect");
    await session.close();
    assert.deepEqual(pidsForDataDir(session.profile), []);
  } finally {
    await session.close().catch(() => undefined);
    if (session.kind === "owned" && pidsForDataDir(session.profile).length) await closeRetainedChrome(session.profile);
    assert.equal(session.kind === "owned" ? pidsForDataDir(session.profile).length : 0, 0, "test must leave no owned Chrome processes");
    await rm(root, { recursive: true, force: true });
  }
});
