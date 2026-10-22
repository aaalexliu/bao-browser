// bao eval drivers. Claude, Codex, and Cursor run only when the CLI and a
// credential are both on this machine. Otherwise the cell is "not run".
// The scripted driver is a local MCP client with no model. It is not those CLIs.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { launchOwnedChrome } from "../launch";
import { BrowserDriver } from "../v1/browser-driver";
import { canonical } from "../v1/canonical";
import { condense } from "../v1/condense";
import type { TrailEvent } from "../v1/interpret";
import { replay } from "../v1/replay";
import type { TrajectoryStep } from "../v1/trajectory";
import { validateWorkflow, type ReplayArgs, type WorkflowV2 } from "../v1/schema";
import { driverBinary, driverProcessEnv, ensurePartialTrail, liveCrashReason, runLiveCli, taskPrompt, unavailableReason, type LiveDriver } from "./live-cli";
import { McpClient } from "./mcp-client";
import {
  CAPTURE_SECRET,
  DRIVER_TASKS,
  captureOk,
  taskHtml,
  type DriverTask,
  type FixtureView,
} from "./tasks";

interface TraceStep {
  stepId: string;
  passed: boolean;
  detail: string;
}

export interface FixtureTrail {
  task: string;
  passed: boolean;
  detail: string;
  steps: TraceStep[];
  trajectory: TrajectoryStep[];
}

export interface DriverCell {
  driver: string;
  task: string;
  status: "pass" | "fail" | "not run" | "driver-error" | "infra";
  reason: string;
  taskComplete: string;
  trailComplete: string;
  workflow: string;
  replay: string;
  modelCalls: string;
  latencyMs: string;
  tokens: string;
}

export async function evalDrivers(args: string[] = []): Promise<{ markdown: string; cells: DriverCell[]; video?: string }> {
  delete process.env.BAO_HEADED;
  const out = flag(args, "--out") || path.join("docs", "eval", "drivers.md");
  const only = flag(args, "--driver");
  const onlyTask = flag(args, "--task");
  const tasks = onlyTask ? DRIVER_TASKS.filter((task) => task.id === onlyTask) : DRIVER_TASKS;
  const ready = {
    claude: probeClaude(),
    codex: probeCodex(),
    cursor: probeCursor(),
  };
  const cells: DriverCell[] = [];
  const videos = new Map<string, string>();
  const server = await startFixtures();
  try {
    for (const driver of ["claude", "codex", "cursor"] as const) {
      if (only && only !== driver) continue;
      const reason = ready[driver];
      const bin = driverBinary(driver);
      if (reason || !bin) {
        for (const task of tasks) cells.push(blank(driver, task.id, "not run", reason || unavailableReason(driver)));
        continue;
      }
      let filmed = false;
      let fallback: { workflow: WorkflowV2; task: DriverTask } | undefined;
      for (const task of tasks) {
        const cell = await runLive(driver, bin, task, server.port, { video: task.id === "drift" });
        cells.push(cell.cell);
        if (cell.video) {
          videos.set(driver, cell.video);
          filmed = true;
        } else if (!fallback && cell.workflow && cell.cell.taskComplete === "yes") {
          fallback = { workflow: cell.workflow, task };
        }
      }
      if (!filmed && fallback) {
        const fileName = fallback.task.replayFiles?.[1] || "";
        const outcome = await replayTask(fallback.workflow, fallback.task, server.port, {
          texts: fallback.task.replayTexts[1] || [],
          secret: fallback.task.replaySecrets?.[1] || "",
          filePath: fileName ? writeSample(mkdtempSync(path.join(tmpdir(), "bao-video-file-")), fileName) : "",
          fileName,
          video: true,
          videoName: `driver-replay-${driver}.webm`,
        });
        if (outcome.video) videos.set(driver, outcome.video);
      }
    }
    if (!only || only === "scripted") {
      for (const task of tasks) {
        const cell = await runScripted(task, server.port);
        cells.push(cell.cell);
        if (cell.video) videos.set("scripted", cell.video);
      }
    }
  } finally {
    await server.close();
  }
  const markdown = render(cells, videos);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, markdown);
  const video = videos.values().next().value as string | undefined;
  for (const file of videos.values()) {
    try {
      mkdirSync("/opt/cursor/artifacts", { recursive: true });
      copyFileSync(file, path.join("/opt/cursor/artifacts", path.basename(file)));
    } catch {
      // The artifact directory is not writable on every machine. The docs copy remains.
    }
  }
  return { markdown, cells, video };
}

function blank(driver: string, task: string, status: DriverCell["status"], reason: string): DriverCell {
  return {
    driver,
    task,
    status,
    reason,
    taskComplete: "",
    trailComplete: "",
    workflow: "",
    replay: "",
    modelCalls: "",
    latencyMs: "",
    tokens: "",
  };
}

async function startFixtures(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const id = url.pathname.split("/").filter(Boolean).pop() || "";
    const html = taskHtml(id);
    if (!html) {
      res.statusCode = 404;
      res.end("missing task");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function taskUrl(port: number, task: DriverTask, query: string): string {
  const suffix = query ? `?${query}` : "";
  return `http://127.0.0.1:${port}/t/${task.id}${suffix}`;
}

async function runLive(
  driver: LiveDriver,
  bin: string,
  task: DriverTask,
  port: number,
  opts: { video: boolean },
): Promise<{ cell: DriverCell; video?: string; workflow?: WorkflowV2 }> {
  const home = mkdtempSync(path.join(tmpdir(), "bao-live-"));
  const uploadPath = task.captureFile ? writeSample(home, task.captureFile) : "";
  console.error(`bao eval ${driver} ${task.id}`);
  const live = await runLiveCli({
    driver,
    bin,
    home,
    fixtureUrl: taskUrl(port, task, task.captureQuery),
    prompt: taskPrompt(task, uploadPath),
  });
  let view: FixtureView | null = null;
  try {
    view = JSON.parse(readFileSync(path.join(home, "last-view.json"), "utf8")) as FixtureView;
  } catch {
    view = null;
  }
  let loaded: LoadedTrail | undefined;
  try {
    loaded = loadTrail(home);
  } catch {
    loaded = undefined;
  }
  const stops = (loaded?.rows || []).flatMap((row) => row.gate ? [row.gate] : []);
  const failed = live.timedOut ? "timed out" : live.code && !view ? `cli exit ${live.code}` : "";
  writeFileSync(path.join(home, "cli-out.txt"), live.stdout.slice(0, 200_000));
  const graded = await grade(driver, task, port, home, uploadPath, view, stops, failed, {
    video: opts.video,
    videoName: `driver-replay-${driver}.webm`,
    tokens: live.tokens,
    extra: redact(live.stderr).slice(0, 240),
    requireRef: false,
    driverCrash: liveCrashReason(live),
  });
  return graded;
}

async function runScripted(task: DriverTask, port: number, opts?: { video?: boolean }): Promise<{ cell: DriverCell; video?: string; steps: TraceStep[]; trajectory: TrajectoryStep[] }> {
  const home = mkdtempSync(path.join(tmpdir(), "bao-driver-"));
  const uploadPath = task.captureFile ? writeSample(home, task.captureFile) : "";
  const client = McpClient.start({
    ...process.env,
    BAO_MCP_LIVE: "1",
    BAO_HOME: home,
    BAO_FIXTURE_URL: taskUrl(port, task, task.captureQuery),
  });
  const stops: string[] = [];
  let view: FixtureView | null = null;
  let failed = "";
  try {
    await client.handshake();
    for (const step of task.plan) {
      if (step.tool === "screenshot") {
        const result = await client.call("screenshot", {});
        if (result.isError) throw new Error(result.text);
      } else if (step.tool === "snapshot") {
        view = await snapshot(client);
      } else if (step.tool === "click" || step.tool === "scroll") {
        if (step.tool === "click" && step.id === "row-30") view = await revealRow(client, view);
        const node = view?.nodes.find((item) => item.id === step.id);
        if (!node || node.w < 1 || node.h < 1) throw new Error(`no box for ${step.id}`);
        if (step.tool === "click" && !inView(node)) throw new Error(`no visible box for ${step.id}`);
        const hit = step.tool === "click" ? visibleCenter(node) : { x: node.x + Math.min(8, node.w / 2), y: node.y + Math.min(8, node.h / 2) };
        const args = step.tool === "click"
          ? hit
          : { ...hit, dx: 0, dy: step.dy };
        const result = await client.call(step.tool, args);
        if (result.isError) throw new Error(result.text);
        noteStop(stops, result.text);
      } else if (step.tool === "clickRef") {
        const result = await client.call("click", { ref: step.id });
        if (result.isError) throw new Error(result.text);
        noteStop(stops, result.text);
      } else if (step.tool === "type") {
        const result = await client.call("type", { text: step.text });
        if (result.isError) throw new Error(result.text);
        noteStop(stops, result.text);
      } else if (step.tool === "upload") {
        const result = await client.call("upload", { id: step.id, path: uploadPath });
        if (result.isError) throw new Error(result.text);
      } else if (step.tool === "key") {
        const result = await client.call("key", { key: step.key });
        if (result.isError) throw new Error(result.text);
      }
    }
    view = await snapshot(client);
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err);
  } finally {
    await client.close();
  }
  return grade("scripted", task, port, home, uploadPath, view, stops, failed, {
    video: opts?.video ?? task.id === "drift",
    videoName: "driver-replay.webm",
    tokens: "n/a",
    extra: redact(client.stderr.join("")).slice(0, 240),
    requireRef: true,
    driverCrash: null,
  });
}

async function grade(
  driver: string,
  task: DriverTask,
  port: number,
  home: string,
  uploadPath: string,
  view: FixtureView | null,
  stops: string[],
  failed: string,
  opts: { video: boolean; videoName: string; tokens: string; extra: string; requireRef: boolean; driverCrash: string | null },
): Promise<{ cell: DriverCell; video?: string; workflow?: WorkflowV2; steps: TraceStep[]; trajectory: TrajectoryStep[] }> {
  const captureReason = !view ? failed || "no final snapshot" : captureOk(task, view, stops);
  const taskComplete = !captureReason;
  const crashed = crashStatus(opts.driverCrash, taskComplete);
  if (crashed) {
    ensurePartialTrail(home, opts.driverCrash || "driver-error");
    return {
      steps: [],
      trajectory: [],
      cell: {
        driver,
        task: task.id,
        status: crashed,
        reason: opts.driverCrash || "driver-error",
        taskComplete: "no",
        trailComplete: "partial",
        workflow: "no",
        replay: "skipped",
        modelCalls: "",
        latencyMs: "",
        tokens: opts.tokens,
      },
    };
  }
  let trailNote = "no trail";
  let trailOk = false;
  let workflowOk = false;
  let replayNote = "";
  let modelCalls = "";
  let latency = "";
  let video: string | undefined;
  let workflow: WorkflowV2 | undefined;
  try {
    const loaded = loadTrail(home);
    const problems = trailProblems(loaded.rows, home, uploadPath);
    if (opts.requireRef && task.id === "form-file" && !loaded.rows.some((row) => row.args?.ref === "noop")) {
      problems.push("form task did not record a DOM id ref");
    }
    trailOk = problems.length === 0 && loaded.rows.length > 0;
    trailNote = trailOk ? `${loaded.rows.length} events` : problems.join("; ") || "empty";
    const acts = loaded.rows.filter((row) => row.kind === "act" && typeof row.latencyMs === "number");
    if (acts.length) {
      const mean = acts.reduce((sum, row) => sum + Number(row.latencyMs), 0) / acts.length;
      latency = String(Math.round(mean));
    }
    const meta = { id: `drv-${task.id}`, name: task.title, startUrl: taskUrl(port, task, task.captureQuery), secrets: [CAPTURE_SECRET] };
    const once = condense(loaded.events, meta);
    const twice = condense(loaded.events, meta);
    if (canonical(once) !== canonical(twice)) throw new Error("condense was not deterministic");
    const errors = validateWorkflow(once);
    if (errors.length) throw new Error(errors.join(","));
    if (once.steps.length === 0) throw new Error("workflow has no steps");
    workflow = once;
    workflowOk = true;
  } catch (err) {
    workflowOk = false;
    replayNote = err instanceof Error ? err.message : String(err);
  }
  let steps: TraceStep[] = [];
  let trajectory: TrajectoryStep[] = [];
  if (workflow && taskComplete) {
    const runs: string[] = [];
    let calls = 0;
    for (let i = 0; i < 2; i++) {
      const fileName = task.replayFiles?.[i];
      const filePath = fileName ? writeSample(home, fileName) : "";
      const outcome = await replayTask(workflow, task, port, {
        texts: task.replayTexts[i] || [],
        secret: task.replaySecrets?.[i] || "",
        filePath,
        fileName: fileName || "",
        video: opts.video && i === 1,
        videoName: opts.videoName,
      });
      calls += outcome.modelCalls;
      if (outcome.video) video = outcome.video;
      if (i === 0) {
        steps = outcome.steps;
        trajectory = outcome.trajectory;
      }
      runs.push(outcome.ok ? "pass" : outcome.reason);
    }
    modelCalls = String(calls);
    replayNote = runs.every((run) => run === "pass") ? "2/2" : runs.join("; ");
  } else if (!replayNote) {
    replayNote = taskComplete ? "no workflow" : "skipped";
  }
  const replayOk = replayNote === "2/2" && modelCalls === "0";
  const pass = taskComplete && trailOk && workflowOk && replayOk;
  const reason = pass ? "" : redact([failed, opts.extra, captureReason || "", trailOk ? "" : trailNote, replayNote].filter(Boolean).join("; ")).slice(0, 300);
  return {
    video,
    workflow,
    steps,
    trajectory,
    cell: {
      driver,
      task: task.id,
      status: pass ? "pass" : "fail",
      reason,
      taskComplete: taskComplete ? "yes" : "no",
      trailComplete: trailOk ? "yes" : "no",
      workflow: workflowOk ? "yes" : "no",
      replay: redact(replayNote),
      modelCalls: modelCalls || (workflow ? "0" : ""),
      latencyMs: latency,
      tokens: opts.tokens,
    },
  };
}

/** A crash with an unfinished task is a driver-error. HTTP 429 is an infra miss, not a bao failure. A finished task stays on the bao grade. */
export function crashStatus(crash: string | null, taskComplete: boolean): "driver-error" | "infra" | null {
  if (!crash || taskComplete) return null;
  if (crash === "HTTP 429") return "infra";
  return "driver-error";
}

function inView(node: FixtureView["nodes"][number]): boolean {
  if (node.vw != null && node.vh != null) return node.vw > 1 && node.vh > 1;
  return node.h > 1 && node.y > 0 && node.y < 680;
}

function visibleCenter(node: FixtureView["nodes"][number]): { x: number; y: number } {
  if (node.vw != null && node.vh != null && node.vx != null && node.vy != null && node.vw > 1 && node.vh > 1) {
    return { x: node.vx + node.vw / 2, y: node.vy + node.vh / 2 };
  }
  return { x: node.x + node.w / 2, y: node.y + node.h / 2 };
}

async function revealRow(client: McpClient, view: FixtureView | null): Promise<FixtureView> {
  let current = view || await snapshot(client);
  for (let i = 0; i < 8; i++) {
    const node = current.nodes.find((item) => item.id === "row-30");
    if (node && inView(node)) return current;
    const list = current.nodes.find((item) => item.id === "list");
    if (!list || !node) break;
    const target = list.y + Math.max(0, list.h - node.h) / 2;
    let dy = Math.round(node.y - target);
    if (dy === 0) dy = node.y < list.y ? -40 : 40;
    const cap = Math.max(list.h, 80);
    if (Math.abs(dy) > cap) dy = Math.sign(dy) * cap;
    const result = await client.call("scroll", { x: list.x + 8, y: list.y + 8, dx: 0, dy });
    if (result.isError) throw new Error(result.text);
    current = await snapshot(client);
  }
  return current;
}

async function snapshot(client: McpClient): Promise<FixtureView> {
  const result = await client.call("snapshot", {});
  if (result.isError) throw new Error(result.text);
  return JSON.parse(result.text) as FixtureView;
}

function noteStop(stops: string[], text: string): void {
  if (text.startsWith("STOP ")) stops.push(text.slice(5).trim());
}

interface LoadedTrail {
  rows: TrailRow[];
  events: TrailEvent[];
}

interface TrailRow {
  kind?: string;
  op?: string;
  latencyMs?: number;
  snapshot?: { sha256?: string; path?: string };
  args?: { ref?: string; path?: string; text?: string };
  performed?: boolean;
  afterText?: string;
  fileName?: string;
  gate?: "login" | "confirm";
}

export function loadTrail(home: string): LoadedTrail {
  const file = path.join(home, "trail.jsonl");
  const raw = readFileSync(file, "utf8").trim();
  const rows = raw ? raw.split("\n").map((line) => JSON.parse(line) as TrailRow & TrailEvent) : [];
  const events = rows.map((row, index) => ({
    id: row.id || `e${index}`,
    ts: row.ts || index,
    kind: row.kind === "read" ? "read" as const : "act" as const,
    op: row.op || "",
    value: row.value,
    sensitive: row.sensitive,
    key: row.key,
    identity: row.identity ? { ...row.identity, path: row.identity.path || [] } : undefined,
    beforeUrl: row.beforeUrl,
    afterUrl: row.afterUrl,
    afterText: row.afterText,
    fileName: row.fileName,
    gate: row.gate,
    performed: row.performed,
    provenance: row.provenance,
    checked: row.checked,
  }));
  return { rows, events };
}

function trailProblems(rows: TrailRow[], home: string, uploadPath: string): string[] {
  const problems: string[] = [];
  if (rows.length === 0) problems.push("empty");
  const blob = JSON.stringify(rows);
  if (blob.includes(CAPTURE_SECRET)) problems.push("secret stored in the trail");
  if (uploadPath && blob.includes(uploadPath)) problems.push("file path stored in the trail");
  for (const row of rows) {
    if (row.kind !== "read" && row.kind !== "act") continue;
    if (!row.snapshot?.sha256 || !row.snapshot.path) {
      problems.push(`${row.op || "event"} missing snapshot`);
      continue;
    }
    const buf = readFileSync(row.snapshot.path);
    if (buf[0] !== 0x89 || buf[1] !== 0x50) problems.push(`${row.op} snapshot is not a png`);
    const hash = createHash("sha256").update(buf).digest("hex");
    if (hash !== row.snapshot.sha256) problems.push(`${row.op} snapshot hash mismatch`);
  }
  const homeTrail = readFileSync(path.join(home, "trail.jsonl"), "utf8");
  if (uploadPath && homeTrail.includes(uploadPath)) problems.push("path in trail.jsonl");
  return problems;
}

/** Scripted MCP client only. No model driver. Replay video is left off. */
export async function scriptedFixtureTrails(): Promise<FixtureTrail[]> {
  const server = await startFixtures();
  const out: FixtureTrail[] = [];
  try {
    for (const task of DRIVER_TASKS) {
      const graded = await runScripted(task, server.port, { video: false });
      const passed = graded.cell.status === "pass";
      let steps = graded.steps;
      if (!passed && steps.every((step) => step.passed)) {
        steps = [...steps, { stepId: "oracle", passed: false, detail: graded.cell.replay || graded.cell.reason }];
      }
      const trail = {
        task: task.id,
        passed,
        detail: graded.cell.reason || graded.cell.replay,
        steps,
        trajectory: graded.trajectory,
      };
      out.push(trail);
      console.log(`drivers/scripted/${task.id} ${passed ? "pass" : trail.detail}`);
    }
  } finally {
    await server.close();
  }
  return out;
}

export async function replayTask(
  workflow: WorkflowV2,
  task: DriverTask,
  port: number,
  spec: { texts: string[]; secret: string; filePath: string; fileName: string; video: boolean; videoName?: string },
): Promise<{ ok: boolean; reason: string; modelCalls: number; video?: string; steps: TraceStep[]; trajectory: TrajectoryStep[] }> {
  const profile = await mkdtemp(path.join(tmpdir(), "bao-replay-"));
  const videoDir = spec.video ? mkdtempSync(path.join(tmpdir(), "bao-video-")) : undefined;
  let modelCalls = 0;
  let context: Awaited<ReturnType<typeof launchOwnedChrome>> | undefined;
  try {
    context = await launchOwnedChrome({
      userDataDir: profile,
      headless: true,
      videoDir,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
    const page = context.pages()[0] || await context.newPage();
    const video = page.video();
    await page.goto(taskUrl(port, task, task.replayQuery), { waitUntil: "domcontentloaded" });
    const run = await replay({ ...workflow, startUrl: taskUrl(port, task, task.replayQuery) }, argsFor(workflow, spec), new BrowserDriver(page), {
      heal: {
        available: () => false,
        propose: async () => {
          modelCalls += 1;
          return null;
        },
      },
    });
    const oracle = run.status === "passed" ? await pageOracle(task, page, spec) : run.failure?.reason || run.status;
    if (spec.video) await page.waitForTimeout(800);
    await context.close();
    context = undefined;
    let videoPath: string | undefined;
    if (video) {
      videoPath = await video.path();
      const saved = path.join("docs", "eval", spec.videoName || "driver-replay.webm");
      mkdirSync(path.dirname(saved), { recursive: true });
      copyFileSync(videoPath, saved);
      videoPath = saved;
    }
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    const steps = run.steps.map((step) => ({
      stepId: step.id,
      passed: step.status === "passed",
      detail: step.reason || "",
    }));
    return { ok: run.status === "passed" && oracle == null, reason: oracle || "pass", modelCalls, video: videoPath, steps, trajectory: run.trajectory };
  } catch (err) {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, reason: err instanceof Error ? err.message : String(err), modelCalls, steps: [], trajectory: [] };
  }
}

function argsFor(workflow: WorkflowV2, spec: { texts: string[]; secret: string; filePath: string; fileName: string }): ReplayArgs {
  const texts = spec.texts.slice();
  const args: ReplayArgs = {};
  for (const input of workflow.inputs) {
    if (input.type === "secret") args[input.name] = spec.secret;
    else if (input.type === "file") args[input.name] = { name: spec.fileName, path: spec.filePath };
    else args[input.name] = texts.shift() ?? "";
  }
  return args;
}

async function pageOracle(task: DriverTask, page: Page, spec: { texts: string[]; secret: string; fileName: string }): Promise<string | null> {
  const status = (await page.locator("#status").innerText().catch(() => "")).trim();
  const flash = (await page.locator("#flash").innerText().catch(() => "")).trim();
  const files = (await page.locator("#files").innerText().catch(() => "")).trim();
  const picked = (await page.locator("#picked").innerText().catch(() => "")).trim();
  if (task.id === "login") {
    const user = await page.locator("#username").inputValue();
    if (user !== spec.texts[0]) return `username ${user}`;
    if (!flash.includes("Welcome " + spec.texts[0])) return `flash ${flash}`;
    return null;
  }
  if (task.id === "confirm") {
    const note = await page.locator("#note").inputValue();
    if (note !== spec.texts[0]) return `note ${note}`;
    if (status !== "Deleted") return `status ${status}`;
    return null;
  }
  if (task.id === "form-file") {
    const name = await page.locator("#name").inputValue();
    if (name !== spec.texts[0]) return `name ${name}`;
    if (status !== "Saved") return `status ${status}`;
    if (!files.includes(spec.fileName)) return `files ${files}`;
    return null;
  }
  if (task.id === "tabs") {
    const city = await page.locator("#city").inputValue();
    if (city !== spec.texts[0]) return `city ${city}`;
    if (status !== "Done") return `status ${status}`;
    return null;
  }
  if (task.id === "drift") {
    const note = await page.locator("#note").inputValue();
    if (note !== spec.texts[0]) return `note ${note}`;
    if (status !== "Saved") return `status ${status}`;
    if (page.url().includes("shift=1")) return "replay stayed on the shifted layout";
    return null;
  }
  if (task.id === "dialog") {
    if (picked !== spec.texts[0]) return `picked ${picked}`;
    if (status !== "Chosen") return `status ${status}`;
    return null;
  }
  if (task.id === "scroll") {
    const filter = await page.locator("#filter").inputValue();
    if (filter !== spec.texts[0]) return `filter ${filter}`;
    if (picked !== "Row 30") return `picked ${picked}`;
    if (status !== "Picked") return `status ${status}`;
    return null;
  }
  if (task.id === "choice") {
    const label = await page.locator("#label").inputValue();
    const blue = await page.locator("#blue").isChecked();
    if (label !== spec.texts[0]) return `label ${label}`;
    if (!blue) return "blue not checked";
    if (status !== "Applied") return `status ${status}`;
    return null;
  }
  return `no oracle for ${task.id}`;
}

function writeSample(home: string, name: string): string {
  const file = path.join(home, name);
  writeFileSync(file, `sample ${name}\n`);
  return file;
}

function redact(text: string): string {
  let out = text;
  for (const secret of [process.env.GROQ_API_KEY, process.env.OPENAI_API_KEY, process.env.ANTHROPIC_API_KEY, CAPTURE_SECRET]) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/\/(?:var\/folders|private\/tmp|tmp)\/[^\s'")]+/g, "[tmp]");
}

function probeClaude(): string {
  const bin = driverBinary("claude");
  if (!bin) return unavailableReason("claude");
  const status = spawnSync(bin, ["auth", "status"], { encoding: "utf8", timeout: 20000, env: driverProcessEnv() });
  if (`${status.stdout || ""}`.includes('"loggedIn": true') || `${status.stdout || ""}`.includes('"loggedIn":true')) return "";
  if (process.env.ANTHROPIC_API_KEY) return "";
  return "not run: claude CLI is present but not logged in";
}

function probeCodex(): string {
  const bin = driverBinary("codex");
  if (!bin) return unavailableReason("codex");
  const status = spawnSync(bin, ["login", "status"], { encoding: "utf8", timeout: 20000, env: driverProcessEnv() });
  const text = `${status.stdout || ""}\n${status.stderr || ""}`;
  if (status.status === 0 && /logged in/i.test(text)) return "";
  return "not run: codex CLI is present but not logged in";
}

function probeCursor(): string {
  const bin = driverBinary("cursor");
  if (!bin) return unavailableReason("cursor");
  const status = spawnSync(bin, ["status"], { encoding: "utf8", timeout: 20000, env: driverProcessEnv() });
  const text = `${status.stdout || ""}\n${status.stderr || ""}`;
  if (status.status === 0 && /logged in/i.test(text)) return "";
  return "not run: cursor-agent is present but not logged in";
}

function render(cells: DriverCell[], videos: Map<string, string>): string {
  const lines = [
    "# Driver eval",
    "",
    "Scripted is a local MCP client. It sends coordinates from a snapshot, and one DOM id ref on the form task. It does not call a model. Claude, Codex, and Cursor run only when that CLI is already logged in. This command does not start a login. Model calls are replay heal calls. Tokens are the driver CLI usage.",
    "",
  ];
  if (videos.size === 0) lines.push("No replay video was written.", "");
  else {
    lines.push("Replay video of one derived workflow per driver:");
    for (const [driver, file] of videos) lines.push(`- ${driver}: ${file}`);
    lines.push("");
  }
  lines.push(
    "| driver | task | status | task complete | trail complete | workflow | replay | model calls | latency ms | tokens | reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const cell of cells) {
    lines.push(`| ${[
      cell.driver,
      cell.task,
      cell.status,
      cell.taskComplete,
      cell.trailComplete,
      cell.workflow,
      cell.replay.replace(/\|/g, "/"),
      cell.modelCalls,
      cell.latencyMs,
      cell.tokens,
      cell.reason.replace(/\|/g, "/").replace(/\n/g, " "),
    ].join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function driverProbeReasons(): { claude: string; codex: string; cursor: string } {
  return { claude: probeClaude(), codex: probeCodex(), cursor: probeCursor() };
}
