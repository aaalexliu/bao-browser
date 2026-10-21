// Local app. The UI, the library, and replay all stay on disk.
// Nothing is recorded unless a session was started.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { BrowserContext, Page } from "playwright";
import { launchOwnedChrome } from "../launch";
import { BrowserDriver } from "../v1/browser-driver";
import { effectiveMode, keepPatch, llmHealFromEnv, revertPatch, scriptedHeal, type HealProposal, type HealProvider, type HealRecord } from "../v1/heal";
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

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return sendFile(res, path.join(publicDir, "index.html"), "text/html");
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
          runs: library.listRuns(),
        });
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/workflows/")) {
        return json(res, library.read(decodeURIComponent(url.pathname.split("/")[3] || "")));
      }
      if (req.method === "GET" && url.pathname.startsWith("/api/trails/")) {
        return json(res, library.readTrail(decodeURIComponent(url.pathname.split("/")[3] || "")));
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
        library.saveTrail(id, events);
        await stopBrowser();
        return json(res, workflow);
      }
      if (req.method === "POST" && url.pathname === "/api/replay") {
        const body = await readBody(req) as { id: string; args: ReplayArgs; heal?: HealMode };
        const saved = library.read(body.id);
        const workflow: WorkflowV2 = body.heal ? { ...saved, heal: body.heal } : saved;
        const args = await materializeFiles(body.args || {});
        const run = await runWorkflow(library, workflow, args, notices);
        return json(res, run);
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

  async function stopBrowser(): Promise<void> {
    recording = false;
    await context?.close().catch(() => undefined);
    context = undefined;
    page = undefined;
    if (profile) await rm(profile, { recursive: true, force: true }).catch(() => undefined);
    profile = undefined;
  }

  return {
    library,
    port,
    notices,
    get recording() { return recording; },
    async close() {
      await stopBrowser();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}

async function runWorkflow(library: Library, workflow: WorkflowV2, args: ReplayArgs, notices: Notice[]) {
  const profile = await mkdtemp(path.join(tmpdir(), "bao-replay-"));
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: process.env.BAO_HEADED !== "1",
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    if (workflow.startUrl.startsWith("http")) await page.goto(workflow.startUrl);
    const driver = new BrowserDriver(page, (notice) => {
      notices.unshift({ ...notice, id: `n-${notices.length + 1}`, at: Date.now() });
    });
    const heal = healProvider();
    const result = await replay(workflow, args, driver, {
      settings: library.settings(),
      heal,
      now: () => Date.now(),
    } satisfies ReplayOptions);
    library.saveRun({
      id: result.runId,
      workflowId: workflow.id,
      status: result.status,
      at: Date.now(),
      heals: result.heals,
      failure: result.failure,
      steps: result.steps,
    });
    return { ...result, mode: effectiveMode(workflow, library.settings()) };
  } finally {
    await context.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true }).catch(() => undefined);
  }
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
  return llmHealFromEnv();
}

function summary(doc: WorkflowV2) {
  return {
    id: doc.id,
    name: doc.name,
    steps: doc.steps.length,
    inputs: doc.inputs,
    heal: doc.heal,
    heals: doc.steps.filter((step) => step.label.startsWith("healed")).length,
  };
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
