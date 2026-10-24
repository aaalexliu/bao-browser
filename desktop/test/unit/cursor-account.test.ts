// Cursor-account heal. The binary here is a local stand-in. No network, no API key.

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import {
  cursorAccountHeal,
  parseAgentPrint,
  parseAgentStatus,
  resetCursorAccountCache,
} from "../../src/v1/cursor-account";
import type { StepFailure } from "../../src/v1/heal";
import type { WorkflowStep } from "../../src/v1/schema";

const SECRET = "SuperSecretPassword!";

const step: WorkflowStep = {
  id: "s1",
  index: 0,
  action: "click",
  label: "Log in",
  surface: "dom",
  timeoutMs: 8000,
  identity: { surface: "dom", role: "button", testId: "missing", path: [] },
};

const failure = {
  stepId: "s1",
  index: 0,
  intent: `Click login ${SECRET}`,
  phase: "find",
  reason: "below-threshold",
  brokenAttr: "testId",
  snapshot: { dom: { role: "button", testId: "login", note: SECRET } },
} as StepFailure;

function writeAgent(mode: "login" | "logged-out" | "flag" | "fail"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-agent-"));
  const file = path.join(dir, "agent");
  const body = `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
if (process.env.BAO_AGENT_LOG) fs.writeFileSync(process.env.BAO_AGENT_LOG, JSON.stringify(args));
if (args[0] === "status") {
  const loggedOut = ${mode === "logged-out" ? "true" : "false"};
  const body = loggedOut
    ? { status: "unauthenticated", isAuthenticated: false, hasAccessToken: false, hasRefreshToken: false, message: "Not logged in" }
    : { status: "authenticated", isAuthenticated: true, hasAccessToken: true, hasRefreshToken: true, userInfo: { email: "dev@example.com" } };
  process.stdout.write(JSON.stringify(body));
  process.exit(0);
}
let stdin = "";
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  if (process.env.BAO_AGENT_STDIN) fs.writeFileSync(process.env.BAO_AGENT_STDIN, stdin);
  if (${mode === "fail" ? "true" : "false"}) process.exit(1);
  const source = ${mode === "flag" ? '"flag"' : '"login"'};
  const lines = [
    { type: "system", subtype: "init", apiKeySource: source, model: "Composer", session_id: "s" },
    { type: "result", subtype: "success", is_error: false, result: JSON.stringify({ identity: { surface: "dom", role: "button", testId: "login", path: [] } }), session_id: "s" },
  ];
  process.stdout.write(lines.map((line) => JSON.stringify(line)).join("\\n") + "\\n");
  process.exit(0);
});
`;
  writeFileSync(file, body);
  chmodSync(file, 0o755);
  return file;
}

function envFor(bin: string, extra: NodeJS.ProcessEnv = {}): { env: NodeJS.ProcessEnv; log: string; stdin: string } {
  const dir = path.dirname(bin);
  const log = path.join(dir, "args.json");
  const stdin = path.join(dir, "stdin.txt");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BAO_CURSOR_AGENT: bin,
    BAO_AGENT_LOG: log,
    BAO_AGENT_STDIN: stdin,
    BAO_HEAL_WAIT_MS: "2000",
    ...extra,
  };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.BAO_HEAL_CURSOR_ACCOUNT;
  delete env.BAO_HEAL_FIXTURE;
  delete env.CURSOR_API_KEY;
  return { env, log, stdin };
}

test("logged-out status JSON is not a Cursor session", () => {
  const status = parseAgentStatus(JSON.stringify({
    status: "unauthenticated",
    isAuthenticated: false,
    hasAccessToken: false,
    hasRefreshToken: false,
    message: "Not logged in",
  }));
  assert.equal(status.authenticated, false);
  assert.equal(status.source, "none");
  const partial = parseAgentStatus(JSON.stringify({
    status: "partially-authenticated",
    isAuthenticated: false,
    hasAccessToken: true,
    hasRefreshToken: false,
  }));
  assert.equal(partial.authenticated, false);
});

test("a logged-in CLI print is the heal and the prompt stays off the command line", async () => {
  const bin = writeAgent("login");
  const { env, log, stdin } = envFor(bin);
  resetCursorAccountCache();
  const heal = await cursorAccountHeal(env, [SECRET]);
  assert.equal(heal.available(), true);
  const proposal = await heal.propose(failure, step);
  assert.ok(proposal);
  assert.equal(proposal.model.provider, "cursor");
  assert.equal(proposal.model.name, "Composer");
  assert.equal(proposal.model.version, "login");
  assert.equal(proposal.patch.identity?.testId, "login");
  assert.equal(proposal.prompt.includes(SECRET), false);
  assert.equal(proposal.rawResponse.includes(SECRET), false);
  const args = JSON.parse(readFileSync(log, "utf8")) as string[];
  assert.equal(args.includes("--api-key"), false);
  assert.equal(args.includes("--print"), true);
  assert.equal(args.includes("ask"), true);
  assert.equal(JSON.stringify(args).includes(SECRET), false);
  assert.equal(JSON.stringify(args).includes("Intent:"), false);
  const sent = readFileSync(stdin, "utf8");
  assert.equal(sent.includes(SECRET), false);
  assert.match(sent, /testId/);
  resetCursorAccountCache();
});

test("print mode that authenticated with a flag is not used", async () => {
  const bin = writeAgent("flag");
  const { env } = envFor(bin);
  resetCursorAccountCache();
  const heal = await cursorAccountHeal(env, [SECRET]);
  assert.equal(await heal.propose(failure, step), null);
  resetCursorAccountCache();
});

test("a logged-out CLI falls back to the response file", async () => {
  const bin = writeAgent("logged-out");
  const dir = mkdtempSync(path.join(tmpdir(), "bao-heal-file-"));
  const { env } = envFor(bin, { BAO_HEAL_CURSOR: "1", BAO_HEAL_DIR: dir });
  resetCursorAccountCache();
  const heal = await cursorAccountHeal(env, [SECRET]);
  assert.equal(heal.available(), true);
  const pending = heal.propose(failure, step);
  setTimeout(() => {
    writeFileSync(path.join(dir, "heal-response.json"), JSON.stringify({
      identity: { surface: "dom", role: "button", testId: "login", path: [] },
    }));
  }, 200);
  const proposal = await pending;
  assert.ok(proposal);
  assert.equal(proposal.model.name, "cursor");
  assert.equal(proposal.model.version, "live");
  assert.equal(proposal.patch.identity?.testId, "login");
  const request = readFileSync(path.join(dir, "heal-request.json"), "utf8");
  assert.equal(request.includes(SECRET), false);
  resetCursorAccountCache();
});

test("stream-json keeps the model name from the init event", () => {
  const stdout = [
    JSON.stringify({ type: "system", subtype: "init", apiKeySource: "login", model: "Composer", session_id: "s" }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "{\"identity\":{}}", session_id: "s" }),
  ].join("\n");
  const parsed = parseAgentPrint(stdout);
  assert.equal(parsed?.model, "Composer");
  assert.equal(parsed?.source, "login");
  assert.match(parsed?.text || "", /identity/);
});

test("the footer names a logged-in Cursor CLI", async () => {
  const bin = writeAgent("login");
  const previous = {
    agent: process.env.BAO_CURSOR_AGENT,
    off: process.env.BAO_HEAL_CURSOR_ACCOUNT,
    fixture: process.env.BAO_HEAL_FIXTURE,
  };
  process.env.BAO_CURSOR_AGENT = bin;
  delete process.env.BAO_HEAL_CURSOR_ACCOUNT;
  delete process.env.BAO_HEAL_FIXTURE;
  resetCursorAccountCache();
  const home = mkdtempSync(path.join(tmpdir(), "bao-account-ui-"));
  const app = await startApp({ home, port: 0 });
  try {
    const res = await fetch(`http://127.0.0.1:${app.port}/api/state`);
    const state = await res.json() as { model?: { label?: string } };
    assert.equal(state.model?.label, "cursor account");
  } finally {
    await app.close();
    if (previous.agent === undefined) delete process.env.BAO_CURSOR_AGENT;
    else process.env.BAO_CURSOR_AGENT = previous.agent;
    if (previous.off === undefined) delete process.env.BAO_HEAL_CURSOR_ACCOUNT;
    else process.env.BAO_HEAL_CURSOR_ACCOUNT = previous.off;
    if (previous.fixture === undefined) delete process.env.BAO_HEAL_FIXTURE;
    else process.env.BAO_HEAL_FIXTURE = previous.fixture;
    resetCursorAccountCache();
  }
});
