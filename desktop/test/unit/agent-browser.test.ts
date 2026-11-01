import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentBrowserPage, EngineUncertain, pageEngineName, type EvaluationPhase } from "../../src/engines/agent-browser";
import { CdpLiveDriver } from "../../src/cdp-live/driver";
import type { CdpSocket } from "../../src/cdp-live/socket";

async function fakeEngine(mode = "ok", commandMs: number | null = 150, timeouts: { idleMs?: number; lifetimeMs?: number } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "bao-engine-unit-"));
  const executable = path.join(root, "native");
  const output = path.join(root, "transport.jsonl");
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify({pid: process.pid, argv: process.argv, env: process.env}) + '\\n');
net.createServer(socket => {
  let buffer = '';
  socket.on('data', chunk => {
    buffer += chunk;
    const line = buffer.indexOf('\\n');
    if (line < 0) return;
    const cmd = JSON.parse(buffer.slice(0, line));
    fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify(cmd) + '\\n');
    if (cmd.action === 'keyboard' && ${JSON.stringify(mode)} === 'hang') return;
    if (cmd.action === 'keyboard' && ${JSON.stringify(mode)} === 'malformed') { socket.end('not-json\\n'); return; }
    if (cmd.action === 'keyboard' && ${JSON.stringify(mode)} === 'error') { socket.end(JSON.stringify({ id: cmd.id, success: false, error: cmd.text }) + '\\n'); return; }
    if (cmd.action === 'keyboard' && ${JSON.stringify(mode)} === 'missing-result') { socket.end(JSON.stringify({ id: cmd.id, success: true, data: {} }) + '\\n'); return; }
    if (cmd.action === 'keyboard' && ${JSON.stringify(mode)} === 'ended') { socket.end(); return; }
    if (cmd.action === 'screenshot') fs.writeFileSync(cmd.path, Buffer.from('89504e470d0a1a0a', 'hex'));
    const data = cmd.action === 'evaluate' ? { result: {count: ${mode === "ambiguous" ? 2 : 1}, credential: false} } : cmd.action === 'keyboard' ? {inserted: true} : cmd.action === 'screenshot' ? {path: cmd.path} : cmd.action === 'tab_switch' ? {targetId: ${mode === "wrongtab" ? "'WRONG'" : "cmd.tabId"}} : {};
    socket.end(JSON.stringify({id: cmd.id, success: true, data}) + '\\n');
  });
}).listen(process.env.AGENT_BROWSER_SOCKET_DIR + '/bao.sock');
`, { mode: 0o700 });
  let page: AgentBrowserPage;
  try { page = await AgentBrowserPage.open({ endpoint: "ws://127.0.0.1:12345/devtools/browser/test", targetId: "ABC123", ownership: "external", executable, ...timeouts, ...(commandMs === null ? {} : { commandMs }) }); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const records = async () => (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { page, records, async close() { await page.close(); await rm(root, { recursive: true, force: true }); } };
}

test("engine selection defaults to old and refuses unknown choices", () => {
  const prior = process.env.BAO_PAGE_ENGINE;
  try {
    process.env.BAO_PAGE_ENGINE = "agent-browser";
    assert.equal(pageEngineName(), "old");
  } finally {
    if (prior === undefined) delete process.env.BAO_PAGE_ENGINE; else process.env.BAO_PAGE_ENGINE = prior;
  }
  assert.equal(pageEngineName(""), "old");
  assert.equal(pageEngineName("old"), "old");
  assert.equal(pageEngineName("agent-browser"), "agent-browser");
  assert.throws(() => pageEngineName("other"), /must be/);
});

test("native transport keeps option-shaped text and secrets out of argv and environment", async () => {
  const fake = await fakeEngine();
  try {
    const literal = '--provider remote\n"secret literal"\\';
    await fake.page.insertText(literal);
    const [spawn, ...commands] = await fake.records();
    assert.deepEqual(spawn.argv.slice(2), []);
    assert.equal(JSON.stringify(spawn).includes(literal), false);
    assert.equal(spawn.env.AGENT_BROWSER_NO_WEBMCP, "1");
    assert.equal(spawn.env.AGENT_BROWSER_CDP, "ws://127.0.0.1:12345/devtools/browser/test");
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CURSOR_API_KEY", "AGENT_BROWSER_PROVIDER", "NODE_OPTIONS"]) assert.equal(spawn.env[key], undefined);
    assert.deepEqual(commands.filter((cmd) => cmd.action === "keyboard").map((cmd) => cmd.text), [literal]);
    await fake.page.screenshot();
    const shot = (await fake.records()).find((cmd) => cmd.action === "screenshot");
    assert.equal(path.dirname(shot.path), fake.page.stateDir);
    await assert.rejects(readFile(shot.path), /ENOENT/);
    const stateDir = fake.page.stateDir;
    await fake.page.close();
    assert.throws(() => process.kill(spawn.pid, 0));
    await assert.rejects(readFile(path.join(stateDir, "bao.pid")), /ENOENT/);
    assert.equal((await fake.records()).some((cmd) => cmd.action === "close"), false, "disconnect never sends browser close");
  } finally { await fake.close(); }
});

for (const mode of ["hang", "malformed", "error", "missing-result", "ended"]) {
  test(`${mode} stops the run without repeating an uncertain mutation or leaking upstream error text`, async () => {
    const fake = await fakeEngine(mode);
    try {
      const secret = "private-value-that-must-not-be-logged";
      await assert.rejects(fake.page.insertText(secret), (error: Error) => {
        assert.equal(error.message.includes(secret), false);
        if (mode !== "error") {
          assert.ok(error instanceof EngineUncertain);
          const cause = mode === "hang" ? "deadline" : mode === "malformed" ? "invalid-json" : mode === "ended" ? "socket-ended" : "action-result";
          assert.ok(error.message.includes(`(${cause})`));
        }
        return true;
      });
      await assert.rejects(fake.page.insertText("second"), /stopped/);
      assert.equal((await fake.records()).filter((cmd) => cmd.action === "keyboard").length, 1);
    } finally { await fake.close(); }
  });
}

test("ambiguous selection fails before any mutation", async () => {
  const fake = await fakeEngine("ambiguous");
  try {
    await assert.rejects(fake.page.click(".two"), /unique/);
    assert.equal((await fake.records()).some((cmd) => cmd.action === "click"), false);
  } finally { await fake.close(); }
});

test("navigation allows the native 25-second wait to finish within a bounded 30-second deadline", async (t) => {
  const fake = await fakeEngine("ok", null);
  try {
    const timer = t.mock.method(globalThis, "setTimeout");
    await fake.page.goto("https://example.test/");
    assert.ok(timer.mock.calls.some((call) => call.arguments[1] === 30_000));
    timer.mock.restore();
  } finally { await fake.close(); }
});

test("startup evaluation allows the upstream 30-second wait plus a response budget; ordinary reads keep 12 seconds", async (t) => {
  const fake = await fakeEngine("ok", null);
  const timer = t.mock.method(globalThis, "setTimeout");
  try {
    await fake.page.evaluate("document.readyState", "startup");
    assert.ok(timer.mock.calls.some((call) => call.arguments[1] === 35_000));
    const start = timer.mock.calls.length;
    await fake.page.evaluate("document.title");
    const reads = timer.mock.calls.slice(start);
    assert.ok(reads.some((call) => call.arguments[1] === 12_000));
    assert.equal(reads.some((call) => call.arguments[1] === 35_000), false);
  } finally { timer.mock.restore(); await fake.close(); }
});

test("native navigation uses startup evaluation for both readiness and final location", async (t) => {
  const fake = await fakeEngine();
  const phases: EvaluationPhase[] = [];
  t.mock.method(fake.page, "evaluate", async <T>(expression: string, phase: EvaluationPhase = "page"): Promise<T> => {
    phases.push(phase);
    return (expression === "location.href" ? "https://example.test/" : { href: "https://example.test/", ready: "complete" }) as T;
  });
  try {
    const driver = new CdpLiveDriver({} as CdpSocket, "session", "ABC123", ["example.test"]);
    driver.usePageEngine(fake.page);
    await driver.goto("https://example.test/");
    assert.deepEqual(phases, ["startup", "startup"]);
    assert.equal((await fake.records()).filter((cmd) => cmd.action === "navigate").length, 1);
  } finally { await fake.close(); }
});

test("an uncertain native startup read propagates immediately without another probe", async (t) => {
  const fake = await fakeEngine();
  const failure = new EngineUncertain("evaluate", "deadline");
  const evaluate = t.mock.method(fake.page, "evaluate", async () => { throw failure; });
  try {
    const driver = new CdpLiveDriver({} as CdpSocket, "session", "ABC123", ["example.test"]);
    driver.usePageEngine(fake.page);
    await assert.rejects(driver.goto("https://example.test/", 20), (error) => error === failure);
    assert.equal(evaluate.mock.calls.length, 1);
  } finally { await fake.close(); }
});

test("live activity resets the idle timeout without extending the absolute cap", async () => {
  const idle = await fakeEngine("ok", 150, { idleMs: 500 });
  try {
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await idle.page.evaluate("document.title");
    }
    await new Promise((resolve) => setTimeout(resolve, 600));
    await assert.rejects(idle.page.evaluate("document.title"), /idle timeout/);
  } finally { await idle.close(); }
  const capped = await fakeEngine("ok", 150, { idleMs: 500, lifetimeMs: 900 });
  try {
    for (let i = 0; i < 6; i++) {
      capped.page.touch();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    await assert.rejects(capped.page.evaluate("document.title"), /lifetime exceeded/);
  } finally { await capped.close(); }
});

test("a mismatched native tab response stops startup before any page action", async () => {
  await assert.rejects(fakeEngine("wrongtab"), (error: Error) => error instanceof EngineUncertain && error.message.includes("(action-result)"));
});

test("a missing native executable and remote endpoint cannot cause a browser launch", async () => {
  await assert.rejects(AgentBrowserPage.open({ endpoint: "wss://remote.example/devtools/browser/test", targetId: "ABC", ownership: "external" }), /loopback/);
  await assert.rejects(AgentBrowserPage.open({ endpoint: "ws://127.0.0.1:12345/devtools/browser/test", targetId: "ABC", ownership: "external", executable: "/nonexistent/bao-engine" }), /missing/);
});
