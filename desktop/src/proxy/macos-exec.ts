// macOS accessibility executor. A click coordinate is resolved with
// AXUIElementCopyElementAtPosition, then performed with AXPress. Replay does
// not read the coordinate.

import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { isSensitiveValue } from "../../../src/mask";
import { deriveWorkflow, trimTrail, type AuditOrigin, type AuditTrail } from "./audit";
import type { ActResult, Executor, NeutralAction, Observation } from "./neutral";
import { MacOsHelper, targetFrom, type AxNode } from "./os-macos";

export class MacOsExecutor implements Executor {
  private size: { w: number; h: number } | null = null;

  constructor(
    readonly trail: AuditTrail,
    private readonly helper: MacOsHelper,
    private readonly bundle: string,
    private readonly work: string,
  ) {}

  async observe(origin: AuditOrigin): Promise<Observation> {
    const png = await this.shot();
    const nodes = (await this.helper.nodes(this.bundle)).nodes ?? [];
    const ax = nodes.filter((n) => n.name).slice(0, 40).map((n) => ({ role: n.role, name: n.name }));
    const snap = {
      screenshot: "sha256:" + createHash("sha256").update(png).digest("hex"),
      url: `os://${this.bundle}`,
      dom: [],
      ax,
    };
    this.trail.append({
      kind: "read",
      op: "screenshot",
      source: origin.source,
      raw: origin.raw,
      after: snap,
    });
    return { png, url: snap.url, viewport: { w: png.length, h: 0 }, dom: [], ax };
  }

  async act(action: NeutralAction, origin: AuditOrigin): Promise<ActResult> {
    if (action.op === "type") return this.actType(action.text, origin);
    if (action.op === "click") return this.actClick(action.x, action.y, origin);
    if (action.op === "keypress") return this.actKey(action.keys, origin);
    return this.miss(action.op, origin, `${action.op} is not performed on the macOS plane`, undefined);
  }

  workflow(startUrl: string) {
    return deriveWorkflow(trimTrail(this.trail.events), startUrl, {
      id: `wf-${this.bundle}`,
      name: `macOS ${this.bundle}`,
    });
  }

  private async actClick(x: number, y: number, origin: AuditOrigin): Promise<ActResult> {
    const provenance = { x, y, space: "screen" as const };
    const hit = await this.helper.hit(x, y, this.bundle);
    if (!hit.useful || !hit.element) {
      return this.miss("osClick", origin, hit.reason || "no useful accessibility element", provenance);
    }
    const screen = await this.screen();
    const target = targetFrom(hit.element, screen);
    const before = this.snap(await this.shot());
    try {
      if (hit.element.actions.includes("AXPress")) await this.helper.press(target);
      else if (isTextRole(hit.element.role)) await this.helper.focusRole(this.bundle, hit.element.role, hit.element.name);
      else return this.miss("osClick", origin, `${hit.element.role} has no AXPress`, provenance, hit.element);
    } catch (err) {
      return this.miss("osClick", origin, err instanceof Error ? err.message : String(err), provenance, hit.element);
    }
    await sleep(180);
    const png = await this.shot();
    this.trail.append({
      kind: "act",
      op: "osClick",
      source: origin.source,
      raw: origin.raw,
      before,
      after: this.snap(png),
      provenance,
      os: osOf(hit.element),
    });
    return { unresolved: false };
  }

  private async actKey(keys: string[], origin: AuditOrigin): Promise<ActResult> {
    const combo = keys.join("+");
    const before = this.snap(await this.shot());
    try {
      await this.helper.key(this.bundle, combo);
    } catch (err) {
      return this.miss("osKey", origin, err instanceof Error ? err.message : String(err), undefined);
    }
    await sleep(120);
    this.trail.append({
      kind: "act",
      op: "osKey",
      source: origin.source,
      raw: origin.raw,
      before,
      after: this.snap(await this.shot()),
      os: { app: this.bundle, role: "AXApplication", name: combo, path: [], key: combo },
    });
    return { unresolved: false };
  }

  private async actType(text: string, origin: AuditOrigin): Promise<ActResult> {
    const secret = isSensitiveValue(text);
    const before = this.snap(await this.shot());
    let hit = await this.helper.focused(this.bundle);
    if (!hit.useful || !hit.element) {
      await this.helper.focusRole(this.bundle, "AXTextArea").catch(() => undefined);
      hit = await this.helper.focused(this.bundle);
    }
    if (!hit.useful || !hit.element) {
      return this.miss("osSetValue", origin, hit.reason || "type has no focused text control", undefined);
    }
    const screen = await this.screen();
    const target = targetFrom(hit.element, screen);
    try {
      await this.helper.setValue(target, text);
    } catch (err) {
      return this.miss("osSetValue", origin, err instanceof Error ? err.message : String(err), undefined, hit.element);
    }
    const png = await this.shot();
    this.trail.append({
      kind: "act",
      op: "osSetValue",
      source: origin.source,
      raw: secret ? { type: "type" } : origin.raw,
      before,
      after: this.snap(png),
      os: { ...osOf(hit.element), value: secret ? undefined : text },
      sensitive: secret || undefined,
    });
    return { unresolved: false };
  }

  private async miss(
    op: string,
    origin: AuditOrigin,
    reason: string,
    provenance: { x: number; y: number; space: "screen" } | undefined,
    element?: AxNode,
  ): Promise<ActResult> {
    this.trail.append({
      kind: "act",
      op,
      source: origin.source,
      raw: origin.raw,
      unresolved: { reason },
      provenance,
      os: element ? osOf(element) : undefined,
    });
    return { unresolved: true, reason };
  }

  private snap(png: Buffer) {
    return {
      screenshot: "sha256:" + createHash("sha256").update(png).digest("hex"),
      url: `os://${this.bundle}`,
      dom: [],
      ax: [],
    };
  }

  private async screen(): Promise<{ w: number; h: number }> {
    if (this.size && this.size.w > 0) return this.size;
    const geom = (await this.helper.nodes(this.bundle)).geometry;
    this.size = { w: geom?.screen_w ?? 0, h: geom?.screen_h ?? 0 };
    return this.size;
  }

  private async shot(): Promise<Buffer> {
    const file = path.join(this.work, `cap-${Date.now()}.png`);
    await this.helper.shot(this.bundle, file);
    const png = await readFile(file);
    await rm(file, { force: true });
    return png;
  }
}

function isTextRole(role: string): boolean {
  return role === "AXTextArea" || role === "AXTextField" || role === "AXTextView" || role === "AXSearchField" || role === "AXComboBox";
}

function osOf(node: AxNode) {
  return {
    platform: "macos" as const,
    app: node.app,
    role: node.role,
    subrole: node.subrole || undefined,
    name: node.name,
    title: node.title || undefined,
    description: node.description || undefined,
    identifier: node.identifier || undefined,
    path: node.path.map((seg) => ({ role: seg.role, name: seg.name })),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
