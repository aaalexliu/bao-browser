// Native proxy spike. No browser. Scripted OpenAI and Claude clicks on a GTK 3
// calculator are resolved against AT-SPI extents. Replay presses the button
// by role and name in a new window, and the label reads 12.

import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Workflow } from "../../../src/types";
import { AuditTrail, deriveWorkflow, trimTrail } from "./audit";
import { createClaudeSession, handleClaudeTool, type ClaudeToolResult, type ClaudeToolUse } from "./claude";
import { DesktopExecutor } from "./desktop-exec";
import { handleComputerCall, type ComputerAction, type ComputerCall } from "./openai";
import { osNodes, osPress, osRead, type OsNode } from "./os";
import { pngSize } from "./png";
import { surfaceAt } from "./surface";

const ARTIFACTS = process.env.BAO_SPIKE_ARTIFACTS || "/opt/cursor/artifacts";
const SCREEN = { w: 1400, h: 900 };
const SCREEN_ARG = `${SCREEN.w}x${SCREEN.h}`;
const APP_PY = path.resolve(process.cwd(), "desktop/os-helper/baocalc.py");
const BIN = path.resolve(process.cwd(), "desktop/os-helper/target/release/bao-os-helper");

const vendorHits: string[] = [];

function installNodeGuard(): void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (/openai\.com|anthropic\.com/i.test(url)) {
      vendorHits.push(url);
      throw new Error(`blocked network call to ${url}`);
    }
    if (!orig) throw new Error("fetch is unavailable");
    return orig(input, init);
  }) as typeof fetch;
}

function use(id: string, name: ClaudeToolUse["name"], input: ClaudeToolUse["input"] = {}): ClaudeToolUse {
  return { type: "tool_use", id, name, toolset_name: "computer", input };
}

function center(node: OsNode): { x: number; y: number } {
  return { x: node.bbox.x + node.bbox.w / 2, y: node.bbox.y + node.bbox.h / 2 };
}

function workflowShape(workflow: Workflow): unknown[] {
  return workflow.steps.map((step) => ({
    action: step.action,
    label: step.label,
    unresolved: step.unresolved?.reason ?? null,
    app: step.os?.target.app ?? null,
    role: step.os?.target.role ?? null,
    name: step.os?.target.name ?? null,
    path: step.os?.target.path ?? null,
  }));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function shot(file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("import", ["-window", "root", file]);
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`import ${code}`)));
  });
}

interface Session {
  env: NodeJS.ProcessEnv;
  pids: ChildProcess[];
  work: string;
}

async function startSession(work: string): Promise<Session> {
  const home = path.join(work, "home");
  const runtime = path.join(work, "runtime");
  await mkdir(home, { recursive: true });
  await mkdir(runtime, { recursive: true });
  const xvfb = spawn("Xvfb", [":84", "-screen", "0", `${SCREEN_ARG}x24`, "-ac"], { stdio: "ignore" });
  await sleep(400);
  const dbus = spawn("dbus-launch", ["--sh-syntax"], { stdio: ["ignore", "pipe", "pipe"] });
  const dbusOut = await new Promise<string>((resolve, reject) => {
    let out = "";
    dbus.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    dbus.on("error", reject);
    dbus.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`dbus-launch ${code}`)));
  });
  const env: NodeJS.ProcessEnv = { ...process.env, DISPLAY: ":84", GTK_A11Y: "atspi", GTK_MODULES: "gail:atk-bridge" };
  for (const line of dbusOut.split("\n")) {
    const match = line.match(/^(DBUS_SESSION_BUS_[A-Z]+)='?([^';]+)'?/);
    if (match) env[match[1]] = match[2];
  }
  const atspi = spawn("/usr/libexec/at-spi-bus-launcher", [], { env, stdio: "ignore" });
  await sleep(400);
  Object.assign(process.env, env);
  return { env, pids: [xvfb, atspi], work: home };
}

function launchCalc(session: Session, x: number, y: number, w: number, h: number): ChildProcess {
  return spawn("python3", [APP_PY, "--x", String(x), "--y", String(y), "--w", String(w), "--h", String(h)], {
    env: { ...session.env, HOME: session.work },
    stdio: "ignore",
  });
}

async function waitNodes(): Promise<OsNode[]> {
  let last: OsNode[] = [];
  for (let i = 0; i < 30; i++) {
    try {
      last = await osNodes(BIN, SCREEN_ARG);
      if (last.some((node) => node.role === "push button" && node.name === "7")) return last;
    } catch { /* tree not up */ }
    await sleep(200);
  }
  throw new Error("calculator did not appear in the accessibility tree");
}

async function capture(kind: "openai" | "claude", outDir: string): Promise<{ workflow: Workflow; transcript: unknown; trail: unknown }> {
  const nodes = await waitNodes();
  const app = nodes.find((node) => node.name === "7")?.app;
  if (!app) throw new Error("no button 7");
  const buttons = ["7", "+", "5", "="].map((name) => {
    const node = nodes.find((item) => item.role === "push button" && item.name === name);
    if (!node) throw new Error(`missing ${name}`);
    return { name, at: center(node) };
  });
  const area = nodes.find((node) => node.role === "drawing area");
  if (!area) throw new Error("missing drawing area");
  const areaAt = center(area);
  const far = { x: 1300, y: 820 };
  const trail = new AuditTrail();
  const crops: string[] = [];
  const executor = new DesktopExecutor(trail, { bin: BIN, screen: SCREEN, cropDir: outDir, crops, chrome: [] });
  const exchanges: unknown[] = [];

  if (kind === "openai") {
    const send = async (id: string, actions: ComputerAction[]) => {
      const computer_call: ComputerCall = { type: "computer_call", call_id: id, actions, status: "completed" };
      const computer_call_output = await handleComputerCall(computer_call, executor);
      exchanges.push({ computer_call, computer_call_output });
    };
    await send("shot", [{ type: "screenshot" }]);
    await shot(path.join(outDir, "spike_native_openai_before.png"));
    for (const button of buttons) {
      await send(`click_${button.name}`, [{ type: "click", button: "left", x: button.at.x, y: button.at.y }]);
    }
    await send("type_orphan", [{ type: "type", text: "x" }]);
    await send("area", [{ type: "click", button: "left", x: areaAt.x, y: areaAt.y }]);
    await send("far", [{ type: "click", button: "left", x: far.x, y: far.y }]);
  } else {
    const session = createClaudeSession();
    const send = async (tool: ClaudeToolUse) => {
      const tool_result: ClaudeToolResult = await handleClaudeTool(tool, executor, session);
      exchanges.push({ tool_use: tool, tool_result });
      if (tool_result.is_error) throw new Error(`${tool.name} failed`);
      return tool_result;
    };
    const shotResult = await send(use("shot", "screenshot"));
    const image = resultImage(shotResult);
    if (!image) throw new Error("claude screenshot was not an image");
    const size = pngSize(image);
    if (size.w !== SCREEN.w / 2 || size.h !== SCREEN.h / 2) {
      throw new Error(`expected half screenshot, got ${size.w}x${size.h}`);
    }
    await shot(path.join(outDir, "spike_native_before.png"));
    const toImage = (point: { x: number; y: number }) => ({
      x: point.x * (size.w / SCREEN.w),
      y: point.y * (size.h / SCREEN.h),
    });
    for (const button of buttons) {
      const at = toImage(button.at);
      await send(use(`click_${button.name}`, "left_click", { coordinate: [at.x, at.y] }));
    }
    await send(use("type_orphan", "type", { text: "x" }));
    const areaImage = toImage(areaAt);
    await send(use("area", "left_click", { coordinate: [areaImage.x, areaImage.y] }));
    const farImage = toImage(far);
    await send(use("far", "left_click", { coordinate: [farImage.x, farImage.y] }));
  }

  await shot(path.join(outDir, kind === "claude" ? "spike_native_after.png" : "spike_native_openai_after.png"));
  const workflow = deriveWorkflow(trimTrail(trail.events), "desktop://baocalc", {
    id: kind === "claude" ? "wf-proxy-native" : "wf-proxy-native-openai",
    name: "Proxy spike — calculator",
  });
  return { workflow, transcript: { vendor: kind, exchanges, crops }, trail: trail.log() };
}

function resultImage(result: ClaudeToolResult): Buffer | null {
  if (!Array.isArray(result.content)) return null;
  const block = result.content.find((item) => item.type === "image");
  if (!block || block.type !== "image") return null;
  return Buffer.from(block.source.data, "base64");
}

async function replay(workflow: Workflow, outDir: string, prefix: string): Promise<{ names: string[]; usedY: number; storedY: number; args: string[] }> {
  const clicks = workflow.steps.filter((step) => step.action === "osClick" && step.os && !step.unresolved);
  const storedY = clicks[0]?.provenance?.y ?? -1;
  const video = path.join(outDir, `${prefix}_replay.webm`);
  const grab = spawn("ffmpeg", [
    "-y", "-f", "x11grab", "-video_size", SCREEN_ARG, "-framerate", "8", "-i", process.env.DISPLAY || ":84",
    "-c:v", "libvpx", "-b:v", "1M", "-an", video,
  ], { stdio: "ignore" });
  await sleep(900);
  const argsLog: string[] = [];
  let usedY = -1;
  for (const step of clicks) {
    const target = step.os!.target;
    const args = ["press", "--screen", SCREEN_ARG, "--app", target.app, "--entry-role", target.role, "--entry-name", target.name];
    argsLog.push(args.join(" "));
    const pressed = await osPress(BIN, SCREEN_ARG, target.app, target.role, target.name);
    if (target.name === "7" && pressed.bbox) usedY = pressed.bbox.y;
    await sleep(350);
  }
  const names = await osRead(BIN, SCREEN_ARG, clicks[0].os!.target.app, "label");
  await shot(path.join(outDir, `${prefix}_replay_after.png`));
  await sleep(600);
  if (grab.exitCode === null) {
    grab.kill("SIGINT");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { grab.kill("SIGKILL"); resolve(); }, 4000);
      grab.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  return { names: names.names, usedY, storedY, args: argsLog };
}

async function main(): Promise<void> {
  installNodeGuard();
  const work = await mkdtemp(path.join(tmpdir(), "bao-native-"));
  const outDir = path.join(work, "out");
  await mkdir(outDir, { recursive: true });
  const checks: { name: string; pass: boolean; detail?: string }[] = [];
  const check = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail });
  check(
    "a point inside a chrome window is the DOM surface",
    surfaceAt(10, 10, [{ x: 0, y: 0, w: 100, h: 80 }]) === "dom" &&
      surfaceAt(200, 200, [{ x: 0, y: 0, w: 100, h: 80 }]) === "os",
  );

  let session: Session | undefined;
  let calc: ChildProcess | undefined;
  try {
    session = await startSession(work);
    calc = launchCalc(session, 30, 40, 320, 200);
    const claude = await capture("claude", outDir);
    const claudeApp = claude.workflow.steps.find((step) => step.os)?.os?.target.app || "";
    const claudeShown = await osRead(BIN, SCREEN_ARG, claudeApp, "label");
    check("Claude pixel clicks display 12 via AT-SPI", claudeShown.names.includes("12"), claudeShown.names.join(","));
    // Fresh calculator for the OpenAI pass, same place, so the tree matches.
    calc.kill("SIGTERM");
    await sleep(300);
    calc = launchCalc(session, 30, 40, 320, 200);
    const openai = await capture("openai", outDir);
    const openaiApp = openai.workflow.steps.find((step) => step.os)?.os?.target.app || "";
    const openaiShown = await osRead(BIN, SCREEN_ARG, openaiApp, "label");
    check("OpenAI pixel clicks display 12 via AT-SPI", openaiShown.names.includes("12"), openaiShown.names.join(","));
    const claudeShape = workflowShape(claude.workflow);
    const openaiShape = workflowShape(openai.workflow);
    const equal = JSON.stringify(claudeShape) === JSON.stringify(openaiShape);
    await writeFile(path.join(outDir, "spike_native_workflow.json"), JSON.stringify(claude.workflow, null, 2));
    await writeFile(path.join(outDir, "spike_native_openai_workflow.json"), JSON.stringify(openai.workflow, null, 2));
    await writeFile(path.join(outDir, "spike_native_diff.json"), JSON.stringify({ equal, claude: claudeShape, openai: openaiShape }, null, 2));
    await writeFile(path.join(outDir, "spike_native_transcript.json"), JSON.stringify(claude.transcript, null, 2));
    await writeFile(path.join(outDir, "spike_native_openai_transcript.json"), JSON.stringify(openai.transcript, null, 2));
    await writeFile(path.join(outDir, "spike_native_trail.json"), JSON.stringify(claude.trail, null, 2));

    const resolved = claude.workflow.steps.filter((step) => step.action === "osClick" && step.os);
    const missed = claude.workflow.steps.filter((step) => step.unresolved);
    check("both adapters record the same os workflow", equal, equal ? `${claudeShape.length} steps` : "see diff");
    check(
      "7 + 5 = are osClick steps with no coordinate in the target",
      resolved.map((step) => step.os?.target.name).join(",") === "7,+,5,=",
      resolved.map((step) => step.os?.target.name).join(","),
    );
    check(
      "drawing area and empty desktop are unresolved",
      missed.length === 3 && missed.some((step) => /drawing area/.test(step.unresolved?.reason || "")) &&
        missed.some((step) => /no accessible at point/.test(step.unresolved?.reason || "")) &&
        missed.some((step) => /no focused editable/.test(step.unresolved?.reason || "")),
      missed.map((step) => step.unresolved?.reason).join(" | "),
    );
    const trailJson = JSON.stringify(claude.trail);
    check("unresolved click keeps a screenshot crop", trailJson.includes("\"crop\":\"sha256:"), "crop");
    const click7 = resolved[0];
    check(
      "coordinate is provenance only",
      click7?.provenance?.space === "image" && click7.provenance.y > 0,
      `${click7?.provenance?.space} y=${click7?.provenance?.y}`,
    );

    calc.kill("SIGTERM");
    await sleep(300);
    calc = launchCalc(session, 220, 160, 460, 280);
    await waitNodes();
    await shot(path.join(outDir, "spike_native_replay_before.png"));
    const claudeReplay = await replay(claude.workflow, outDir, "spike_native");
    const noCoord = claudeReplay.args.every((line) => !line.includes("--x") && !line.includes("--y"));
    check("replay press takes role and name, not a coordinate", noCoord, claudeReplay.args[0]);
    check(
      "replay label reads 12 from AT-SPI",
      claudeReplay.names.includes("12"),
      claudeReplay.names.join(","),
    );
    check(
      "replay button is not at the stored coordinate",
      Math.abs(claudeReplay.usedY - claudeReplay.storedY) > 40,
      `stored=${claudeReplay.storedY} live=${claudeReplay.usedY}`,
    );

    calc.kill("SIGTERM");
    await sleep(300);
    calc = launchCalc(session, 220, 160, 460, 280);
    await waitNodes();
    const openaiReplay = await replay(openai.workflow, outDir, "spike_native_openai");
    check(
      "OpenAI replay also reads 12 and ignores its coordinate",
      openaiReplay.names.includes("12") && Math.abs(openaiReplay.usedY - openaiReplay.storedY) > 40 &&
        openaiReplay.args.every((line) => !line.includes("--x")),
      `stored=${openaiReplay.storedY} live=${openaiReplay.usedY} label=${openaiReplay.names.join(",")}`,
    );
  } finally {
    if (calc && calc.exitCode === null) calc.kill("SIGTERM");
    if (session) {
      for (const pid of session.pids) {
        if (pid.exitCode === null) pid.kill("SIGTERM");
      }
      if (session.env.DBUS_SESSION_BUS_PID) {
        try { process.kill(Number(session.env.DBUS_SESSION_BUS_PID), "SIGTERM"); } catch { /* already gone */ }
      }
    }
  }

  check("zero network calls to openai or anthropic", vendorHits.length === 0, vendorHits.join(" ") || "none");
  let failed = 0;
  for (const item of checks) {
    console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
    if (!item.pass) failed++;
  }
  console.log(failed === 0 ? "SPIKE NATIVE: PASS" : `SPIKE NATIVE: FAIL (${failed})`);
  if (failed === 0) {
    await mkdir(ARTIFACTS, { recursive: true });
    for (const name of await readdir(outDir)) {
      if (name.endsWith(".png") || name.endsWith(".webm") || name.endsWith(".json")) {
        await copyFile(path.join(outDir, name), path.join(ARTIFACTS, name));
      }
    }
    await rm(work, { recursive: true, force: true });
  } else {
    console.log(`debug left in ${work}`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
