// Claude adapter spike. The login scenario from the focus spike runs through
// computer_toolset_20260801 and through the OpenAI computer tool. The derived
// workflows match apart from provenance: Claude's click is in the half-scale
// screenshot, OpenAI's is in the viewport. Replay uses neither coordinate.

import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext, Page, Request } from "playwright";
import type { Workflow } from "../../../src/types";
import { omitSecret, redactPayload } from "../../../src/mask";
import { launchOwnedChrome } from "../launch";
import { AuditTrail, deriveWorkflow, trimTrail } from "./audit";
import {
  CLAUDE_MEMBERS,
  createClaudeSession,
  handleClaudeTool,
  toNeutral,
  type ClaudeSession,
  type ClaudeToolResult,
  type ClaudeToolUse,
} from "./claude";
import { PageExecutor, preparePage } from "./executor";
import { handleComputerCall, type ComputerAction, type ComputerCall, type ComputerCallOutput } from "./openai";
import { pngSize } from "./png";
import { replayWorkflow } from "./replay";

const PAGE_URL = "https://the-internet.herokuapp.com/login";
const ARTIFACTS = process.env.BAO_SPIKE_ARTIFACTS || "/opt/cursor/artifacts";
const USERNAME = "tomsmith";
const PASSWORD = "SuperSecretPassword!";

const vendorHits: string[] = [];

function watch(ctx: BrowserContext): void {
  const note = (req: Request) => {
    try {
      const host = new URL(req.url()).hostname;
      if (
        host === "openai.com" || host.endsWith(".openai.com") ||
        host === "anthropic.com" || host.endsWith(".anthropic.com")
      ) vendorHits.push(req.url());
    } catch { /* non-URL */ }
  };
  ctx.on("request", note);
}

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

function call(id: string, actions: ComputerAction[]): ComputerCall {
  return { type: "computer_call", call_id: id, actions, status: "completed" };
}

async function fieldCenter(page: Page, selector: string): Promise<{ x: number; y: number }> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLElement)) throw new Error(`no element ${sel}`);
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, selector);
}

async function secureState(page: Page): Promise<{ url: string; flash: string }> {
  return page.evaluate(() => ({
    url: location.href,
    flash: (document.querySelector("#flash")?.textContent || "").replace(/\s+/g, " ").trim(),
  }));
}

function selectorBlob(step: { target?: { selectors: { value: string }[] } } | undefined): string {
  return step?.target?.selectors.map((s) => s.value).join(" ") ?? "";
}

function resultText(result: ClaudeToolResult): string {
  if (typeof result.content === "string") return result.content;
  return result.content.map((block) => block.type === "text" ? block.text : "image").join(" ");
}

function resultImage(result: ClaudeToolResult): Buffer | null {
  if (!Array.isArray(result.content)) return null;
  const block = result.content.find((item) => item.type === "image");
  if (!block || block.type !== "image") return null;
  return Buffer.from(block.source.data, "base64");
}

/** Steps with vendor pixels, ids, and timestamps removed. */
function workflowShape(workflow: Workflow): unknown[] {
  return workflow.steps.map((step) => ({
    action: step.action,
    label: step.label,
    key: step.key ?? null,
    value: step.value ?? null,
    sensitive: step.sensitive ?? false,
    submits: step.submits ?? false,
    unresolved: step.unresolved?.reason ?? null,
    frame: step.frame?.url ?? null,
    selectors: (step.target?.selectors ?? []).map((sel) => `${sel.type}:${sel.value}`),
  }));
}

function memberTable(): { pass: boolean; detail: string } {
  const session = createClaudeSession();
  session.frame = { image: { w: 640, h: 360 }, viewport: { w: 1280, h: 720 } };
  session.cursor = { x: 10, y: 20 };
  const samples: ClaudeToolUse[] = [
    use("s", "screenshot"),
    use("z", "zoom", { region: [0, 0, 40, 20] }),
    use("l", "left_click", { coordinate: [100, 40] }),
    use("r", "right_click", { coordinate: [4, 6] }),
    use("m", "middle_click", { coordinate: [4, 6] }),
    use("d", "double_click", { coordinate: [4, 6] }),
    use("t", "triple_click", { coordinate: [4, 6] }),
    use("g", "left_click_drag", { start_coordinate: [0, 0], coordinate: [8, 8] }),
    use("mv", "mouse_move", { coordinate: [12, 14] }),
    use("dn", "left_mouse_down"),
    use("up", "left_mouse_up"),
    use("c", "cursor_position"),
    use("sc", "scroll", { scroll_direction: "down", scroll_amount: 2, coordinate: [3, 3] }),
    use("ty", "type", { text: "hi" }),
    use("k", "key", { text: "Return" }),
    use("h", "hold_key", { text: "shift", duration: 0.05 }),
    use("w", "wait", { duration: 0.05 }),
  ];
  if (samples.length !== CLAUDE_MEMBERS.length) {
    return { pass: false, detail: `samples ${samples.length}` };
  }
  const ops = samples.map((sample) => toNeutral(sample, session).op);
  const click = toNeutral(samples[2], session);
  const key = toNeutral(samples[14], session);
  const zoom = toNeutral(samples[1], session);
  const clickOk = click.op === "click" && click.x === 200 && click.y === 80 &&
    click.button === "left" && click.provenance?.space === "image" && click.provenance.x === 100;
  const keyOk = key.op === "keypress" && key.keys[0] === "Enter";
  const zoomOk = zoom.op === "zoom" && zoom.x1 === 80 && zoom.y1 === 40;
  const named = samples.every((sample, i) => sample.name === CLAUDE_MEMBERS[i]);
  const pass = named && clickOk && keyOk && zoomOk && !ops.includes("unsupported");
  return { pass, detail: ops.join(",") };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface OpenAICapture {
  workflow: Workflow;
  transcript: unknown;
  before: string;
  after: string;
}

interface ClaudeCapture {
  workflow: Workflow;
  transcript: unknown;
  trail: unknown;
  before: string;
  after: string;
  image: { w: number; h: number };
  viewport: { w: number; h: number };
  measured: { x: number; y: number };
}

async function captureOpenAI(dir: string, outDir: string): Promise<OpenAICapture> {
  const ctx = await launchOwnedChrome({ userDataDir: dir, headless: true });
  watch(ctx);
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await preparePage(page);
    const executor = new PageExecutor(page, new AuditTrail());
    await executor.beginNavigation(PAGE_URL);
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("#username", { timeout: 15000 });
    await executor.finishNavigation();
    const exchanges: { computer_call: ComputerCall; computer_call_output: ComputerCallOutput }[] = [];
    const send = async (id: string, actions: ComputerAction[]) => {
      const computer_call = call(id, actions);
      const computer_call_output = await handleComputerCall(computer_call, executor);
      exchanges.push({ computer_call, computer_call_output });
    };
    await send("call_escape", [{ type: "keypress", keys: ["Escape"] }]);
    await send("call_orphan", [{ type: "keypress", keys: ["a"] }]);
    await send("call_screenshot", [{ type: "screenshot" }]);
    const before = path.join(outDir, "spike_claude_openai_before.png");
    await page.screenshot({ path: before, type: "png" });
    const userAt = await fieldCenter(page, "#username");
    await send("call_click", [{ type: "click", button: "left", x: userAt.x, y: userAt.y }]);
    await send("call_user", [{ type: "type", text: USERNAME }]);
    await send("call_tab", [{ type: "keypress", keys: ["Tab"] }]);
    await send("call_password", [{ type: "type", text: PASSWORD }]);
    await send("call_enter", [{ type: "keypress", keys: ["Enter"] }]);
    const after = path.join(outDir, "spike_claude_openai_after.png");
    await page.screenshot({ path: after, type: "png" });
    const workflow = deriveWorkflow(trimTrail(executor.trail.events), PAGE_URL, {
      id: "wf-proxy-claude-openai",
      name: "Proxy spike — login",
    });
    const transcript = {
      exchanges: exchanges.map((ex) => ({
        computer_call: omitSecret(redactPayload(ex.computer_call).value, PASSWORD),
        computer_call_output: ex.computer_call_output,
      })),
    };
    return { workflow, transcript, before, after };
  } finally {
    await ctx.close();
  }
}

async function captureClaude(dir: string, outDir: string): Promise<ClaudeCapture> {
  const ctx = await launchOwnedChrome({ userDataDir: dir, headless: true });
  watch(ctx);
  try {
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await preparePage(page);
    const trail = new AuditTrail();
    const executor = new PageExecutor(page, trail);
    const session: ClaudeSession = createClaudeSession();
    await executor.beginNavigation(PAGE_URL);
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("#username", { timeout: 15000 });
    await executor.finishNavigation();
    const exchanges: { tool_use: ClaudeToolUse; tool_result: ClaudeToolResult }[] = [];
    const send = async (tool: ClaudeToolUse) => {
      const tool_result = await handleClaudeTool(tool, executor, session);
      exchanges.push({ tool_use: tool, tool_result });
      if (tool_result.is_error) throw new Error(`${tool.name}: ${resultText(tool_result)}`);
      return tool_result;
    };
    const shot = await send(use("tool_screenshot", "screenshot"));
    const png = resultImage(shot);
    if (!png) throw new Error("screenshot result was not an image");
    const image = pngSize(png);
    const viewport = page.viewportSize() ?? { width: image.w, height: image.h };
    const measured = await fieldCenter(page, "#username");
    const ix = measured.x * (image.w / viewport.width);
    const iy = measured.y * (image.h / viewport.height);
    const before = path.join(outDir, "spike_claude_before.png");
    await page.screenshot({ path: before, type: "png" });
    await send(use("tool_zoom", "zoom", { region: [ix - 30, iy - 12, ix + 30, iy + 12] }));
    await send(use("tool_move", "mouse_move", { coordinate: [ix, iy] }));
    const cursor = await send(use("tool_cursor", "cursor_position"));
    await send(use("tool_escape", "key", { text: "Escape" }));
    await send(use("tool_orphan", "key", { text: "a" }));
    await send(use("tool_click", "left_click", { coordinate: [ix, iy] }));
    await send(use("tool_user", "type", { text: USERNAME }));
    await send(use("tool_tab", "key", { text: "Tab" }));
    await send(use("tool_password", "type", { text: PASSWORD }));
    await send(use("tool_enter", "key", { text: "Return" }));
    const captured = await secureState(page);
    const after = path.join(outDir, "spike_claude_after.png");
    await page.screenshot({ path: after, type: "png" });
    const workflow = deriveWorkflow(trimTrail(trail.events), PAGE_URL, {
      id: "wf-proxy-claude",
      name: "Proxy spike — login",
    });
    const trailSnapshot = trail.log();
    const transcript = {
      toolset: "computer_toolset_20260801",
      cursor: resultText(cursor),
      exchanges: exchanges.map((ex) => ({
        tool_use: omitSecret(redactPayload(ex.tool_use).value, PASSWORD),
        tool_result: ex.tool_use.name === "screenshot" || ex.tool_use.name === "zoom"
          ? { ...ex.tool_result, content: "[image omitted]" }
          : ex.tool_result,
      })),
    };
    // Members that are not part of the login workflow. They must run, and they
    // must not be required for the workflow diff above.
    const probes: ClaudeToolUse[] = [
      use("probe_scroll", "scroll", { scroll_direction: "down", scroll_amount: 1, coordinate: [ix, iy] }),
      use("probe_drag", "left_click_drag", { start_coordinate: [4, 4], coordinate: [12, 12] }),
      use("probe_hold", "hold_key", { text: "shift", duration: 0.05 }),
      use("probe_wait", "wait", { duration: 0.05 }),
      use("probe_middle", "middle_click", { coordinate: [2, 2] }),
      use("probe_right", "right_click", { coordinate: [2, 2] }),
      use("probe_double", "double_click", { coordinate: [2, 2] }),
      use("probe_triple", "triple_click", { coordinate: [2, 2] }),
      use("probe_down", "left_mouse_down"),
      use("probe_up", "left_mouse_up"),
    ];
    for (const probe of probes) {
      const result = await handleClaudeTool(probe, executor, session);
      if (result.is_error) throw new Error(`${probe.name}: ${resultText(result)}`);
    }
    return {
      workflow,
      transcript: { ...transcript, captured },
      trail: trailSnapshot,
      before,
      after,
      image,
      viewport: { w: viewport.width, h: viewport.height },
      measured,
    };
  } finally {
    await ctx.close();
  }
}

async function replayOne(
  dir: string,
  workflow: Workflow,
  outDir: string,
  prefix: string,
): Promise<{ flash: string; url: string; usedY: number; shiftedY: number; storedY: number }> {
  const savedDisplay = process.env.DISPLAY;
  const screen = await startPrivateScreen(path.join(outDir, `${prefix}_replay.webm`));
  let ctx: BrowserContext | undefined;
  try {
    ctx = await launchOwnedChrome({
      userDataDir: dir,
      headless: false,
      args: ["--window-position=0,0", "--window-size=1400,900", "--ozone-platform=x11"],
    });
    watch(ctx);
    const page = ctx.pages()[0] ?? await ctx.newPage();
    await preparePage(page);
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("#username", { timeout: 15000 });
    await page.evaluate(() => { document.body.style.marginTop = "220px"; });
    const shifted = await fieldCenter(page, "#username");
    await page.screenshot({ path: path.join(outDir, `${prefix}_replay_before.png`), type: "png" });
    await page.waitForTimeout(600);
    const used = await replayWorkflow(page, workflow, { secrets: [PASSWORD] });
    const state = await secureState(page);
    await page.screenshot({ path: path.join(outDir, `${prefix}_replay_after.png`), type: "png" });
    await page.waitForTimeout(800);
    const click = workflow.steps.find((step) => step.action === "click" && !step.unresolved);
    const clickUsed = used.find((row) => row.label === click?.label);
    return {
      flash: state.flash,
      url: state.url,
      usedY: clickUsed?.y ?? -1,
      shiftedY: shifted.y,
      storedY: click?.provenance?.y ?? -1,
    };
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    await stopPrivateScreen(screen);
    process.env.DISPLAY = savedDisplay;
  }
}

async function main(): Promise<void> {
  installNodeGuard();
  const work = await mkdtemp(path.join(tmpdir(), "bao-claude-"));
  const outDir = path.join(work, "out");
  await mkdir(outDir, { recursive: true });
  const checks: { name: string; pass: boolean; detail?: string }[] = [];
  const check = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail });

  const mapped = memberTable();
  check("17 Claude members map onto neutral actions", mapped.pass, mapped.detail);

  const openaiDir = path.join(work, "openai");
  const claudeDir = path.join(work, "claude");
  const openaiReplayDir = path.join(work, "openai-replay");
  const claudeReplayDir = path.join(work, "claude-replay");
  try {
    const openai = await captureOpenAI(openaiDir, outDir);
    const claude = await captureClaude(claudeDir, outDir);
    const openaiShape = workflowShape(openai.workflow);
    const claudeShape = workflowShape(claude.workflow);
    const diff = { equal: JSON.stringify(openaiShape) === JSON.stringify(claudeShape), openai: openaiShape, claude: claudeShape };
    await writeFile(path.join(outDir, "spike_claude_workflow.json"), JSON.stringify(claude.workflow, null, 2));
    await writeFile(path.join(outDir, "spike_claude_openai_workflow.json"), JSON.stringify(openai.workflow, null, 2));
    await writeFile(path.join(outDir, "spike_claude_diff.json"), JSON.stringify(diff, null, 2));
    await writeFile(path.join(outDir, "spike_claude_transcript.json"), JSON.stringify(claude.transcript, null, 2));
    await writeFile(path.join(outDir, "spike_claude_openai_transcript.json"), JSON.stringify(openai.transcript, null, 2));
    await writeFile(path.join(outDir, "spike_claude_trail.json"), JSON.stringify(claude.trail, null, 2));

    const click = claude.workflow.steps.find((step) => step.action === "click" && !step.unresolved);
    const openaiClick = openai.workflow.steps.find((step) => step.action === "click" && !step.unresolved);
    const scaledBack = (click?.provenance?.y ?? 0) * (claude.viewport.h / claude.image.h);
    const persisted = JSON.stringify(claude.trail) + JSON.stringify(claude.workflow) +
      JSON.stringify(claude.transcript) + JSON.stringify(openai.workflow) + JSON.stringify(openai.transcript);
    const loggedIn = (body: { captured?: { url: string; flash: string } } | undefined, workflow: Workflow) => {
      const enter = workflow.steps.find((step) => step.action === "keypress" && step.key === "Enter");
      return !!enter?.submits && selectorBlob(enter).includes("password");
    };

    check(
      "Claude screenshot is half the viewport",
      claude.image.w === Math.trunc(claude.viewport.w / 2) && claude.image.h === Math.trunc(claude.viewport.h / 2),
      `${claude.image.w}x${claude.image.h} vs ${claude.viewport.w}x${claude.viewport.h}`,
    );
    check(
      "Claude click provenance is the image pixel, scaled back onto the field",
      click?.provenance?.space === "image" && Math.abs(scaledBack - claude.measured.y) < 3,
      `image=${click?.provenance?.y} back=${scaledBack} field=${claude.measured.y}`,
    );
    check(
      "OpenAI click provenance stays in the viewport",
      openaiClick?.provenance?.space === "viewport" && (openaiClick.provenance?.y ?? 0) > 200,
      `y=${openaiClick?.provenance?.y}`,
    );
    check("workflows match apart from provenance", diff.equal, diff.equal ? `${claudeShape.length} steps` : "see spike_claude_diff.json");
    check("Claude capture submitted from #password", loggedIn(undefined, claude.workflow));
    check("OpenAI capture submitted from #password", loggedIn(undefined, openai.workflow));
    check("password withheld from both transcripts, trails, and workflows", !persisted.includes(PASSWORD), "withheld");
    const cursorText = (claude.transcript as { cursor?: string }).cursor ?? "";
    check("cursor_position is text in image space", /\[\d+, \d+\]/.test(cursorText), cursorText);

    const claudeReplay = await replayOne(claudeReplayDir, claude.workflow, outDir, "spike_claude");
    const openaiReplay = await replayOne(openaiReplayDir, openai.workflow, outDir, "spike_claude_openai");
    check(
      "Claude replay ignored the image coordinate",
      claudeReplay.url.includes("/secure") &&
        /logged into a secure area/i.test(claudeReplay.flash) &&
        Math.abs(claudeReplay.usedY - claudeReplay.storedY) > 80,
      `stored=${claudeReplay.storedY} used=${claudeReplay.usedY} flash=${claudeReplay.flash}`,
    );
    check(
      "OpenAI replay ignored the viewport coordinate",
      openaiReplay.url.includes("/secure") &&
        /logged into a secure area/i.test(openaiReplay.flash) &&
        Math.abs(openaiReplay.usedY - openaiReplay.storedY) > 80,
      `stored=${openaiReplay.storedY} used=${openaiReplay.usedY} shifted=${openaiReplay.shiftedY}`,
    );
  } finally {
    await rm(openaiDir, { recursive: true, force: true });
    await rm(claudeDir, { recursive: true, force: true });
    await rm(openaiReplayDir, { recursive: true, force: true });
    await rm(claudeReplayDir, { recursive: true, force: true });
  }

  check(
    "temp profiles are gone",
    !(await exists(openaiDir)) && !(await exists(claudeDir)) &&
      !(await exists(openaiReplayDir)) && !(await exists(claudeReplayDir)),
  );
  check("zero network calls to openai or anthropic", vendorHits.length === 0, vendorHits.join(" ") || "none");

  let failed = 0;
  for (const item of checks) {
    const detail = item.detail?.includes(PASSWORD) ? "redacted" : item.detail;
    console.log(`${item.pass ? "PASS" : "FAIL"}  ${item.name}${detail ? ` — ${detail}` : ""}`);
    if (!item.pass) failed++;
  }
  console.log(failed === 0 ? "SPIKE CLAUDE: PASS" : `SPIKE CLAUDE: FAIL (${failed})`);
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

interface PrivateScreen {
  display: string;
  xvfb: ChildProcess;
  grab: ChildProcess;
}

async function startPrivateScreen(videoPath: string): Promise<PrivateScreen> {
  for (let n = 120; n < 150; n++) {
    const display = `:${n}`;
    const xvfb = spawn("Xvfb", [display, "-screen", "0", "1400x900x24", "-nolisten", "tcp"], { stdio: "ignore" });
    const up = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(xvfb.exitCode === null), 300);
      xvfb.once("exit", () => { clearTimeout(timer); resolve(false); });
    });
    if (!up) continue;
    process.env.DISPLAY = display;
    const grab = spawn("ffmpeg", [
      "-y", "-f", "x11grab", "-video_size", "1400x900", "-framerate", "12", "-i", display,
      "-c:v", "libvpx", "-b:v", "1M", "-an", videoPath,
    ], { stdio: "ignore" });
    return { display, xvfb, grab };
  }
  throw new Error("Could not start a private Xvfb for the replay recording.");
}

async function stopPrivateScreen(screen: PrivateScreen): Promise<void> {
  if (screen.grab.exitCode === null) {
    screen.grab.kill("SIGINT");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { screen.grab.kill("SIGKILL"); resolve(); }, 4000);
      screen.grab.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (screen.xvfb.exitCode === null) screen.xvfb.kill("SIGTERM");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
