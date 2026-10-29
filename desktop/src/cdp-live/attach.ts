import { spawn, type ChildProcess } from "node:child_process";
import { WORKFLOW_SCHEMA_ID, type WorkflowStep, type WorkflowV2 } from "../v1/schema";
import { lockIsStale as lockFileIsStale, parseLock } from "./lock";

export const LOCK_STALE_MS = 20 * 60 * 1000;

export function parseLockText(text: string): { agent: string; startedAt: number } | null {
  const parsed = parseLock(text);
  if (!parsed || !/^[\w.-]+$/.test(parsed.agentId)) return null;
  return { agent: parsed.agentId, startedAt: parsed.startedAt };
}

export function lockIsStale(startedAt: number, now: number, staleMs = LOCK_STALE_MS): boolean {
  return lockFileIsStale(startedAt, now, staleMs);
}

export function keepAwake(): ChildProcess {
  const child = spawn("/usr/bin/caffeinate", ["-ims", "-w", String(process.pid)], { stdio: "ignore" });
  child.unref();
  child.on("error", () => undefined);
  return child;
}

export function releaseAwake(child: ChildProcess | undefined): void {
  if (!child || child.killed || child.exitCode != null) return;
  child.kill("SIGTERM");
}

export interface ExistingPage {
  targetId: string;
  host: string;
  path: string;
}

export function normalizePath(pathname: string): string {
  if (!pathname) return "/";
  const trimmed = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return trimmed || "/";
}

/** The one already-open page whose host and pathname match. Two matches is not a guess. */
export function pickExistingPage<T extends ExistingPage>(
  pages: readonly T[],
  hosts: readonly string[],
  attachPath: string,
): { page: T | null; matches: number } {
  const want = normalizePath(attachPath);
  const matches = pages.filter((page) => hosts.includes(page.host) && normalizePath(page.path) === want);
  if (matches.length !== 1) return { page: null, matches: matches.length };
  return { page: matches[0] || null, matches: 1 };
}

export function attachPathMatches(start: string, attachPath: string): boolean {
  try {
    return normalizePath(new URL(start).pathname) === normalizePath(attachPath);
  } catch {
    return false;
  }
}

export interface AuditClick {
  name: string;
  path: string;
  label: string;
  kind: string;
}

export interface LiveAction {
  name: "click" | "type";
  label: string;
  path: string;
  kind: string;
  value?: string;
}

/** A saved live run. Each typed field is preceded by a human confirm, which replay does not type. */
export function workflowFromLive(input: {
  id: string;
  name: string;
  intent: string;
  startUrl: string;
  createdAt: number;
  actions: readonly LiveAction[];
}): WorkflowV2 {
  const steps: WorkflowStep[] = [];
  for (const action of input.actions) {
    if (!action.label) continue;
    if (action.name === "type") {
      steps.push({
        id: `${input.id}-confirm-${steps.length}`,
        index: steps.length,
        action: "confirm",
        label: `Confirm before typing into ${action.label}`.slice(0, 120),
        surface: "dom",
        human: true,
        heal: "never",
        timeoutMs: 0,
        intent: "A person confirms this write",
      });
    }
    const role = action.kind === "link" ? "link" : action.name === "type" ? "textbox" : "button";
    const index = steps.length;
    const step: WorkflowStep = {
      id: `${input.id}-${index}`,
      index,
      action: action.name === "type" ? "type" : "click",
      label: action.name === "type" ? `Type into ${action.label}` : `Click ${action.label}`,
      surface: "dom",
      timeoutMs: 8000,
      heal: "never",
      identity: { surface: "dom", role, name: action.label, path: [] },
      locators: [{ kind: "role", role, name: action.label }],
    };
    if (action.name === "type" && action.value && !action.value.startsWith("/") && !action.value.startsWith("~/")) {
      step.value = action.value.slice(0, 80);
    }
    steps.push(step);
  }
  return {
    schema: WORKFLOW_SCHEMA_ID,
    version: 2,
    id: input.id,
    name: input.name,
    startUrl: input.startUrl,
    inputs: [],
    steps,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    heal: "approve",
    driver: "cdp-live",
    intent: input.intent,
    summary: "Local draft. Recorded in the open Chrome. A person confirms each typed field.",
  };
}

/** A local v2 draft. The last step is a human confirm, which replay does not click. */
export function workflowFromAudit(input: {
  id: string;
  name: string;
  intent: string;
  startUrl: string;
  createdAt: number;
  steps: readonly AuditClick[];
  confirmLabel: string;
}): WorkflowV2 {
  const clicks = input.steps.filter((step) => step.name === "click" && step.label);
  const steps: WorkflowStep[] = clicks.map((step, index) => {
    const role = step.kind === "link" ? "link" : "button";
    return {
      id: `${input.id}-${index}`,
      index,
      action: "click" as const,
      label: `Click ${step.label}`,
      surface: "dom" as const,
      timeoutMs: 8000,
      heal: "never" as const,
      identity: { surface: "dom" as const, role, name: step.label, path: [] },
      locators: [{ kind: "role" as const, role, name: step.label }],
      postcondition: step.path ? { kind: "url" as const, match: step.path, timeoutMs: 8000 } : undefined,
    };
  });
  if (input.confirmLabel) {
    steps.push({
      id: `${input.id}-confirm`,
      index: steps.length,
      action: "confirm",
      label: `Stop before ${input.confirmLabel}`,
      surface: "dom",
      human: true,
      heal: "never",
      timeoutMs: 0,
      intent: "Do not click this control",
    });
  }
  return {
    schema: WORKFLOW_SCHEMA_ID,
    version: 2,
    id: input.id,
    name: input.name,
    startUrl: input.startUrl,
    inputs: [],
    steps,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    heal: "approve",
    driver: "cdp-live",
    intent: input.intent,
    summary: "Local draft. Recorded inside the already open tab. The confirm control was not clicked.",
  };
}

/** Blurs likely personal text in the page and returns only a count. */
export function redactForShot(): number {
  const styleId = "bao-redact-style";
  let style = document.getElementById(styleId);
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    style.textContent = "[data-bao-redact='1']{filter:blur(18px) !important;}";
    document.documentElement.appendChild(style);
  }
  let count = 0;
  const seen = new Set<Element>();
  const mark = (el: Element): void => {
    if (seen.has(el)) return;
    seen.add(el);
    el.setAttribute("data-bao-redact", "1");
    count += 1;
  };
  const textOf = (el: Element): string => ((el as HTMLElement).innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  const secret = (text: string): boolean => {
    if (!text || text.length > 180) return false;
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return true;
    if (/\b\d{3}-\d{2}-\d{4}\b/.test(text)) return true;
    if (/\$\s?\d/.test(text)) return true;
    if (/\b\d{3}[-.)]\s*\d{3}[-.)]\s*\d{4}\b/.test(text)) return true;
    if (/\b(?:street|avenue|ave|road|boulevard|blvd|lane|drive|apt|suite)\b/i.test(text) && /\d/.test(text)) return true;
    if (/\b\d{5}(?:-\d{4})?\b/.test(text) && /[A-Za-z]{2,}/.test(text)) return true;
    if (/\b(?:ssn|social security|credit score|vantagescore|fico)\b/i.test(text)) return true;
    if (/^(?:hi|hello|welcome)\b/i.test(text)) return true;
    return false;
  };
  const control = (el: Element): boolean => {
    const role = (el.getAttribute("role") || "").toLowerCase();
    return el.tagName === "BUTTON" || el.tagName === "A" || role === "button" || role === "link";
  };
  const walk = (root: ParentNode): void => {
    for (const el of root.querySelectorAll("*")) {
      if (!(el instanceof Element)) continue;
      if (el.shadowRoot) walk(el.shadowRoot);
      const className = typeof (el as HTMLElement).className === "string" ? (el as HTMLElement).className : "";
      const blob = `${el.getAttribute("aria-label") || ""} ${el.id || ""} ${className}`;
      if (/score|balance|ssn|address|member-name|account-name|profile-name/i.test(blob)) {
        mark(el);
        continue;
      }
      if (el instanceof HTMLInputElement && el.value && !/^(button|submit|search|hidden|checkbox|radio)$/i.test(el.type)) {
        mark(el);
        continue;
      }
      const text = textOf(el);
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (control(el)) {
        if (secret(text)) mark(el);
        continue;
      }
      if (el.childElementCount === 0 && secret(text)) mark(el);
      else if (el.childElementCount === 0 && /^\d{3}$/.test(text) && rect.height >= 20) mark(el);
    }
  };
  walk(document);
  return count;
}

export function clearRedact(): number {
  document.getElementById("bao-redact-style")?.remove();
  let count = 0;
  const walk = (root: ParentNode): void => {
    for (const el of root.querySelectorAll("[data-bao-redact]")) {
      el.removeAttribute("data-bao-redact");
      count += 1;
    }
    for (const el of root.querySelectorAll("*")) {
      if (el instanceof Element && el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  return count;
}
