import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { isSensitiveField, isSensitiveValue, omitSecret, redactPayload, type FieldHint } from "../../../src/mask";
import { installPageHelpers, type Described } from "../page-fns";
import { AuditTrail, deriveWorkflow, trimTrail, type AuditOrigin, type AuditSnapshot } from "./audit";
import { clickViewport } from "./input";
import type { ActResult, AxSnap, DomSnap, Executor, NeutralAction, Observation } from "./neutral";

const CONTROL = "a,button,input,select,textarea";

interface Hit {
  blank: boolean;
  tag: string;
  inputType: string;
  described: Described | null;
  rect: { x: number; y: number; w: number; h: number } | null;
}

interface Captured {
  png: Buffer;
  snap: AuditSnapshot;
  viewport: { w: number; h: number };
}

export async function preparePage(page: Page): Promise<void> {
  await page.context().addInitScript(installPageHelpers);
}

export class PageExecutor implements Executor {
  private navId: string | null = null;

  constructor(readonly page: Page, readonly trail: AuditTrail) {}

  /** Append the navigate event before requests for that document start. */
  async beginNavigation(url: string): Promise<void> {
    const ev = this.trail.append({
      kind: "read",
      op: "navigate",
      source: { agent: "scripted-driver", vendor: "bao", adapter: "none" },
      raw: { url },
    });
    this.navId = ev.id;
    const before = await this.capture();
    this.trail.fillBefore(ev.id, before.snap);
  }

  async finishNavigation(): Promise<void> {
    if (!this.navId) throw new Error("navigation was not started");
    const after = await this.capture();
    this.trail.complete(this.navId, after.snap);
    this.navId = null;
  }

  async observe(origin: AuditOrigin): Promise<Observation> {
    const cap = await this.capture();
    const before = this.trail.lastSnapshot();
    this.trail.append({
      kind: "read",
      op: "screenshot",
      source: origin.source,
      raw: origin.raw,
      before,
      after: cap.snap,
    });
    this.trail.append({
      kind: "read",
      op: "dom",
      source: origin.source,
      raw: { type: "dom" },
      before,
      after: { ...cap.snap, ax: [] },
    });
    this.trail.append({
      kind: "read",
      op: "ax",
      source: origin.source,
      raw: { type: "ax" },
      before,
      after: { ...cap.snap, dom: [] },
    });
    return {
      png: cap.png,
      url: cap.snap.url,
      viewport: cap.viewport,
      dom: cap.snap.dom,
      ax: cap.snap.ax,
    };
  }

  async act(action: NeutralAction, origin: AuditOrigin): Promise<ActResult> {
    const before = await this.capture();
    if (action.op === "type") return this.actType(action.text, origin, before);
    if (action.op === "keypress") {
      return this.recordUnresolved("keypress", origin, before, "keypress is not performed in this spike");
    }
    if (action.op === "unsupported") {
      const reason = `${action.vendor} action ${action.type} is not performed in this spike`;
      return this.recordUnresolved(action.type, origin, before, reason);
    }
    if (action.button !== "left") {
      const reason = `click button ${action.button} is not performed in this spike`;
      return this.recordUnresolved("click", origin, before, reason, { x: action.x, y: action.y });
    }
    const hit = await this.hitTest(action.x, action.y);
    const provenance = { x: action.x, y: action.y, space: "viewport" as const };
    if (hit.blank || !hit.described || !hit.rect) {
      const reason = `hit ${hit.tag || "nothing"}, not an actionable control`;
      const after = await this.capture();
      this.trail.append({
        kind: "act",
        op: "click",
        source: origin.source,
        raw: redactPayload(origin.raw).value,
        before: before.snap,
        after: after.snap,
        resolved: null,
        unresolved: { reason },
        provenance,
      });
      return { unresolved: true, reason };
    }
    const cx = hit.rect.x + hit.rect.w / 2;
    const cy = hit.rect.y + hit.rect.h / 2;
    await clickViewport(this.page, cx, cy);
    let checked: boolean | undefined;
    if (hit.inputType === "checkbox" || hit.inputType === "radio") {
      checked = await this.readChecked(action.x, action.y);
    }
    const after = await this.capture();
    this.trail.append({
      kind: "act",
      op: "click",
      source: origin.source,
      raw: redactPayload(origin.raw).value,
      before: before.snap,
      after: after.snap,
      resolved: {
        tag: hit.tag,
        selectors: hit.described.selectors,
        unique: hit.described.unique,
        text: hit.described.text || undefined,
      },
      provenance,
      checked,
    });
    return { unresolved: false };
  }

  workflow(startUrl: string) {
    return deriveWorkflow(trimTrail(this.trail.events), startUrl);
  }

  private async actType(text: string, origin: AuditOrigin, before: Captured): Promise<ActResult> {
    const hint = await focusedField(this.page);
    const secret = isSensitiveValue(text) || (!!hint && isSensitiveField({ ...hint, value: text }));
    const redacted = redactPayload(origin.raw);
    const raw = secret ? omitSecret(redacted.value, text) : redacted.value;
    const reason = "type has no focused text control in this spike";
    const after = await this.capture();
    this.trail.append({
      kind: "act",
      op: "type",
      source: origin.source,
      raw,
      before: before.snap,
      after: after.snap,
      resolved: null,
      unresolved: { reason },
      sensitive: secret || undefined,
    });
    return { unresolved: true, reason };
  }

  private async recordUnresolved(
    op: string,
    origin: AuditOrigin,
    before: Captured,
    reason: string,
    at?: { x: number; y: number },
  ): Promise<ActResult> {
    const after = await this.capture();
    this.trail.append({
      kind: "act",
      op,
      source: origin.source,
      raw: redactPayload(origin.raw).value,
      before: before.snap,
      after: after.snap,
      resolved: null,
      unresolved: { reason },
      provenance: at ? { x: at.x, y: at.y, space: "viewport" } : undefined,
    });
    return { unresolved: true, reason };
  }

  private async capture(): Promise<Captured> {
    const png = await this.page.screenshot({ type: "png" });
    const viewport = this.page.viewportSize() ?? { width: 1280, height: 720 };
    const dom = await this.page.evaluate(() => {
      const out: DomSnap[] = [];
      const nodes = document.querySelectorAll("a,button,input,select,textarea,h1,h2,h3");
      nodes.forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return;
        const input = el instanceof HTMLInputElement ? el.type : "";
        out.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || "",
          type: input,
          text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 80),
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      });
      return out;
    });
    const ax = await axSnapshot(this.page);
    const screenshot = "sha256:" + createHash("sha256").update(png).digest("hex");
    return {
      png,
      viewport: { w: viewport.width, h: viewport.height },
      snap: { screenshot, url: this.page.url(), dom, ax },
    };
  }

  private async hitTest(x: number, y: number): Promise<Hit> {
    return this.page.evaluate(({ x, y, control }) => {
      const el = document.elementFromPoint(x, y);
      const tag = el ? el.tagName.toLowerCase() : "";
      const controlEl = el && "closest" in el ? (el as Element).closest(control) : null;
      if (!el || !controlEl) {
        return { blank: true, tag: tag || "none", inputType: "", described: null, rect: null };
      }
      const w = window as unknown as { __baoDescribe?: (node: Element) => Described };
      if (!w.__baoDescribe) {
        return { blank: true, tag, inputType: "", described: null, rect: null };
      }
      const r = controlEl.getBoundingClientRect();
      const inputType = controlEl instanceof HTMLInputElement ? controlEl.type : "";
      return {
        blank: false,
        tag: controlEl.tagName.toLowerCase(),
        inputType,
        described: w.__baoDescribe(controlEl),
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
      };
    }, { x, y, control: CONTROL });
  }

  private async readChecked(x: number, y: number): Promise<boolean> {
    return this.page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      const input = el && "closest" in el ? (el as Element).closest("input") : null;
      return input instanceof HTMLInputElement ? input.checked : false;
    }, { x, y });
  }
}

async function focusedField(page: Page): Promise<FieldHint | null> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    const input = el instanceof HTMLInputElement ? el : null;
    const area = el instanceof HTMLTextAreaElement ? el : null;
    if (!input && !area) return null;
    return {
      type: input?.type || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      name: el.getAttribute("name") || "",
      id: el.id || "",
      ariaLabel: el.getAttribute("aria-label") || "",
      placeholder: el.getAttribute("placeholder") || "",
      value: input?.value || area?.value || "",
    };
  });
}

async function axSnapshot(page: Page): Promise<AxSnap[]> {
  const client = await page.context().newCDPSession(page);
  try {
    const tree = await client.send("Accessibility.getFullAXTree");
    const nodes = (tree as { nodes?: Array<{ ignored?: boolean; role?: { value?: string }; name?: { value?: string } }> }).nodes ?? [];
    const out: AxSnap[] = [];
    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role?.value || "";
      const name = node.name?.value || "";
      if (!role || role === "generic" || role === "none" || role === "InlineTextBox") continue;
      if (!name && role !== "checkBox" && role !== "button") continue;
      out.push({ role, name: name.slice(0, 80) });
      if (out.length >= 40) break;
    }
    return out;
  } finally {
    await client.detach().catch(() => {});
  }
}
