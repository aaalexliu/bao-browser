import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { navigationAllowed } from "./allowlist";
import { ALLOW_CLICK_WINDOW_MS, checkboxReach, mayClickAllow } from "./consent";
import { AxUnavailable, checkboxState, chromeHelper, chromeTree, pressAllow } from "./ax";
import { openLiveWindow, type CdpLiveDriver, type PageObservation } from "./driver";
import { readDevToolsActivePort } from "./endpoint";
import { classifyPage } from "../v1/page-class";
import { connectCdp, type CdpSocket } from "./socket";

const PACE_MS = 2500;
const FINAL_HOLD_MS = 8000;
const CLICK_CAP = 6;

export interface SurfaceAsk {
  mode: "read" | "mark";
  index: number;
  label: string;
  stopPath: string;
  deny: string;
  commit: string;
}

export interface SurfaceControl {
  index: number;
  label: string;
  kind: string;
  y: number;
}

export interface Surface {
  ok: boolean;
  reason: string;
  path: string;
  title: string;
  headings: string[];
  controls: SurfaceControl[];
  commit: string[];
  blocked: string;
}

export function publicPath(href: string): string {
  let pathname = "";
  try {
    pathname = new URL(href, "https://example.invalid").pathname;
  } catch {
    return "";
  }
  const parts = pathname.split("/").map((seg) => {
    if (!seg) return seg;
    if (/^\d{3,}$/.test(seg)) return ":id";
    if (/^[0-9a-f]{8}-[0-9a-f-]{13,}$/i.test(seg)) return ":id";
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ":id";
    return seg;
  });
  return parts.join("/") || "/";
}

export function redactText(text: string): string {
  const clean = text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/\b\d{3,}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "";
  if (/^(hi|hello|welcome)\b/i.test(clean)) return "[greeting]";
  if (/@|\bstreet\b|\bavenue\b|\broad\b|\bapt\b|\bssn\b/i.test(clean)) return "";
  return clean.slice(0, 80);
}

export function clickAllowed(label: string, kind: string, denySource: string, commitSource: string): boolean {
  if (kind === "submit" || kind === "radio" || kind === "check" || kind === "other") return false;
  if (kind !== "link" && kind !== "button") return false;
  const text = label.trim();
  if (!text || text.length > 120) return false;
  try {
    if (denySource && new RegExp(denySource, "i").test(text)) return false;
    if (kind === "button" && commitSource && new RegExp(commitSource, "i").test(text)) return false;
  } catch {
    return false;
  }
  return true;
}

/** Lists visible controls in the top document and open shadow roots. Marks one only after the guard passes. */
export function readSurface(ask: SurfaceAsk): Surface {
  const empty: Surface = {
    ok: false, reason: "", path: "", title: "", headings: [], controls: [], commit: [], blocked: "",
  };
  function labelOf(el: Element): string {
    const aria = el.getAttribute("aria-label") || "";
    const text = (el as HTMLElement).innerText || el.textContent || "";
    const value = el instanceof HTMLInputElement ? el.value : "";
    return (aria || text || value).replace(/\s+/g, " ").trim().slice(0, 120);
  }
  function kindOf(el: Element): string {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (type === "password") return "password";
    if (tag === "a" || role === "link") return "link";
    if (type === "submit") return "submit";
    if (type === "radio" || role === "radio") return "radio";
    if (type === "checkbox" || role === "checkbox") return "check";
    if (tag === "button" || type === "button" || role === "button") return "button";
    return "other";
  }
  const seen = new Set<Element>();
  const found: { el: Element; y: number }[] = [];
  let password = false;
  function walk(root: ParentNode): void {
    for (const el of root.querySelectorAll("*")) {
      if (!(el instanceof Element)) continue;
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.hasAttribute("data-bao-pick")) el.removeAttribute("data-bao-pick");
      if (seen.has(el)) continue;
      const kind = kindOf(el);
      if (kind === "password") {
        password = true;
        continue;
      }
      if (kind === "other") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2 || rect.height > 140) continue;
      if (!labelOf(el)) continue;
      seen.add(el);
      found.push({ el, y: rect.top });
    }
  }
  walk(document);
  found.sort((a, b) => a.y - b.y);
  const head = found.filter((item) => item.y < window.innerHeight + 40).slice(0, 40);
  const tail = found.slice(-15);
  const picked: { el: Element; y: number }[] = [];
  const pickSeen = new Set<Element>();
  for (const item of head.concat(tail)) {
    if (pickSeen.has(item.el)) continue;
    pickSeen.add(item.el);
    picked.push(item);
  }
  let deny: RegExp | null = null;
  let commit: RegExp | null = null;
  let stopPath: RegExp | null = null;
  try {
    if (ask.deny) deny = new RegExp(ask.deny, "i");
    if (ask.commit) commit = new RegExp(ask.commit, "i");
    if (ask.stopPath) stopPath = new RegExp(ask.stopPath, "i");
  } catch {
    return { ...empty, reason: "bad-guard" };
  }
  const controls: SurfaceControl[] = picked.map((item, index) => ({
    index,
    label: labelOf(item.el),
    kind: kindOf(item.el),
    y: Math.round(item.y),
  }));
  const commitLabels = controls
    .filter((control) => control.kind !== "link" && !!commit && commit.test(control.label))
    .map((control) => control.label)
    .slice(0, 4);
  let blocked = "";
  if (password) blocked = "login";
  const here = location.pathname || "/";
  if (!blocked && stopPath && stopPath.test(here)) blocked = "stop-path";
  const body = (document.body?.innerText || "").slice(0, 1500).toLowerCase();
  if (!blocked && /request unsuccessful|powered by imperva|incapsula incident/.test(body)) blocked = "bot_wall";
  if (!blocked && /verify you are human|i'm not a robot|recaptcha challenge/.test(body)) blocked = "captcha";
  for (const dialog of document.querySelectorAll("[role=dialog], dialog")) {
    if (blocked) break;
    const text = ((dialog as HTMLElement).innerText || "").slice(0, 400).toLowerCase();
    if (/captcha|verify you are human/.test(text)) blocked = "captcha";
    else if (/password|verification code|one-time|two-factor/.test(text)) blocked = "login";
    else if (deny && deny.test(text) && /trial|upgrade|subscribe|premium|purchase/.test(text)) blocked = "upsell";
  }
  if (ask.mode === "mark") {
    const item = picked[ask.index];
    if (!item || blocked) return { ...empty, reason: blocked || "missing", path: here, blocked };
    const label = labelOf(item.el);
    const kind = kindOf(item.el);
    if (label !== ask.label) return { ...empty, reason: "moved", path: here };
    if (kind !== "link" && kind !== "button") return { ...empty, reason: "refused", path: here };
    if (deny && deny.test(label)) return { ...empty, reason: "refused", path: here };
    if (kind === "button" && commit && commit.test(label)) return { ...empty, reason: "refused", path: here };
    item.el.setAttribute("data-bao-pick", "1");
    (item.el as HTMLElement).scrollIntoView({ block: "center", inline: "center" });
    return { ok: true, reason: "", path: here, title: "", headings: [], controls: [], commit: commitLabels, blocked };
  }
  const headings: string[] = [];
  for (const el of document.querySelectorAll("h1, h2, [role=heading]")) {
    const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    headings.push(text.slice(0, 80));
    if (headings.length >= 4) break;
  }
  return {
    ok: true,
    reason: "",
    path: here,
    title: (document.title || "").slice(0, 80),
    headings,
    controls,
    commit: commitLabels,
    blocked,
  };
}

class NeedsHuman extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "NeedsHuman";
  }
}

interface StepNote {
  name: string;
  path: string;
  label: string;
  ms: number;
}

interface Guard {
  hosts: string[];
  start: string;
  deny: string;
  commit: string;
  stopPath: string;
  reached: string;
  intent: string;
  inbox: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function progress(line: string): void {
  process.stderr.write(`${new Date().toISOString()} ${line}\n`);
}

function arg(name: string, fallback = ""): string {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  return process.argv[index + 1] || "";
}

function parseGuard(root: string): Guard {
  const hosts = arg("--hosts").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean);
  const start = arg("--start");
  const deny = arg("--deny");
  const commit = arg("--commit");
  const stopPath = arg("--stop-path");
  const reached = arg("--reached");
  const intent = arg("--intent");
  const inbox = arg("--inbox", path.join(root, ".evidence", "session-inbox.txt"));
  if (hosts.length === 0 || hosts.some((host) => host.includes("*") || host.includes("/"))) {
    throw new Error("hosts must be exact names");
  }
  if (!start || !navigationAllowed(start, hosts)) throw new Error("start url is not on the host list");
  if (!deny || !commit || !stopPath || !reached || !intent) {
    throw new Error("deny, commit, stop-path, reached, and intent are required");
  }
  new RegExp(deny, "i");
  new RegExp(commit, "i");
  new RegExp(stopPath, "i");
  new RegExp(reached, "i");
  return { hosts, start, deny, commit, stopPath, reached, intent, inbox };
}

function safeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/https?:\/\/\S+/g, "[url]").slice(0, 240);
}

function publishSurface(page: Surface): Surface {
  return {
    ...page,
    path: publicPath(page.path),
    title: redactText(page.title),
    headings: page.headings.map(redactText).filter(Boolean).slice(0, 4),
    controls: page.controls.map((control) => ({ ...control, label: redactText(control.label) })).filter((control) => control.label),
    commit: page.commit.map(redactText).filter(Boolean),
  };
}

function scrollDown(): void {
  window.scrollBy(0, Math.round(window.innerHeight * 0.75));
}

async function wall(driver: CdpLiveDriver, start: string): Promise<string | null> {
  const signals = await driver.pageSignals();
  const decision = classifyPage({
    url: signals.url,
    startedUrl: start,
    hasPassword: signals.hasPassword,
    markers: signals.markers,
    widgets: signals.widgets,
    iframeSrcs: [],
    texts: [],
    cookies: [],
    responses: [],
    closes: [],
  });
  if (decision.class === "bot_wall" || decision.class === "login_wall") return decision.class;
  return null;
}

async function main(): Promise<void> {
  const root = process.cwd();
  const guard = parseGuard(root);
  const evidence = path.join(root, ".evidence");
  const axLog = path.join(evidence, "cdp-live-ax.jsonl");
  const outFile = path.join(evidence, "session-run.json");
  const draftFile = path.join(evidence, "session-workflow.json");
  await mkdir(evidence, { recursive: true });
  await writeFile(guard.inbox, "");

  const helper = chromeHelper();
  progress("helper permissions");
  const perms = await helper.permissions(false);
  if (perms.prompted) throw new Error("helper asked for a permission prompt");
  if (!perms.accessibility) throw new Error("BaoOSHelper accessibility is not granted");
  if (perms.screenCapture) throw new Error("BaoOSHelper screen recording is granted; not starting");
  progress("reading the remote-debugging checkbox");
  const box = await checkboxState(helper);
  if (checkboxReach(box.summary) === "stop") {
    throw new AxUnavailable("BaoOSHelper cannot see a Chrome window", box.summary);
  }
  if (box.on === false) throw new NeedsHuman("remote-debugging-off");
  const dialogPresentBeforeConnect = box.summary.dialog.present || box.summary.dialog.buttonCount > 0;
  if (dialogPresentBeforeConnect) {
    throw new AxUnavailable("Allow dialog was already up; not connecting and not clicking", box.summary);
  }
  progress("reading DevToolsActivePort");
  const endpoint = await readDevToolsActivePort();
  progress(`browser socket on port ${endpoint.port}`);
  const abort = new AbortController();
  const connectionStartedAt = Date.now();
  let opened = false;
  const pending = connectCdp(endpoint.port, endpoint.browserPath, { timeoutMs: 200_000, signal: abort.signal })
    .then((socket) => {
      opened = true;
      return socket;
    });
  pending.catch(() => undefined);
  let last = box.summary;
  let clickedAt: number | undefined;
  let allowWindow = "";
  const deadline = connectionStartedAt + ALLOW_CLICK_WINDOW_MS;
  while (Date.now() < deadline && !opened) {
    progress("reading AX for the Allow dialog");
    const tree = await chromeTree(helper);
    last = tree.summary;
    if (opened) break;
    if (mayClickAllow({
      openedByBao: true,
      connectionStartedAt,
      now: Date.now(),
      dialogPresentBeforeConnect,
      dialog: tree.summary.dialog,
    })) {
      if (opened) break;
      progress("pressing Allow");
      const pressed = await pressAllow(helper, box.pid, axLog);
      clickedAt = pressed.at;
      allowWindow = pressed.window;
      break;
    }
  }
  if (clickedAt == null && !opened) {
    abort.abort();
    await pending.catch(() => undefined);
    throw new AxUnavailable("BaoOSHelper cannot see the Allow remote debugging dialog", last);
  }
  const cdp: CdpSocket = await pending;
  const connectToAllowMs = clickedAt == null ? null : clickedAt - connectionStartedAt;
  progress(`socket open; connect-to-Allow ${connectToAllowMs == null ? "not clicked" : `${connectToAllowMs}ms`}`);

  const steps: StepNote[] = [];
  let clicks = 0;
  let reached = false;
  let confirmLabel = "";
  let confirmClicked = false;
  let code = "";
  let status: "passed" | "needs_human" | "failed" = "failed";
  let observed: PageObservation | undefined;
  let lastSurface: Surface | undefined;
  let rawControls: SurfaceControl[] = [];
  let driver: CdpLiveDriver | undefined;

  const ask = (mode: "read" | "mark", index = -1, label = ""): SurfaceAsk => ({
    mode, index, label, stopPath: guard.stopPath, deny: guard.deny, commit: guard.commit,
  });

  const note = (name: string, started: number, label: string, pagePath: string): void => {
    steps.push({ name, path: publicPath(pagePath), label: redactText(label), ms: Date.now() - started });
  };

  const remember = (page: Surface): Surface => {
    lastSurface = page;
    rawControls = page.controls;
    const screen = [page.title, page.path, ...page.headings].join("\n");
    let onScreen = false;
    try {
      onScreen = new RegExp(guard.reached, "i").test(screen);
    } catch {
      onScreen = false;
    }
    if (page.commit.length && onScreen) {
      reached = true;
      if (!confirmLabel) confirmLabel = page.commit[0] || "";
    }
    return publishSurface(page);
  };

  const read = async (): Promise<Surface> => {
    const page = await driver!.evaluateFunction<Surface>(readSurface, ask("read"));
    const blockedWall = await wall(driver!, guard.start).catch(() => null);
    if (blockedWall && !page.blocked) page.blocked = blockedWall;
    return page;
  };

  const emit = (page: Surface): void => {
    const shown = remember(page);
    process.stdout.write(`${JSON.stringify({
      path: shown.path,
      title: shown.title,
      headings: shown.headings,
      commit: shown.commit,
      blocked: shown.blocked,
      reached,
      controls: shown.controls.map((control) => ({ index: control.index, kind: control.kind, label: control.label, y: control.y })),
    })}\n`);
  };

  const finishHold = async (): Promise<void> => {
    progress(reached ? "holding the stop screen" : "closing");
    await sleep(reached ? FINAL_HOLD_MS : PACE_MS);
  };

  try {
    driver = await openLiveWindow(cdp, guard.hosts);
    const openStarted = Date.now();
    await driver.goto(guard.start, 30_000);
    await driver.show();
    await sleep(PACE_MS);
    const landed = await read();
    note("open", openStarted, "", landed.path);
    emit(landed);
    if (landed.blocked) throw new NeedsHuman(landed.blocked);

    let offset = 0;
    let finished = false;
    while (!finished) {
      const raw = await readFile(guard.inbox, "utf8").catch(() => "");
      const chunk = raw.slice(offset);
      offset = raw.length;
      const lines = chunk.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length === 0) {
        await sleep(300);
        continue;
      }
      for (const line of lines) {
        if (line === "look") {
          const started = Date.now();
          await driver.show();
          const page = await read();
          note("look", started, "", page.path);
          emit(page);
          if (page.blocked) throw new NeedsHuman(page.blocked);
          continue;
        }
        if (line === "scroll") {
          const started = Date.now();
          await driver.show();
          await driver.evaluateFunction(scrollDown, null);
          await sleep(PACE_MS);
          const page = await read();
          note("scroll", started, "", page.path);
          emit(page);
          if (page.blocked) throw new NeedsHuman(page.blocked);
          continue;
        }
        if (line.startsWith("click ")) {
          if (reached) throw new NeedsHuman("commit-visible");
          const index = Number(line.slice(6));
          const control = rawControls.find((item) => item.index === index);
          if (!control || !clickAllowed(control.label, control.kind, guard.deny, guard.commit)) {
            throw new NeedsHuman("refused-click");
          }
          if (clicks >= CLICK_CAP) throw new NeedsHuman("too-many-clicks");
          const started = Date.now();
          await driver.show();
          const marked = await driver.evaluateFunction<Surface>(readSurface, ask("mark", index, control.label));
          if (!marked.ok) throw new NeedsHuman(marked.reason || "refused-click");
          await driver.clickCss("[data-bao-pick]");
          clicks += 1;
          await sleep(PACE_MS);
          const page = await read();
          note("click", started, control.label, page.path);
          emit(page);
          if (page.blocked) throw new NeedsHuman(page.blocked);
          continue;
        }
        if (line === "done") {
          finished = true;
          break;
        }
        progress(`ignored command`);
      }
    }
    observed = await driver.observe();
    status = reached ? "passed" : "needs_human";
    if (!reached) code = "not-reached";
    await finishHold();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof NeedsHuman) {
      code = err.code;
      status = code === "commit-visible" ? "passed" : "needs_human";
      if (code === "commit-visible") reached = true;
    } else if (/allowlist refused/.test(message)) {
      code = /blocked-path/.test(message) ? "blocked-path" : "off-host";
      status = "needs_human";
    } else {
      code = safeError(err);
      status = "failed";
    }
    progress(`stopped ${status} ${code}`);
    if (driver) observed = await driver.observe().catch(() => undefined);
    await finishHold().catch(() => undefined);
  } finally {
    await driver?.end().catch(() => undefined);
  }

  progress("reading the automation banner");
  const during = (await chromeTree(helper)).summary.banner;
  cdp.close();
  await sleep(500);
  const after = (await chromeTree(helper)).summary.banner;
  const trust = (observed?.trust || []).map((event) => ({
    isTrusted: event.isTrusted === true,
    tag: event.tag,
    text: redactText(event.text),
  }));
  const shown = lastSurface ? publishSurface(lastSurface) : undefined;
  const body = {
    status,
    code: code || undefined,
    intent: guard.intent,
    reached,
    path: shown?.path || "",
    title: shown?.title || "",
    headings: shown?.headings || [],
    confirmLabel: redactText(confirmLabel),
    confirmClicked,
    clicks,
    connectToAllowMs,
    allowWindow,
    webdriver: observed ? observed.webdriver : null,
    host: guard.hosts.includes(observed?.host || "") ? observed?.host || "" : "",
    trusted: trust.length ? trust.every((event) => event.isTrusted) : null,
    trust,
    steps,
    botWall: code === "bot_wall",
    banner: { during: during.visible, afterClose: after.visible },
    checkboxOn: box.on,
    screenCapture: false,
  };
  const draft = {
    driver: "cdp-live",
    intent: guard.intent,
    hosts: guard.hosts,
    steps: steps.map((step) => ({ action: step.name, path: step.path, label: step.label })),
    confirmLabel: body.confirmLabel,
    confirmClicked: false,
  };
  await writeFile(outFile, `${JSON.stringify(body, null, 2)}\n`);
  await writeFile(draftFile, `${JSON.stringify(draft, null, 2)}\n`);
  progress(`wrote ${path.basename(outFile)}`);
  process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  if (status !== "passed") process.exitCode = 2;
}

if (require.main === module) {
  main().catch((err) => {
    const summary = err instanceof AxUnavailable ? err.summary : undefined;
    process.stderr.write(`${safeError(err)}\n`);
    if (summary) process.stderr.write(`${JSON.stringify(summary)}\n`);
    process.exit(1);
  });
}
