// Local app. The UI, the library, and replay all stay on disk.
// Nothing is recorded unless a session was started.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as esbuild from "esbuild";
import type { BrowserContext, Page } from "playwright";
import { launchOwnedChrome, pidsForDataDir } from "../launch";
import { BrowserDriver, notifyOs, type PersonPrompts } from "../v1/browser-driver";
import { makeAsk, type HumanAsk } from "../v1/human-ask";
import { ensureTrailTimes } from "../v1/trail-time";
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
import { cursorSessionHeal, effectiveMode, keepPatch, llmHealFromEnv, revertPatch, scriptedHeal, type HealProposal, type HealProvider, type HealRecord } from "../v1/heal";
import { interpret, type TrailEvent } from "../v1/interpret";
import { replay, type HealNotice, type ReplayOptions } from "../v1/replay";
import { Library } from "../v1/store";
import type { HealMode, ReplayArgs, WorkflowV2 } from "../v1/schema";

export interface Notice extends HealNotice {
  id: string;
  at: number;
}

export interface App {
  library: Library;
  port: number;
  notices: Notice[];
  /** OS notifications the window asked for. The spawn can still fail. */
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
  let loginWait: { message: string } | null = null;
  let humanConfirm: { message: string; detail?: string } | null = null;
  let activeAsk: HumanAsk | null = null;
  let stopRun = false;
  let loginContinued = false;
  const notifications: { title: string; body: string }[] = [];
  let site: { context: BrowserContext; page: Page; profile: string } | undefined;
  const note = (title: string, body: string) => {
    notifications.push({ title, body });
    void notifyOs(title, body);
  };
  const prompts: PersonPrompts = {
    showConfirm(label) {
      if (activeAsk?.kind === "confirm") return;
      humanConfirm = { message: `Press ${label} in the Bao Chrome window. bao will not press it.`, detail: label };
    },
    clearConfirm() {
      humanConfirm = null;
      if (activeAsk?.kind === "confirm") activeAsk = null;
    },
    showLoginWait() {
      if (activeAsk?.kind === "login") return;
      loginWait = { message: "Sign in in the Bao Chrome window. bao is not recording keystrokes in password fields." };
    },
    clearLoginWait() {
      loginWait = null;
      loginContinued = false;
      if (activeAsk?.kind === "login") activeAsk = null;
    },
    showAsk(ask) {
      activeAsk = ask;
      if (ask.kind === "confirm") humanConfirm = { message: ask.instruction, detail: ask.button || ask.label };
      else loginWait = { message: ask.instruction };
      note("You need to act", ask.instruction);
    },
    shouldStop: () => stopRun,
    loginContinued: () => loginContinued,
  };
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
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        res.end(js);
        return;
      }
      if (req.method === "GET" && (url.pathname === "/fixture" || url.pathname === "/secure")) {
        return sendFile(res, path.join(publicDir, "fixture.html"), "text/html");
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
          model: modelStatus(),
          pendingImport: pending ? publicPending(pending) : null,
          loginWait,
          humanConfirm,
          activeAsk,
        });
      }
      const runVideo = url.pathname.match(/^\/api\/runs\/([^/]+)\/video$/);
      if (req.method === "GET" && runVideo) {
        const id = decodeURIComponent(runVideo[1] || "");
        const file = path.join(opts.home, "videos", `${id}.webm`);
        if (!existsSync(file)) return json(res, { error: "no video" }, 404);
        return sendFile(res, file, "video/webm");
      }
      const runOne = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (req.method === "GET" && runOne) {
        return json(res, library.readRun(decodeURIComponent(runOne[1] || "")));
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
        note("You need to act", `Press Import in this window to copy cookies for ${domain}, or Cancel. Nothing is read until you do.`);
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
        const body = await readBody(req) as {
          kind?: string;
          detail?: string;
          workflowName?: string;
          stepIndex?: number;
          stepCount?: number;
          button?: string;
          timeoutMs?: number;
        };
        if (body.kind === "login" || body.kind === "confirm") {
          prompts.showAsk?.(makeAsk({
            kind: body.kind,
            workflowId: "prompt",
            workflowName: body.workflowName || "workflow",
            stepId: "prompt",
            stepIndex: body.stepIndex || 1,
            stepCount: body.stepCount || 1,
            label: body.detail || body.kind,
            button: body.button || body.detail,
            timeoutMs: body.timeoutMs ?? 120000,
          }));
        } else {
          loginWait = null;
          humanConfirm = null;
          activeAsk = null;
        }
        return json(res, { loginWait, humanConfirm, activeAsk });
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
        if (!session) return json(res, { error: "replay window is not open" }, 409);
        await session.page.bringToFront().catch(() => undefined);
        return json(res, { ok: true });
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
      if (req.method === "GET" && url.pathname.startsWith("/api/trails/")) {
        const id = decodeURIComponent(url.pathname.split("/")[3] || "");
        const raw = library.readTrail(id);
        if (!Array.isArray(raw)) return json(res, raw);
        const timed = ensureTrailTimes(raw as { ts?: number }[]);
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
        events.length = 0;
        profile = await mkdtemp(path.join(tmpdir(), "bao-profile-"));
        context = await launchOwnedChrome({ userDataDir: profile, headless: process.env.BAO_HEADED !== "1" });
        await context.exposeBinding("__baoRecord", async (_source, payload: TrailEvent) => {
          if (!recording) return;
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
        const id = `wf-${Date.now()}`;
        const startUrl = page ? page.url() : "";
        const workflow = interpret(events, { id, name: "Captured workflow", startUrl, secrets: [] });
        library.save(workflow);
        library.saveTrail(id, ensureTrailTimes(events).events);
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
      if (process.env.BAO_DRIVE === "1" && req.method === "POST" && url.pathname === "/api/replay/press") {
        const body = await readBody(req) as { name?: string; fill?: { selector: string; value: string } };
        const session = [...replays.values()].find((item) => !item.page.isClosed());
        if (!session) return json(res, { error: "replay window is not open" }, 409);
        if (body.fill) await session.page.fill(body.fill.selector, body.fill.value);
        if (body.name) await session.page.getByRole("button", { name: body.name, exact: true }).click();
        return json(res, { ok: true });
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
    const context = await launchOwnedChrome({
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
      const profiles = readProfileNames(path.join(userData, "Local State"));
      const choice = chooseProfile(profiles, pending.profile);
      if (!choice.ok) {
        if (choice.reason === "none") {
          pending.phase = "error";
          pending.error = "Chrome has no profiles";
          return;
        }
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
      if (loaded.cookies.length > 0) {
        const page = await sitePage();
        try {
          await injectCookies(page, loaded.cookies);
        } finally {
          for (const cookie of loaded.cookies) cookie.value = "";
        }
      }
      const audit = loaded.audit;
      const auditDir = path.join(opts.home, "audit");
      mkdirSync(auditDir, { recursive: true });
      appendFileSync(path.join(auditDir, "import-login.jsonl"), `${auditLine(audit)}\n`);
      pending.audit = audit;
      pending.phase = "done";
      pending.profiles = undefined;
    } catch (err) {
      if (pending) {
        pending.phase = "error";
        pending.error = safeImportError(err);
      }
    } finally {
      importing = false;
    }
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
  const recordVideo = process.env.BAO_RUN_VIDEO === "1";
  const videoDir = recordVideo ? path.join(library.root, "videos", workflow.id) : undefined;
  if (videoDir) mkdirSync(videoDir, { recursive: true });
  const session = await openReplay(library, workflow.id, replays, videoDir);
  const page = session.page;
  const videoStartedAt = recordVideo ? Date.now() : undefined;
  if (workflow.startUrl.startsWith("http")) await page.goto(workflow.startUrl);
  const driver = new BrowserDriver(page, (notice) => {
    notices.unshift({ ...notice, id: `n-${notices.length + 1}`, at: Date.now() });
  }, prompts);
  const heal = healProvider();
  const result = await replay(workflow, args, driver, {
    settings: library.settings(),
    heal,
    now: () => Date.now(),
    shots: true,
  } satisfies ReplayOptions);
  let video: string | undefined;
  if (recordVideo && page.video()) {
    const clip = page.video()!;
    const dest = path.join(library.root, "videos", `${result.runId}.webm`);
    mkdirSync(path.dirname(dest), { recursive: true });
    await page.close().catch(() => undefined);
    await clip.saveAs(dest).catch(() => undefined);
    await session.context.close().catch(() => undefined);
    replays.delete(workflow.id);
    if (existsSync(dest)) video = `${result.runId}.webm`;
  }
  const inputs = maskedInputs(workflow, args);
  library.saveRun({
    id: result.runId,
    workflowId: workflow.id,
    status: result.status,
    at: Date.now(),
    heals: result.heals,
    failure: result.failure,
    steps: result.steps,
    modelCalls: result.modelCalls,
    inputs,
    video,
    videoStartedAt,
  });
  const bounds = await readOwnedWindow(page).catch(() => null);
  if (bounds) library.writeBounds(workflow.id, bounds);
  return { ...result, mode: effectiveMode(workflow, library.settings()), fileProof: driver.proofs, bounds, inputs, video, videoStartedAt };
}

async function openReplay(
  library: Library,
  id: string,
  replays: Map<string, { context: BrowserContext; page: Page; profile: string }>,
  videoDir?: string,
): Promise<{ context: BrowserContext; page: Page; profile: string }> {
  const existing = replays.get(id);
  if (existing && !existing.page.isClosed() && !videoDir) return existing;
  if (existing) {
    await existing.context.close().catch(() => undefined);
    await rm(existing.profile, { recursive: true, force: true }).catch(() => undefined);
    replays.delete(id);
  }
  const profile = await mkdtemp(path.join(tmpdir(), "bao-replay-"));
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: process.env.BAO_HEADED !== "1",
    videoDir,
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

function publicPending(pending: PendingImport) {
  return {
    id: pending.id,
    domain: pending.domain,
    phase: pending.phase,
    message: pending.message,
    profiles: pending.profiles?.map((profile) => ({ directory: profile.directory, name: profile.name })),
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
    else if (value && typeof value === "object" && !Array.isArray(value) && "name" in value) out[input.name] = String(value.name);
    else if (Array.isArray(value)) out[input.name] = value.map((file) => file.name).filter(Boolean).join(", ");
    else out[input.name] = value === undefined ? "" : String(value);
  }
  return out;
}

function helperStatus(report: unknown): { label: string } {
  if (process.platform !== "darwin" || !bundledHelperApp()) return { label: "helper off" };
  const row = report as { accessibility?: boolean; screenCapture?: boolean; ok?: boolean } | undefined;
  if (row && row.accessibility && row.screenCapture) return { label: "helper ok" };
  return { label: "helper needs permission" };
}

function modelStatus(): { label: string } {
  if (process.env.BAO_HEAL_FIXTURE === "1") return { label: "fixture model" };
  if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) return { label: "model ready" };
  return { label: "no model" };
}

let bundledAppJs: string | undefined;

async function browserScript(): Promise<string> {
  if (bundledAppJs) return bundledAppJs;
  const result = await esbuild.build({
    entryPoints: [path.join(process.cwd(), "desktop/src/app/client.ts")],
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
    target: "es2022",
    legalComments: "none",
  });
  bundledAppJs = result.outputFiles[0]?.text || "";
  return bundledAppJs;
}

function recorderSource(): string {
  return `(() => {
    const norm = (v) => (v || "").replace(/\\s+/g, " ").trim();
    const send = (payload) => { if (window.__baoRecord) window.__baoRecord(payload); };
    const ident = (el) => ({
      surface: "dom",
      role: el.getAttribute("role") || el.tagName.toLowerCase(),
      testId: el.getAttribute("data-testid") || undefined,
      id: el.id || undefined,
      nameAttr: el.getAttribute("name") || undefined,
      tag: el.tagName.toLowerCase(),
      label: el.getAttribute("aria-label") || undefined,
      text: norm(el.innerText || el.textContent || "").slice(0, 80) || undefined,
      path: [],
    });
    document.addEventListener("click", (event) => {
      const el = event.target && event.target.closest ? event.target.closest("button,a,input,textarea,select,li,[data-testid]") : event.target;
      if (!el) return;
      const before = location.href;
      setTimeout(() => send({ kind: "act", op: "click", identity: ident(el), beforeUrl: before, afterUrl: location.href }), 0);
    }, true);
    document.addEventListener("change", (event) => {
      const el = event.target;
      if (!el) return;
      if (el.type === "file") {
        const file = el.files && el.files[0];
        send({ kind: "act", op: "upload", identity: ident(el), fileName: file && file.name });
        return;
      }
      const secret = el.type === "password";
      send({ kind: "act", op: "type", identity: ident(el), value: secret ? undefined : el.value, sensitive: secret || undefined });
    }, true);
    document.addEventListener("drop", (event) => {
      const el = event.target;
      const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
      send({ kind: "act", op: "drop", identity: ident(el), fileName: file && file.name });
    }, true);
  })();`;
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
