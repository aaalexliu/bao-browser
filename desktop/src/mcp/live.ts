// Live MCP session. The model chooses pixels. Bao hit-tests them, performs
// the action, and appends a trail event labeled live-model.
// BAO_MCP_STUB stays the protocol-only path. This file runs only for BAO_MCP_LIVE=1.

import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FileChooser, Page } from "playwright";
import { launchOwnedChrome } from "../launch";
import { osHit, osNodes } from "../proxy/os";
import type { TrailEvent } from "../v1/interpret";
import type { Identity } from "../v1/schema";

export const LIVE_SOURCE = { agent: "live-model", vendor: "cursor", adapter: "stdio" } as const;

export interface ToolContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface Hit {
  blank: boolean;
  tag?: string;
  type?: string;
  id?: string;
  nameAttr?: string;
  text?: string;
  role?: string;
}

let seq = 0;

export function scrubTrailText(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[secret]");
  }
  return out;
}

export function typeTrailEvent(text: string, identity: Identity | undefined, secrets: string[]): TrailEvent {
  const sensitive = identity?.role === "password" || secrets.some((secret) => secret && text === secret);
  return {
    id: `live-${++seq}`,
    ts: Date.now(),
    kind: "act",
    op: "type",
    source: LIVE_SOURCE,
    identity,
    value: sensitive ? undefined : scrubTrailText(text, secrets),
    sensitive: sensitive || undefined,
  };
}

export class LiveSession {
  private chooser: FileChooser | null = null;
  private fileIdentity: Identity | undefined;
  private n = 0;

  private constructor(
    private readonly trailPath: string,
    private readonly secrets: string[],
    private readonly surface: "browser" | "desktop",
    private readonly page: Page | undefined,
    private readonly screen: string,
    private readonly helper: string,
  ) {}

  static async start(env: NodeJS.ProcessEnv = process.env): Promise<LiveSession> {
    const home = env.BAO_HOME || path.join(tmpdir(), "bao-mcp");
    const trailPath = path.join(home, "trail.jsonl");
    const secrets = (env.BAO_SECRETS || "").split(",").map((item) => item.trim()).filter(Boolean);
    const surface = env.BAO_MCP_SURFACE === "desktop" ? "desktop" : "browser";
    const screen = env.BAO_SCREEN || "1400x900";
    const helper = env.BAO_OS_HELPER || path.join(process.cwd(), "desktop/os-helper/target/release/bao-os-helper");
    if (surface === "desktop") {
      return new LiveSession(trailPath, secrets, surface, undefined, screen, helper);
    }
    const profile = mkdtempSync(path.join(tmpdir(), "bao-mcp-profile-"));
    const context = await launchOwnedChrome({
      userDataDir: profile,
      headless: env.BAO_HEADED !== "1",
    });
    const page = context.pages()[0] || await context.newPage();
    const url = env.BAO_MCP_URL || "about:blank";
    if (url !== "about:blank") await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    const session = new LiveSession(trailPath, secrets, surface, page, screen, helper);
    session.write({
      id: "live-nav",
      ts: Date.now(),
      kind: "read",
      op: "navigate",
      source: LIVE_SOURCE,
      beforeUrl: page.url(),
    });
    return session;
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ content: ToolContent[]; isError: boolean }> {
    if (name === "screenshot") return this.screenshot();
    if (name === "click") return this.click(Number(args.x), Number(args.y));
    if (name === "type") return this.type(String(args.text ?? ""));
    if (name === "key") return this.key(String(args.key ?? "Enter"));
    if (name === "scroll") return this.scroll(Number(args.dx || 0), Number(args.dy || 0));
    return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  }

  private async screenshot(): Promise<{ content: ToolContent[]; isError: boolean }> {
    const png = this.surface === "desktop" ? await rootPng(this.screen) : await this.page!.screenshot({ type: "png" });
    this.write({
      id: this.nextId(),
      ts: Date.now(),
      kind: "read",
      op: "screenshot",
      source: LIVE_SOURCE,
      beforeUrl: this.page ? this.page.url() : "desktop://screen",
    });
    const where = this.page ? this.page.url() : `desktop ${this.screen}`;
    return {
      isError: false,
      content: [
        { type: "image", data: png.toString("base64"), mimeType: "image/png" },
        { type: "text", text: where },
      ],
    };
  }

  private async click(x: number, y: number): Promise<{ content: ToolContent[]; isError: boolean }> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { content: [{ type: "text", text: "click needs x and y" }], isError: true };
    }
    if (this.surface === "desktop") return this.clickDesktop(x, y);
    return this.clickBrowser(x, y);
  }

  private async clickBrowser(x: number, y: number): Promise<{ content: ToolContent[]; isError: boolean }> {
    const page = this.page!;
    if (this.chooser) {
      await xdotool(["mousemove", String(Math.round(x)), String(Math.round(y)), "click", "1"]);
      return { content: [{ type: "text", text: "clicked while a file chooser is open" }], isError: false };
    }
    const hit = await page.evaluate(describeAt, { x, y }) as Hit;
    const identity = identityFromHit(hit);
    const before = page.url();
    if (hit.type === "file") {
      const pending = page.waitForEvent("filechooser", { timeout: 3000 }).catch(() => null);
      await page.mouse.click(x, y);
      this.chooser = await pending;
      this.fileIdentity = identity;
      this.write({
        id: this.nextId(),
        ts: Date.now(),
        kind: "act",
        op: "click",
        source: LIVE_SOURCE,
        identity,
        provenance: { x, y, space: "viewport" },
        beforeUrl: before,
        afterUrl: page.url(),
        unresolved: { reason: "file dialog opened; the path is not part of the action" },
      });
      const note = this.chooser
        ? "File chooser is open. Type the file name. Playwright keeps the dialog, so it is not on the screenshot."
        : "File input clicked, no chooser appeared.";
      return { content: [{ type: "text", text: note }], isError: !this.chooser };
    }
    await page.mouse.click(x, y);
    const moved = page.waitForURL((url) => url.toString() !== before, { timeout: 5000 }).then(() => true).catch(() => false);
    await page.waitForTimeout(400);
    await moved;
    const outcome = await page.evaluate(outcomeText) as { flash: string; heading: string };
    const afterText = resultText(outcome);
    const actionable = !!hit.tag && /^(a|button|input|textarea|select|label)$/.test(hit.tag);
    this.write({
      id: this.nextId(),
      ts: Date.now(),
      kind: "act",
      op: "click",
      source: LIVE_SOURCE,
      identity,
      provenance: { x, y, space: "viewport" },
      beforeUrl: before,
      afterUrl: page.url(),
      afterText: afterText ? scrubTrailText(afterText, this.secrets) : undefined,
      unresolved: actionable ? undefined : { reason: hit.blank ? "hit nothing actionable" : `hit ${hit.tag || "text"}, not a control` },
    });
    return { content: [{ type: "text", text: `${page.url()} ${afterText || hit.text || hit.tag || "blank"}` }], isError: false };
  }

  private async clickDesktop(x: number, y: number): Promise<{ content: ToolContent[]; isError: boolean }> {
    const hit = await osHit(this.helper, this.screen, x, y).catch((err: Error) => ({
      ok: false as const,
      reason: err.message,
      role: undefined,
      name: undefined,
      app: undefined,
      path: undefined as { role: string; name: string }[] | undefined,
    }));
    await xdotool(["mousemove", String(Math.round(x)), String(Math.round(y)), "click", "1"]);
    await wait(200);
    const identity: Identity | undefined = hit.ok && hit.role ? {
      surface: "atspi",
      role: hit.role,
      name: hit.name || undefined,
      app: hit.app,
      path: hit.path || [],
    } : undefined;
    this.write({
      id: this.nextId(),
      ts: Date.now(),
      kind: "act",
      op: "click",
      source: LIVE_SOURCE,
      identity,
      provenance: { x, y, space: "screen" },
      beforeUrl: "desktop://screen",
      unresolved: identity ? undefined : { reason: hit.reason || "no accessible at point" },
    });
    return { content: [{ type: "text", text: identity ? `${identity.role} ${identity.name || ""}`.trim() : (hit.reason || "miss") }], isError: false };
  }

  private async type(text: string): Promise<{ content: ToolContent[]; isError: boolean }> {
    if (this.chooser) {
      const name = path.basename(text);
      const full = text.startsWith("/") ? text : path.join(process.env.BAO_MCP_FILES || "/tmp", text);
      await this.chooser.setFiles(full);
      this.write({
        id: this.nextId(),
        ts: Date.now(),
        kind: "act",
        op: "upload",
        source: LIVE_SOURCE,
        identity: this.fileIdentity,
        fileName: name,
        beforeUrl: this.page?.url(),
        afterUrl: this.page?.url(),
      });
      this.chooser = null;
      return { content: [{ type: "text", text: `uploaded ${name}` }], isError: false };
    }
    if (this.surface === "desktop") {
      await xdotool(["type", "--", text]);
      return { content: [{ type: "text", text: "typed" }], isError: false };
    }
    const page = this.page!;
    const hit = await page.evaluate(focused) as Hit;
    const identity = identityFromHit(hit);
    const event = typeTrailEvent(text, identity, this.secrets);
    await page.keyboard.type(text, { delay: 15 });
    this.write(event);
    const where = identity?.role === "password" ? "password field" : (identity?.id || identity?.nameAttr || "focus");
    return { content: [{ type: "text", text: `typed into ${where}` }], isError: false };
  }

  private async key(key: string): Promise<{ content: ToolContent[]; isError: boolean }> {
    if (this.surface === "desktop" || this.chooser) await xdotool(["key", key]);
    else await this.page!.keyboard.press(key);
    this.write({
      id: this.nextId(),
      ts: Date.now(),
      kind: "act",
      op: "key",
      source: LIVE_SOURCE,
      key,
      beforeUrl: this.page?.url() || "desktop://screen",
      afterUrl: this.page?.url(),
    });
    return { content: [{ type: "text", text: `key ${key}` }], isError: false };
  }

  private async scroll(dx: number, dy: number): Promise<{ content: ToolContent[]; isError: boolean }> {
    if (this.surface === "browser" && this.page) await this.page.mouse.wheel(dx, dy);
    this.write({
      id: this.nextId(),
      ts: Date.now(),
      kind: "read",
      op: "scroll",
      source: LIVE_SOURCE,
    });
    return { content: [{ type: "text", text: "scrolled" }], isError: false };
  }

  private nextId(): string {
    this.n += 1;
    return `live-${this.n}`;
  }

  private write(event: TrailEvent): void {
    const json = JSON.stringify(event);
    if (this.secrets.some((secret) => secret && json.includes(secret))) {
      throw new Error("refusing to write a secret into the trail");
    }
    appendFileSync(this.trailPath, json + "\n");
  }
}

function identityFromHit(hit: Hit): Identity | undefined {
  if (hit.blank || !hit.tag) return undefined;
  const role = hit.type === "password" ? "password" : (hit.type === "submit" ? "button" : (hit.role || hit.tag));
  return {
    surface: "dom",
    role,
    id: hit.id,
    nameAttr: hit.nameAttr,
    text: hit.text || undefined,
    name: hit.text || undefined,
    path: [],
  };
}

function describeAt(point: { x: number; y: number }): Hit {
  const start = document.elementFromPoint(point.x, point.y);
  if (!start) return { blank: true };
  const interesting = (el: Element) => /^(A|BUTTON|INPUT|TEXTAREA|SELECT|LABEL)$/.test(el.tagName);
  let el: Element | null = start;
  while (el && el !== document.body && !interesting(el)) el = el.parentElement;
  const node = el && el !== document.body ? el : start;
  if (node === document.body || node === document.documentElement) return { blank: true, tag: start.tagName.toLowerCase() };
  const input = node as HTMLInputElement;
  const visible = input.type === "password" ? "" : ((node as HTMLElement).innerText || node.textContent || input.value || "");
  const text = visible.replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    blank: false,
    tag: node.tagName.toLowerCase(),
    type: input.type || "",
    id: node.id || undefined,
    nameAttr: node.getAttribute("name") || undefined,
    text,
    role: node.getAttribute("role") || node.tagName.toLowerCase(),
  };
}

function focused(): Hit {
  const node = document.activeElement;
  if (!node || node === document.body) return { blank: true };
  const input = node as HTMLInputElement;
  return {
    blank: false,
    tag: node.tagName.toLowerCase(),
    type: input.type || "",
    id: node.id || undefined,
    nameAttr: node.getAttribute("name") || undefined,
    text: ((node as HTMLElement).innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
    role: node.getAttribute("role") || node.tagName.toLowerCase(),
  };
}

function outcomeText(): { flash: string; heading: string } {
  const norm = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
  return {
    flash: norm(document.querySelector("#flash-messages")?.textContent).slice(0, 160),
    heading: norm(document.querySelector("#content h3")?.textContent).slice(0, 80),
  };
}

function resultText(outcome: { flash: string; heading: string }): string {
  if (outcome.flash) return outcome.flash;
  if (outcome.heading === "File Uploaded!") return outcome.heading;
  return "";
}

function rootPng(screen: string): Promise<Buffer> {
  const file = path.join(tmpdir(), `bao-root-${process.pid}.png`);
  const [w, h] = screen.split("x");
  return run("ffmpeg", [
    "-y", "-loglevel", "error", "-f", "x11grab", "-video_size", `${w}x${h}`,
    "-i", process.env.DISPLAY || ":0", "-frames:v", "1", file,
  ]).then(() => readFileSync(file));
}

function xdotool(args: string[]): Promise<void> {
  return run("xdotool", args).then(() => undefined);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exit ${code}`)));
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function desktopLabel(helper: string, screen: string): Promise<string> {
  const nodes = await osNodes(helper, screen);
  const label = nodes.find((node) => /label/i.test(node.role));
  return label?.name || "";
}
