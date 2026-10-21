// Append-only capture trail. The workflow is derived from this. Replay never
// reads the trail. A later interpret pass can, because each event is one read
// or one act with the vendor payload and the element it resolved to.

import type { Step, Workflow } from "../../../src/types";
import type { RankedSelector } from "../page-fns";
import type { AxSnap, DomSnap } from "./neutral";

export interface AuditSource {
  agent: string;
  vendor: string;
  adapter: string;
}

/** What the adapter hands the executor with each call. */
export interface AuditOrigin {
  source: AuditSource;
  raw: unknown;
}

export interface AuditSnapshot {
  /** sha256 of the PNG. The bytes live in the transcript, not in the trail. */
  screenshot: string;
  url: string;
  dom: DomSnap[];
  ax: AxSnap[];
}

export interface ResolvedElement {
  tag: string;
  selectors: RankedSelector[];
  unique: boolean;
  text?: string;
}

export interface AuditEvent {
  id: string;
  ts: number;
  kind: "read" | "act";
  op: string;
  source: AuditSource;
  raw: unknown;
  before?: AuditSnapshot;
  after?: AuditSnapshot;
  resolved?: ResolvedElement | null;
  unresolved?: { reason: string };
  sensitive?: boolean;
  provenance?: { x: number; y: number; space: "viewport" | "image" | "screen" };
  /** Set when the act resolved against an OS accessibility element. */
  os?: {
    platform?: "linux" | "macos";
    app: string;
    role: string;
    subrole?: string;
    name: string;
    title?: string;
    description?: string;
    identifier?: string;
    path: { role: string; name?: string }[];
    value?: string;
  };
  /** sha256 of a screenshot crop kept for an unresolved pixel. */
  crop?: string;
  checked?: boolean;
  /** Playwright key name. Replay presses this, not a coordinate. */
  key?: string;
  /** Escape or Tab with no focused editable. A real step, not a miss. */
  pageLevel?: boolean;
  submits?: boolean;
  focus?: {
    scope: "element" | "page";
    editable: boolean;
    axRole?: string;
    axName?: string;
  };
}

export interface AuditLog {
  version: 1;
  events: AuditEvent[];
}

export class AuditTrail {
  readonly events: AuditEvent[] = [];
  private seq = 0;
  private last?: AuditSnapshot;

  currentId(): string {
    return this.events[this.events.length - 1]?.id ?? "";
  }

  lastSnapshot(): AuditSnapshot | undefined {
    return this.last;
  }

  append(partial: Omit<AuditEvent, "id" | "ts">): AuditEvent {
    const ev: AuditEvent = { id: `evt-${this.seq++}`, ts: Date.now(), ...partial };
    this.events.push(ev);
    if (ev.after) this.last = ev.after;
    else if (ev.before) this.last = ev.before;
    return ev;
  }

  /** Set before once, after the event is already the current id. */
  fillBefore(id: string, before: AuditSnapshot): void {
    const ev = this.events.find((e) => e.id === id);
    if (!ev) throw new Error(`no audit event ${id}`);
    if (ev.before) throw new Error(`audit event ${id} already has a before snapshot`);
    ev.before = before;
    if (!ev.after) this.last = before;
  }

  /** Set after once. The event was appended when it started; this closes it. */
  complete(id: string, after: AuditSnapshot): void {
    const ev = this.events.find((e) => e.id === id);
    if (!ev) throw new Error(`no audit event ${id}`);
    if (ev.after) throw new Error(`audit event ${id} already has an after snapshot`);
    ev.after = after;
    this.last = after;
  }

  log(): AuditLog {
    return { version: 1, events: this.events };
  }

  /** T1: a typed secret must not remain in earlier snapshots either. */
  redactSecret(secret: string): void {
    if (!secret) return;
    const walk = (v: unknown): unknown => {
      if (typeof v === "string") return v.split(secret).join("");
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        const out: Record<string, unknown> = {};
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = walk(child);
        return out;
      }
      return v;
    };
    for (let i = 0; i < this.events.length; i++) {
      this.events[i] = walk(this.events[i]) as AuditEvent;
    }
  }
}

/**
 * Drop a screenshot read whose image hash matches the previous screenshot read.
 * DOM and AX events between the two stay. Other events are not dropped.
 */
export function trimTrail(events: readonly AuditEvent[]): AuditEvent[] {
  let prevShot: string | undefined;
  const out: AuditEvent[] = [];
  for (const e of events) {
    if (e.kind === "read" && e.op === "screenshot") {
      const hash = e.after?.screenshot;
      if (hash && hash === prevShot) continue;
      if (hash) prevShot = hash;
    }
    out.push(e);
  }
  return out;
}

function typedText(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const text = (raw as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

function targetOf(e: AuditEvent): Step["target"] {
  if (!e.resolved) return undefined;
  return {
    selectors: e.resolved.selectors,
    reach: "light",
    unique: e.resolved.unique,
    text: e.sensitive ? undefined : e.resolved.text,
  };
}

function osAction(op: string): Step["action"] {
  if (op === "osClick") return "osClick";
  if (op === "osSetValue") return "osSetValue";
  return "osType";
}

function osPlatform(e: AuditEvent): "linux" | "macos" {
  if (e.os?.platform) return e.os.platform;
  if (e.os?.subrole || e.os?.identifier || e.os?.title || e.os?.description) return "macos";
  return "linux";
}

function osLabel(e: AuditEvent, action: Step["action"]): string {
  if (action === "osSetValue") return "Set value";
  if (action === "osType") return "Type";
  const name = e.os?.name;
  const role = e.os?.role || "control";
  if (osPlatform(e) === "macos") return `Press ${name || role}`;
  return name ? `Click "${name}"` : `Click ${role}`;
}

/** Workflow version 2, from act events only. Reads are not steps. */
export function deriveWorkflow(
  events: readonly AuditEvent[],
  startUrl: string,
  opts?: { id?: string; name?: string },
): Workflow {
  const id = opts?.id ?? "wf-proxy-openai";
  const steps: Step[] = [];
  for (const e of events) {
    if (e.kind !== "act") continue;
    if (e.op === "osClick" || e.op === "osType" || e.op === "osSetValue") {
      const action = osAction(e.op);
      const osBase: Step = {
        ts: e.ts,
        action,
        label: e.op,
        surface: "os",
        provenance: e.provenance,
      };
      if (e.unresolved || !e.os) {
        steps.push({
          ...osBase,
          label: `Unresolved ${e.op}`,
          unresolved: e.unresolved ?? { reason: "unresolved" },
        });
        continue;
      }
      const platform = osPlatform(e);
      steps.push({
        ...osBase,
        label: osLabel(e, action),
        os: {
          target: {
            platform,
            app: e.os.app,
            role: e.os.role,
            subrole: e.os.subrole,
            name: e.os.name,
            title: e.os.title,
            description: e.os.description,
            identifier: e.os.identifier,
            path: e.os.path,
          },
          value: e.sensitive ? undefined : e.os.value,
        },
        sensitive: e.sensitive || undefined,
      });
      continue;
    }
    const frameUrl = e.after?.url || e.before?.url || startUrl;
    const base: Step = {
      ts: e.ts,
      action: "click",
      label: e.op,
      surface: "dom",
      frame: { url: frameUrl, top: true },
      provenance: e.provenance,
    };
    if (e.op === "type") {
      steps.push({
        ...base,
        action: "input",
        label: e.sensitive ? "Type (withheld)" : "Type",
        sensitive: e.sensitive || undefined,
        value: e.sensitive ? undefined : typedText(e.raw),
        target: e.resolved ? targetOf(e) : undefined,
        unresolved: e.resolved ? undefined : e.unresolved,
      });
      continue;
    }
    if (e.op === "keypress" && e.pageLevel && e.key) {
      steps.push({
        ...base,
        action: "keypress",
        key: e.key,
        label: `Press ${e.key}`,
        provenance: undefined,
      });
      continue;
    }
    if (e.op === "keypress" && e.resolved && e.key && !e.unresolved) {
      steps.push({
        ...base,
        action: "keypress",
        key: e.key,
        label: `Press ${e.key}`,
        target: targetOf(e),
        submits: e.submits || undefined,
        provenance: undefined,
      });
      continue;
    }
    if (e.unresolved || !e.resolved) {
      steps.push({
        ...base,
        action: e.op === "keypress" ? "keypress" : "click",
        label: `Unresolved ${e.op}`,
        unresolved: e.unresolved ?? { reason: "unresolved" },
      });
      continue;
    }
    if (typeof e.checked === "boolean") {
      steps.push({
        ...base,
        action: "setChecked",
        label: e.checked ? "Set checkbox checked" : "Set checkbox unchecked",
        checked: e.checked,
        target: {
          selectors: e.resolved.selectors,
          reach: "light",
          unique: e.resolved.unique,
          text: e.resolved.text,
        },
      });
      continue;
    }
    steps.push({
      ...base,
      action: "click",
      label: e.resolved.text ? `Click "${e.resolved.text}"` : `Click ${e.resolved.tag}`,
      target: {
        selectors: e.resolved.selectors,
        reach: "light",
        unique: e.resolved.unique,
        text: e.resolved.text,
      },
    });
  }
  const createdAt = events[0]?.ts ?? Date.now();
  return {
    id,
    name: opts?.name ?? "Proxy spike — checkboxes",
    version: 2,
    startUrl,
    variables: [],
    createdAt,
    steps: steps.map((s, i) => ({ ...s, id: `${id}-${i}`, index: i })),
  };
}
