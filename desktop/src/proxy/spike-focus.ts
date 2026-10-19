// Focus spike. Scripted OpenAI computer_call on the-internet's login form.
// The executor tracks focus and turns type / keypress into selector steps.
// The password is a public test credential and must not land in the trail.

import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext, Page, Request } from "playwright";
import { omitSecret, redactPayload } from "../../../src/mask";
import { launchOwnedChrome } from "../launch";
import { AuditTrail, deriveWorkflow, trimTrail } from "./audit";
import { PageExecutor, preparePage } from "./executor";
import { handleComputerCall, type ComputerAction, type ComputerCall, type ComputerCallOutput } from "./openai";
import { replayWorkflow } from "./replay";

const PAGE_URL = "https://the-internet.herokuapp.com/login";
const ARTIFACTS = process.env.BAO_SPIKE_ARTIFACTS || "/opt/cursor/artifacts";
const USERNAME = "tomsmith";
const PASSWORD = "SuperSecretPassword!";

const openaiHits: string[] = [];

function watch(ctx: BrowserContext): void {
  const note = (req: Request) => {
    try {
      const host = new URL(req.url()).hostname;
      if (host === "openai.com" || host.endsWith(".openai.com")) openaiHits.push(req.url());
    } catch { /* non-URL */ }
  };
  ctx.on("request", note);
}

function installNodeGuard(): void {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (/openai\.com/i.test(url)) {
      openaiHits.push(url);
      throw new Error(`blocked network call to ${url}`);
    }
    if (!orig) throw new Error("fetch is unavailable");
    return orig(input, init);
  }) as typeof fetch;
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

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

interface Exchange {
  computer_call: ComputerCall;
  computer_call_output: ComputerCallOutput;
}

async function main(): Promise<void> {
  installNodeGuard();
  const work = await mkdtemp(path.join(tmpdir(), "bao-focus-"));
  const recordDir = path.join(work, "record");
  const replayDir = path.join(work, "replay");
  const outDir = path.join(work, "out");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });

  const exchanges: Exchange[] = [];
  const checks: { name: string; pass: boolean; detail?: string }[] = [];
  const check = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, detail });

  let recordCtx: BrowserContext | undefined;
  let replayCtx: BrowserContext | undefined;
  let privateScreen: PrivateScreen | undefined;
  try {
    recordCtx = await launchOwnedChrome({ userDataDir: recordDir, headless: true });
    watch(recordCtx);
    const recordPage = recordCtx.pages()[0] ?? await recordCtx.newPage();
    await preparePage(recordPage);
    const trail = new AuditTrail();
    const executor = new PageExecutor(recordPage, trail);
    await executor.beginNavigation(PAGE_URL);
    await recordPage.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await recordPage.waitForSelector("#username", { timeout: 15000 });
    await executor.finishNavigation();

    const send = async (id: string, actions: ComputerAction[]) => {
      const computer_call = call(id, actions);
      const computer_call_output = await handleComputerCall(computer_call, executor);
      exchanges.push({ computer_call, computer_call_output });
    };

    await send("call_escape", [{ type: "keypress", keys: ["Escape"] }]);
    await send("call_orphan", [{ type: "keypress", keys: ["a"] }]);
    await send("call_screenshot", [{ type: "screenshot" }]);
    await recordPage.screenshot({ path: path.join(outDir, "spike_focus_before.png"), type: "png" });

    const userAt = await fieldCenter(recordPage, "#username");
    await send("call_click", [{ type: "click", button: "left", x: userAt.x, y: userAt.y }]);
    await send("call_user", [{ type: "type", text: USERNAME }]);
    await send("call_tab", [{ type: "keypress", keys: ["Tab"] }]);
    await send("call_password", [{ type: "type", text: PASSWORD }]);
    await send("call_enter", [{ type: "keypress", keys: ["Enter"] }]);
    const captured = await secureState(recordPage);
    await recordPage.screenshot({ path: path.join(outDir, "spike_focus_after.png"), type: "png" });

    const workflow = deriveWorkflow(trimTrail(trail.events), PAGE_URL, {
      id: "wf-proxy-focus",
      name: "Proxy spike — login",
    });
    const transcript = {
      exchanges: exchanges.map((ex) => ({
        computer_call: omitSecret(redactPayload(ex.computer_call).value, PASSWORD),
        computer_call_output: ex.computer_call_output,
      })),
    };
    await writeFile(path.join(outDir, "spike_focus_workflow.json"), JSON.stringify(workflow, null, 2));
    await writeFile(path.join(outDir, "spike_focus_transcript.json"), JSON.stringify(transcript, null, 2));
    await writeFile(path.join(outDir, "spike_focus_trail.json"), JSON.stringify(trail.log(), null, 2));

    const steps = workflow.steps;
    const escape = steps.find((s) => s.action === "keypress" && s.key === "Escape");
    const orphan = steps.find((s) => s.unresolved && s.action === "keypress");
    const click = steps.find((s) => s.action === "click" && !s.unresolved);
    const typedUser = steps.find((s) => s.action === "input" && !s.sensitive);
    const tab = steps.find((s) => s.action === "keypress" && s.key === "Tab");
    const typedSecret = steps.find((s) => s.action === "input" && s.sensitive);
    const enter = steps.find((s) => s.action === "keypress" && s.key === "Enter");
    const userTypeEvent = trail.events.find((e) => e.op === "type" && !e.sensitive && !e.unresolved);
    const secretTypeEvent = trail.events.find((e) => e.op === "type" && e.sensitive);
    const persisted = JSON.stringify(trail.log()) + JSON.stringify(workflow) + JSON.stringify(transcript.exchanges.map((e) => e.computer_call));

    const loggedIn = captured.url.includes("/secure") && /logged into a secure area/i.test(captured.flash);
    check("capture reached /secure", loggedIn, captured.url);
    check(
      "Escape with no focus is a page-level key step",
      !!escape && !escape.target && !escape.unresolved,
      escape?.label
    );
    check(
      "a key with no focus and no page meaning is unresolved",
      !!orphan?.unresolved && !orphan.target,
      orphan?.unresolved?.reason
    );
    check(
      "click, type, Tab, and Enter resolved to selectors",
      !!click?.target?.selectors.length &&
        selectorBlob(typedUser).includes("username") &&
        typedUser?.value === USERNAME &&
        !!tab?.target && selectorBlob(tab).includes("username") &&
        selectorBlob(typedSecret).includes("password") &&
        typedSecret?.value === undefined &&
        !!enter?.target && selectorBlob(enter).includes("password"),
      `user=${selectorBlob(typedUser)} secret=${selectorBlob(typedSecret)}`
    );
    check(
      "focus tracked in the DOM and the AX tree",
      userTypeEvent?.focus?.scope === "element" &&
        userTypeEvent.focus.editable === true &&
        !!userTypeEvent.focus.axRole &&
        secretTypeEvent?.focus?.editable === true,
      `ax=${userTypeEvent?.focus?.axRole}`
    );
    check(
      "password is withheld from the trail, transcript, and workflow",
      typedSecret?.sensitive === true && !persisted.includes(PASSWORD),
      typedSecret?.sensitive ? "withheld" : "present"
    );
    check(
      "computer_call_output matches call_id",
      exchanges.every((ex) => ex.computer_call_output.call_id === ex.computer_call.call_id && ex.computer_call_output.output.type === "computer_screenshot"),
      String(exchanges.length)
    );

    await recordCtx.close();
    recordCtx = undefined;

    privateScreen = await startPrivateScreen(path.join(outDir, "spike_focus_replay.webm"));
    replayCtx = await launchOwnedChrome({
      userDataDir: replayDir,
      headless: false,
      args: ["--window-position=0,0", "--window-size=1400,900", "--ozone-platform=x11"],
    });
    watch(replayCtx);
    const replayPage = replayCtx.pages()[0] ?? await replayCtx.newPage();
    await preparePage(replayPage);
    await replayPage.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await replayPage.waitForSelector("#username", { timeout: 15000 });
    await replayPage.evaluate(() => {
      document.body.style.marginTop = "220px";
    });
    const shifted = await fieldCenter(replayPage, "#username");
    await replayPage.screenshot({ path: path.join(outDir, "spike_focus_replay_before.png"), type: "png" });
    await replayPage.waitForTimeout(600);
    const used = await replayWorkflow(replayPage, workflow, { secrets: [PASSWORD] });
    const replayed = await secureState(replayPage);
    await replayPage.screenshot({ path: path.join(outDir, "spike_focus_replay_after.png"), type: "png" });
    await replayPage.waitForTimeout(800);

    const clickUsed = used.find((u) => u.label === click?.label);
    const moved = !!click?.provenance && !!clickUsed && Math.abs(clickUsed.y - click.provenance.y) > 80;
    check(
      "replay used the live field, not the stored coordinate",
      moved,
      `stored=${click?.provenance?.y} used=${clickUsed?.y} shifted=${shifted.y}`
    );
    check(
      "replay reached the same flash, read from the DOM",
      replayed.url.includes("/secure") && /logged into a secure area/i.test(replayed.flash),
      replayed.flash
    );
  } finally {
    if (replayCtx) await replayCtx.close().catch(() => {});
    if (recordCtx) await recordCtx.close().catch(() => {});
    if (privateScreen) await stopPrivateScreen(privateScreen);
  }

  await rm(recordDir, { recursive: true, force: true });
  await rm(replayDir, { recursive: true, force: true });
  check("both temp profiles are gone", !(await exists(recordDir)) && !(await exists(replayDir)));
  check("zero network calls to openai", openaiHits.length === 0, openaiHits.join(" ") || "none");

  let failed = 0;
  for (const c of checks) {
    const detail = c.detail?.includes(PASSWORD) ? "redacted" : c.detail;
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${detail ? ` — ${detail}` : ""}`);
    if (!c.pass) failed++;
  }
  console.log(failed === 0 ? "SPIKE FOCUS: PASS" : `SPIKE FOCUS: FAIL (${failed})`);
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
