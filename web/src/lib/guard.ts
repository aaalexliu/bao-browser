// What may leave the device. A secret-tagged value, a cookie, or an unredacted
// screenshot fails the check. Private sync may still carry a non-secret literal
// such as a username. Sharing and publishing clear personal values separately.

import { redactedPng } from "./png";

export class SyncRejected extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SyncRejected";
  }
}

const COOKIE_KEY = /^(cookie|cookies|set-cookie|setcookie)$/i;
const DROP_KEY = /^(cookie|cookies|set-cookie|setcookie|authorization|proxy-authorization|args|params)$/i;

export interface SyncShot {
  stepId: string;
  png: string;
  redacted: true;
}

export interface SyncPush {
  baseVersion: number;
  document: unknown;
  heal?: unknown;
  shots: SyncShot[];
  category?: string;
}

export interface SyncRun {
  id: string;
  status: string;
  at: number;
  steps: { id: string; status: string }[];
  shots: SyncShot[];
}

interface WorkflowLike {
  inputs?: { name?: string; type?: string; default?: string; value?: string }[];
  steps?: { id?: string; sensitive?: boolean; value?: string; input?: string }[];
}

export function assertSyncSafe(payload: unknown): void {
  const names = secretNames(payload);
  const problems: string[] = [];
  scan(payload, names, problems);
  if (problems.length) throw new SyncRejected(problems[0] || "rejected");
}

export function buildPushBody(
  document: unknown,
  opts: { baseVersion: number; heal?: unknown; category?: string },
): SyncPush {
  const secrets = collectSecretStrings(document, opts.heal);
  const cleaned = stripUnsafe(structuredClone(document), secrets) as WorkflowLike;
  const heal = opts.heal === undefined ? undefined : stripUnsafe(structuredClone(opts.heal), secrets);
  const steps = Array.isArray(cleaned.steps) ? cleaned.steps : [];
  const shots: SyncShot[] = steps.map((step, index) => ({
    stepId: String(step.id ?? index),
    png: redactedPng(index + 1).toString("base64"),
    redacted: true,
  }));
  const body: SyncPush = {
    baseVersion: opts.baseVersion,
    document: cleaned,
    shots,
    category: opts.category,
  };
  if (heal !== undefined) body.heal = heal;
  assertSyncSafe(body);
  assertNoSecrets(body, secrets);
  return body;
}

export function buildRunBody(run: {
  id: string;
  status: string;
  at: number;
  steps?: { id?: string; status?: string }[];
}): SyncRun {
  const steps = (run.steps ?? []).map((step, index) => ({
    id: String(step.id ?? index),
    status: String(step.status ?? ""),
  }));
  const body: SyncRun = {
    id: run.id,
    status: run.status,
    at: run.at,
    steps,
    shots: steps.map((step, index) => ({
      stepId: step.id,
      png: redactedPng(index + 1).toString("base64"),
      redacted: true,
    })),
  };
  assertSyncSafe(body);
  return body;
}

export function stripUnsafe(value: unknown, secrets: string[]): unknown {
  const walk = (current: unknown): unknown => {
    if (typeof current === "string") {
      let out = current;
      for (const secret of secrets) {
        if (secret) out = out.split(secret).join("");
      }
      return out;
    }
    if (Array.isArray(current)) return current.map(walk);
    if (!current || typeof current !== "object") return current;
    const obj = current as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(obj)) {
      if (DROP_KEY.test(key) || key === "screenshot") continue;
      next[key] = walk(child);
    }
    if (next.type === "secret") {
      delete next.default;
      delete next.value;
    }
    if (next.sensitive === true && typeof next.value === "string" && !next.value.includes("{{")) {
      delete next.value;
    }
    return next;
  };
  return walk(value);
}

function secretNames(payload: unknown): Set<string> {
  const names = new Set<string>();
  walkObjects(payload, (obj) => {
    if (obj.type === "secret" && typeof obj.name === "string") names.add(obj.name);
  });
  return names;
}

function collectSecretStrings(document: unknown, heal: unknown): string[] {
  const found = new Set<string>();
  const take = (value: unknown) => {
    if (typeof value === "string" && value) found.add(value);
  };
  walkObjects(document, (obj) => {
    if (obj.type === "secret") {
      take(obj.default);
      take(obj.value);
    }
  });
  walkObjects(heal, (obj) => {
    if (obj.type === "secret") {
      take(obj.default);
      take(obj.value);
    }
  });
  return [...found];
}

function scan(value: unknown, names: Set<string>, problems: string[], key?: string): void {
  if (key && COOKIE_KEY.test(key)) {
    problems.push("cookie");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scan(item, names, problems, key);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  if (obj.type === "secret") {
    if (nonEmpty(obj.default) || nonEmpty(obj.value)) problems.push("secret param");
  }
  if (obj.sensitive === true && typeof obj.value === "string" && obj.value && !obj.value.includes("{{")) {
    problems.push("secret literal");
  }
  if ((key === "args" || key === "params" || key === "values") && !Array.isArray(value)) {
    for (const [name, child] of Object.entries(obj)) {
      if (names.has(name) && nonEmpty(child)) problems.push("secret param");
    }
  }
  if (typeof obj.png === "string" && obj.png && obj.redacted !== true) problems.push("unredacted screenshot");
  if (typeof obj.screenshot === "string" && obj.screenshot && obj.redacted !== true) problems.push("unredacted screenshot");
  for (const [childKey, child] of Object.entries(obj)) {
    if (COOKIE_KEY.test(childKey)) {
      problems.push("cookie");
      continue;
    }
    scan(child, names, problems, childKey);
  }
}

function assertNoSecrets(payload: unknown, secrets: string[]): void {
  const blob = JSON.stringify(payload);
  for (const secret of secrets) {
    if (secret && blob.includes(secret)) throw new SyncRejected("secret param");
  }
}

function nonEmpty(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function walkObjects(value: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  visit(obj);
  for (const child of Object.values(obj)) walkObjects(child, visit);
}
