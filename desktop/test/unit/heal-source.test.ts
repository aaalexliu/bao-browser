import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { MacOsHelper } from "../../src/proxy/os-macos";
import { resetCursorAccountCache } from "../../src/v1/cursor-account";
import type { HealSource } from "../../src/v1/heal";
import type { WorkflowV2 } from "../../src/v1/schema";

const patch = { identity: { surface: "dom", role: "button", testId: "login", path: [] } };

test("saved None, Cursor account and API keys drive real replay heals after restart", { timeout: 120_000 }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-heal-source-"));
  const previous = { HOME: process.env.HOME, BAO_CURSOR_AGENT: process.env.BAO_CURSOR_AGENT, BAO_HEAL_CURSOR_ACCOUNT: process.env.BAO_HEAL_CURSOR_ACCOUNT };
  process.env.HOME = home;
  process.env.BAO_CURSOR_AGENT = path.join(home, "agent");
  process.env.BAO_HEAL_CURSOR_ACCOUNT = "1";
  const callsFile = path.join(home, "cursor-calls.jsonl");
  await writeFile(process.env.BAO_CURSOR_AGENT, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv[2] === 'status') {
  console.log(JSON.stringify({status:'authenticated',isAuthenticated:true}));
} else {
  let prompt = '';
  process.stdin.on('data', chunk => { prompt += chunk; });
  process.stdin.on('end', () => {
    fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({args:process.argv.slice(2),prompt}) + '\\n');
    console.log(JSON.stringify({type:'system',subtype:'init',apiKeySource:'login',model:'fixture-cursor'}));
    console.log(JSON.stringify({type:'result',subtype:'success',result:${JSON.stringify(JSON.stringify(patch))}}));
  });
}
`);
  await chmod(process.env.BAO_CURSOR_AGENT, 0o755);
  resetCursorAccountCache();
  t.mock.method(MacOsHelper.prototype, "exec", async () => ({ ok: true, accessibility: false }));
  const vendorCalls: { url: string; auth: string | null }[] = [];
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.openai.com/") || url.startsWith("https://api.anthropic.com/")) {
      const headers = new Headers(init?.headers);
      vendorCalls.push({ url, auth: headers.get("authorization") || headers.get("x-api-key") });
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      assert.match(body.messages[0].content, /missing-login/);
      return new Response(JSON.stringify(url.includes("openai")
        ? { choices: [{ message: { content: JSON.stringify(patch) } }] }
        : { content: [{ type: "text", text: JSON.stringify(patch) }] }), { status: 200 });
    }
    return realFetch(input, init);
  });
  const libraryHome = path.join(home, "library");
  const options = { home: libraryHome, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") };
  let app = await startApp(options);
  const cursorCalls = async () => (await readFile(callsFile, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  const choices: HealSource[] = [
    { kind: "none" },
    { kind: "cursor-account" },
    { kind: "api-key", provider: "openai", key: "fixture-openai-key" },
    { kind: "api-key", provider: "anthropic", key: "fixture-anthropic-key" },
    { kind: "none" },
  ];
  try {
    for (const [index, choice] of choices.entries()) {
      const response = await realFetch(`http://127.0.0.1:${app.port}/api/settings`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ healSource: choice }),
      });
      assert.equal(response.status, 200);
      await app.close();
      app = await startApp(options);
      const state = await (await realFetch(`http://127.0.0.1:${app.port}/api/state`)).json() as { settings: { healSource: HealSource } };
      assert.deepEqual(state.settings.healSource, choice);
      const workflow: WorkflowV2 = {
        schema: "bao.workflow/v2", version: 2, createdAt: 1, id: `wf-source-${index}`, name: "Fixture heal source", startUrl: `http://127.0.0.1:${app.port}/fixture`,
        inputs: [], steps: [{ id: "login", index: 0, action: "click", label: "Click login", intent: "the missing control", surface: "dom", identity: { surface: "dom", role: "button", testId: "missing-login", path: [] }, timeoutMs: 500 }],
      };
      app.library.save(workflow);
      const beforeCursor = (await cursorCalls()).length;
      const beforeVendor = vendorCalls.length;
      const runResponse = await realFetch(`http://127.0.0.1:${app.port}/api/replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: workflow.id, args: {} }) });
      const run = await runResponse.json() as { status: string; runId: string; error?: string };
      assert.equal(runResponse.ok, true, JSON.stringify(run));
      assert.equal(run.status, choice.kind === "none" ? "failed" : "passed", JSON.stringify(run));
      const stored = app.library.readRun(run.runId);
      assert.equal(stored.heals.length, choice.kind === "none" ? 0 : 1);
      assert.equal((await cursorCalls()).length - beforeCursor, choice.kind === "cursor-account" ? 1 : 0);
      assert.equal(vendorCalls.length - beforeVendor, choice.kind === "api-key" ? 1 : 0);
      if (choice.kind === "api-key") {
        assert.equal(vendorCalls.at(-1)?.auth, choice.provider === "openai" ? `Bearer ${choice.key}` : choice.key);
        assert.ok(vendorCalls.at(-1)?.url.includes(`api.${choice.provider}.com/`));
      }
      if (choice.kind === "cursor-account") {
        const call = JSON.parse((await cursorCalls()).at(-1)!) as { args: string[]; prompt: string };
        assert.ok(call.args.includes("--print"));
        assert.match(call.prompt, /missing-login/);
        assert.equal(call.args.includes("--api-key"), false);
      }
    }
    for (const invalid of [null, { kind: "other" }, { kind: "api-key", provider: "openai", key: " " }, { kind: "api-key", provider: "other", key: "fixture" }]) {
      const response = await realFetch(`http://127.0.0.1:${app.port}/api/settings`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ healSource: invalid }) });
      assert.equal(response.status, 400);
      assert.deepEqual(app.library.settings().healSource, { kind: "none" });
    }
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetCursorAccountCache();
    await rm(home, { recursive: true, force: true });
  }
});
