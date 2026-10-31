// Opt-in. Starts throwaway copies of the installed Google Chrome, never the daily profile.
// Run: BAO_REMOTE_DEBUGGING_LIVE=1 BAO_OS_HELPER=<signed BaoOSHelper.app> npx tsc -p tsconfig.desktop.json && node --test desktop/dist/desktop/test/live/remote-debugging-live.test.js

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromeHelper, closeInspectTab, openInspect } from "../../src/cdp-live/ax";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { setRemoteDebugging } from "../../src/cdp-live/remote-debugging";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const enabled = process.env.BAO_REMOTE_DEBUGGING_LIVE === "1";

function browserPids(text: string, dir: string): number[] {
  const pids: number[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || !match[2].includes(dir) || /\s--type=/.test(match[2])) continue;
    pids.push(Number(match[1]));
  }
  return pids;
}

function ps(): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("/bin/ps", ["-axww", "-o", "pid=,args="], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    child.on("close", () => resolve(out));
  });
}

test("throwaway Chrome remote debugging turns on and off by pid with a decoy", { skip: enabled ? false : "set BAO_REMOTE_DEBUGGING_LIVE=1" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-rd-live-"));
  const targetDir = path.join(root, "target");
  const decoyDir = path.join(root, "decoy");
  const children: ReturnType<typeof spawn>[] = [];
  const before = await ps();
  try {
    children.push(spawn(CHROME, ["--headless=new", `--user-data-dir=${decoyDir}`, "--no-first-run", "--disable-sync", "about:blank"], { stdio: "ignore" }));
    children.push(spawn(CHROME, ["--user-data-dir=" + targetDir, "--no-first-run", "--no-default-browser-check", "--disable-sync", "--window-size=1100,800", "about:blank"], { stdio: "ignore" }));
    const pid = await waitForPid(targetDir);
    const decoy = await waitForPid(decoyDir);
    const helper = chromeHelper();
    const axLog = path.join(root, "ax.jsonl");
    const portFile = path.join(targetDir, "DevToolsActivePort");
    const deps = {
      helper,
      portFile,
      axLog,
      openInspect: (chromePid: number) => openInspect(helper, axLog, chromePid),
      screenLocked: () => helper.screenLocked(),
      closeOpenedTab: (chromePid: number) => closeInspectTab(helper, axLog, chromePid),
      findChrome: async (dir: string) => browserPids(await ps(), dir),
    };
    const on = await setRemoteDebugging(true, deps);
    assert.equal(on.pid, pid);
    assert.equal(on.already, false);
    assert.ok(on.port);
    const again = await setRemoteDebugging(true, deps);
    assert.equal(again.already, true);
    assert.equal(again.port, on.port);
    const endpoint = await readDevToolsActivePort(portFile);
    assert.equal(endpoint.port, on.port);
    const off = await setRemoteDebugging(false, deps);
    assert.equal(off.port, null);
    const stillOff = await setRemoteDebugging(false, deps);
    assert.equal(stillOff.already, true);
    const decoyAfter = browserPids(await ps(), decoyDir);
    assert.deepEqual(decoyAfter, [decoy]);
    const daily = browserPids(before, path.join(process.env.HOME || "", "Library/Application Support/Google/Chrome"));
    const dailyAfter = browserPids(await ps(), path.join(process.env.HOME || "", "Library/Application Support/Google/Chrome"));
    assert.deepEqual(dailyAfter, daily);
  } finally {
    for (const child of children) child.kill("SIGTERM");
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForPid(dir: string): Promise<number> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const pids = browserPids(await ps(), dir);
    if (pids[0]) return pids[0];
    if (Date.now() > deadline) throw new Error(`Chrome did not start for ${dir}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
