import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentBrowserPage, EngineUncertain, pageEngineName } from "../../src/engines/agent-browser";

async function fakeEngine(mode = "ok", commandMs: number | null = 150) {
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
    if (cmd.action === 'fill' && ${JSON.stringify(mode)} === 'hang') return;
    if (cmd.action === 'fill' && ${JSON.stringify(mode)} === 'malformed') { socket.end('not-json\\n'); return; }
    if (cmd.action === 'fill' && ${JSON.stringify(mode)} === 'error') { socket.end(JSON.stringify({ id: cmd.id, success: false, error: cmd.value }) + '\\n'); return; }
    const data = cmd.action === 'evaluate' ? { result: {count: ${mode === "ambiguous" ? 2 : 1}, credential: false} } : cmd.action === 'fill' ? {filled: cmd.selector} : cmd.action === 'tab_switch' ? {targetId: ${mode === "wrongtab" ? "'WRONG'" : "cmd.tabId"}} : {};
    socket.end(JSON.stringify({id: cmd.id, success: true, data}) + '\\n');
  });
}).listen(process.env.AGENT_BROWSER_SOCKET_DIR + '/bao.sock');
`, { mode: 0o700 });
  let page: AgentBrowserPage;
  try { page = await AgentBrowserPage.open({ endpoint: "ws://127.0.0.1:12345/devtools/browser/test", targetId: "ABC123", ownership: "external", executable, artifactDir: root, ...(commandMs === null ? {} : { commandMs }) }); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  const records = async () => (await readFile(output, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { page, records, async close() { await page.close(); await rm(root, { recursive: true, force: true }); } };
}

test("engine selection defaults to old and refuses unknown choices", () => {
  assert.equal(pageEngineName(""), "old");
  assert.equal(pageEngineName("old"), "old");
  assert.equal(pageEngineName("agent-browser"), "agent-browser");
  assert.throws(() => pageEngineName("other"), /must be/);
});

test("native transport keeps option-shaped text and secrets out of argv and environment", async () => {
  const fake = await fakeEngine();
  try {
    const literal = '--provider remote\n"secret literal"\\';
    await fake.page.fill("#field", literal);
    const [spawn, ...commands] = await fake.records();
    assert.deepEqual(spawn.argv.slice(2), []);
    assert.equal(JSON.stringify(spawn).includes(literal), false);
    assert.equal(spawn.env.AGENT_BROWSER_NO_WEBMCP, "1");
    assert.equal(spawn.env.AGENT_BROWSER_CDP, "ws://127.0.0.1:12345/devtools/browser/test");
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "CURSOR_API_KEY", "AGENT_BROWSER_PROVIDER", "NODE_OPTIONS"]) assert.equal(spawn.env[key], undefined);
    assert.deepEqual(commands.filter((cmd) => cmd.action === "fill").map((cmd) => cmd.value), [literal]);
    const stateDir = fake.page.stateDir;
    await fake.page.close();
    assert.throws(() => process.kill(spawn.pid, 0));
    await assert.rejects(readFile(path.join(stateDir, "bao.pid")), /ENOENT/);
    assert.equal((await fake.records()).some((cmd) => cmd.action === "close"), false, "disconnect never sends browser close");
  } finally { await fake.close(); }
});

for (const mode of ["hang", "malformed", "error"]) {
  test(`${mode} stops the run without repeating an uncertain mutation or leaking upstream error text`, async () => {
    const fake = await fakeEngine(mode);
    try {
      const secret = "private-value-that-must-not-be-logged";
      await assert.rejects(fake.page.fill("#field", secret), (error: Error) => {
        assert.equal(error.message.includes(secret), false);
        if (mode !== "error") assert.ok(error instanceof EngineUncertain);
        return true;
      });
      await assert.rejects(fake.page.fill("#field", "second"), /stopped/);
      assert.equal((await fake.records()).filter((cmd) => cmd.action === "fill").length, 1);
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

test("a mismatched native tab response stops startup before any page action", async () => {
  await assert.rejects(fakeEngine("wrongtab"), EngineUncertain);
});

test("a missing native executable and remote endpoint cannot cause a browser launch", async () => {
  await assert.rejects(AgentBrowserPage.open({ endpoint: "wss://remote.example/devtools/browser/test", targetId: "ABC", ownership: "external", artifactDir: "/tmp" }), /loopback/);
  await assert.rejects(AgentBrowserPage.open({ endpoint: "ws://127.0.0.1:12345/devtools/browser/test", targetId: "ABC", ownership: "external", artifactDir: "/tmp", executable: "/nonexistent/bao-engine" }), /missing/);
});
