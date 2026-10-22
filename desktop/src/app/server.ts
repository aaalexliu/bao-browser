// Local app. The UI, the library, and replay all stay on disk.
// Nothing is recorded unless a session was started.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as esbuild from "esbuild";
import type { BrowserContext, Page } from "playwright";
import { launchAccountChrome, launchOwnedChrome, pidsForDataDir } from "../launch";
import { BrowserDriver, notifyOs, type PersonPrompts } from "../v1/browser-driver";
import type { HumanAsk } from "../v1/human-ask";
import { ensureTrailTimes } from "../v1/trail-time";
import { maskPasswordFields, unmaskPasswordFields } from "../v1/dom-page";
import {
  cookieHeader,
  loginDocument,
  loginRedirect,
  newToken,
  PENDING_COOKIE,
  readCookie,
  safeNext,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionExpiry,
  sessionStatus,
  type FreezeSession,
} from "../v1/freeze-session";
import { recorderSource } from "../v1/recorder";
import {
  auditLine,
  chooseProfile,
  chromeUserDataDir,
  assertDomain,
  importConfirmText,
  injectCookies,
  loadChromeSiteCookies,
  readChromeSafeStoragePassword,
  readProfileNames,
  safeImportError,
  type ChromeProfile,
  type ImportAudit,
} from "../v1/chrome-login";
import { boundsApplied, moveOwnedWindow, readOwnedWindow, type WindowBounds } from "../v1/window-bounds";
import { bundledHelperApp, MacOsHelper } from "../proxy/os-macos";
import { cursorHeal, cursorSessionHeal, effectiveMode, keepPatch, llmHealFromEnv, maskText, revertPatch, scriptedHeal, unavailableHeal, type HealProposal, type HealProvider, type HealRecord } from "../v1/heal";
import { interpret, type TrailEvent } from "../v1/interpret";
import { noteDrift, noteReplay, openProvisional, promotionEvent, type Promotion } from "../v1/promote";
import { ReceiptLog } from "../v1/receipt";
import { replay, type HealNotice, type ReplayOptions } from "../v1/replay";
import { Library } from "../v1/store";
import type { HealMode, ReplayArgs, WorkflowStep, WorkflowV2 } from "../v1/schema";

export interface Notice extends HealNotice {
  id: string;
  at: number;
}

export interface App {
  library: Library;
  port: number;
  notices: Notice[];
  notifications: { title: string; body: string }[];
  recording: boolean;
  close(): Promise<void>;
}

const publicDir = process.env.BAO_PUBLIC || path.join(process.cwd(), "desktop/src/app/public");

export async function startApp(opts: { home: string; port?: number }): Promise<App> {
  const library = new Library(opts.home);
  const notices: Notice[] = [];
  let boundPort = opts.port ?? 0;
  let recording = false;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let profile: string | undefined;
  const events: TrailEvent[] = [];
  const replays = new Map<string, { context: BrowserContext; page: Page; profile: string }>();
  let pending: PendingImport | undefined;
  let importing = false;
  let loginWait: { message: string; detail?: string } | null = null;
  let humanConfirm: { message: string; detail?: string } | null = null;
  let activeAsk: HumanAsk | null = null;
  let stopRun = false;
  let loginContinued = false;
  let capturePaused = false;
  let recordingSince = 0;
  const notifications: { title: string; body: string }[] = [];
  let site: { context: BrowserContext; page: Page; profile: string } | undefined;
  const note = (title: string, body: string) => {
    notifications.push({ title, body });
    void notifyOs(title, body);
  };
  const prompts: PersonPrompts = {
    showConfirm(_label) {
      humanConfirm = { message: "confirm before applying", detail: "Press Apply on the site window." };
    },
    clearConfirm() {
      humanConfirm = null;
      if (activeAsk?.kind === "confirm") activeAsk = null;
    },
    showLoginWait(label) {
      const detail = label && label.length <= 120 ? label : "Sign in on the site window";
      loginWait = { message: "waiting for you to log in", detail };
    },
    clearLoginWait() {
      loginWait = null;
      loginContinued = false;
      if (activeAsk?.kind === "login") activeAsk = null;
    },
    showAsk(ask) {
      activeAsk = ask;
      note("You need to act", ask.instruction);
    },
    shouldStop: () => stopRun,
    loginContinued: () => loginContinued,
  };
  const sessions = new Map<string, FreezeSession>();
  const pendings = new Map<string, { user: string; exp: number }>();
  let applyClicks = 0;
  let helperReport: unknown;
  if (process.platform === "darwin" && bundledHelperApp()) {
    helperReport = await new MacOsHelper(bundledHelperApp()!).permissions(false).catch((err) => ({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }));
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return sendFile(res, path.join(publicDir, "index.html"), "text/html");
      }
      if (req.method === "GET" && url.pathname === "/app.js") {
        const js = await browserScript();
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end(js);
        return;
      }
      if (req.method === "GET" && (url.pathname === "/fixture" || url.pathname === "/secure")) {
        return sendFile(res, path.join(publicDir, "fixture.html"), "text/html");
      }
      if (req.method === "GET" && url.pathname === "/login") {
        const verify = url.searchParams.get("verify") === "1";
        const html = loginDocument(readFileSync(path.join(publicDir, "login.html"), "utf8"), verify);
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html);
        return;
      }
      if (req.method === "POST" && url.pathname === "/login") {
        return answerLogin(req, res);
      }
      if (req.method === "POST" && url.pathname === "/freeze/applied") {
        applyClicks += 1;
        return json(res, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/api/fixture/apply-count") {
        return json(res, { count: applyClicks });
      }
      if (req.method === "GET" && url.pathname === "/freeze") {
        const token = readCookie(req.headers.cookie, SESSION_COOKIE);
        const status = sessionStatus(token, sessions, Date.now());
        if (status !== "ok") {
          const next = `${url.pathname}${url.search}`;
          const dest = loginRedirect(next, url.searchParams.get("verify") === "1");
          res.writeHead(302, { location: dest, "cache-control": "no-store" });
          res.end();
          return;
        }
        return sendFile(res, path.join(publicDir, "freeze.html"), "text/html");
      }
      if (req.method === "GET" && url.pathname === "/api/state") {
        return json(res, {
          recording,
          notices,
          settings: library.settings(),
          workflows: library.list().map(summary),
          trails: library.listTrails(),
          runs: library.listRuns().map(slimRun),
          helper: helperStatus(helperReport),
          helperApp: bundledHelperApp() || null,
          model: modelStatus(),
          pendingImport: pending ? publicPending(pending) : null,
          loginWait,
          humanConfirm,
          activeAsk,
          capturePaused,
          recordingSince: recording ? recordingSince : 0,
          liveTrail: events.slice(-40).map((event) => ({ id: event.id, ts: event.ts, op: event.op, kind: event.kind })),
          notifications,
          promotions: library.list().map((workflow) => library.readPromotion(workflow.id)).filter(Boolean),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/import-login") {
        if (!pending || pending.id !== url.searchParams.get("id")) return json(res, { error: "no import" }, 404);
        return json(res, publicPending(pending));
      }
      if (req.method === "POST" && url.pathname === "/api/import-login") {
        const body = await readBody(req) as { from?: string; domain?: string; profile?: string };
        if (body.from !== "chrome") return json(res, { error: "only chrome is supported" }, 400);
        let domain = "";
        try { domain = assertDomain(body.domain || ""); }
        catch (err) { return json(res, { error: safeImportError(err) }, 400); }
        if (pending && (pending.phase === "confirm" || pending.phase === "pick" || pending.phase === "running")) {
          return json(res, publicPending(pending));
        }
        pending = {
          id: `imp-${Date.now()}`,
          domain,
          profile: body.profile,
          phase: "confirm",
          message: importConfirmText(domain),
        };
        return json(res, publicPending(pending));
      }
      if (req.method === "POST" && url.pathname === "/api/import-login/answer") {
        const body = await readBody(req) as { id?: string; accept?: boolean; profile?: string };
        if (!pending || body.id !== pending.id) return json(res, { error: "no import" }, 404);
        if (body.accept === false) {
          pending.phase = "cancelled";
          return json(res, publicPending(pending));
        }
        if (pending.phase !== "confirm" && pending.phase !== "pick") return json(res, publicPending(pending));
        if (pending.phase === "pick" && !body.profile) return json(res, { error: "pick a profile" }, 400);
        if (body.profile) pending.profile = body.profile;
        void settleImport();
        return json(res, publicPending(pending));
      }
      if (req.method === "POST" && url.pathname === "/api/prompt") {
        const body = await readBody(req) as { kind?: string; detail?: string };
        if (body.kind === "login") {
          const detail = typeof body.detail === "string" ? body.detail.replace(/\s+/g, " ").trim() : "";
          if (detail && (detail.length > 120 || looksPersonal(detail))) return json(res, { error: "detail" }, 400);
          loginWait = { message: "waiting for you to log in", ...(detail ? { detail } : {}) };
        }
        else if (body.kind === "confirm") {
          humanConfirm = { message: "confirm before applying", detail: body.detail || "Press Apply on the site window." };
        }
        else { loginWait = null; humanConfirm = null; }
        return json(res, { loginWait, humanConfirm });
      }
      if (req.method === "GET" && url.pathname === "/api/site") {
        if (!site || site.page.isClosed()) return json(res, { open: false });
        return json(res, { open: true, ...(await siteSignals(site.page)) });
      }
      if (req.method === "POST" && url.pathname === "/api/site/open") {
        const body = await readBody(req) as { url?: string };
        const page = await sitePage();
        if (body.url) await page.goto(body.url, { waitUntil: "domcontentloaded" });
        await moveOwnedWindow(page, { x: 80, y: 60, width: 1100, height: 780 }).catch(() => undefined);
        return json(res, { open: true, ...(await siteSignals(page)) });
      }
      if (req.method === "POST" && url.pathname === "/api/site/query") {
        const body = await readBody(req) as { names?: string[] };
        const names = (body.names || []).filter((name) => typeof name === "string" && name.trim() && name.length <= 40).slice(0, 8);
        const page = await sitePage();
        const controls = await namedControls(page, names);
        return json(res, { controls });
      }
      if (req.method === "POST" && url.pathname === "/api/site/click") {
        const body = await readBody(req) as { name?: string };
        const name = (body.name || "").trim();
        if (!["open", "frozen"].includes(name.toLowerCase())) return json(res, { error: "that control is not a selectable state" }, 400);
        const page = await sitePage();
        try {
          await page.getByText(name, { exact: true }).first().click();
        } catch {
          return json(res, { error: "could not select that state" }, 409);
        }
        return json(res, { selected: name });
      }
      if (req.method === "POST" && url.pathname === "/api/site/text") {
        const body = await readBody(req) as { phrases?: string[] };
        const phrases = (body.phrases || []).filter((phrase) => typeof phrase === "string" && phrase.length <= 40).slice(0, 6);
        const page = await sitePage();
        const texts = (await shortTexts(page, phrases)).filter((text) => !looksPersonal(text));
        return json(res, { texts });
      }
      if (req.method === "POST" && url.pathname === "/api/site/shot") {
        const body = await readBody(req) as { phrase?: string; file?: string };
        const phrase = (body.phrase || "").trim();
        if (!phrase || phrase.length > 80 || looksPersonal(phrase)) return json(res, { error: "phrase" }, 400);
        const base = path.basename(body.file || "status-card.png");
        if (!/^[\w.-]+$/.test(base)) return json(res, { error: "file" }, 400);
        const page = await sitePage();
        const box = await clipForPhrase(page, phrase);
        if (!box) return json(res, { error: "status card was not found" }, 404);
        const shots = path.join(opts.home, "shots");
        mkdirSync(shots, { recursive: true });
        const dest = path.join(shots, base);
        await page.screenshot({ path: dest, clip: box });
        return json(res, { file: base });
      }
      if (req.method === "GET" && url.pathname === "/api/pids") {
        const product = pidsForDataDir(path.join(opts.home, "ui-profile"))[0] ?? null;
        const capture = profile ? pidsForDataDir(profile)[0] ?? null : null;
        const replay: Record<string, number> = {};
        for (const [id, session] of replays) {
          const pid = pidsForDataDir(session.profile)[0];
          if (pid) replay[id] = pid;
        }
        return json(res, { helper: bundledHelperApp() || null, helperReport, product, capture, replay });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/workflows/")) {
        return json(res, library.read(decodeURIComponent(url.pathname.split("/")[3] || "")));
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/video")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const run = library.readRun(id);
        const file = path.join(library.root, "videos", `${run.id}.webm`);
        if (!existsSync(file)) return json(res, { error: "no video" }, 404);
        res.writeHead(200, { "content-type": "video/webm" });
        res.end(readFileSync(file));
        return;
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) {
        return json(res, library.readRun(decodeURIComponent(url.pathname.split("/")[3] || "")));
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/trails/")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const raw = library.readTrail(id);
        const events = Array.isArray(raw) ? raw as { ts?: number }[] : [];
        const timed = ensureTrailTimes(events);
        if (timed.filled) library.saveTrail(id, timed.events);
        return json(res, timed.events);
      }
      if (req.method === "PUT" && url.pathname === "/api/settings") {
        const body = await readBody(req) as { heal?: HealMode };
        if (body.heal !== "auto" && body.heal !== "approve") return json(res, { error: "heal" }, 400);
        return json(res, library.setHeal(body.heal));
      }
      if (req.method === "POST" && url.pathname === "/api/workflows/import") {
        return json(res, library.importJson(String(await readBody(req, true))));
      }
      if (req.method === "POST" && url.pathname === "/api/sessions") {
        const body = await readBody(req) as { url?: string };
        await stopBrowser();
        recording = true;
        recordingSince = Date.now();
        events.length = 0;
        profile = await mkdtemp(path.join(tmpdir(), "bao-profile-"));
        context = await launchOwnedChrome({ userDataDir: profile, headless: process.env.BAO_HEADED !== "1" });
        capturePaused = false;
        await context.exposeBinding("__baoRecord", async (_source, payload: TrailEvent) => {
          if (!recording || capturePaused) return;
          events.push({ ...payload, id: `evt-${events.length}`, ts: Date.now() });
        });
        await context.addInitScript(recorderSource());
        page = context.pages()[0] || await context.newPage();
        await page.goto(body.url || `http://127.0.0.1:${boundPort}/fixture`);
        return json(res, { recording: true });
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "POST" && url.pathname === "/api/sessions/drive") {
        if (!page) return json(res, { error: "no session" }, 409);
        const body = await readBody(req) as {
          fill?: { selector: string; value: string };
          click?: string;
          upload?: { selector: string; path: string };
          drop?: { selector: string; name: string; path: string };
        };
        if (body.fill) await page.fill(body.fill.selector, body.fill.value);
        if (body.click) await page.click(body.click);
        if (body.upload) await page.setInputFiles(body.upload.selector, body.upload.path);
        if (body.drop) {
          const b64 = readFileSync(body.drop.path).toString("base64");
          await page.evaluate(({ selector, name, b64 }) => {
            const el = document.querySelector(selector);
            if (!el) throw new Error("missing drop target");
            const bin = atob(b64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], name));
            for (const type of ["dragenter", "dragover", "drop"]) {
              el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
            }
          }, { selector: body.drop.selector, name: body.drop.name, b64 });
        }
        await page.waitForTimeout(50);
        return json(res, { events: events.length });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/stop") {
        recording = false;
        recordingSince = 0;
        const id = `wf-${Date.now()}`;
        const startUrl = page ? page.url() : "";
        const clean = events.map((event) => {
          if (!event.sensitive && event.identity?.role !== "password") return event;
          const copy = { ...event, sensitive: true };
          delete copy.value;
          return copy;
        });
        const workflow = interpret(clean, { id, name: "Captured workflow", startUrl, secrets: [] });
        library.save(workflow);
        library.saveTrail(id, ensureTrailTimes(clean).events);
        capturePaused = false;
        await stopBrowser();
        return json(res, workflow);
      }
      if (req.method === "POST" && url.pathname === "/api/replay") {
        const body = await readBody(req) as { id: string; args: ReplayArgs; heal?: HealMode };
        const saved = library.read(body.id);
        const workflow: WorkflowV2 = body.heal ? { ...saved, heal: body.heal } : saved;
        const args = await materializeFiles(body.args || {});
        stopRun = false;
        loginContinued = false;
        const run = await runWorkflow(library, workflow, args, notices, replays, prompts);
        return json(res, run);
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "GET" && url.pathname === "/api/replay/page") {
        const session = replays.get(url.searchParams.get("id") || "");
        if (!session || session.page.isClosed()) return json(res, { open: false }, 404);
        const current = new URL(session.page.url());
        const hasPassword = await session.page.locator("input[type=password]:visible").count().then((count) => count > 0).catch(() => false);
        const status = await session.page.locator("#status").innerText().catch(() => "");
        return json(res, { open: true, pathname: current.pathname, hasPassword, status });
      }
      if (req.method === "POST" && url.pathname === "/api/prompt/continue") {
        loginContinued = true;
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/replay/cancel") {
        stopRun = true;
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/replay/show") {
        const session = [...replays.values()].find((item) => !item.page.isClosed());
        if (session) await session.page.bringToFront().catch(() => undefined);
        return json(res, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/pause") {
        capturePaused = !capturePaused;
        return json(res, { paused: capturePaused, recording });
      }
      if (req.method === "POST" && url.pathname === "/api/sessions/mark") {
        events.push({ id: `evt-${events.length}`, ts: Date.now(), kind: "act", op: "mark" });
        return json(res, { events: events.length });
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "POST" && url.pathname === "/api/replay/press") {
        const body = await readBody(req) as { name?: string; fill?: { selector: string; value: string } };
        const session = [...replays.values()].find((item) => !item.page.isClosed());
        if (!session) return json(res, { error: "replay window is not open" }, 409);
        if (body.fill) await session.page.fill(body.fill.selector, body.fill.value);
        if (body.name) await session.page.getByRole("button", { name: body.name, exact: true }).click();
        return json(res, { ok: true });
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "POST" && url.pathname === "/api/replay/drive") {
        const body = await readBody(req) as { id?: string; fill?: { selector?: string; value?: string }; click?: string };
        const session = replays.get(body.id || "");
        if (!session || session.page.isClosed()) return json(res, { error: "replay window is not open" }, 409);
        const fill = body.fill;
        if (fill) {
          if (!fill.selector || !/^#[A-Za-z][\w-]*$/.test(fill.selector)) return json(res, { error: "selector" }, 400);
          await session.page.locator(fill.selector).fill(fill.value ?? "");
        }
        if (body.click) {
          if (!/^#[A-Za-z][\w-]*$/.test(body.click)) return json(res, { error: "selector" }, 400);
          await session.page.locator(body.click).click();
        }
        return json(res, { ok: true });
      }
      if (process.env.BAO_DRIVE === "1" && req.method === "POST" && url.pathname === "/api/replay/shot") {
        const body = await readBody(req) as { id?: string; file?: string };
        const session = replays.get(body.id || "");
        if (!session || session.page.isClosed()) return json(res, { error: "replay window is not open" }, 409);
        const base = path.basename(body.file || "replay.png");
        if (!/^[\w.-]+$/.test(base)) return json(res, { error: "file" }, 400);
        const shots = path.join(opts.home, "shots");
        mkdirSync(shots, { recursive: true });
        await session.page.evaluate(maskPasswordFields);
        try {
          await session.page.screenshot({ path: path.join(shots, base), type: "png" });
        } finally {
          await session.page.evaluate(unmaskPasswordFields).catch(() => undefined);
        }
        return json(res, { file: base });
      }
      if (req.method === "POST" && url.pathname === "/api/replay/place") {
        const body = await readBody(req) as { id?: string; x?: number; y?: number; width?: number; height?: number };
        const id = body.id || "";
        const session = replays.get(id);
        if (!session || session.page.isClosed()) return json(res, { error: "replay window is not open" }, 409);
        const want: WindowBounds = { x: Number(body.x), y: Number(body.y), width: Number(body.width), height: Number(body.height) };
        const placed = await placeReplayWindow(session.page, session.profile, want);
        if (placed.applied && placed.after) library.writeBounds(id, placed.after);
        return json(res, placed);
      }
      if (req.method === "POST" && url.pathname === "/api/promotions/check") {
        const body = await readBody(req) as { id?: string };
        const checked = await checkPromotion(library, body.id || "", notices);
        return json(res, checked);
      }
      if (req.method === "POST" && url.pathname === "/api/heal/keep") {
        const body = await readBody(req) as { id: string; stepId: string; patch: HealProposal["patch"]; runId?: string; healId?: string };
        const next = keepPatch(library.read(body.id), body.stepId, body.patch);
        library.save(next);
        if (body.runId && body.healId) {
          library.appendDecision(body.runId, { ts: Date.now(), healId: body.healId, decision: "keep" });
        }
        return json(res, next);
      }
      if (req.method === "POST" && url.pathname === "/api/heal/revert") {
        const body = await readBody(req) as { id: string; runId: string; healId: string };
        const run = library.readRun(body.runId);
        const heal = (run.heals as HealRecord[]).find((item) => item.id === body.healId);
        if (!heal) return json(res, { error: "no heal" }, 404);
        const next = revertPatch(library.read(body.id), heal.failedStep);
        library.save(next);
        const recorded = library.appendDecision(body.runId, { ts: Date.now(), healId: body.healId, decision: "revert" });
        return json(res, { workflow: next, decisions: recorded.decisions, heals: recorded.heals });
      }
      if (req.method === "PATCH" && url.pathname.startsWith("/api/workflows/")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const body = await readBody(req) as { name?: string; workflow?: WorkflowV2; heal?: HealMode | null };
        if (body.workflow) {
          library.save({ ...body.workflow, id, updatedAt: Date.now() });
          return json(res, library.read(id));
        }
        if (body.heal === "auto" || body.heal === "approve" || body.heal === null) {
          const doc = library.read(id);
          const next: WorkflowV2 = { ...doc, updatedAt: Date.now() };
          if (body.heal) next.heal = body.heal;
          else delete next.heal;
          library.save(next);
          return json(res, next);
        }
        return json(res, library.rename(id, body.name || library.read(id).name));
      }
      if (req.method === "DELETE" && url.pathname.startsWith("/api/workflows/")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const body = await readBody(req) as { confirm?: boolean };
        if (!body.confirm) return json(res, { error: "confirm required" }, 400);
        library.remove(id);
        return json(res, { ok: true });
      }
      json(res, { error: "not found" }, 404);
    } catch (err) {
      json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  boundPort = port;
  writeFileSync(path.join(opts.home, "server.json"), JSON.stringify({ port }));

  async function stopBrowser(): Promise<void> {
    recording = false;
    await context?.close().catch(() => undefined);
    context = undefined;
    page = undefined;
    if (profile) await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    profile = undefined;
  }

  async function sitePage(): Promise<Page> {
    if (site && !site.page.isClosed()) return site.page;
    const profile = path.join(opts.home, "site-profile");
    mkdirSync(profile, { recursive: true });
    const context = await launchAccountChrome({
      userDataDir: profile,
      headless: process.env.BAO_HEADED !== "1",
    });
    const page = context.pages()[0] || await context.newPage();
    site = { context, page, profile };
    return page;
  }

  async function settleImport(): Promise<void> {
    if (!pending || importing) return;
    if (pending.phase === "done" || pending.phase === "cancelled" || pending.phase === "error") return;
    importing = true;
    try {
      const userData = chromeUserDataDir();
      if (!existsSync(path.join(userData, "Local State"))) throw new Error("Chrome was not found");
      const profiles = readProfileNames(path.join(userData, "Local State"));
      const choice = chooseProfile(profiles, pending.profile);
      if (!choice.ok) {
        if (choice.reason === "none") throw new Error("Chrome has no profiles");
        pending.profile = undefined;
        pending.profiles = profiles;
        pending.phase = "pick";
        return;
      }
      pending.phase = "running";
      const password = readChromeSafeStoragePassword();
      const loaded = await loadChromeSiteCookies({
        userDataDir: userData,
        profileDir: choice.profile.directory,
        domain: pending.domain,
        password,
      });
      let count = loaded.cookies.length;
      const page = await sitePage();
      try {
        count = await injectCookies(page, loaded.cookies);
      } finally {
        for (const cookie of loaded.cookies) cookie.value = "";
      }
      const audit = { ...loaded.audit, count };
      writeImportAudit(opts.home, audit);
      pending.audit = audit;
      pending.phase = "done";
      pending.profiles = undefined;
    } catch (err) {
      if (pending) {
        const profile = pending.profile;
        pending.phase = "error";
        pending.error = safeImportError(err, profile);
        const audit = { domain: pending.domain, count: 0, at: Date.now(), reason: pending.error, profile };
        writeImportAudit(opts.home, audit);
        pending.audit = audit;
      }
    } finally {
      importing = false;
    }
  }

  async function answerLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req) as {
      username?: string;
      password?: string;
      code?: string;
      next?: string;
      verify?: boolean;
      ttlMs?: number;
    };
    const next = safeNext(typeof body.next === "string" ? body.next : undefined);
    const now = Date.now();
    const pendingToken = readCookie(req.headers.cookie, PENDING_COOKIE);
    const pending = pendingToken ? pendings.get(pendingToken) : undefined;
    if (typeof body.code === "string") {
      if (!pending || pending.exp <= now || !body.code.trim()) return json(res, { error: "code" }, 401);
      pendings.delete(pendingToken || "");
      const session = issueSession(pending.user, now, typeof body.ttlMs === "number" ? body.ttlMs : SESSION_TTL_MS);
      writeLogin(res, { ok: true, next }, [
        cookieHeader(SESSION_COOKIE, session.token, Math.max(0, Math.ceil((session.exp - now) / 1000))),
        cookieHeader(PENDING_COOKIE, "", 0),
      ]);
      return;
    }
    const username = typeof body.username === "string" ? body.username.trim().slice(0, 80) : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username) return json(res, { error: "username" }, 400);
    if (!password) return json(res, { error: "password" }, 400);
    if (body.verify === true) {
      const token = newToken();
      pendings.set(token, { user: username, exp: now + 5 * 60 * 1000 });
      writeLogin(res, { ok: false, stage: "code" }, [cookieHeader(PENDING_COOKIE, token, 300)]);
      return;
    }
    const session = issueSession(username, now, typeof body.ttlMs === "number" ? body.ttlMs : SESSION_TTL_MS);
    const maxAge = session.exp <= now ? 0 : Math.ceil((session.exp - now) / 1000);
    writeLogin(res, { ok: true, next }, [cookieHeader(SESSION_COOKIE, session.token, maxAge)]);
  }

  function issueSession(user: string, now: number, ttlMs: number): FreezeSession {
    const token = newToken();
    const session = { token, user, exp: sessionExpiry(now, ttlMs) };
    sessions.set(token, session);
    return session;
  }

  return {
    library,
    port,
    notices,
    notifications,
    get recording() { return recording; },
    async close() {
      await stopBrowser();
      await site?.context.close().catch(() => undefined);
      site = undefined;
      for (const session of replays.values()) {
        await session.context.close().catch(() => undefined);
        await rm(session.profile, { recursive: true, force: true }).catch(() => undefined);
      }
      replays.clear();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}

async function runWorkflow(
  library: Library,
  workflow: WorkflowV2,
  args: ReplayArgs,
  notices: Notice[],
  replays: Map<string, { context: BrowserContext; page: Page; profile: string }>,
  prompts?: PersonPrompts,
) {
  const session = await openReplay(library, workflow.id, replays);
  const page = session.page;
  if (workflow.startUrl.startsWith("http")) await page.goto(workflow.startUrl);
  const driver = new BrowserDriver(page, (notice) => {
    notices.unshift({ ...notice, id: `n-${notices.length + 1}`, at: Date.now() });
  }, prompts);
  const heal = healProvider();
  const receiptLog = new ReceiptLog(path.join(library.root, "trails", `${workflow.id}.receipts.jsonl`));
  const result = await replay(workflow, args, driver, {
    settings: library.settings(),
    heal,
    now: () => Date.now(),
    receipts: receiptLog,
  } satisfies ReplayOptions);
  for (const repair of result.repairs) {
    library.appendTrail(workflow.id, { kind: "repair", ts: Date.now(), ...repair });
  }
  for (const receipt of result.receipts) {
    library.appendTrail(workflow.id, receipt);
  }
  const promotion = recordProvisional(library, workflow, result.heals);
  const secretList = workflow.inputs.flatMap((input) => {
    if (input.type !== "secret") return [];
    const value = args[input.name];
    return typeof value === "string" && value ? [value] : [];
  });
  const saved = JSON.parse(maskText(JSON.stringify({
    id: result.runId,
    workflowId: workflow.id,
    status: result.status,
    at: Date.now(),
    heals: result.heals,
    failure: result.failure,
    steps: result.steps,
    repairs: result.repairs,
    receipts: result.receipts,
    trail: result.trail,
    precondition: result.precondition,
    trajectory: result.trajectory,
    promotion,
    modelCalls: result.modelCalls,
    inputs: maskedInputs(workflow, args),
  }), secretList)) as Parameters<Library["saveRun"]>[0];
  library.saveRun(saved);
  const hold = Number(process.env.BAO_REPLAY_HOLD_MS || 0);
  if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
  const bounds = await readOwnedWindow(page).catch(() => null);
  if (bounds) library.writeBounds(workflow.id, bounds);
  return { ...result, promotion, mode: effectiveMode(workflow, library.settings()), fileProof: driver.proofs, bounds };
}

async function openReplay(
  library: Library,
  id: string,
  replays: Map<string, { context: BrowserContext; page: Page; profile: string }>,
): Promise<{ context: BrowserContext; page: Page; profile: string }> {
  const existing = replays.get(id);
  if (existing && !existing.page.isClosed()) return existing;
  if (existing) {
    await existing.context.close().catch(() => undefined);
    await rm(existing.profile, { recursive: true, force: true }).catch(() => undefined);
    replays.delete(id);
  }
  const profile = await mkdtemp(path.join(tmpdir(), "bao-replay-"));
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: process.env.BAO_HEADED !== "1",
  });
  const page = context.pages()[0] || await context.newPage();
  const saved = library.readBounds(id);
  if (saved) await moveOwnedWindow(page, saved).catch(() => undefined);
  const session = { context, page, profile };
  replays.set(id, session);
  return session;
}

async function placeReplayWindow(page: Page, profile: string, want: WindowBounds) {
  const attempts: { method: string; applied: boolean; error?: string; after?: unknown }[] = [];
  try {
    const cdp = await moveOwnedWindow(page, want);
    attempts.push({ method: "cdp", applied: cdp.applied, after: cdp.after });
  } catch (err) {
    attempts.push({ method: "cdp", applied: false, error: err instanceof Error ? err.message : String(err) });
  }
  const helper = process.platform === "darwin" ? bundledHelperApp() : undefined;
  const pid = pidsForDataDir(profile)[0];
  if (helper && pid) {
    try {
      const ax = await new MacOsHelper(helper).moveWindow("", {
        x: want.x, y: want.y, w: want.width, h: want.height,
      }, { pid, frontmost: true });
      const after = ax.after
        ? { x: ax.after.x, y: ax.after.y, width: ax.after.w, height: ax.after.h }
        : null;
      attempts.push({ method: "ax-frontmost", applied: boundsApplied(after, want), after });
    } catch (err) {
      attempts.push({ method: "ax-frontmost", applied: false, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const after = await readOwnedWindow(page).catch(() => null);
  const applied = boundsApplied(after, want);
  return {
    applied,
    after,
    attempts,
    reason: applied
      ? `window at ${after?.x},${after?.y} ${after?.width}x${after?.height}`
      : `n/a-harness: requested ${want.x},${want.y} ${want.width}x${want.height}; stayed ${after ? `${after.x},${after.y} ${after.width}x${after.height}` : "unread"}`,
  };
}

function healProvider(): HealProvider {
  if (process.env.BAO_HEAL_CURSOR === "1") {
    return cursorHeal(process.env.BAO_HEAL_DIR || process.env.BAO_HOME || path.join(tmpdir(), "bao-heal"));
  }
  if (process.env.BAO_HEAL_FIXTURE === "1") {
    return scriptedHeal({
      patch: { identity: { surface: "dom", role: "button", testId: "login", path: [] } },
      model: { provider: "fixture", name: "bao-heal-fixture", version: "1" },
      prompt: "The login control's test id is login. Propose that identity. No coordinates.",
      rawResponse: "{\"identity\":{\"surface\":\"dom\",\"role\":\"button\",\"testId\":\"login\",\"path\":[]}}",
    });
  }
  const cursorResponse = process.env.BAO_HEAL_CURSOR_RESPONSE;
  if (cursorResponse && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return cursorSessionHeal(() => readFileSync(cursorResponse, "utf8"));
  }
  return llmHealFromEnv();
}

interface PendingImport {
  id: string;
  domain: string;
  profile?: string;
  phase: "confirm" | "pick" | "running" | "done" | "cancelled" | "error";
  message: string;
  profiles?: ChromeProfile[];
  error?: string;
  audit?: ImportAudit;
}

function writeImportAudit(home: string, audit: ImportAudit): void {
  const auditDir = path.join(home, "audit");
  mkdirSync(auditDir, { recursive: true });
  appendFileSync(path.join(auditDir, "import-login.jsonl"), `${auditLine(audit)}\n`);
}

function publicPending(pending: PendingImport) {
  return {
    id: pending.id,
    domain: pending.domain,
    phase: pending.phase,
    message: pending.message,
    profiles: pending.profiles?.map((profile) => ({ directory: profile.directory, name: profile.name, lastUsed: profile.lastUsed === true })),
    error: pending.error,
    audit: pending.audit,
  };
}

async function siteSignals(page: Page): Promise<{ url: string; hasPassword: boolean }> {
  const raw = page.url();
  let url = "";
  try {
    const parsed = new URL(raw);
    url = `${parsed.origin}${parsed.pathname}`;
  } catch {
    url = "";
  }
  const hasPassword = await page.locator("input[type=password]").count().then((count) => count > 0).catch(() => false);
  return { url, hasPassword };
}

async function namedControls(page: Page, names: string[]): Promise<{ role: string; name: string; id: string; testId: string; tag: string }[]> {
  return page.evaluate((wanted) => {
    const exact = new Set(wanted.map((name) => name.toLowerCase()));
    const out: { role: string; name: string; id: string; testId: string; tag: string }[] = [];
    for (const el of document.querySelectorAll("button, a, label, [role=radio], [role=button], input")) {
      const name = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      if (!exact.has(name.toLowerCase()) || name.length > 40) continue;
      out.push({
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        name,
        id: (el as HTMLElement).id || "",
        testId: el.getAttribute("data-testid") || "",
        tag: el.tagName.toLowerCase(),
      });
    }
    return out;
  }, names);
}

async function shortTexts(page: Page, phrases: string[]): Promise<string[]> {
  return page.evaluate((wanted) => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const el of document.querySelectorAll("body *")) {
      const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 80) continue;
      const lower = text.toLowerCase();
      if (!wanted.some((phrase) => lower.includes(phrase.toLowerCase()))) continue;
      if (seen.has(lower)) continue;
      seen.add(lower);
      out.push(text);
      if (out.length >= 8) break;
    }
    return out;
  }, phrases);
}

function looksPersonal(text: string): boolean {
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return true;
  if (/\d{6,}/.test(text)) return true;
  return false;
}

async function clipForPhrase(page: Page, phrase: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
  const box = await page.evaluate((wanted) => {
    let best: { length: number; x: number; y: number; width: number; height: number } | null = null;
    for (const el of document.querySelectorAll("body *")) {
      const text = ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").trim();
      if (!text.toLowerCase().includes(wanted.toLowerCase()) || text.length > 160) continue;
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      if (!best || text.length < best.length) {
        best = { length: text.length, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }
    }
    if (!best) return null;
    return { x: best.x, y: best.y, width: Math.min(best.width, 640), height: Math.min(best.height, 240) };
  }, phrase);
  if (!box) return null;
  return {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: box.width,
    height: box.height,
  };
}

function recordProvisional(library: Library, workflow: WorkflowV2, heals: HealRecord[]): Promotion | undefined {
  const heal = [...heals].reverse().find((item) => item.postconditionPassed && item.proposedPatch);
  if (!heal?.proposedPatch) return undefined;
  const before = workflow.steps.find((step) => step.id === heal.failedStep.id) || heal.failedStep;
  const promotion = openProvisional({
    healId: heal.id,
    workflowId: workflow.id,
    stepId: heal.failedStep.id,
    patch: heal.proposedPatch,
    before,
  });
  library.save(keepPatch(workflow, heal.failedStep.id, heal.proposedPatch));
  library.savePromotion(promotion);
  library.appendTrail(workflow.id, promotionEvent(promotion, Date.now()));
  return promotion;
}

async function checkPromotion(library: Library, id: string, notices: Notice[]): Promise<Promotion> {
  const current = library.readPromotion(id) as Promotion | undefined;
  if (!current || current.status !== "provisional") throw new Error("no provisional heal");
  const workflow = library.read(id);
  const args = defaultArgs(workflow);
  let driftOk = true;
  for (const change of driftChanges) {
    if (!await replayChanged(workflow, args, change)) {
      driftOk = false;
      break;
    }
  }
  let promotion = noteDrift(current, driftOk);
  library.savePromotion(promotion);
  library.appendTrail(id, promotionEvent(promotion, Date.now()));
  if (promotion.status === "reverted") {
    library.save(revertPatch(workflow, promotion.before));
    return promotion;
  }
  for (let i = 0; i < 2 && promotion.status === "provisional"; i++) {
    const passed = await replayChanged(library.read(id), args, { query: "" });
    promotion = noteReplay(promotion, passed);
    library.savePromotion(promotion);
    library.appendTrail(id, promotionEvent(promotion, Date.now()));
    if (promotion.status === "reverted") library.save(revertPatch(library.read(id), promotion.before));
  }
  notices.unshift({
    id: `n-${notices.length + 1}`,
    at: Date.now(),
    title: promotion.status === "promoted" ? "Bao promoted a heal" : "Bao reverted a heal",
    body: `${workflow.name}: ${promotion.status}`,
    workflowId: id,
    runId: promotion.healId,
    stepId: promotion.stepId,
  });
  return promotion;
}

const driftChanges: { name: string; query: string; slow?: boolean; scale?: number }[] = [
  { name: "shift", query: "shift=1" },
  { name: "theme", query: "theme=dark" },
  { name: "font", query: "font=big" },
  { name: "order", query: "order=flip" },
  { name: "slow", query: "", slow: true },
  { name: "scale-2x", query: "", scale: 2 },
];

function defaultArgs(workflow: WorkflowV2): ReplayArgs {
  const args: ReplayArgs = {};
  for (const input of workflow.inputs) {
    if (input.type === "secret" || input.type === "file" || !input.default) continue;
    args[input.name] = input.type === "number" ? Number(input.default) : input.default;
  }
  return args;
}

async function replayChanged(
  workflow: WorkflowV2,
  args: ReplayArgs,
  change: { query: string; slow?: boolean; scale?: number },
): Promise<boolean> {
  const profile = await mkdtemp(path.join(tmpdir(), "bao-promote-"));
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: true,
    deviceScaleFactor: change.scale,
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    if (change.slow) {
      await page.route("**/*", async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.continue();
      });
    }
    const startUrl = withChange(workflow.startUrl, change.query);
    await page.goto(startUrl);
    const result = await replay({ ...workflow, startUrl }, args, new BrowserDriver(page), { heal: unavailableHeal() });
    return result.status === "passed";
  } finally {
    await context.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
}

function withChange(startUrl: string, query: string): string {
  const url = new URL(startUrl);
  if (query) new URLSearchParams(query).forEach((value, key) => url.searchParams.set(key, value));
  return url.toString();
}

function summary(doc: WorkflowV2) {
  return {
    id: doc.id,
    name: doc.name,
    steps: doc.steps.length,
    inputs: doc.inputs,
    heal: doc.heal,
    heals: doc.steps.filter((step) => step.label.startsWith("healed")).length,
    replayed: doc.replayed,
    waits: doc.steps.filter((step) => step.action === "login" || step.action === "confirm").length,
    expects: doc.steps.filter((step) => step.action === "verify" || step.expect || step.readBack).length,
    firstStep: doc.steps[0] ? { action: doc.steps[0].action, label: doc.steps[0].label } : undefined,
  };
}

function slimRun(run: ReturnType<Library["readRun"]>) {
  const steps = Array.isArray(run.steps) ? run.steps.map((step) => {
    const row = step as { beforeShot?: string; afterShot?: string };
    const { beforeShot, afterShot, ...rest } = row;
    void beforeShot;
    void afterShot;
    return rest;
  }) : [];
  const failure = run.failure && typeof run.failure === "object"
    ? { ...(run.failure as Record<string, unknown>), snapshot: undefined, beforeShot: undefined }
    : run.failure;
  const heals = Array.isArray(run.heals) ? run.heals.map((heal) => {
    const row = heal as { snapshot?: unknown; beforeShot?: string };
    return { ...row, snapshot: undefined, beforeShot: undefined };
  }) : [];
  return { ...run, steps, failure, heals };
}

function maskedInputs(workflow: WorkflowV2, args: ReplayArgs): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of workflow.inputs) {
    const value = args[input.name];
    if (input.type === "secret") out[input.name] = value ? "••••" : "";
    else if (value && typeof value === "object" && !Array.isArray(value) && "name" in value) out[input.name] = String((value as { name?: string }).name || "");
    else if (Array.isArray(value)) out[input.name] = value.map((file) => file && typeof file === "object" && "name" in file ? String(file.name) : "").filter(Boolean).join(", ");
    else out[input.name] = value === undefined || value === null ? "" : String(value);
  }
  return out;
}

function helperStatus(report: unknown): { label: string; accessibility: boolean; screenCapture: boolean } {
  const row = report as { accessibility?: boolean; screenCapture?: boolean } | undefined;
  if (process.platform !== "darwin" || !bundledHelperApp()) {
    return { label: "helper off", accessibility: false, screenCapture: false };
  }
  const accessibility = !!row?.accessibility;
  const screenCapture = !!row?.screenCapture;
  return {
    label: accessibility && screenCapture ? "helper ok" : "helper needs permission",
    accessibility,
    screenCapture,
  };
}

function modelStatus(): { label: string } {
  if (process.env.BAO_HEAL_FIXTURE === "1" || process.env.BAO_HEAL_CURSOR === "1") return { label: "fixture model" };
  if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) return { label: "model ready" };
  return { label: "no model" };
}

let bundledClient = "";
async function browserScript(): Promise<string> {
  if (bundledClient) return bundledClient;
  const result = await esbuild.build({
    absWorkingDir: process.cwd(),
    entryPoints: ["desktop/src/app/client.ts"],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    target: "es2022",
  });
  bundledClient = result.outputFiles[0]?.text || "";
  return bundledClient;
}

async function materializeFiles(args: ReplayArgs): Promise<ReplayArgs> {
  const out: ReplayArgs = { ...args };
  for (const [key, value] of Object.entries(out)) {
    const file = value as { name?: string; base64?: string; path?: string };
    if (!file || typeof file !== "object" || !file.base64 || !file.name) continue;
    const dir = await mkdtemp(path.join(tmpdir(), "bao-file-"));
    const dest = path.join(dir, file.name);
    await writeFile(dest, Buffer.from(file.base64, "base64"));
    out[key] = { name: file.name, path: dest };
  }
  return out;
}

function writeLogin(res: ServerResponse, body: unknown, cookies: string[]): void {
  res.writeHead(200, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "set-cookie": cookies,
  });
  res.end(JSON.stringify(body));
}

function sendFile(res: ServerResponse, file: string, type: string): void {
  res.writeHead(200, { "content-type": type });
  res.end(readFileSync(file));
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, text = false): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (text) return resolve(raw);
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
  });
}
