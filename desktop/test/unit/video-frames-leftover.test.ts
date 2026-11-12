import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { handoffPaths, sweepClaimedVideoFrames } from "../../src/engines/video-handoff";
import { scaledMs } from "../runtime";

const load = createRequire(__filename);
const handoff = load.resolve("../../src/engines/video-handoff");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function library(name: string): Promise<{ root: string; home: string; runId: string; mp4: string; frames: string }> {
  const root = await mkdtemp(path.join(tmpdir(), `bao-${name}-`));
  const home = path.join(root, "library");
  const runId = "run-frames-leftover";
  const mp4 = path.join(home, "videos", `${runId}.mp4`);
  const frames = `${mp4}.frames-leftover`;
  await mkdir(path.dirname(mp4), { recursive: true });
  await mkdir(path.join(home, "runs"), { recursive: true });
  await mkdir(frames, { recursive: true });
  await writeFile(path.join(frames, "frame-000000.jpg"), Buffer.alloc(32));
  await writeFile(mp4, Buffer.alloc(2000));
  return { root, home, runId, mp4, frames };
}

test("a supervisor that exits during its release wait still removes the frames and keeps the MP4", { timeout: scaledMs(15_000) }, async () => {
  const { root, home, runId, mp4, frames } = await library("video-frames-exit");
  const encoder = path.join(root, "encoder");
  await writeFile(encoder, `#!${process.execPath}
require("node:fs").writeFileSync(process.argv.at(-1), Buffer.alloc(2000));
`, { mode: 0o700 });
  const specPath = handoffPaths(mp4).spec;
  await writeFile(specPath, JSON.stringify({
    destination: mp4,
    framesDir: frames,
    ffmpeg: encoder,
    ffmpegArgs: [mp4],
    deadline: Date.now() + 30_000,
    parentPid: process.pid,
    truncated: false,
    runFile: path.join(home, "runs", `${runId}.json`),
    videoName: `${runId}.mp4`,
    startedAt: 1,
  }), { mode: 0o600 });
  await writeFile(path.join(home, "runs", `${runId}.json`), JSON.stringify({ id: runId }));
  const child = spawn(process.execPath, [handoff, specPath], { stdio: "ignore" });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    const gone = Date.now() + scaledMs(8_000);
    while (existsSync(frames)) {
      assert.ok(Date.now() < gone, "frames directory removed before the supervisor finishes waiting");
      await wait(20);
    }
    assert.equal((await stat(mp4)).size, 2000);
    const releasedAt = Date.now() + scaledMs(4_000);
    while (!existsSync(handoffPaths(mp4).result)) {
      assert.ok(Date.now() < releasedAt, "encode result written");
      await wait(20);
    }
    await writeFile(handoffPaths(mp4).released, "");
    const attached = Date.now() + scaledMs(4_000);
    let video: string | undefined;
    while (video !== `${runId}.mp4`) {
      assert.ok(Date.now() < attached, "run keeps the MP4 after the release wait");
      await wait(20);
      try { video = (JSON.parse(await readFile(path.join(home, "runs", `${runId}.json`), "utf8")) as { video?: string }).video; }
      catch { /* the run file is between the temp write and the rename */ }
    }
    assert.equal(existsSync(frames), false);
    assert.equal((await stat(mp4)).size, 2000);
    assert.equal(await exited, 0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("a kill during the release wait leaves the MP4 and no frames", { timeout: scaledMs(15_000) }, async () => {
  const { root, home, runId, mp4, frames } = await library("video-frames-kill");
  const encoder = path.join(root, "encoder");
  await writeFile(encoder, `#!${process.execPath}
require("node:fs").writeFileSync(process.argv.at(-1), Buffer.alloc(2000));
`, { mode: 0o700 });
  const specPath = handoffPaths(mp4).spec;
  await writeFile(specPath, JSON.stringify({
    destination: mp4, framesDir: frames, ffmpeg: encoder, ffmpegArgs: [mp4],
    deadline: Date.now() + 30_000, parentPid: process.pid, truncated: false,
    runFile: path.join(home, "runs", `${runId}.json`), videoName: `${runId}.mp4`, startedAt: 1,
  }), { mode: 0o600 });
  const child = spawn(process.execPath, [handoff, specPath], { stdio: "ignore" });
  try {
    const gone = Date.now() + scaledMs(8_000);
    while (existsSync(frames)) {
      assert.ok(Date.now() < gone, "frames removed before the wait can be killed");
      await wait(20);
    }
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await writeFile(path.join(home, "runs", `${runId}.json`), JSON.stringify({ id: runId, video: `${runId}.mp4` }));
    sweepClaimedVideoFrames(home);
    assert.equal(existsSync(frames), false);
    assert.equal((await stat(mp4)).size, 2000);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed encode keeps its frames until the run claims a video", { timeout: scaledMs(15_000) }, async () => {
  const { root, home, runId, mp4, frames } = await library("video-frames-fail");
  const encoder = path.join(root, "encoder");
  await writeFile(encoder, `#!${process.execPath}
process.exit(1);
`, { mode: 0o700 });
  await writeFile(handoffPaths(mp4).spec, JSON.stringify({
    destination: mp4, framesDir: frames, ffmpeg: encoder, ffmpegArgs: [mp4],
    deadline: Date.now() + 30_000, parentPid: process.pid, truncated: false,
    runFile: path.join(home, "runs", `${runId}.json`), videoName: `${runId}.mp4`, startedAt: 1,
  }), { mode: 0o600 });
  await writeFile(path.join(home, "runs", `${runId}.json`), JSON.stringify({ id: runId }));
  const child = spawn(process.execPath, [handoff, handoffPaths(mp4).spec], { stdio: "ignore" });
  try {
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    assert.equal(code, 1);
    assert.equal(existsSync(frames), true);
    assert.equal((await stat(mp4)).size, 2000);
    sweepClaimedVideoFrames(home);
    assert.equal(existsSync(frames), true);
    assert.equal((await stat(mp4)).size, 2000);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("the next start removes only frames whose run already has that video", { timeout: scaledMs(30_000) }, async () => {
  const { root, home, runId, mp4, frames } = await library("video-frames-sweep");
  const other = path.join(home, "videos", "run-still-encoding.mp4.frames-live");
  const link = path.join(home, "videos", "run-link.mp4.frames-link");
  await mkdir(other, { recursive: true });
  await writeFile(path.join(other, "frame.jpg"), Buffer.alloc(8));
  await writeFile(path.join(home, "runs", "run-still-encoding.json"), JSON.stringify({ id: "run-still-encoding" }));
  await writeFile(path.join(home, "runs", "run-link.json"), JSON.stringify({ id: "run-link", video: "run-link.mp4" }));
  await writeFile(path.join(home, "runs", `${runId}.json`), JSON.stringify({ id: runId, video: `${runId}.mp4` }));
  const { symlink } = await import("node:fs/promises");
  await symlink(mp4, link);
  try {
    sweepClaimedVideoFrames(home);
    assert.equal(existsSync(frames), false);
    assert.equal(existsSync(other), true);
    assert.equal(existsSync(link), true);
    assert.equal((await stat(mp4)).size, 2000);
    const { startApp } = await import("../../src/app/server");
    const replanted = `${mp4}.frames-again`;
    await mkdir(replanted, { recursive: true });
    const previous = process.env.BAO_HOME;
    const app = await startApp({ home, port: 0, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
    try {
      assert.equal(existsSync(replanted), false);
      assert.equal((await stat(mp4)).size, 2000);
      assert.equal(existsSync(other), true);
    } finally {
      await app.close();
      if (previous === undefined) delete process.env.BAO_HOME; else process.env.BAO_HOME = previous;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an mcp start sweeps claimed frames and leaves the MP4", { timeout: scaledMs(20_000) }, async () => {
  const { root, home, runId, mp4, frames } = await library("video-frames-mcp");
  const live = path.join(home, "videos", "run-live.mp4.frames-live");
  await mkdir(live, { recursive: true });
  await writeFile(path.join(home, "runs", `${runId}.json`), JSON.stringify({ id: runId, video: `${runId}.mp4` }));
  await writeFile(path.join(home, "runs", "run-live.json"), JSON.stringify({ id: "run-live" }));
  const cli = path.resolve(__dirname, "../../src/app/cli.js");
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: root, BAO_HEAL_CURSOR_ACCOUNT: "0" };
  delete env.BAO_HOME;
  const child = spawn(process.execPath, [cli, "mcp", "--home", home], { env, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdin.end();
  try {
    const gone = Date.now() + scaledMs(10_000);
    while (existsSync(frames)) {
      assert.ok(Date.now() < gone, `mcp start left claimed frames\n${stderr}`);
      await wait(20);
    }
    assert.equal(existsSync(live), true);
    assert.equal((await stat(mp4)).size, 2000);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
