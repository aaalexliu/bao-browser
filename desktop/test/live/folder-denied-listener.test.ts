// A throwaway Google Chrome, never the daily profile. The live runner starts it because a hermetic
// lane returns before pid matching, and a hold fixture skips that match. The folder is the path
// mkdtemp returns. macOS realpaths /var/folders to /private/var/folders; the hold passes that twin.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromeDataPath } from "../../src/chrome-access";
import { holdDir } from "../../src/cdp-live/chrome-hold";
import { listeningProfileDirectory } from "../../src/cdp-live/current-chrome";
import { scaledMs } from "../runtime";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = /^(?:Default|Profile \d+)$/;

function signalMatching(dir: string, signal: NodeJS.Signals): void {
  const found = spawnSync("pgrep", ["-f", dir], { encoding: "utf8" });
  for (const pid of (found.stdout || "").split(/\s+/)) {
    if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
    try { process.kill(Number(pid), signal); } catch { /* already gone */ }
  }
}

test("a denied Chrome folder still names the profile the listener opened", { timeout: scaledMs(90_000), skip: existsSync(CHROME) ? false : "Google Chrome is not installed" }, async (t) => {
  delete process.env.BAO_CHROME_HOLD_FIXTURE;
  const root = await mkdtemp(path.join(tmpdir(), "bao-ale79-loc-"));
  const held = holdDir(root);
  const child = spawn(CHROME, [
    `--user-data-dir=${root}`,
    "--remote-debugging-port=0",
    "--profile-directory=Profile 1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--no-startup-window",
  ], { stdio: "ignore" });
  t.after(async () => {
    await chmod(root, 0o700).catch(() => undefined);
    try {
      const record = JSON.parse(await readFile(path.join(held, "hold.json"), "utf8")) as { holderPid?: number };
      if (record.holderPid && record.holderPid !== process.pid) process.kill(record.holderPid, "SIGTERM");
    } catch { /* the hold already ended */ }
    signalMatching(root, "SIGKILL");
    signalMatching(chromeDataPath(root), "SIGKILL");
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
    await rm(held, { recursive: true, force: true });
  });
  assert.equal(process.env.BAO_CHROME_HOLD_FIXTURE, undefined);
  assert.notEqual(chromeDataPath(root), root, "this Chrome's argv path is not the realpath the hold passes in");

  const stateFile = path.join(root, "Local State");
  const portFile = path.join(root, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  let opened = "";
  while (Date.now() < deadline && !opened) {
    if (existsSync(stateFile)) {
      const state = JSON.parse(await readFile(stateFile, "utf8")) as { profile?: { last_used?: unknown } };
      const last = state.profile?.last_used;
      if (typeof last === "string" && PROFILE.test(last) && existsSync(portFile)) opened = last;
    }
    if (!opened) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.equal(opened, "Profile 1", "Chrome's Local State last_used is the profile it opened");

  await chmod(portFile, 0o000);
  await chmod(root, 0o111);
  const reported = await listeningProfileDirectory(root);
  assert.equal(reported, opened);
});
