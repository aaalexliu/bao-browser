import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { driverProcessEnv, liveMcpServerEnv, taskPrompt, tokenCount, unavailableReason } from "../../src/eval/live-cli";
import { ACCOUNT_CHROME_MAC, LINUX_CHROME, resolveNormalChrome } from "../../src/launch";
import { frameRpc, takeRpcChunk } from "../../src/eval/live-mcp";
import { CAPTURE_SECRET, DRIVER_TASKS } from "../../src/eval/tasks";

test("a live prompt names the fixture goal and keeps the password out of other tasks", () => {
  const drift = DRIVER_TASKS.find((task) => task.id === "drift");
  const login = DRIVER_TASKS.find((task) => task.id === "login");
  assert.ok(drift && login);
  const driftPrompt = taskPrompt(drift, "");
  assert.equal(driftPrompt.includes("Save"), true);
  assert.equal(driftPrompt.includes(CAPTURE_SECRET), false);
  assert.equal(taskPrompt(login, "").includes(CAPTURE_SECRET), true);
  assert.equal(unavailableReason("cursor").includes("cursor-agent"), true);
});

test("driver env keeps the account home and drops a trail CODEX_HOME", () => {
  const env = driverProcessEnv({
    HOME: "/tmp/bao-live-x/trail.jsonl",
    CODEX_HOME: "/tmp/bao-live-x/trail.jsonl/.codex",
    BAO_HEADED: "1",
    PATH: "/usr/bin",
    AGENT_CLI_CREDENTIAL_STORE: "file",
  });
  assert.equal(env.HOME, userInfo().homedir);
  assert.equal("CODEX_HOME" in env, false);
  assert.equal("BAO_HEADED" in env, false);
  assert.equal("AGENT_CLI_CREDENTIAL_STORE" in env, false);
  assert.equal(env.PATH, "/usr/bin");
});

test("the live evaluator launches the test browser, not the installed Chrome", () => {
  const pin = path.join(mkdtempSync(path.join(tmpdir(), "bao-eval-pin-")), "Google Chrome for Testing");
  writeFileSync(pin, "");
  chmodSync(pin, 0o755);
  const env = liveMcpServerEnv("/tmp/bao-eval-home", "http://127.0.0.1:1/t/form", { BAO_TEST_BROWSER: pin });
  assert.deepEqual(env, {
    BAO_MCP_LIVE: "1",
    BAO_HOME: "/tmp/bao-eval-home",
    BAO_FIXTURE_URL: "http://127.0.0.1:1/t/form",
    BAO_HEADED: "0",
    BAO_TEST_BROWSER: pin,
  });
  const installed = (file: string) => file === ACCOUNT_CHROME_MAC || file === LINUX_CHROME;
  assert.equal(resolveNormalChrome(installed, env, "darwin"), pin);
  assert.throws(
    () => liveMcpServerEnv("/tmp/bao-eval-home", "http://127.0.0.1:1/t/form", { BAO_TEST_BROWSER: ACCOUNT_CHROME_MAC }),
    /BAO_TEST_BROWSER is the installed Google Chrome/,
  );
});

test("stdio accepts a claude json line and a content-length frame", () => {
  const line = Buffer.from('{"jsonrpc":"2.0","id":0,"method":"initialize"}\n');
  const json = takeRpcChunk(line, null);
  assert.ok(json);
  assert.equal(json.framing, "json");
  assert.equal(JSON.parse(json.body).method, "initialize");
  assert.equal(json.rest.length, 0);
  assert.equal(frameRpc({ ok: true }, "json"), '{"ok":true}\n');
  const body = '{"jsonrpc":"2.0","id":1}';
  const framed = Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  const headers = takeRpcChunk(framed, null);
  assert.ok(headers);
  assert.equal(headers.framing, "headers");
  assert.equal(headers.body, body);
});

test("token usage is read from a cli json result", () => {
  const text = JSON.stringify({ usage: { input_tokens: 20, output_tokens: 5 } });
  assert.equal(tokenCount(text), "25");
  assert.equal(tokenCount(JSON.stringify({ usage: { inputTokens: 10, outputTokens: 2 } })), "12");
  assert.equal(tokenCount("no usage here"), "n/a");
});
