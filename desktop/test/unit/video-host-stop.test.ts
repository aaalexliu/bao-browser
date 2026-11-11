// Real host signals against a throwaway headless Chrome. Skips without AGENT_BROWSER_PROXY_BINARY.
// The required experian CI group stages that binary; a local run sets the env. The test never downloads one.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { launchOwnedChromeEndpoint, pidsForDataDir, pinTestBrowser } from "../../src/launch";
import { ffmpegBin } from "../../src/v1/replay-video";
import { chromeProfiles } from "../support/chrome-profiles";

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;
const ffmpeg = ffmpegBin();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let lane: Promise<void> = Promise.resolve();
function exclusive(body: () => Promise<void>): Promise<void> {
  const run = lane.then(body, body);
  lane = run.then(() => undefined, () => undefined);
  return run;
}

function playable(file: string): void {
  const probe = spawnSync(ffmpeg!, ["-hide_banner", "-loglevel", "error", "-i", file, "-frames:v", "1", "-f", "null", "-"]);
  assert.equal(probe.status, 0, probe.stderr.toString());
}

async function pageServer(): Promise<{ base: string; close(): void }> {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end("<!doctype html><title>Order check</title><h1>Order check</h1><label>Name <input id=q></label><button id=b>Save</button><p id=out>Ready</p><script>b.onclick=()=>{out.textContent='Saved '+q.value;document.body.style.background='#d6f5df'}</script>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function mcp(home: string, extra: NodeJS.ProcessEnv): { child: ChildProcessWithoutNullStreams; call(method: string, params: unknown, ms?: number): Promise<{ text: string }> } {
  const cli = path.resolve(__dirname, "../../src/app/cli.js");
  const child = spawn(process.execPath, [cli, "mcp", "--home", home], {
    env: extra,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let text = "";
  let stderr = "";
  let nextId = 1;
  const waiters = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk: Buffer) => {
    text += chunk.toString();
    for (;;) {
      const start = text.indexOf("{");
      if (start < 0) return;
      let depth = 0;
      let quoted = false;
      let escaped = false;
      let end = -1;
      for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === "\"") quoted = false;
          continue;
        }
        if (c === "\"") quoted = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) { end = i + 1; break; }
      }
      if (end < 0) return;
      const message = JSON.parse(text.slice(start, end)) as { id?: number; error?: { message?: string }; result?: { isError?: boolean; content?: { text?: string }[] } };
      text = text.slice(end);
      const waiter = message.id === undefined ? undefined : waiters.get(message.id);
      if (!waiter) continue;
      waiters.delete(message.id!);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || "mcp error"));
      else if (message.result?.isError) waiter.reject(new Error((message.result.content || []).map((block) => block.text || "").join("\n") || stderr));
      else waiter.resolve((message.result?.content || []).map((block) => block.text || "").join("\n"));
    }
  });
  const call = (method: string, params: unknown, ms = 45_000) => new Promise<string>((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`${method} exceeded ${ms}ms\n${stderr}`)); }, ms);
    waiters.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return { child, call: async (method, params, ms) => ({ text: await call(method, params, ms) }) };
}

async function ownedChrome(root: string): Promise<{ profile: string; endpoint: { port: number; browserPath: string }; chromePid: number; browser: string; close(): Promise<void> }> {
  const profile = path.join(root, "chrome");
  await chromeProfiles(profile);
  const browser = pinTestBrowser();
  const chrome = await launchOwnedChromeEndpoint({ userDataDir: profile, headless: true, args: ["--no-startup-window"] });
  const endpoint = await readDevToolsActivePort(chrome.portFile);
  const chromePid = pidsForDataDir(profile)[0];
  assert.ok(chromePid, "owned Chrome PID");
  return {
    profile, endpoint, chromePid, browser,
    async close() {
      for (const pid of pidsForDataDir(profile)) {
        try { process.kill(pid, "SIGCONT"); } catch { /* already gone */ }
      }
      await chrome.close();
    },
  };
}

function childEnv(root: string, chrome: Awaited<ReturnType<typeof ownedChrome>>, ffmpegPath: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/opt/homebrew/bin",
    HOME: root,
    TMPDIR: root,
    PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    BAO_TEST_BROWSER: chrome.browser,
    BAO_CHROME_USER_DATA: chrome.profile,
    BAO_AGENT_BROWSER_PROFILE_ROOT: chrome.profile,
    BAO_CHROME_HOLD_FIXTURE: JSON.stringify({ ...chrome.endpoint, chromePid: chrome.chromePid, executable: chrome.browser }),
    BAO_AGENT_BROWSER: binary,
    BAO_HEAL_CURSOR_ACCOUNT: "0",
    FFMPEG: ffmpegPath,
    ...extra,
  };
}

async function openTask(session: ReturnType<typeof mcp>, base: string): Promise<string> {
  await session.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "video-host-stop", version: "0" } }, 15_000);
  const opened = await session.call("tools/call", { name: "agent_browser", arguments: { command: "open", args: [`${base}/task`], browser: "current", profile: "Default" } });
  const id = opened.text.match(/run-[0-9a-f-]{36}/)?.[0];
  assert.ok(id, opened.text);
  await session.call("tools/call", { name: "agent_browser", arguments: { command: "fill", args: ["#q", "Ada"], run_id: id } });
  await session.call("tools/call", { name: "agent_browser", arguments: { command: "click", args: ["#b"], run_id: id } });
  await wait(400);
  return id;
}

test("a host signal exits within the cap and the run later points at a playable video", { skip: !binary || !ffmpeg, timeout: 360_000 }, () => exclusive(async () => {
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    const root = await mkdtemp(path.join(tmpdir(), "bao-video-signal-"));
    const home = path.join(root, "library");
    const mark = path.join(root, "encoder-started");
    const done = path.join(root, "encoder-done");
    const wrapper = path.join(root, "ffmpeg");
    await writeFile(wrapper, `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
fs.writeFileSync(${JSON.stringify(mark)}, String(process.pid));
setTimeout(() => {
  const child = spawn(${JSON.stringify(ffmpeg)}, process.argv.slice(2), { stdio: "inherit" });
  child.on("exit", (code) => {
    fs.writeFileSync(${JSON.stringify(done)}, "done");
    process.exit(code ?? 1);
  });
}, 20000);
`, { mode: 0o700 });
    const pages = await pageServer();
    const chrome = await ownedChrome(root);
    const session = mcp(home, childEnv(root, chrome, wrapper));
    let id = "";
    try {
      id = await openTask(session, pages.base);
      const signaled = Date.now();
      session.child.kill(signal);
      const code = await new Promise<number | null>((resolve) => session.child.once("exit", resolve));
      const elapsed = Date.now() - signaled;
      assert.ok(elapsed >= 12_000 && elapsed <= 20_000, `${signal} exited in ${elapsed}ms, code ${code}`);
      assert.equal(existsSync(done), false, `${signal} waited for the encode`);
      const savedAt = Date.now() + 40_000;
      let run: { video?: string; videoUnavailable?: string } | undefined;
      while (Date.now() < savedAt) {
        try { run = JSON.parse(await readFile(path.join(home, "runs", `${id}.json`), "utf8")) as { video?: string; videoUnavailable?: string }; }
        catch { /* the exit can land between the temp write and the rename */ }
        if (run?.video) break;
        await wait(100);
      }
      assert.equal(run?.video, `${id}.mp4`, `${signal} run ${JSON.stringify(run)}`);
      assert.equal(run?.videoUnavailable, undefined);
      const file = path.join(home, "videos", `${id}.mp4`);
      assert.ok((await stat(file)).size >= 1000);
      playable(file);
      assert.equal((await readdir(path.join(home, "videos"))).some((name) => name.includes(".frames-")), false);
    } finally {
      if (session.child.exitCode === null) session.child.kill("SIGKILL");
      await chrome.close();
      pages.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}));

test("a host signal after the capture limit still points the run at the saved video", { skip: !binary || !ffmpeg, timeout: 180_000 }, () => exclusive(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-video-limit-signal-"));
  const home = path.join(root, "library");
  const pages = await pageServer();
  const chrome = await ownedChrome(root);
  // Cleanup aborts after one 5 second CDP timeout, so the 15 second cap would lose to encodeVideo. The short cap makes the host-stop claim win while Chrome is stopped.
  const session = mcp(home, childEnv(root, chrome, ffmpeg!, { BAO_CDP_VIDEO_MAX_FRAMES: "2", BAO_HOST_STOP_MS: "1000" }));
  try {
    const id = await openTask(session, pages.base);
    await session.call("tools/call", { name: "agent_browser", arguments: { command: "tab", args: ["new", `${pages.base}/task`], run_id: id } });
    const file = path.join(home, "videos", `${id}.mp4`);
    const ready = Date.now() + 20_000;
    let size = 0;
    while (size < 1000 || existsSync(`${file}.handoff.json`)) {
      assert.ok(Date.now() < ready, `capture limit finished the video; videos=${existsSync(path.join(home, "videos")) ? (await readdir(path.join(home, "videos"))).join(",") : "missing"}`);
      try { size = (await stat(file)).size; } catch { size = 0; }
      await wait(50);
    }
    for (const pid of pidsForDataDir(chrome.profile)) process.kill(pid, "SIGSTOP");
    const signaled = Date.now();
    session.child.kill("SIGTERM");
    const code = await new Promise<number | null>((resolve) => session.child.once("exit", resolve));
    const elapsed = Date.now() - signaled;
    assert.ok(elapsed >= 700 && elapsed <= 4_000, `limit stop exited in ${elapsed}ms, code ${code}`);
    const run = JSON.parse(await readFile(path.join(home, "runs", `${id}.json`), "utf8")) as { video?: string; videoTruncated?: boolean; videoUnavailable?: string };
    assert.equal(run.video, `${id}.mp4`);
    assert.equal(run.videoTruncated, true);
    assert.equal(run.videoUnavailable, undefined);
    assert.ok((await stat(file)).size >= 1000);
    playable(file);
  } finally {
    if (session.child.exitCode === null) session.child.kill("SIGKILL");
    await chrome.close();
    pages.close();
    await rm(root, { recursive: true, force: true });
  }
}));
