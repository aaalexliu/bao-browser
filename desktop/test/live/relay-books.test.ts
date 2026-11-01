// Throwaway Chrome profile, public books.toscrape.com only. Not part of test:v1.
// The port file this process reads is a copy under tmp, named DevToolsActivePort.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { workflowDriver } from "../../src/extension/protocol";
import { createRemoteAgent } from "../../src/v1/remote-agent";
import { saveRelay } from "../../src/v1/relay-link";
import { replayLiveWorkflow } from "../../src/cdp-live/live-replay";
import { pinTestBrowser } from "../../src/launch";
import { TEST_MEDIA_ARGS } from "../../src/test-browser.js";
import type { WorkflowV2 } from "../../src/v1/schema";
import { Library } from "../../src/v1/store";
import { MemoryJobStore } from "../../../web/src/lib/relay-job";
import { createRelay, listenRelay, MemoryDirectory } from "../../../web/src/lib/relay";

const TEST_BROWSER = pinTestBrowser();

test("a paired relay replays books.toscrape.com from a throwaway profile", { timeout: 180_000 }, async () => {
  const previous = {
    sandbox: process.env.BAO_CHROME_NO_SANDBOX,
    headed: process.env.BAO_HEADED,
    heal: process.env.BAO_HEAL_CURSOR_ACCOUNT,
    remote: process.env.BAO_REMOTE_MCP,
  };
  process.env.BAO_CHROME_NO_SANDBOX = "1";
  process.env.BAO_HEADED = "0";
  process.env.BAO_HEAL_CURSOR_ACCOUNT = "0";
  delete process.env.BAO_REMOTE_MCP;
  const root = mkdtempSync(path.join(tmpdir(), "bao-relay-books-"));
  const library = new Library(root);
  library.save(books("books-playwright"));
  library.updateSettings({ remoteMcp: true, remotePermission: "ask" });
  const store = new MemoryJobStore();
  const directory = new MemoryDirectory();
  directory.addDevice("dev-books", "user-books");
  const relay = createRelay({ store, directory, enabled: () => true });
  const server = await listenRelay(relay, {
    principal(req) {
      const user = req.headers["x-test-user"];
      return typeof user === "string" && user ? { userId: user } : null;
    },
  });
  let chrome: ChildProcess | undefined;
  try {
    const paired = await claim(server.origin);
    const agent = await directory.mintAgent("user-books", paired.deviceId);
    assert.ok(agent);
    saveRelay(root, { server: server.origin, token: paired.token, deviceId: paired.deviceId, tokenId: paired.tokenId });
    const device = createRemoteAgent({
      library,
      prompts: {},
      stop() {},
      clearStop() {},
      autoAllow: true,
    });
    device.start();
    try {
      await waitForOnline(server.origin, agent.token);
      const started = Date.now();
      const done = await tool(server.origin, agent.token, "books-playwright");
      const ms = Date.now() - started;
      console.log(`books replay round trip ms=${ms}`);
      assert.equal(done.outcome, "ok", JSON.stringify(done));
      assert.ok(ms < 120_000, `replay took ${ms}ms`);
      const job = store.snapshot().find((item) => item.workflowId === "books-playwright");
      assert.ok(job);
      const dumped = JSON.stringify(job);
      assert.equal(dumped.includes("cookie"), false);
      assert.equal(dumped.includes("password"), false);
      assert.equal(dumped.includes("iVBORw0KGgo"), false);
      const profile = path.join(root, "chrome-profile");
      assert.equal(profile.startsWith(tmpdir()), true);
      assert.equal(workflowDriver(library.read("books-playwright")), "playwright");
    } finally {
      await device.stop();
    }

    const userData = path.join(root, "cdp-user");
    mkdirSync(userData, { recursive: true });
    chrome = spawn(TEST_BROWSER, [
      `--user-data-dir=${userData}`,
      "--remote-debugging-port=0",
      ...TEST_MEDIA_ARGS,
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--no-first-run",
      "--disable-dev-shm-usage",
      "--use-mock-keychain",
      "--password-store=basic",
      "about:blank",
    ], { stdio: "ignore" });
    const written = path.join(userData, "DevToolsActivePort");
    await waitFor(() => existsSync(written), 20_000);
    const portFile = path.join(root, "DevToolsActivePort");
    copyFileSync(written, portFile);
    assert.equal(path.basename(portFile), "DevToolsActivePort");
    assert.equal(portFile.startsWith(root), true);
    library.save(books("books-cdp", "cdp-live"));
    assert.equal(workflowDriver(library.read("books-cdp")), "playwright");
    const liveDevice = createRemoteAgent({
      library,
      prompts: {},
      stop() {},
      clearStop() {},
      autoAllow: true,
      runners: {
        live: (workflow, inputs) => replayLiveWorkflow(workflow, inputs, {
          target: { kind: "throwaway", portFile },
          lockFile: path.join(root, "cdp.lock"),
          openProfile: async () => {
            throw new Error("a throwaway Chrome has no profile window");
          },
          axLog: path.join(root, "ax.jsonl"),
        }),
      },
    });
    liveDevice.start();
    try {
      await waitForOnline(server.origin, agent.token);
      const started = Date.now();
      const done = await tool(server.origin, agent.token, "books-cdp");
      console.log(`books cdp-live round trip ms=${Date.now() - started}`);
      assert.equal(done.outcome, "ok", JSON.stringify(done));
      const job = store.snapshot().find((item) => item.workflowId === "books-cdp");
      const dumped = JSON.stringify(job || {});
      assert.equal(dumped.includes("cookie"), false);
      assert.equal(dumped.includes("iVBORw0KGgo"), false);
    } finally {
      await liveDevice.stop();
    }
  } finally {
    chrome?.kill("SIGKILL");
    rmSync(path.join(root, "cdp-user"), { recursive: true, force: true });
    await server.close();
    restore("BAO_CHROME_NO_SANDBOX", previous.sandbox);
    restore("BAO_HEADED", previous.headed);
    restore("BAO_HEAL_CURSOR_ACCOUNT", previous.heal);
    restore("BAO_REMOTE_MCP", previous.remote);
  }
});

function books(id: string, driver?: WorkflowV2["driver"]): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id,
    name: "Books to Scrape",
    startUrl: "https://books.toscrape.com/",
    inputs: [],
    createdAt: 1,
    steps: [{
      id: "see-books",
      index: 0,
      action: "verify",
      label: "The page says Books",
      surface: "dom",
      timeoutMs: 20_000,
      expect: { kind: "text", match: "Books", timeoutMs: 20_000 },
    }],
    ...(driver ? { driver } : {}),
  };
}

async function claim(origin: string): Promise<{ token: string; tokenId: string; deviceId: string }> {
  const issued = await fetch(`${origin}/api/agent/pair`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-user": "user-books" },
    body: "{}",
  });
  const code = (await issued.json() as { code: string }).code;
  const claimed = await fetch(`${origin}/api/agent/pair/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, name: "throwaway", deviceId: "dev-books" }),
  });
  assert.equal(claimed.status, 200, await claimed.clone().text());
  return await claimed.json() as { token: string; tokenId: string; deviceId: string };
}

async function waitForOnline(origin: string, token: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    const res = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "search_workflows", arguments: { query: "books" } },
      }),
    });
    const body = await res.json() as { result?: { content?: { type?: string; text?: string }[] } };
    const text = body.result?.content?.find((item) => item.type === "text")?.text || "{}";
    const json = JSON.parse(text) as { outcome?: string };
    if (json.outcome && json.outcome !== "device_offline") return;
    if (Date.now() - start > 8000) throw new Error("device stayed offline");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function tool(origin: string, token: string, id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run_workflow", arguments: { id } },
    }),
  });
  const body = await res.json() as { result?: { content?: { type?: string; text?: string }[] } };
  const text = body.result?.content?.find((item) => item.type === "text")?.text || "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function waitFor(ready: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > ms) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 20);
  });
}
