import { isSealedArtifact, scrubSaved, STRIPPED_SECRET, type SavedContext } from "../../../shared/saved-secrets";
import { isElementCrop } from "./png";

const DROP_KEY = /^(cookie|cookies|set-cookie|setcookie|authorization|proxy-authorization|args|params)$/i;

export interface SyncShot {
  stepId: string;
  png: string;
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

export function buildPushBody(
  document: unknown,
  opts: { baseVersion: number; heal?: unknown; category?: string; crops?: { stepId: string; png: Buffer }[] },
): SyncPush {
  const secrets = collectSecretStrings(document, opts.heal);
  const copy = stripUnsafe(document, secrets) as { inputs?: { name?: string; type?: string }[]; steps?: { id?: string; sensitive?: boolean; input?: string }[] };
  const body: SyncPush = {
    baseVersion: opts.baseVersion,
    document: copy,
    shots: stepShots(Array.isArray(copy.steps) ? copy.steps : [], opts.crops, copy.inputs),
    category: opts.category,
  };
  if (opts.heal !== undefined) body.heal = stripUnsafe(opts.heal, secrets, { workflow: document as SavedContext["workflow"] });
  return body;
}

export function buildRunBody(
  run: {
    id: string;
    status: string;
    at: number;
    steps?: { id?: string; status?: string }[];
  },
  opts: { crops?: { stepId: string; png: Buffer }[] } = {},
): SyncRun {
  const steps = (run.steps ?? []).map((step, index) => ({
    id: String(step.id ?? index),
    status: String(step.status ?? ""),
  }));
  return {
    id: run.id,
    status: run.status,
    at: run.at,
    steps,
    shots: stepShots(steps, opts.crops),
  };
}

function stepShots(
  steps: { id?: string; sensitive?: boolean; input?: string }[],
  crops: { stepId: string; png: Buffer }[] | undefined,
  inputs: { name?: string; type?: string }[] = [],
): SyncShot[] {
  const secrets = new Set(inputs.filter((input) => input.type === "secret").map((input) => input.name));
  const byId = new Map((crops ?? []).map((crop) => [crop.stepId, crop.png]));
  const shots: SyncShot[] = [];
  steps.forEach((step, index) => {
    if (step.sensitive || (step.input && secrets.has(step.input))) return;
    const id = String(step.id ?? index);
    const png = byId.get(id);
    if (png && isElementCrop(png)) shots.push({ stepId: id, png: png.toString("base64") });
  });
  return shots;
}

export function stripUnsafe(value: unknown, secrets: string[] = [], context?: SavedContext): unknown {
  const walk = (current: unknown): unknown => {
    if (isSealedArtifact(current)) return structuredClone(current);
    if (Array.isArray(current)) return current.map(walk);
    if (!current || typeof current !== "object") return current;
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current)) {
      if (DROP_KEY.test(key)) continue;
      next[key] = walk(child);
    }
    if (next.type === "secret") {
      delete next.default;
      delete next.value;
    }
    if (next.sensitive === true && typeof next.value === "string" && !next.value.includes("{{")) delete next.value;
    return next;
  };
  return walk(scrubSaved(value, { ...context, secrets }));
}

function collectSecretStrings(document: unknown, heal: unknown): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (obj.type === "secret") {
      for (const value of [obj.default, obj.value]) if (typeof value === "string" && value && value !== STRIPPED_SECRET) found.add(value);
    }
    Object.values(obj).forEach(walk);
  };
  walk(document);
  walk(heal);
  return [...found];
}
