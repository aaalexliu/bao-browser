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
import { validateWorkflow, type ReplayArgs, type WorkflowV2 } from "../v1/schema";
import { McpClient } from "./mcp-client";
import {
  CAPTURE_SECRET,
  DRIVER_TASKS,
  captureOk,
  taskHtml,
  type DriverTask,
  type FixtureView,
} from "./tasks";

export interface DriverCell {
  driver: string;
  task: string;
  status: "pass" | "fail" | "not run";
  reason: string;
  taskComplete: string;
  trailComplete: string;
  workflow: string;
  replay: string;
  modelCalls: string;
  latencyMs: string;
  tokens: string;
}

const NOT_RUN = {
  claude: probeClaude(),
  codex: probeCodex(),
  cursor: probeCursor(),
};

export async function evalDrivers(args: string[] = []): Promise<{ markdown: string; cells: DriverCell[]; video?: string }> {
  const out = flag(args, "--out") || path.join("docs", "eval", "drivers.md");
  const only = flag(args, "--driver");
  const onlyTask = flag(args, "--task");
  const tasks = onlyTask ? DRIVER_TASKS.filter((task) => task.id === onlyTask) : DRIVER_TASKS;
  const cells: DriverCell[] = [];
  for (const driver of ["claude", "codex", "cursor"] as const) {
    if (only && only !== driver) continue;
    const reason = NOT_RUN[driver];
    for (const task of tasks) {
      cells.push(blank(driver, task.id, "not run", reason));
    }
  }
  let video: string | undefined;
  if (!only || only === "scripted") {
    const server = await startFixtures();
    try {
      for (const task of tasks) {
        const cell = await runScripted(task, server.port);
        cells.push(cell.cell);
        if (cell.video) video = cell.video;
      }
    } finally {
      await server.close();
    }
  }
  const markdown = render(cells, video);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, markdown);
  if (video) {
    mkdirSync("/opt/cursor/artifacts", { recursive: true });
    const dest = "/opt/cursor/artifacts/driver-replay.webm";
    copyFileSync(video, dest);
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

async function runScripted(task: DriverTask, port: number): Promise<{ cell: DriverCell; video?: string }> {
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
  const stderr = redact(client.stderr.join(""));
  const captureReason = !view ? failed || "no final snapshot" : captureOk(task, view, stops);
  const taskComplete = !captureReason;
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
    if (task.id === "form-file" && !loaded.rows.some((row) => row.args?.ref === "noop")) {
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
        video: task.id === "drift" && i === 1,
      });
      calls += outcome.modelCalls;
      if (outcome.video) video = outcome.video;
      runs.push(outcome.ok ? "pass" : outcome.reason);
    }
    modelCalls = String(calls);
    replayNote = runs.every((run) => run === "pass") ? "2/2" : runs.join("; ");
  } else if (!replayNote) {
    replayNote = taskComplete ? "no workflow" : "skipped";
  }
  const replayOk = replayNote === "2/2" && modelCalls === "0";
  const pass = taskComplete && trailOk && workflowOk && replayOk;
  const reason = pass ? "" : redact([failed, captureReason || "", trailOk ? "" : trailNote, replayNote].filter(Boolean).join("; "));
  return {
    video,
    cell: {
      driver: "scripted",
      task: task.id,
      status: pass ? "pass" : "fail",
      reason,
      taskComplete: taskComplete ? "yes" : "no",
      trailComplete: trailOk ? "yes" : "no",
      workflow: workflowOk ? "yes" : "no",
      replay: replayNote,
      modelCalls: modelCalls || (workflow ? "0" : ""),
      latencyMs: latency,
      tokens: "n/a",
    },
  };
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

function loadTrail(home: string): LoadedTrail {
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

async function replayTask(
  workflow: WorkflowV2,
  task: DriverTask,
  port: number,
  spec: { texts: string[]; secret: string; filePath: string; fileName: string; video: boolean },
): Promise<{ ok: boolean; reason: string; modelCalls: number; video?: string }> {
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
      const saved = path.join("docs", "eval", "driver-replay.webm");
      mkdirSync(path.dirname(saved), { recursive: true });
      copyFileSync(videoPath, saved);
      videoPath = saved;
    }
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    return { ok: run.status === "passed" && oracle == null, reason: oracle || "pass", modelCalls, video: videoPath };
  } catch (err) {
    await context?.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    return { ok: false, reason: err instanceof Error ? err.message : String(err), modelCalls };
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
  return out;
}

function which(bin: string): string | null {
  const result = spawnSync("which", [bin], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function probeClaude(): string {
  const bin = which("claude");
  const key = !!process.env.ANTHROPIC_API_KEY;
  let sdk = false;
  try {
    require.resolve("@anthropic-ai/claude-agent-sdk");
    sdk = true;
  } catch { /* not installed */ }
  if (!bin && !sdk) {
    return "not run: claude CLI is not on PATH, and @anthropic-ai/claude-agent-sdk is not installed";
  }
  if (!key && !bin) return "not run: ANTHROPIC_API_KEY is unset";
  if (!bin && !key) return "not run: claude CLI is not on PATH and ANTHROPIC_API_KEY is unset";
  if (!bin) return "not run: claude CLI is not on PATH";
  if (!key) return "not run: claude CLI is on PATH but ANTHROPIC_API_KEY is unset and no Agent SDK session was configured";
  return "not run: claude was found but this process did not start it";
}

function probeCodex(): string {
  const bin = which("codex");
  const key = !!process.env.OPENAI_API_KEY;
  if (!bin && !key) return "not run: codex CLI is not on PATH and OPENAI_API_KEY is unset";
  if (!bin) return "not run: codex CLI is not on PATH";
  if (!key) return "not run: codex CLI is on PATH but OPENAI_API_KEY is unset";
  return "not run: codex was found but this process did not start it";
}

function probeCursor(): string {
  const bin = which("cursor-agent") || which("agent") || which("cursor");
  if (!bin) return "not run: cursor-agent CLI is not on PATH";
  return `not run: ${bin} is on PATH but no Cursor credential for a computer-use session was configured`;
}

function render(cells: DriverCell[], video?: string): string {
  const lines = [
    "# Driver eval",
    "",
    "Scripted is a local MCP client. It sends coordinates from a snapshot, and one DOM id ref on the form task. It does not call a model. Claude, Codex, and Cursor are marked not run when the CLI or a credential is missing. Those cells are not filled in.",
    "",
    video ? `Replay video of the drifted-layout workflow: docs/eval/driver-replay.webm.` : "No replay video was written.",
    "",
    "| driver | task | status | task complete | trail complete | workflow | replay | model calls | latency ms | tokens | reason |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
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
  return { ...NOT_RUN };
}
