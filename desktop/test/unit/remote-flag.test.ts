// Remote MCP is off until the registry flag and this Mac's setting say otherwise.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { remoteBanner, remoteMcpSetting } from "../../src/app/views";
import { createRemoteAgent, desktopRemoteEnabled } from "../../src/v1/remote-agent";
import { saveRelay } from "../../src/v1/relay-link";
import { Library } from "../../src/v1/store";
import { remoteDisabled, remoteMcpEnabled } from "../../../web/src/lib/remote-flag";

test("BAO_REMOTE_MCP is off unless it is exactly 1", async () => {
  assert.equal(remoteMcpEnabled({}), false);
  assert.equal(remoteMcpEnabled({ BAO_REMOTE_MCP: "" }), false);
  assert.equal(remoteMcpEnabled({ BAO_REMOTE_MCP: "0" }), false);
  assert.equal(remoteMcpEnabled({ BAO_REMOTE_MCP: "true" }), false);
  assert.equal(remoteMcpEnabled({ BAO_REMOTE_MCP: "1" }), true);
  const closed = remoteDisabled();
  assert.equal(closed.status, 404);
  assert.deepEqual(await closed.json(), { error: "remote_disabled" });
});

test("the remote agent setting is unchecked and the banner stays empty while it is off", () => {
  const off = remoteMcpSetting(false);
  assert.match(off, /id="remote-mcp" type="checkbox">/);
  assert.match(remoteMcpSetting(true), /id="remote-mcp" type="checkbox" checked>/);
  assert.equal(remoteBanner({ phase: "idle" }), "");
  assert.equal(remoteBanner(undefined), "");
});

test("this Mac dials the websocket only when relay.json is present", async () => {
  const previous = process.env.BAO_REMOTE_MCP;
  delete process.env.BAO_REMOTE_MCP;
  const hits: { path: string; authorization: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    hits.push({ path: req.url || "", authorization: String(req.headers.authorization || "") });
    res.writeHead(404);
    res.end();
  });
  server.on("upgrade", (req, socket) => {
    hits.push({ path: req.url || "", authorization: String(req.headers.authorization || "") });
    socket.destroy();
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  const root = mkdtempSync(path.join(tmpdir(), "bao-remote-flag-"));
  const library = new Library(root);
  writeFileSync(path.join(root, "sync.json"), JSON.stringify({
    server: `http://127.0.0.1:${port}`,
    deviceToken: "fixture-device-token",
    deviceId: "dev-flag",
  }));
  const home = mkdtempSync(path.join(tmpdir(), "bao-remote-setting-"));
  const app = await startApp({ home });
  assert.equal(desktopRemoteEnabled(library), false);
  const agent = createRemoteAgent({ library, prompts: {}, stop() {}, clearStop() {} });
  agent.start();
  try {
    const before = await fetch(`http://127.0.0.1:${app.port}/api/state`).then((res) => res.json()) as {
      settings?: { remoteMcp?: boolean };
      remote?: { phase?: string };
    };
    assert.notEqual(before.settings?.remoteMcp, true);
    assert.equal(before.remote?.phase, "idle");
    const js = await fetch(`http://127.0.0.1:${app.port}/app.js`).then((res) => res.text());
    assert.match(js, /Let a remote agent run workflows on this Mac/);

    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(hits.length, 0);
    assert.equal(agent.view().phase, "idle");
    agent.allow();
    agent.deny();
    assert.equal(remoteBanner(agent.view()), "");

    const saved = await fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteMcp: true }),
    });
    assert.equal(saved.status, 200, await saved.clone().text());
    library.updateSettings({ remoteMcp: true });
    assert.equal(desktopRemoteEnabled(library, {}), true);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    assert.equal(hits.length, 0);
    assert.equal(agent.view().phase, "idle");
    await agent.stop();

    const turnedOff = await fetch(`http://127.0.0.1:${app.port}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ remoteMcp: false }),
    });
    assert.equal(turnedOff.status, 200);
    const disabled = await fetch(`http://127.0.0.1:${app.port}/api/state`).then((res) => res.json()) as { settings?: { remoteMcp?: boolean } };
    assert.equal(disabled.settings?.remoteMcp, false);
    library.updateSettings({ remoteMcp: false });
    delete process.env.BAO_REMOTE_MCP;
    const quiet = createRemoteAgent({ library, prompts: {}, stop() {}, clearStop() {} });
    quiet.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(hits.length, 0);
      assert.equal(quiet.view().phase, "idle");
      quiet.allow();
      assert.equal(remoteBanner(quiet.view()), "");
    } finally {
      await quiet.stop();
    }

    process.env.BAO_REMOTE_MCP = "1";
    assert.equal(desktopRemoteEnabled(library), true);
    const byEnv = createRemoteAgent({ library, prompts: {}, stop() {}, clearStop() {} });
    byEnv.start();
    try {
      await new Promise((resolve) => setTimeout(resolve, 1800));
      assert.equal(hits.length, 0);
      assert.equal(byEnv.view().phase, "idle");
      saveRelay(root, {
        server: `http://127.0.0.1:${port}`,
        token: "bao_rt_fixture",
        deviceId: "dev-flag",
        tokenId: "rtk-flag",
      });
      await waitFor(() => hits.some((hit) => hit.path.startsWith("/api/agent/relay")));
      assert.equal(hits.find((hit) => hit.path.startsWith("/api/agent/relay"))?.authorization, "Bearer bao_rt_fixture");
      assert.equal(byEnv.view().phase, "idle");
    } finally {
      await byEnv.stop();
    }
  } finally {
    await agent.stop();
    if (previous === undefined) delete process.env.BAO_REMOTE_MCP;
    else process.env.BAO_REMOTE_MCP = previous;
    await app.close();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

function waitFor(ready: () => boolean): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (ready()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > 4000) {
        clearInterval(timer);
        reject(new Error("timed out waiting for the websocket"));
      }
    }, 40);
  });
}
