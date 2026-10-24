// Scripted OpenAI computer_call against a throwaway Chrome.
// The driver measures a point, then speaks only the published computer_call
// schema. No OpenAI client, no model.

import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserContext, Page, Request } from "playwright";
import { redactPayload } from "../../../src/mask";
import { launchOwnedChrome } from "../launch";
import { AuditTrail, deriveWorkflow, trimTrail } from "./audit";
import { PageExecutor, preparePage } from "./executor";
import { NetworkCapture, type HarLog } from "./network";
import { handleComputerCall, type ComputerAction, type ComputerCall, type ComputerCallOutput } from "./openai";
import { replayWorkflow } from "./replay";

// Same Visa test number the extension's T1 fixture types into #card.
const TEST_CARD = "4111111111111111";

const PAGE_URL = "https://the-internet.herokuapp.com/checkboxes";
const ARTIFACTS = process.env.BAO_SPIKE_ARTIFACTS || "/opt/cursor/artifacts";

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

async function checkboxStates(page: Page): Promise<boolean[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#checkboxes input")).map((el) => (el as HTMLInputElement).checked)
  );
}

async function checkboxCenter(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const el = document.querySelector("#checkboxes input");
    if (!(el instanceof HTMLElement)) throw new Error("no checkbox to measure");
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
}

async function blankPoint(page: Page): Promise<{ x: number; y: number; tag: string }> {
  return page.evaluate(() => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (let y = Math.floor(h * 0.72); y > 120; y -= 24) {
      for (const x of [Math.floor(w / 2), 48, w - 48]) {
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        if (el.closest("a,button,input,select,textarea")) continue;
        return { x, y, tag: el.tagName.toLowerCase() };
      }
    }
    return { x: 4, y: 4, tag: "fallback" };
  });
}

function pngOk(output: ComputerCallOutput): boolean {
  const url = output.output.image_url;
  if (!url.startsWith("data:image/png;base64,")) return false;
  const buf = Buffer.from(url.slice("data:image/png;base64,".length), "base64");
  return buf.length > 5000 && buf[0] === 0x89 && buf[1] === 0x50;
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function shot(page: Page, file: string): Promise<void> {
  await page.screenshot({ path: file, type: "png" });
}

interface Exchange {
  computer_call: ComputerCall;
  computer_call_output: ComputerCallOutput;
}

async function main(): Promise<void> {
  installNodeGuard();
  const work = await mkdtemp(path.join(tmpdir(), "bao-proxy-"));
  const recordDir = path.join(work, "record");
  const replayDir = path.join(work, "replay");
  const outDir = path.join(work, "out");
  await rm(outDir, { recursive: true, force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });

  const exchanges: Exchange[] = [];
  let axCount = 0;
  let domCount = 0;
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
    const net = new NetworkCapture(() => trail.currentId());
    net.attach(recordCtx);
    const executor = new PageExecutor(recordPage, trail);
    await executor.beginNavigation(PAGE_URL);
    await recordPage.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await recordPage.waitForSelector("#checkboxes input", { timeout: 15000 });
    await executor.finishNavigation();
    await net.flush();
    const before = await checkboxStates(recordPage);

    const shotCall = call("call_screenshot", [{ type: "screenshot" }]);
    const shotOut = await handleComputerCall(shotCall, executor);
    exchanges.push({ computer_call: shotCall, computer_call_output: shotOut });
    const firstObs = await executor.observe({
      source: { agent: "scripted-driver", vendor: "bao", adapter: "none" },
      raw: { type: "screenshot" },
    });
    axCount = firstObs.ax.length;
    domCount = firstObs.dom.length;
    await writeFile(path.join(outDir, "spike_proxy_before.png"), firstObs.png);

    const at = await checkboxCenter(recordPage);
    const clickCall = call("call_click", [{ type: "click", button: "left", x: at.x, y: at.y }]);
    const clickOut = await handleComputerCall(clickCall, executor);
    exchanges.push({ computer_call: clickCall, computer_call_output: clickOut });
    const afterClick = await checkboxStates(recordPage);
    await shot(recordPage, path.join(outDir, "spike_proxy_after.png"));

    const blank = await blankPoint(recordPage);
    const blankCall = call("call_blank", [{ type: "click", button: "left", x: blank.x, y: blank.y }]);
    const blankOut = await handleComputerCall(blankCall, executor);
    exchanges.push({ computer_call: blankCall, computer_call_output: blankOut });
    const afterBlank = await checkboxStates(recordPage);

    const typeCall = call("call_type", [{ type: "type", text: TEST_CARD }]);
    const typeOut = await handleComputerCall(typeCall, executor);
    exchanges.push({ computer_call: typeCall, computer_call_output: typeOut });
    const afterType = await checkboxStates(recordPage);

    await net.flush();
    const fullLog = trail.log();
    const trimmedEvents = trimTrail(fullLog.events);
    const workflow = deriveWorkflow(trimmedEvents, PAGE_URL);
    const fromFull = deriveWorkflow(fullLog.events, PAGE_URL);
    const transcript = {
      exchanges: exchanges.map((ex) => ({
        computer_call: redactPayload(ex.computer_call).value as ComputerCall,
        computer_call_output: ex.computer_call_output,
      })),
    };
    const har = net.har();
    await writeFile(path.join(outDir, "spike_proxy_workflow.json"), JSON.stringify(workflow, null, 2));
    await writeFile(path.join(outDir, "spike_proxy_transcript.json"), JSON.stringify(transcript, null, 2));
    await writeFile(path.join(outDir, "spike_proxy_trail.json"), JSON.stringify(fullLog, null, 2));
    await writeFile(path.join(outDir, "spike_proxy_trail_trimmed.json"), JSON.stringify({ version: 1, events: trimmedEvents }, null, 2));
    await writeFile(path.join(outDir, "spike_proxy_har.json"), JSON.stringify(har, null, 2));

    const resolved = workflow.steps.find((s) => s.action === "setChecked" && !s.unresolved);
    const missed = workflow.steps.find((s) => s.unresolved);
    const outputsOk = exchanges.every((ex) =>
      ex.computer_call_output.type === "computer_call_output" &&
      ex.computer_call_output.call_id === ex.computer_call.call_id &&
      ex.computer_call_output.output.type === "computer_screenshot" &&
      ex.computer_call_output.output.detail === "original" &&
      pngOk(ex.computer_call_output)
    );

    check(
      "computer_call_output matches call_id and carries a png screenshot",
      outputsOk && exchanges.length === 4,
      exchanges.map((ex) => ex.computer_call.call_id).join(", ")
    );
    check(
      "observe returned an AX snapshot and a DOM snapshot",
      axCount > 0 && domCount > 0,
      `ax=${axCount} dom=${domCount}`
    );
    check(
      "workflow version 2 stores a selector on the checkbox step",
      workflow.version === 2 &&
        !!resolved &&
        (resolved.target?.selectors.length ?? 0) > 0 &&
        resolved.provenance?.space === "viewport" &&
        resolved.checked === true,
      resolved?.target?.selectors.map((s) => `${s.type}:${s.value}`).join(" | ")
    );
    check(
      "blank click is stored unresolved and did not change the checkbox",
      !!missed &&
        !missed.target &&
        !!missed.unresolved?.reason &&
        JSON.stringify(afterClick) === JSON.stringify(afterBlank) &&
        JSON.stringify(afterClick) === JSON.stringify([true, true]) &&
        JSON.stringify(before) === JSON.stringify([false, true]) &&
        JSON.stringify(afterType) === JSON.stringify(afterBlank),
      `before=${before} after=${afterClick} blank=${afterBlank} reason=${missed?.unresolved?.reason} tag=${blank.tag}`
    );
    const shotEvents = (op: string) => fullLog.events.filter((e) => e.kind === "read" && e.op === op);
    const clickAct = fullLog.events.find((e) => e.kind === "act" && e.op === "click" && e.resolved);
    const blankAct = fullLog.events.find((e) => e.kind === "act" && e.unresolved && e.provenance);
    const typeAct = fullLog.events.find((e) => e.kind === "act" && e.op === "type");
    const trailBlob = JSON.stringify(fullLog) + JSON.stringify(trimmedEvents) + JSON.stringify(workflow) + JSON.stringify(har);
    const callBlob = JSON.stringify(transcript.exchanges.map((ex) => ex.computer_call));
    const shotsFull = shotEvents("screenshot").length;
    const shotsTrim = trimmedEvents.filter((e) => e.kind === "read" && e.op === "screenshot").length;
    check(
      "audit trail records reads and acts with source, snapshots, and the resolved element",
      fullLog.version === 1 &&
        shotEvents("screenshot").every((e) => !!e.after?.screenshot && !!e.source.adapter && !!e.ts) &&
        shotEvents("dom").some((e) => (e.after?.dom.length ?? 0) > 0) &&
        shotEvents("ax").some((e) => (e.after?.ax.length ?? 0) > 0) &&
        !!clickAct?.resolved?.selectors.length &&
        !!blankAct?.unresolved &&
        !blankAct?.resolved &&
        typeAct?.sensitive === true &&
        typeAct?.unresolved?.reason !== undefined,
      `events=${fullLog.events.length} selector=${clickAct?.resolved?.selectors[0]?.value}`
    );
    check(
      "trim drops consecutive duplicate screenshots and the workflow re-derives",
      shotsTrim < shotsFull &&
        shotsTrim >= 1 &&
        JSON.stringify(workflow.steps) === JSON.stringify(fromFull.steps) &&
        JSON.stringify(deriveWorkflow(trimTrail(trimmedEvents), PAGE_URL).steps) === JSON.stringify(workflow.steps),
      `screenshots ${shotsFull} -> ${shotsTrim}, steps=${workflow.steps.length}`
    );
    check(
      "typed card is withheld from the trail, the transcript, and the workflow",
      !trailBlob.includes(TEST_CARD) && !callBlob.includes(TEST_CARD) && typeAct?.sensitive === true,
      typeAct?.sensitive ? "withheld" : "present"
    );
    check(
      "HAR links requests to audit events and strips cookies and auth headers",
      harClean(har, new Set(fullLog.events.map((e) => e.id)), fullLog.events.find((e) => e.op === "navigate")?.id),
      harSummary(har, fullLog.events.find((e) => e.op === "navigate")?.id)
    );

    await recordCtx.close();
    recordCtx = undefined;

    // Headless Chrome's page screencast ends before the shift, so a Playwright
    // video never shows the click. Record the replay from a private Xvfb.
    privateScreen = await startPrivateScreen(path.join(outDir, "spike_proxy_replay.webm"));
    replayCtx = await launchOwnedChrome({
      userDataDir: replayDir,
      headless: false,
      args: ["--window-position=0,0", "--window-size=1400,900", "--ozone-platform=x11"],
    });
    watch(replayCtx);
    const replayPage = replayCtx.pages()[0] ?? await replayCtx.newPage();
    await preparePage(replayPage);
    await replayPage.goto(PAGE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    await replayPage.waitForSelector("#checkboxes input", { timeout: 15000 });
    await replayPage.evaluate(() => {
      document.body.style.marginTop = "220px";
    });
    const shifted = await checkboxCenter(replayPage);
    await shot(replayPage, path.join(outDir, "spike_proxy_replay_before.png"));
    // Hold each state so the screencast includes the shift and the click.
    await replayPage.waitForTimeout(800);
    const used = await replayWorkflow(replayPage, workflow);
    const replayStates = await checkboxStates(replayPage);
    await shot(replayPage, path.join(outDir, "spike_proxy_replay_after.png"));
    await replayPage.waitForTimeout(1200);

    const provenance = resolved?.provenance;
    const clickUsed = used.find((u) => u.label === resolved?.label);
    const moved = !!provenance && !!clickUsed && Math.abs(clickUsed.y - provenance.y) > 80;
    check(
      "replay clicked the live element, not the stored coordinate",
      moved && used.length === 1,
      `stored=${provenance?.x},${provenance?.y} used=${clickUsed?.x},${clickUsed?.y} shifted=${shifted.x},${shifted.y}`
    );
    check(
      "replay checkbox state read from the DOM",
      JSON.stringify(replayStates) === JSON.stringify([true, true]),
      JSON.stringify(replayStates)
    );
  } finally {
    if (replayCtx) await replayCtx.close().catch(() => {});
    if (recordCtx) await recordCtx.close().catch(() => {});
    if (privateScreen) {
      await stopPrivateScreen(privateScreen);
      privateScreen = undefined;
    }
  }

  await rm(recordDir, { recursive: true, force: true });
  await rm(replayDir, { recursive: true, force: true });
  check(
    "both temp profiles are gone",
    !(await exists(recordDir)) && !(await exists(replayDir)),
    `record=${recordDir} replay=${replayDir}`
  );
  check("zero network calls to openai", openaiHits.length === 0, openaiHits.join(" ") || "none");

  let failed = 0;
  for (const c of checks) {
    console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
    if (!c.pass) failed++;
  }
  console.log(failed === 0 ? "SPIKE PROXY: PASS" : `SPIKE PROXY: FAIL (${failed})`);

  if (failed === 0) {
    await mkdirArtifacts();
    for (const name of await readdir(outDir)) {
      if (name.endsWith(".png") || name.endsWith(".webm") || name.endsWith(".json")) {
        await copyFile(path.join(outDir, name), path.join(ARTIFACTS, name));
      }
    }
    console.log(`artifacts: ${ARTIFACTS}`);
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

/** A display that is not the user's session. ffmpeg grabs it for the replay video. */
async function startPrivateScreen(videoPath: string): Promise<PrivateScreen> {
  for (let n = 120; n < 150; n++) {
    const display = `:${n}`;
    const xvfb = spawn("Xvfb", [display, "-screen", "0", "1400x900x24", "-nolisten", "tcp"], {
      stdio: "ignore",
    });
    const up = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(xvfb.exitCode === null), 300);
      xvfb.once("exit", () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (!up) continue;
    process.env.DISPLAY = display;
    const grab = spawn("ffmpeg", [
      "-y",
      "-f", "x11grab",
      "-video_size", "1400x900",
      "-framerate", "12",
      "-i", display,
      "-c:v", "libvpx",
      "-b:v", "1M",
      "-an",
      videoPath,
    ], { stdio: "ignore" });
    return { display, xvfb, grab };
  }
  throw new Error("Could not start a private Xvfb for the replay recording.");
}

async function stopPrivateScreen(screen: PrivateScreen): Promise<void> {
  if (screen.grab.exitCode === null) {
    screen.grab.kill("SIGINT");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        screen.grab.kill("SIGKILL");
        resolve();
      }, 4000);
      screen.grab.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (screen.xvfb.exitCode === null) screen.xvfb.kill("SIGTERM");
}

const FORBIDDEN_HEADERS = ["cookie", "authorization", "proxy-authorization", "x-api-key", "set-cookie"];

function harClean(har: HarLog, ids: Set<string>, navId: string | undefined): boolean {
  const entries = har.log.entries;
  if (!navId || entries.length === 0) return false;
  const pageHits = entries.filter((e) => e.request.url.includes("the-internet.herokuapp.com"));
  if (!pageHits.some((e) => e._auditEventId === navId)) return false;
  for (const e of entries) {
    if (!e._auditEventId || !ids.has(e._auditEventId)) return false;
    const headers = [...e.request.headers, ...e.response.headers];
    if (headers.some((h) => FORBIDDEN_HEADERS.includes(h.name.toLowerCase()))) return false;
    if (e.request.cookies.length > 0 || e.response.cookies.length > 0) return false;
  }
  return true;
}

function harSummary(har: HarLog, navId: string | undefined): string {
  const linked = har.log.entries.filter((e) => e._auditEventId === navId).length;
  return `entries=${har.log.entries.length} linked-to-navigate=${linked}`;
}

async function mkdirArtifacts(): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(ARTIFACTS, { recursive: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
