// Replay a live-model OS workflow twice with different inputs. No model calls.

import { execFile } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Workflow } from "../../../src/types";
import type { AuditEvent } from "./audit";
import { bindWorkflow, interpretOs } from "./interpret-os";
import { readout, isTwelve } from "./spike-macos-calc";
import { replayOsWorkflow, replayUsedCoordinates } from "./macos-replay";
import { MacOsHelper, targetFrom } from "./os-macos";
import {
  ARTIFACTS, CALC_BUNDLE, EDIT_BUNDLE, HELPER, cleanupNewAutosave, launchIfDown,
  namesIn, quitOwned, sleep, TEXTEDIT_AUTOSAVE, workDir, writeJson,
} from "./spike-macos-host";
const FFMPEG = process.env.BAO_FFMPEG || "/etc/profiles/per-user/alexliu/bin/ffmpeg";

interface TrailFile {
  source?: { agent?: string; vendor?: string; model?: string };
  events: AuditEvent[];
}

function expected(op: string, a: number, b: number): number {
  if (op === "Subtract" || op === "-") return a - b;
  if (op === "Multiply" || op === "*") return a * b;
  if (op === "Divide" || op === "/") return b === 0 ? NaN : a / b;
  return a + b;
}

function operator(workflow: Workflow): string {
  for (const step of workflow.steps) {
    const name = step.os?.target.name ?? "";
    if (["Add", "Subtract", "Multiply", "Divide", "+", "-", "*", "/"].includes(name)) return name;
  }
  return "Add";
}

async function encode(dir: string, out: string): Promise<string> {
  const frames = (await readdir(dir)).filter((name) => name.endsWith(".png")).sort();
  if (frames.length < 2) return "skipped";
  await new Promise<void>((resolve, reject) => {
    execFile(FFMPEG, [
      "-y", "-framerate", "2", "-start_number", "1", "-i", path.join(dir, "frame-%02d.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
    ], { timeout: 30000 }, (err) => err ? reject(err) : resolve());
  });
  return out;
}

async function place(helper: MacOsHelper, bundle: string): Promise<Record<string, unknown>> {
  const wins = await helper.windows(bundle);
  const win = wins.windows?.[0];
  if (!win) throw new Error(`${bundle} has no window`);
  const moved = await helper.moveWindow(bundle, {
    x: Math.round(win.x + 80),
    y: Math.max(80, Math.round(win.y - 40)),
    w: Math.round(win.w + 40),
    h: Math.round(win.h),
  });
  await sleep(300);
  return { before: moved.before, after: moved.after, resized: moved.resized ?? false, sizeError: moved.sizeError ?? null };
}

async function prepareTextEdit(helper: MacOsHelper): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const nodes = (await helper.nodes(EDIT_BUNDLE)).nodes ?? [];
    const titles = nodes.filter((node) => node.role === "AXWindow").map((node) => (node.name || node.title || "").trim());
    const foreign = titles.find((title) => title !== "" && title !== "Open" && !title.startsWith("Untitled"));
    if (foreign) throw new Error("restored document; aborting without reading it");
    if (titles.includes("Open") && !titles.some((title) => title.startsWith("Untitled"))) {
      const create = nodes.find((node) => node.role === "AXButton" && node.name === "New Document");
      if (!create) throw new Error("TextEdit open panel has no New Document button");
      await helper.press(targetFrom(create, { w: 0, h: 0 }));
      await sleep(400);
      continue;
    }
    if (titles.some((title) => title.startsWith("Untitled"))) return;
    await sleep(250);
  }
  throw new Error("TextEdit opened no untitled window");
}

async function main(): Promise<void> {
  const kind = process.argv[2] === "textedit" ? "textedit" : "calc";
  const trailPath = process.argv[3];
  const tag = process.argv[4] || kind;
  if (!trailPath) throw new Error("usage: spike-macos-live.js calc|textedit <trail.json> <tag>");
  const raw = JSON.parse(await readFile(trailPath, "utf8")) as TrailFile;
  const interpreted = interpretOs(raw.events ?? [], kind);
  await mkdir(workDir(), { recursive: true });
  await mkdir(ARTIFACTS, { recursive: true });
  const helper = new MacOsHelper(HELPER);
  const runs = [];
  if (kind === "calc") {
    const op = operator(interpreted.workflow);
    for (const inputs of [{ a: "3", b: "4" }, { a: "8", b: "1" }]) {
      const want = String(expected(op, Number(inputs.a), Number(inputs.b)));
      const pid = await launchIfDown("Calculator", "Calculator");
      if (pid == null) throw new Error("Calculator was already running");
      await sleep(700);
      try {
        const moved = await place(helper, CALC_BUNDLE);
        const frames = path.join(ARTIFACTS, `live-${tag}-${inputs.a}${inputs.b}`);
        await mkdir(frames, { recursive: true });
        const mark = helper.calls.length;
        let n = 0;
        const bound = bindWorkflow(interpreted.workflow, inputs);
        const replay = await replayOsWorkflow(helper, bound, async () => {
          n += 1;
          await helper.shot(CALC_BUNDLE, path.join(frames, `frame-${String(n).padStart(2, "0")}.png`));
        });
        const shown = readout((await helper.nodes(CALC_BUNDLE)).nodes ?? []);
        await helper.shot(CALC_BUNDLE, path.join(ARTIFACTS, `live-${tag}-${inputs.a}${inputs.b}.png`));
        const video = await encode(frames, path.join(ARTIFACTS, `live-${tag}-${inputs.a}${inputs.b}.mp4`));
        runs.push({
          inputs, want, shown, pass: shown === want || shown === `${want}.`,
          pressed: replay.pressed, skipped: replay.skipped,
          coordinateReplay: replayUsedCoordinates(helper.calls.slice(mark)),
          moved, video,
        });
      } finally {
        await quitOwned(pid, "Calculator");
      }
    }
  } else {
    for (const text of ["alpha one", "beta two"]) {
      const before = await namesIn(TEXTEDIT_AUTOSAVE);
      const pid = await launchIfDown("TextEdit", "TextEdit");
      if (pid == null) throw new Error("TextEdit was already running");
      await sleep(700);
      try {
        await prepareTextEdit(helper);
        const moved = await place(helper, EDIT_BUNDLE);
        const frames = path.join(ARTIFACTS, `live-${tag}-${text.replace(/\s/g, "-")}`);
        await mkdir(frames, { recursive: true });
        const mark = helper.calls.length;
        let n = 1;
        await helper.shot(EDIT_BUNDLE, path.join(frames, "frame-01.png"));
        const bound = bindWorkflow(interpreted.workflow, { text });
        const replay = await replayOsWorkflow(helper, bound, async () => {
          n += 1;
          await helper.shot(EDIT_BUNDLE, path.join(frames, `frame-${String(n).padStart(2, "0")}.png`));
        });
        const nodes = (await helper.nodes(EDIT_BUNDLE)).nodes ?? [];
        const area = nodes.find((node) => node.role === "AXTextArea" || node.role === "AXTextField");
        const shown = area?.value ?? "";
        await helper.shot(EDIT_BUNDLE, path.join(ARTIFACTS, `live-${tag}-${text.replace(/\s/g, "-")}.png`));
        const video = await encode(frames, path.join(ARTIFACTS, `live-${tag}-${text.replace(/\s/g, "-")}.mp4`));
        runs.push({
          inputs: { text }, shown, pass: shown === text,
          pressed: replay.pressed, skipped: replay.skipped,
          coordinateReplay: replayUsedCoordinates(helper.calls.slice(mark)),
          moved, video,
        });
      } finally {
        await quitOwned(pid, "TextEdit");
        await cleanupNewAutosave(before);
      }
    }
  }
  const report = {
    source: raw.source ?? null,
    interpret: { ...interpreted, workflow: interpreted.workflow },
    runs,
    pass: runs.every((run) => run.pass && !run.coordinateReplay),
    twelveCheck: kind === "calc" ? runs.map((run) => isTwelve(String(run.shown))) : undefined,
  };
  const file = await writeJson(`live-${tag}.json`, report);
  console.log(JSON.stringify({ file, pass: report.pass, runs: report.runs, trimmed: interpreted.trimmed, kept: interpreted.kept }, null, 2));
  if (!report.pass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
