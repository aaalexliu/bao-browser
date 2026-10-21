// Real-app drift. Records each workflow once from the live page or app,
// then replays it. Profiles and homes are throwaway directories.

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "playwright";
import { launchOwnedChrome } from "../launch";
import { BrowserDriver } from "./browser-driver";
import { driftMarkdown, driftReport, recoveryRows, type DriftReport, type DriftRow } from "./drift";
import { cursorHeal, keepPatch, unavailableHeal, type HealProvider } from "./heal";
import { interpret, type TrailEvent } from "./interpret";
import { fromAtspiNode } from "./identity";
import { buildLocators } from "./locators";
import { discoverReveal } from "./repair";
import { diffTrajectory, trajectoryFromWorkflow, trajectoryMarkdown, type TrajectoryDiff, type TrajectoryStep } from "./trajectory";
import { AtspiDriver } from "./os-driver";
import { osNodes, osPress, type OsNode } from "../proxy/os";
import { noteDrift, noteReplay, openProvisional, promotionEvent } from "./promote";
import { replay, type LocatorMode } from "./replay";
import type { WorkflowV2 } from "./schema";

export interface CapturedWeb {
  id: string;
  name: string;
  workflow: WorkflowV2;
  langUrl?: string;
  theme: "wikipedia" | "python" | "media";
  trajectory: TrajectoryStep[];
}

const WIKI = "https://en.wikipedia.org/wiki/Main_Page";
const WIKI_ES = "https://es.wikipedia.org/wiki/Wikipedia:Portada";
const PY = "https://docs.python.org/3/search.html";
const PY_ES = "https://docs.python.org/es/3/search.html";
const DYNAMIC = "https://the-internet.herokuapp.com/dynamic_loading/1";
const ADD = "https://the-internet.herokuapp.com/add_remove_elements/";

const WEB_CHANGES = ["move", "resize", "scale", "theme-dark", "theme-light", "font", "lang", "slow"] as const;

const WEB_NOTES = `
## Notes

Wikipedia search is recorded as fill plus Enter. A click on \`#searchInput\` opens Vector's typeahead, and the field the click found is not the field the next step has to type into.

Move keeps a 1280×720 viewport and only relocates the window. Resize sets an 880×560 viewport. Below about 1120px, Vector collapses \`#searchInput\` to a 0×0 box and shows a search link. When the recorded target is that collapsed box, replay clicks a recorded or discoverable reveal control (the search toggle) and logs a \`reveal\` repair, then locates the field that opened. Python docs search and the-internet dynamic loading still have a visible target at 880×560.

Language drift changes the accessible name (Search Wikipedia / Search versus Buscar en Wikipedia / Búsqueda) and leaves the id or the \`name\` attribute. Primary replays the role locator only. Multi can use the css locator.

\`internet-add\` / \`stale-label\` is not a visual mutation of the site. The recorded name is \`Add Element now\` and the live button is \`Add Element\`. The label repair is what makes that step pass. Dynamic loading has no second language on this host.
`.trim();

const DESKTOP_NOTES = `
## Notes

GNOME Calculator is 7 + 5 =. The keypad button and its inner label share a name, so the scorer calls that a tie (role is 20 points, under the 25 point margin). Digit replay then takes the one node whose role is button. The expect is the label 12. Language packs other than en_US.utf8 are not installed, and a desktop app has no page to throttle.

gedit types into the unnamed document text view. The file is a throwaway note.txt. interpret's value postcondition is dropped because this driver does not put the buffer in \`values\`; the expect is the dirty-tab label \`*note.txt\`. GTK_THEME and GDK_DPI_SCALE are relaunched; a missed registration is retried once.
`.trim();

export async function captureWeb(): Promise<{ captured: CapturedWeb[]; stale?: WorkflowV2; errors: DriftRow[] }> {
  const errors: DriftRow[] = [];
  const home = mkdtempSync(path.join(tmpdir(), "bao-real-profile-"));
  const ctx = await launchOwnedChrome({ userDataDir: home, headless: true });
  const captured: CapturedWeb[] = [];
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    for (const spec of [
      ["wikipedia-search", "Wikipedia search", WIKI, WIKI_ES, "wikipedia", recordWikipedia],
      ["python-search", "Python docs search", PY, PY_ES, "python", recordPython],
      ["internet-dynamic", "Dynamic loading", DYNAMIC, undefined, "media", recordDynamic],
    ] as const) {
      try {
        captured.push(await captureOne(page, spec[0], spec[1], spec[2], spec[3], spec[4], spec[5]));
      } catch (err) {
        errors.push(failRow(spec[0], "record", err));
      }
    }
    const stale = await recordStaleAdd(page).catch((err: unknown) => {
      errors.push(failRow("internet-add", "record", err));
      return undefined;
    });
    return { captured, stale, errors };
  } finally {
    await ctx.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
}

async function captureOne(
  page: Page,
  id: string,
  name: string,
  url: string,
  langUrl: string | undefined,
  theme: CapturedWeb["theme"],
  record: (page: Page) => Promise<{ workflow: WorkflowV2; trajectory: TrajectoryStep[] }>,
): Promise<CapturedWeb> {
  const recorded = await record(page);
  recorded.workflow.id = id;
  recorded.workflow.name = name;
  return { id, name, workflow: recorded.workflow, langUrl, theme, trajectory: recorded.trajectory };
}

export async function replayWeb(
  captured: CapturedWeb[],
  mode: LocatorMode,
  headed: boolean,
  diffs?: TrajectoryDiff[],
): Promise<DriftRow[]> {
  const rows: DriftRow[] = [];
  for (const change of WEB_CHANGES) {
    const home = mkdtempSync(path.join(tmpdir(), "bao-real-profile-"));
    const ctx = await launchOwnedChrome({
      userDataDir: home,
      headless: !headed,
      deviceScaleFactor: change === "scale" ? 2 : undefined,
      args: headed ? ["--window-position=30,30", "--window-size=1200,800"] : undefined,
    });
    try {
      for (const item of captured) {
        if (change === "lang" && !item.langUrl) {
          rows.push({ workflow: item.id, change, stepId: "lang", passed: false, na: true, reason: "this site has no second language" });
          continue;
        }
        console.log(`replay ${mode} ${item.id} ${change}`);
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const page = await ctx.newPage();
          try {
            page.setDefaultTimeout(8000);
            if (change === "slow") await throttle(page);
            const url = change === "lang" && item.langUrl ? item.langUrl : item.workflow.startUrl;
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
            const placed = await applyChange(page, item, change);
            if (!placed.ok) {
              rows.push({ workflow: item.id, change, stepId: "window", passed: false, na: true, reason: placed.reason });
              lastErr = undefined;
              break;
            }
            rows.push(...await runWorkflow(item.id, change, item.workflow, new BrowserDriver(page), mode, (trajectory) => {
              if (mode === "all" && diffs && (change === "move" || change === "resize")) {
                diffs.push({ workflow: item.id, change, lines: diffTrajectory(item.trajectory, trajectory) });
              }
            }));
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            const message = err instanceof Error ? err.message : String(err);
            if (attempt < 2 && /context was destroyed|Execution context/i.test(message)) {
              console.log(`retry ${mode} ${item.id} ${change}`);
              continue;
            }
            break;
          } finally {
            await page.close().catch(() => undefined);
          }
        }
        if (lastErr) rows.push(failRow(item.id, change, lastErr));
      }
    } finally {
      await ctx.close().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  }
  return rows;
}

export async function replayStale(stale: WorkflowV2, mode: LocatorMode): Promise<DriftRow[]> {
  const home = mkdtempSync(path.join(tmpdir(), "bao-real-profile-"));
  const ctx = await launchOwnedChrome({ userDataDir: home, headless: true });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(ADD, { waitUntil: "domcontentloaded", timeout: 45000 });
    return await runWorkflow("internet-add", "stale-label", stale, new BrowserDriver(page), mode);
  } finally {
    await ctx.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
}

async function runWorkflow(
  name: string,
  change: string,
  workflow: WorkflowV2,
  driver: BrowserDriver | AtspiDriver,
  mode: LocatorMode,
  onTrajectory?: (steps: TrajectoryStep[]) => void,
  heal?: HealProvider,
): Promise<DriftRow[]> {
  const result = await replay(workflow, argsOf(workflow), driver, {
    locators: mode,
    heal: heal ?? unavailableHeal(),
    settings: { heal: "auto" },
  });
  onTrajectory?.(result.trajectory);
  const first: Record<string, string | undefined> = {};
  for (const step of workflow.steps) first[step.id] = step.locators?.[0]?.kind;
  const rows = recoveryRows({
    workflow: name,
    change,
    steps: result.steps.map((step) => ({
      id: step.id,
      label: workflow.steps.find((item) => item.id === step.id)?.label,
      passed: step.status === "passed",
      reason: clip(step.reason),
      phase: step.phase,
      brokenAttr: result.failure?.stepId === step.id ? result.failure.brokenAttr : undefined,
    })),
    locatorHits: result.locatorHits,
    repairs: result.repairs,
    healedStepIds: result.heals.filter((item) => item.postconditionPassed).map((item) => item.failedStep.id),
    firstLocator: first,
  });
  return rows.map((row, index) => {
    if (result.steps[index]?.status !== "pending") return { ...row, reason: clip(row.reason) };
    return { ...row, na: true, reason: "not reached", brokenAttr: undefined, fixedBy: undefined };
  });
}

async function recordWikipedia(page: Page): Promise<{ workflow: WorkflowV2; trajectory: TrajectoryStep[] }> {
  await page.goto(WIKI, { waitUntil: "domcontentloaded", timeout: 45000 });
  const reveal = await captureSearchReveal(page);
  const driver = new BrowserDriver(page);
  const tree = await driver.tree();
  const input = tree.nodes.find((node) => node.id === "searchInput");
  if (!input) throw new Error("wikipedia searchInput was not in the dump");
  const locators = buildLocators(input, tree.nodes, tree.boxes, tree.nodes.indexOf(input));
  const before = page.url();
  // A click opens Vector's typeahead and the recorded input stops being the field.
  const fillStarted = Date.now();
  await driver.fill(input, "Ada Lovelace");
  const fillMs = Date.now() - fillStarted;
  const keyStarted = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForURL(/Ada_Lovelace/, { timeout: 20000 });
  const keyMs = Date.now() - keyStarted;
  const workflow = finishType(input, locators, "Ada Lovelace", before, page.url(), {
    id: "wf-wikipedia",
    name: "Wikipedia search",
    startUrl: WIKI,
    expect: "Ada_Lovelace",
    expectKind: "url",
    click: false,
  });
  const typed = workflow.steps.find((step) => step.action === "type");
  if (typed && reveal) typed.reveal = reveal;
  return { workflow, trajectory: trajectoryFromWorkflow(workflow, [fillMs, keyMs]) };
}

/** The search toggle Vector shows when #searchInput is a 0×0 box. */
async function captureSearchReveal(page: Page): Promise<WorkflowV2["steps"][number]["reveal"]> {
  const size = page.viewportSize() || { width: 1280, height: 720 };
  await page.setViewportSize({ width: 880, height: 560 });
  await page.waitForTimeout(400);
  const driver = new BrowserDriver(page);
  const tree = await driver.tree();
  const index = tree.nodes.findIndex((node) => node.id === "searchInput");
  let reveal: WorkflowV2["steps"][number]["reveal"];
  if (index >= 0) {
    const found = discoverReveal(tree.nodes, tree.boxes, index, tree.hidden);
    const node = found ? tree.nodes[found.index] : undefined;
    if (node) {
      const locs = buildLocators(node, tree.nodes, tree.boxes, found!.index);
      reveal = locs.find((item) => item.kind === "role") || locs[0];
    }
  }
  await page.setViewportSize(size);
  await page.waitForTimeout(200);
  return reveal;
}

async function recordPython(page: Page): Promise<{ workflow: WorkflowV2; trajectory: TrajectoryStep[] }> {
  await page.goto(PY, { waitUntil: "domcontentloaded", timeout: 45000 });
  const driver = new BrowserDriver(page);
  const tree = await driver.tree();
  const input = tree.nodes.find((node) => node.nameAttr === "q" && /text|input/i.test(node.role));
  if (!input) throw new Error("python search field was not in the dump");
  const locators = buildLocators(input, tree.nodes, tree.boxes, tree.nodes.indexOf(input));
  const before = page.url();
  const clickStarted = Date.now();
  await driver.click(input);
  const clickMs = Date.now() - clickStarted;
  const fillStarted = Date.now();
  await driver.fill(input, "json");
  const fillMs = Date.now() - fillStarted;
  const keyStarted = Date.now();
  await page.keyboard.press("Enter");
  await page.waitForURL(/q=json/, { timeout: 20000 });
  const keyMs = Date.now() - keyStarted;
  const workflow = finishType(input, locators, "json", before, page.url(), {
    id: "wf-python",
    name: "Python docs search",
    startUrl: PY,
    expect: "q=json",
    expectKind: "url",
  });
  return { workflow, trajectory: trajectoryFromWorkflow(workflow, [clickMs, fillMs, keyMs]) };
}

async function recordDynamic(page: Page): Promise<{ workflow: WorkflowV2; trajectory: TrajectoryStep[] }> {
  await page.goto(DYNAMIC, { waitUntil: "domcontentloaded", timeout: 45000 });
  const driver = new BrowserDriver(page);
  const tree = await driver.tree();
  const button = tree.nodes.find((node) => node.role === "button" && (node.text === "Start" || node.name === "Start"));
  if (!button) throw new Error("Start button was not in the dump");
  const locators = buildLocators(button, tree.nodes, tree.boxes, tree.nodes.indexOf(button));
  const event: TrailEvent = {
    id: "e", ts: 1, kind: "act", op: "click", identity: button, locators, afterText: "Hello World!",
  };
  const started = Date.now();
  await driver.click(button);
  await page.getByText("Hello World!").waitFor({ timeout: 15000 });
  const elapsed = Date.now() - started;
  const doc = interpret([event], { id: "wf-dynamic", name: "Dynamic loading", startUrl: DYNAMIC });
  const step = doc.steps[0];
  if (step) {
    step.expect = { kind: "text", match: "Hello World!", timeoutMs: 15000 };
    step.timeoutMs = 15000;
  }
  return { workflow: doc, trajectory: trajectoryFromWorkflow(doc, [elapsed]) };
}

async function recordStaleAdd(page: Page): Promise<WorkflowV2> {
  await page.goto(ADD, { waitUntil: "domcontentloaded", timeout: 45000 });
  const driver = new BrowserDriver(page);
  const tree = await driver.tree();
  const button = tree.nodes.find((node) => node.role === "button" && (node.text === "Add Element" || node.name === "Add Element"));
  if (!button) throw new Error("Add Element was not in the dump");
  const doc = interpret([{
    id: "e", ts: 1, kind: "act", op: "click", identity: button,
    locators: buildLocators(button, tree.nodes, tree.boxes, tree.nodes.indexOf(button)),
  }], { id: "wf-add", name: "Add element", startUrl: ADD });
  const step = doc.steps[0];
  if (!step) throw new Error("no add step");
  step.intent = button.text || button.name || "Add Element";
  step.locators = [{ kind: "role", role: "button", name: "Add Element now" }];
  step.identity = {
    surface: "dom",
    role: "button",
    name: "Add Element now",
    text: "Add Element now",
    path: [],
  };
  step.expect = { kind: "text", match: "Delete", timeoutMs: 8000 };
  return doc;
}

function finishType(
  input: TrailEvent["identity"],
  locators: TrailEvent["locators"],
  value: string,
  before: string,
  after: string,
  meta: { id: string; name: string; startUrl: string; expect: string; expectKind: "url" | "text"; click?: boolean },
): WorkflowV2 {
  const events: TrailEvent[] = [];
  if (meta.click !== false) events.push({ id: "c", ts: 1, kind: "act", op: "click", identity: input, locators });
  events.push(
    { id: "t", ts: events.length + 1, kind: "act", op: "type", value, identity: input, locators },
    { id: "k", ts: events.length + 2, kind: "act", op: "key", key: "Enter", beforeUrl: before, afterUrl: after },
  );
  const doc = interpret(events, { id: meta.id, name: meta.name, startUrl: meta.startUrl });
  for (const step of doc.steps) {
    if (step.action !== "key") {
      step.expect = undefined;
      step.postcondition = undefined;
    }
  }
  const last = doc.steps[doc.steps.length - 1];
  if (last) {
    last.postcondition = undefined;
    last.expect = { kind: meta.expectKind, match: meta.expect, timeoutMs: 15000 };
    last.timeoutMs = 15000;
  }
  return doc;
}

async function applyChange(page: Page, item: CapturedWeb, change: string): Promise<{ ok: boolean; reason: string }> {
  if (change === "resize") {
    await page.setViewportSize({ width: 880, height: 560 });
    return { ok: true, reason: "viewport 880x560" };
  }
  if (change === "move") {
    try {
      const session = await page.context().newCDPSession(page);
      const target = await session.send("Browser.getWindowForTarget");
      await session.send("Browser.setWindowBounds", {
        windowId: target.windowId,
        bounds: { left: 180, top: 96, width: 1400, height: 860, windowState: "normal" },
      });
      // Stay above Vector's 1120px search breakpoint. A narrower viewport hides #searchInput.
      await page.setViewportSize({ width: 1280, height: 720 });
      return { ok: true, reason: "window 180,96 1400x860; viewport 1280x720" };
    } catch (err) {
      return { ok: false, reason: `n/a-harness: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  if (change === "font") {
    await evalRetry(page, () => {
      document.documentElement.classList.add("vector-feature-custom-font-size-clientpref-2");
      const style = document.createElement("style");
      style.setAttribute("data-bao-drift", "font");
      style.textContent = "html, body { font-size: 22px !important; } button, input { font-size: 20px !important; }";
      document.documentElement.appendChild(style);
    });
    return { ok: true, reason: "font 22px" };
  }
  if (change === "theme-dark" || change === "theme-light") {
    const dark = change === "theme-dark";
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light" });
    if (item.theme === "wikipedia") {
      await evalRetry(page, (night) => {
        const html = document.documentElement;
        html.classList.remove("skin-theme-clientpref-day", "skin-theme-clientpref-night", "skin-theme-clientpref-os");
        html.classList.add(night ? "skin-theme-clientpref-night" : "skin-theme-clientpref-day");
      }, dark);
    } else if (item.theme === "python") {
      await evalRetry(page, (night) => {
        const nodes = [...document.querySelectorAll("button, label, span, a, input")];
        const want = night ? "Dark" : "Light";
        const hit = nodes.find((el) => (el.textContent || "").trim() === want);
        if (hit instanceof HTMLElement) hit.click();
      }, dark);
    }
    return { ok: true, reason: dark ? "dark" : "light" };
  }
  if (change === "scale") return { ok: true, reason: "deviceScaleFactor 2" };
  if (change === "slow") return { ok: true, reason: "route delay 300ms" };
  return { ok: true, reason: change };
}

async function throttle(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });
}

function argsOf(workflow: WorkflowV2): Record<string, string> {
  const args: Record<string, string> = {};
  for (const input of workflow.inputs) {
    if (input.type === "secret") continue;
    if (input.default != null) args[input.name] = input.default;
  }
  return args;
}

function failRow(workflow: string, change: string, err: unknown): DriftRow {
  return {
    workflow,
    change,
    stepId: "run",
    passed: false,
    brokenAttr: "run",
    fixedBy: "none",
    reason: clip(err instanceof Error ? err.message : String(err)),
  };
}

function clip(value: string | undefined): string | undefined {
  if (!value) return value;
  const line = value.split("\n")[0] || value;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

async function evalRetry(page: Page, fn: (arg: boolean) => void, arg = false): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await page.evaluate(fn, arg);
      return;
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 3 || !/context was destroyed|Execution context/i.test(message)) throw err;
      await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
    }
  }
  throw last;
}

export function comparisonMarkdown(primary: DriftReport, multi: DriftReport): string {
  const lines = [
    "## Single locator versus multi locator",
    "",
    "Primary replays the first locator only, then the repair tiers. Multi tries role, text, test id, css, xpath, and the anchor before those repairs.",
    "",
    "| workflow | change | primary | multi |",
    "| --- | --- | --- | --- |",
  ];
  const key = (row: DriftRow) => `${row.workflow} ${row.change}`;
  const groups = new Map<string, { primary: DriftRow[]; multi: DriftRow[] }>();
  for (const row of primary.rows) {
    const bucket = groups.get(key(row)) ?? { primary: [], multi: [] };
    bucket.primary.push(row);
    groups.set(key(row), bucket);
  }
  for (const row of multi.rows) {
    const bucket = groups.get(key(row)) ?? { primary: [], multi: [] };
    bucket.multi.push(row);
    groups.set(key(row), bucket);
  }
  for (const [name, bucket] of groups) {
    const [workflow, change] = name.split(" ");
    lines.push(`| ${workflow} | ${change} | ${rate(bucket.primary)} | ${rate(bucket.multi)} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function rate(rows: DriftRow[]): string {
  const scored = rows.filter((row) => !row.na);
  if (!scored.length) return "n/a";
  const passed = scored.filter((row) => row.passed).length;
  return `${passed}/${scored.length}`;
}

export function ensureDesktopSession(): void {
  if (!process.env.DISPLAY) process.env.DISPLAY = ":1";
  if (!process.env.XAUTHORITY) process.env.XAUTHORITY = "/home/ubuntu/.Xauthority";
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS || "";
  if (addr.startsWith("unix:")) return;
  try {
    const machine = readFileSync("/etc/machine-id", "utf8").trim();
    const display = (process.env.DISPLAY || ":1").replace(/^:/, "").split(".")[0] || "0";
    const home = process.env.HOME && !process.env.HOME.startsWith("/tmp/bao-") ? process.env.HOME : "/home/ubuntu";
    const file = path.join(home, ".dbus", "session-bus", `${machine}-${display}`);
    const line = readFileSync(file, "utf8").split("\n").find((row) => row.startsWith("DBUS_SESSION_BUS_ADDRESS="));
    const value = line?.slice("DBUS_SESSION_BUS_ADDRESS=".length).replace(/^'|'$/g, "");
    if (value?.startsWith("unix:")) process.env.DBUS_SESSION_BUS_ADDRESS = value;
  } catch { /* the helper will report the miss */ }
}

export async function runDesktop(mode: LocatorMode, diffs?: TrajectoryDiff[]): Promise<{ rows: DriftRow[]; workflows: WorkflowV2[]; notes: string[] }> {
  ensureDesktopSession();
  const notes: string[] = [];
  const rows: DriftRow[] = [];
  const workflows: WorkflowV2[] = [];
  const bin = process.env.BAO_OS_HELPER || path.join("desktop", "os-helper", "target", "release", "bao-os-helper");
  const screen = displaySize();
  const calc = await driftDesktopApp({
    mode, bin, screen, notes, rows,
    id: "gnome-calculator",
    cmd: ["gnome-calculator"],
    matchApp: (app) => /calc/i.test(app),
    record: recordCalculator,
    diffs,
  }).catch((err: unknown) => {
    rows.push(failRow("gnome-calculator", "record", err));
    return undefined;
  });
  if (calc) workflows.push(calc);
  const edit = await driftDesktopApp({
    mode, bin, screen, notes, rows,
    id: "gedit",
    cmd: ["gedit", "--new-window", emptyNote()],
    matchApp: (app) => /gedit/i.test(app),
    record: recordGedit,
    diffs,
  }).catch((err: unknown) => {
    rows.push(failRow("gedit", "record", err));
    return undefined;
  });
  if (edit) workflows.push(edit);
  return { rows, workflows, notes };
}

function emptyNote(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bao-gedit-"));
  const file = path.join(dir, "note.txt");
  writeFileSync(file, "");
  return file;
}

async function driftDesktopApp(opts: {
  mode: LocatorMode;
  bin: string;
  screen: string;
  notes: string[];
  rows: DriftRow[];
  id: string;
  cmd: string[];
  matchApp: (app: string) => boolean;
  record: (bin: string, screen: string, appNodes: OsNode[]) => Promise<{ workflow: WorkflowV2; trajectory: TrajectoryStep[] }>;
  diffs?: TrajectoryDiff[];
}): Promise<WorkflowV2 | undefined> {
  const home = mkdtempSync(path.join(tmpdir(), `bao-${opts.id}-`));
  const baseEnv = appEnv(home, {});
  stopApp(opts.cmd[0] || opts.id);
  const child = startApp(opts.cmd, baseEnv);
  try {
    const nodes = await waitApp(opts.bin, opts.screen, opts.matchApp);
    await sleep(600);
    const recorded = await opts.record(opts.bin, opts.screen, nodes);
    const workflow = recorded.workflow;
    const driver = () => new AtspiDriver(opts.bin, opts.screen);
    opts.rows.push(...await runWorkflow(opts.id, "baseline", workflow, driver(), opts.mode, (steps) => {
      if (opts.mode === "all" && opts.diffs) {
        opts.diffs.push({ workflow: opts.id, change: "baseline", lines: diffTrajectory(recorded.trajectory, steps) });
      }
    }));
    if (moveWindow(opts.id, 180, 90)) opts.rows.push(...await runWorkflow(opts.id, "move", workflow, driver(), opts.mode));
    else opts.rows.push({ workflow: opts.id, change: "move", stepId: "window", passed: false, na: true, reason: "n/a-harness: window did not move" });
    if (moveWindow(opts.id, 40, 40, 640, 480)) opts.rows.push(...await runWorkflow(opts.id, "resize", workflow, driver(), opts.mode));
    else opts.rows.push({ workflow: opts.id, change: "resize", stepId: "window", passed: false, na: true, reason: "n/a-harness: window did not resize" });
    await relaunch(opts, workflow, { GDK_SCALE: "2" }, "scale");
    await relaunch(opts, workflow, { GTK_THEME: "Adwaita-dark" }, "theme-dark");
    await relaunch(opts, workflow, { GTK_THEME: "Adwaita" }, "theme-light");
    await relaunch(opts, workflow, { GDK_DPI_SCALE: "1.5" }, "font");
    opts.rows.push({ workflow: opts.id, change: "lang", stepId: "lang", passed: false, na: true, reason: "only en_US.utf8 is installed" });
    opts.rows.push({ workflow: opts.id, change: "slow", stepId: "slow", passed: false, na: true, reason: "a desktop app has no page network" });
    return workflow;
  } finally {
    stopApp(opts.cmd[0] || opts.id);
  }
}

async function relaunch(
  opts: { mode: LocatorMode; bin: string; screen: string; rows: DriftRow[]; id: string; cmd: string[]; matchApp: (app: string) => boolean },
  workflow: WorkflowV2,
  extra: Record<string, string>,
  change: string,
): Promise<void> {
  stopApp(opts.cmd[0] || opts.id);
  const home = mkdtempSync(path.join(tmpdir(), `bao-${opts.id}-`));
  let child = startApp(opts.cmd, appEnv(home, extra));
  try {
    try {
      await waitApp(opts.bin, opts.screen, opts.matchApp);
    } catch (err) {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      stopApp(opts.cmd[0] || opts.id);
      child = startApp(opts.cmd, appEnv(home, extra));
      await waitApp(opts.bin, opts.screen, opts.matchApp);
      void err;
    }
    await sleep(400);
    opts.rows.push(...await runWorkflow(opts.id, change, workflow, new AtspiDriver(opts.bin, opts.screen), opts.mode));
  } catch (err) {
    opts.rows.push(failRow(opts.id, change, err));
  } finally {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
}

async function recordCalculator(bin: string, screen: string, nodes: OsNode[]): Promise<{ workflow: WorkflowV2; trajectory: TrajectoryStep[] }> {
  const names = ["7", "+", "5", "="];
  const events: TrailEvent[] = [];
  const timings: number[] = [];
  for (const name of names) {
    const node = nodes.find((item) => item.name === name && /button/i.test(item.role))
      || (await osNodes(bin, screen)).find((item) => item.name === name && /button/i.test(item.role));
    if (!node) {
      const seen = nodes.filter((item) => /button/i.test(item.role)).map((item) => item.name).slice(0, 40);
      throw new Error(`calculator button ${name} missing; saw ${seen.join(", ")}`);
    }
    const identity = fromAtspiNode(node);
    const all = nodes.map((item) => fromAtspiNode(item));
    const boxes = nodes.map((item) => ({ x: item.bbox.x, y: item.bbox.y, w: item.bbox.w, h: item.bbox.h }));
    events.push({
      id: `c${events.length}`,
      ts: events.length + 1,
      kind: "act",
      op: "osClick",
      identity,
      locators: buildLocators(identity, all, boxes, nodes.indexOf(node)),
      provenance: { x: Math.round(node.bbox.x + node.bbox.w / 2), y: Math.round(node.bbox.y + node.bbox.h / 2), space: "screen" },
    });
    const started = Date.now();
    const pressed = await osPress(bin, screen, node.app, node.role, node.name);
    if (!pressed.ok) throw new Error(`calculator press ${name} failed: ${pressed.reason || "not ok"}`);
    await sleep(300);
    timings.push(Date.now() - started);
  }
  const shown = await waitCalcResult(bin, screen);
  if (!shown) {
    const after = (await osNodes(bin, screen)).filter((node) => /calc/i.test(node.app));
    const labels = after.filter((node) => node.role === "label").map((node) => node.name).filter(Boolean);
    throw new Error(`calculator did not show 12; labels ${labels.join(", ")}`);
  }
  const doc = interpret(events, { id: "wf-gnome-calculator", name: "GNOME Calculator", startUrl: "desktop://gnome-calculator" });
  for (const step of doc.steps) {
    if (step.postcondition?.kind === "value") step.postcondition = undefined;
  }
  const last = doc.steps[doc.steps.length - 1];
  if (last) last.expect = { kind: "text", match: "12", timeoutMs: 6000 };
  return { workflow: doc, trajectory: trajectoryFromWorkflow(doc, timings) };
}

async function waitCalcResult(bin: string, screen: string): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    const after = await osNodes(bin, screen);
    if (after.some((node) => /calc/i.test(node.app) && node.name.replace(/\s/g, "") === "12")) return true;
    await sleep(200);
  }
  return false;
}

async function recordGedit(bin: string, screen: string, nodes: OsNode[]): Promise<{ workflow: WorkflowV2; trajectory: TrajectoryStep[] }> {
  const text = nodes.find((node) => node.role === "text" && !node.name);
  if (!text) {
    const seen = nodes.filter((node) => /text/i.test(node.role)).map((node) => `${node.role}:${node.name}`).slice(0, 20);
    throw new Error(`gedit text view missing; saw ${seen.join(", ")}`);
  }
  const identity = fromAtspiNode(text);
  identity.path = identity.path.filter((seg) => !seg.name?.includes("/"));
  const all = nodes.map((node) => fromAtspiNode(node));
  const boxes = nodes.map((node) => ({ x: node.bbox.x, y: node.bbox.y, w: node.bbox.w, h: node.bbox.h }));
  const doc = interpret([{
    id: "t", ts: 1, kind: "act", op: "osSetValue", value: "bao drift", identity,
    locators: buildLocators(identity, all, boxes, nodes.indexOf(text)),
  }], { id: "wf-gedit", name: "gedit", startUrl: "desktop://gedit" });
  const step = doc.steps[0];
  if (step) {
    // interpret's value postcondition reads driver values. The AT-SPI driver
    // does not surface the buffer there. The dirty tab label is the check.
    step.postcondition = undefined;
    step.expect = { kind: "text", match: "*note.txt", timeoutMs: 8000 };
    if (step.identity) step.identity.path = step.identity.path.filter((seg) => !seg.name?.includes("/"));
  }
  return { workflow: doc, trajectory: trajectoryFromWorkflow(doc, [400]) };
}

function appEnv(home: string, extra: Record<string, string>): NodeJS.ProcessEnv {
  mkdirSync(path.join(home, "config"), { recursive: true });
  const xauth = process.env.XAUTHORITY && !process.env.XAUTHORITY.startsWith("/tmp/bao-")
    ? process.env.XAUTHORITY
    : "/home/ubuntu/.Xauthority";
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XAUTHORITY: xauth,
    GTK_A11Y: "atspi",
    ...extra,
  };
}

function startApp(cmd: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(cmd[0]!, cmd.slice(1), { env, detached: true, stdio: "ignore" });
  child.unref();
  return child;
}

function stopApp(bin: string): void {
  const name = path.basename(bin);
  const pattern = name.replace(/^(.)/, "[$1]");
  try { execFileSync("pkill", ["-f", pattern]); } catch { /* not running */ }
}

async function waitApp(bin: string, screen: string, match: (app: string) => boolean): Promise<OsNode[]> {
  let last = "";
  for (let i = 0; i < 60; i++) {
    try {
      const nodes = await osNodes(bin, screen);
      const apps = [...new Set(nodes.map((node) => node.app))];
      last = apps.join(", ");
      const hit = nodes.filter((node) => match(node.app));
      if (hit.length) return hit;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(300);
  }
  throw new Error(`app did not register with AT-SPI (${last})`);
}

function moveWindow(id: string, x: number, y: number, w?: number, h?: number): boolean {
  const title = id === "gnome-calculator" ? "Calculator" : "note.txt";
  let wid = "";
  try {
    wid = execFileSync("xdotool", ["search", "--name", title], { encoding: "utf8" }).trim().split("\n").filter(Boolean).at(-1) || "";
  } catch { /* no window */ }
  if (!wid) return false;
  const before = execFileSync("xdotool", ["getwindowgeometry", wid], { encoding: "utf8" });
  execFileSync("xdotool", ["windowmove", wid, String(x), String(y)]);
  if (w && h) execFileSync("xdotool", ["windowsize", wid, String(w), String(h)]);
  const after = execFileSync("xdotool", ["getwindowgeometry", wid], { encoding: "utf8" });
  return before !== after;
}

function displaySize(): string {
  try {
    const [w, h] = execFileSync("xdotool", ["getdisplaygeometry"], { encoding: "utf8" }).trim().split(/\s+/);
    if (w && h) return `${w}x${h}`;
  } catch { /* fall through */ }
  return "1400x900";
}

export async function runHeal(dir: string, trailPath: string, headed: boolean): Promise<string> {
  const home = mkdtempSync(path.join(tmpdir(), "bao-heal-profile-"));
  const ctx = await launchOwnedChrome({
    userDataDir: home,
    headless: !headed,
    args: headed ? ["--window-position=40,40", "--window-size=1100,760"] : undefined,
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(ADD, { waitUntil: "domcontentloaded", timeout: 45000 });
    const workflow = healWorkflow();
    mkdirSync(dir, { recursive: true });
    const result = await replay(workflow, {}, new BrowserDriver(page), {
      locators: "all",
      heal: cursorHeal(dir),
      settings: { heal: "auto" },
    });
    const heal = result.heals[0];
    appendFileSync(trailPath, JSON.stringify({
      kind: "heal",
      status: result.status,
      model: heal?.model,
      patch: heal?.proposedPatch,
      postconditionPassed: heal?.postconditionPassed,
      repairs: result.repairs,
      reason: result.failure?.reason,
      brokenAttr: result.failure?.brokenAttr,
    }) + "\n");
    if (result.status !== "passed" || !heal?.proposedPatch) {
      return `heal did not pass: ${result.failure?.reason || "no patch"}`;
    }
    let saved = keepPatch(workflow, heal.failedStep.id, heal.proposedPatch);
    let promotion = openProvisional({
      healId: heal.id,
      workflowId: workflow.id,
      stepId: heal.failedStep.id,
      patch: heal.proposedPatch,
      before: heal.failedStep,
    });
    appendFileSync(trailPath, JSON.stringify(promotionEvent(promotion, Date.now())) + "\n");
    const driftOk = await promotionPasses(page, saved);
    promotion = noteDrift(promotion, driftOk);
    appendFileSync(trailPath, JSON.stringify(promotionEvent(promotion, Date.now())) + "\n");
    if (!driftOk) return "heal reverted on drift";
    for (let i = 0; i < 2; i++) {
      await page.goto(ADD, { waitUntil: "domcontentloaded", timeout: 45000 });
      const again = await replay(saved, {}, new BrowserDriver(page), { locators: "all", heal: unavailableHeal() });
      promotion = noteReplay(promotion, again.status === "passed");
      appendFileSync(trailPath, JSON.stringify(promotionEvent(promotion, Date.now())) + "\n");
      if (again.status !== "passed") return "heal reverted on replay";
    }
    saved = keepPatch(saved, heal.failedStep.id, heal.proposedPatch);
    return `promoted ${promotion.status}`;
  } finally {
    await ctx.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
}

function healWorkflow(): WorkflowV2 {
  return {
    schema: "bao.workflow/v2",
    version: 2,
    id: "wf-heal-add",
    name: "Add element heal",
    startUrl: ADD,
    createdAt: Date.now(),
    inputs: [],
    steps: [{
      id: "add",
      index: 0,
      action: "click",
      label: "Submit freeze",
      intent: "Submit freeze",
      surface: "dom",
      timeoutMs: 1000,
      identity: { surface: "dom", role: "button", text: "Submit freeze", testId: "missing-add", path: [] },
      locators: [
        { kind: "role", role: "button", name: "Submit freeze" },
        { kind: "text", value: "Submit freeze" },
        { kind: "testid", value: "missing-add" },
        { kind: "css", value: "#missing-add" },
      ],
      expect: { kind: "text", match: "Delete", timeoutMs: 8000 },
    }],
  };
}

async function promotionPasses(page: Page, workflow: WorkflowV2): Promise<boolean> {
  for (const change of ["theme-dark", "resize"] as const) {
    await page.goto(ADD, { waitUntil: "domcontentloaded", timeout: 45000 });
    if (change === "theme-dark") await page.emulateMedia({ colorScheme: "dark" });
    if (change === "resize") await page.setViewportSize({ width: 900, height: 600 });
    const result = await replay(workflow, {}, new BrowserDriver(page), { locators: "all", heal: unavailableHeal() });
    if (result.status !== "passed") return false;
  }
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const out = process.env.BAO_DRIFT_OUT || path.join("docs");
  mkdirSync(out, { recursive: true });
  const headed = process.env.BAO_HEADED === "1";
  const part = process.env.BAO_REAL_PART || "web";
  const generatedAt = new Date().toISOString();
  if (part === "web" || part === "all") {
    const { captured, stale, errors } = await captureWeb();
    mkdirSync(path.join(out, "workflows"), { recursive: true });
    for (const item of captured) writeFileSync(path.join(out, "workflows", `${item.id}.json`), JSON.stringify(item.workflow, null, 2));
    if (stale) writeFileSync(path.join(out, "workflows", "internet-add.json"), JSON.stringify(stale, null, 2));
    const diffs: TrajectoryDiff[] = [];
    const primaryRows = [...errors, ...await replayWeb(captured, "primary", headed)];
    const multiRows = [...errors, ...await replayWeb(captured, "all", headed, diffs)];
    if (stale) {
      primaryRows.push(...await replayStale(stale, "primary"));
      multiRows.push(...await replayStale(stale, "all"));
    }
    const primary = driftReport(primaryRows, generatedAt);
    const multi = driftReport(multiRows, generatedAt);
    writeFileSync(path.join(out, "drift-real-before.md"), `${driftMarkdown(primary)}\n${WEB_NOTES}`);
    writeFileSync(path.join(out, "drift-real.md"), `${driftMarkdown(multi)}\n${comparisonMarkdown(primary, multi)}\n${trajectoryMarkdown(diffs)}\n${WEB_NOTES}`);
    writeFileSync(path.join(out, "drift-real.json"), JSON.stringify({ primary, multi }, null, 2));
    console.log(comparisonMarkdown(primary, multi));
  }
  if (part === "desktop" || part === "all") {
    const desktopDiffs: TrajectoryDiff[] = [];
    const desktop = await runDesktop("all", desktopDiffs);
    const primary = await runDesktop("primary");
    const report = driftReport(desktop.rows, generatedAt);
    mkdirSync(path.join(out, "workflows"), { recursive: true });
    writeFileSync(path.join(out, "drift-real-desktop.md"), `${driftMarkdown(report)}\n${desktop.notes.join("\n")}\n${comparisonMarkdown(driftReport(primary.rows, generatedAt), report)}\n${trajectoryMarkdown(desktopDiffs)}\n${DESKTOP_NOTES}`);
    writeFileSync(path.join(out, "drift-real-desktop.json"), JSON.stringify({ multi: report, primary: driftReport(primary.rows, generatedAt), notes: desktop.notes }, null, 2));
    for (const workflow of desktop.workflows) {
      writeFileSync(path.join(out, "workflows", `${workflow.id}.json`), JSON.stringify(workflow, null, 2));
    }
  }
  if (part === "heal") {
    const dir = process.env.BAO_HEAL_DIR || path.join(tmpdir(), "bao-heal");
    const trail = path.join(out, "heal-trail.jsonl");
    console.log(await runHeal(dir, trail, headed));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
