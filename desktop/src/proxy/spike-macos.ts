// Scripted macOS spike. OpenAI and Claude loops click Calculator 7 + 5 =.
// Replay looks the buttons up again after the window moves. No model calls.

import { execFile } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { MacOsHelper } from "./os-macos";
import {
  clearDisplay, isTwelve, measureKeys, outsidePoint, readout, recordCalc, relaunchCalc, replayCalc,
} from "./spike-macos-calc";
import { runTextEdit } from "./spike-macos-edit";
import { ARTIFACTS, CALC_BUNDLE, HELPER, ensureArtifacts, quitOwned, sleep, workDir, writeJson } from "./spike-macos-host";

async function gate(helper: MacOsHelper): Promise<Record<string, unknown>> {
  let perm = await helper.permissions(false);
  let prompted = false;
  const allowPrompt = process.env.BAO_OS_PROMPT !== "0";
  if ((!perm.accessibility || !perm.screenCapture) && allowPrompt) {
    perm = await helper.permissions(true);
    prompted = true;
    await sleep(400);
    perm = await helper.permissions(false);
  }
  return {
    ok: Boolean(perm.accessibility && perm.screenCapture),
    prompted,
    accessibility: perm.accessibility,
    screenCapture: perm.screenCapture,
    exe: perm.exe,
    parentExe: perm.parentExe,
  };
}

async function encode(dir: string, out: string): Promise<string> {
  const frames = (await readdir(dir)).filter((name) => name.endsWith(".png")).sort();
  if (frames.length < 2) return "skipped";
  await new Promise<void>((resolve, reject) => {
    execFile("ffmpeg", [
      "-y", "-framerate", "2", "-i", path.join(dir, "frame-%02d.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
    ], { timeout: 30000 }, (err) => err ? reject(err) : resolve());
  });
  return out;
}

async function calculator(helper: MacOsHelper): Promise<Record<string, unknown>> {
  const owned = await launchOwned();
  let pid = owned;
  try {
    const tree = await helper.nodes(CALC_BUNDLE);
    const nodes = tree.nodes ?? [];
    const cleared = await clearDisplay(helper, nodes);
    const fresh = (await helper.nodes(CALC_BUNDLE)).nodes ?? nodes;
    const keys = await measureKeys(fresh);
    const wins = await helper.windows(CALC_BUNDLE);
    const win = wins.windows?.[0];
    if (!win) throw new Error("Calculator has no window");
    const blank = outsidePoint(win);
    await helper.shot(CALC_BUNDLE, path.join(ARTIFACTS, "calc-before.png"));
    const openai = await recordCalc(helper, "openai", keys, blank);
    const openaiShown = readout((await helper.nodes(CALC_BUNDLE)).nodes ?? []);
    await helper.shot(CALC_BUNDLE, path.join(ARTIFACTS, "calc-openai-recorded.png"));
    pid = await relaunchCalc(pid);
    await place(helper, win);
    await clearDisplay(helper, (await helper.nodes(CALC_BUNDLE)).nodes ?? []);
    const openaiReplay = await replayCalc(helper, openai.workflow, path.join(ARTIFACTS, "frames-openai"));
    const openaiAfter = readout((await helper.nodes(CALC_BUNDLE)).nodes ?? []);
    await helper.shot(CALC_BUNDLE, path.join(ARTIFACTS, "calc-openai-replay.png"));
    await clearDisplay(helper, (await helper.nodes(CALC_BUNDLE)).nodes ?? []);
    const movedKeys = await measureKeys((await helper.nodes(CALC_BUNDLE)).nodes ?? []);
    const claude = await recordCalc(helper, "claude", movedKeys, null);
    const claudeShown = readout((await helper.nodes(CALC_BUNDLE)).nodes ?? []);
    await helper.shot(CALC_BUNDLE, path.join(ARTIFACTS, "calc-claude-recorded.png"));
    pid = await relaunchCalc(pid);
    await place(helper, win);
    await clearDisplay(helper, (await helper.nodes(CALC_BUNDLE)).nodes ?? []);
    const claudeReplay = await replayCalc(helper, claude.workflow, path.join(ARTIFACTS, "frames-claude"));
    const claudeAfter = readout((await helper.nodes(CALC_BUNDLE)).nodes ?? []);
    await helper.shot(CALC_BUNDLE, path.join(ARTIFACTS, "calc-claude-replay.png"));
    return {
      cleared, blank, keys: keys.map((k) => ({ label: k.label, x: k.x, y: k.y, role: k.node.role, name: k.node.name })),
      openai: { shown: openaiShown, replayed: openaiAfter, ...openaiReplay, unresolved: openai.workflow.steps.filter((s) => s.unresolved).length, workflow: openai.workflow, trail: openai.trail },
      claude: { shown: claudeShown, replayed: claudeAfter, ...claudeReplay, workflow: claude.workflow, trail: claude.trail },
      pass: isTwelve(openaiAfter) && isTwelve(claudeAfter) && !openaiReplay.coordinateReplay && !claudeReplay.coordinateReplay,
    };
  } finally {
    await quitOwned(pid, "Calculator");
  }
}

async function launchOwned(): Promise<number> {
  const { launchIfDown } = await import("./spike-macos-host");
  const pid = await launchIfDown("Calculator", "Calculator");
  if (pid == null) throw new Error("Calculator was already running; not touching it");
  await sleep(800);
  return pid;
}

async function place(helper: MacOsHelper, win: { x: number; y: number; w: number; h: number }): Promise<void> {
  await helper.moveWindow(CALC_BUNDLE, {
    x: Math.round(win.x + 90),
    y: Math.max(40, Math.round(win.y + 60)),
    w: Math.max(320, Math.round(win.w * 0.86)),
    h: Math.max(280, Math.round(win.h * 0.86)),
  });
  await sleep(300);
}

async function main(): Promise<void> {
  await mkdir(workDir(), { recursive: true });
  await ensureArtifacts();
  const helper = new MacOsHelper(HELPER);
  const permissions = await gate(helper);
  const report: Record<string, unknown> = { macos: "26.6.2 (25G83)", helper: HELPER, permissions };
  if (!permissions.ok) {
    await writeJson("spike-macos-result.json", report);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = 2;
    return;
  }
  try {
    report.calculator = await calculator(helper);
    report.textedit = await runTextEdit(helper);
    report.videoOpenai = await encode(path.join(ARTIFACTS, "frames-openai"), path.join(ARTIFACTS, "calc-openai-replay.mp4"));
    report.videoClaude = await encode(path.join(ARTIFACTS, "frames-claude"), path.join(ARTIFACTS, "calc-claude-replay.mp4"));
  } finally {
    await writeJson("spike-macos-result.json", report);
    await rm(workDir(), { recursive: true, force: true });
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
