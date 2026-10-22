// Apply a model's edit on top of a deterministic workflow.
// The model may drop a noise step, write intent text, and flag human steps.
// It cannot add a step, change an input, or clear a secret or gate tag.

import type { WorkflowStep, WorkflowV2 } from "./schema";

export interface HybridHuman {
  id: string;
  gate: "login" | "confirm";
}

export interface HybridEdit {
  drop: string[];
  summary: string;
  intents: Map<string, string>;
  human: HybridHuman[];
  ignored: string[];
}

export interface HybridApplied {
  workflow: WorkflowV2;
  refused: string[];
  ignored: string[];
  human: HybridHuman[];
  rewritten: boolean;
}

export function readHybrid(raw: unknown, allowed: ReadonlySet<string>): HybridEdit {
  if (!raw || typeof raw !== "object") throw new Error("hybrid JSON is not an object");
  const body = raw as { drop?: unknown; summary?: unknown; steps?: unknown; human?: unknown };
  const ignored: string[] = [];
  const drop = strings(body.drop).filter((id) => {
    if (allowed.has(id)) return true;
    ignored.push(id);
    return false;
  });
  const intents = new Map<string, string>();
  if (body.steps != null && !Array.isArray(body.steps)) throw new Error("hybrid steps is not a list");
  for (const item of Array.isArray(body.steps) ? body.steps : []) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; intent?: unknown };
    if (typeof row.id !== "string") continue;
    if (!allowed.has(row.id)) {
      ignored.push(row.id);
      continue;
    }
    if (typeof row.intent === "string") intents.set(row.id, row.intent);
  }
  const human = humans(body.human).filter((mark) => {
    if (allowed.has(mark.id)) return true;
    ignored.push(mark.id);
    return false;
  });
  for (const item of Array.isArray(body.steps) ? body.steps : []) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; human?: unknown };
    if (typeof row.id !== "string" || !allowed.has(row.id)) continue;
    if (row.human !== "login" && row.human !== "confirm") continue;
    const gate: "login" | "confirm" = row.human;
    if (!human.some((mark) => mark.id === row.id && mark.gate === gate)) human.push({ id: row.id, gate });
  }
  return {
    drop,
    summary: typeof body.summary === "string" ? body.summary : "",
    intents,
    human,
    ignored,
  };
}

export function parseHybrid(text: string, allowed: ReadonlySet<string>): HybridEdit {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return JSON");
  return readHybrid(JSON.parse(text.slice(start, end + 1)), allowed);
}

export function applyHybrid(base: WorkflowV2, raw: unknown, secrets: string[]): HybridApplied {
  const allowed = new Set(base.steps.map((step) => step.id));
  const edit = readHybrid(raw, allowed);
  const byId = new Map(base.steps.map((step) => [step.id, step]));
  const refused: string[] = [];
  const dropping = new Set<string>();
  for (const id of edit.drop) {
    const step = byId.get(id);
    if (!step || !isNoiseStep(step)) {
      refused.push(id);
      continue;
    }
    dropping.add(id);
  }
  const replacements = literals(base, secrets);
  let rewritten = false;
  const scrub = (text: string) => {
    const next = scrubText(text, replacements);
    if (next !== text) rewritten = true;
    return next;
  };
  const workflow = structuredClone(base);
  workflow.inputs = base.inputs.map((input) => ({ ...input }));
  workflow.summary = scrub(edit.summary);
  workflow.steps = base.steps.filter((step) => !dropping.has(step.id)).map((step, index) => {
    const intent = edit.intents.get(step.id);
    const copy = structuredClone(step);
    copy.index = index;
    copy.intent = scrub(intent && intent.trim() ? intent : step.label);
    copy.input = step.input;
    copy.value = step.value;
    copy.sensitive = step.sensitive;
    copy.gate = step.gate;
    return copy;
  });
  return { workflow, refused, ignored: edit.ignored, human: edit.human, rewritten };
}

export function isNoiseStep(step: WorkflowStep): boolean {
  if (step.input || step.sensitive || step.gate) return false;
  const effect = step.postcondition?.kind;
  if (effect === "text" || effect === "url" || effect === "value") return false;
  const name = [step.identity?.name, step.identity?.text, step.identity?.label, step.label].filter(Boolean).join(" ");
  return /\bhelp\b/i.test(name);
}

export function scrubText(text: string, replacements: { from: string; to: string }[]): string {
  const ordered = replacements.filter((item) => item.from).sort((a, b) => b.from.length - a.from.length);
  let out = text;
  for (const item of ordered) out = replaceToken(out, item.from, item.to);
  return out;
}

function literals(workflow: WorkflowV2, secrets: string[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  for (const secret of secrets) if (secret) out.push({ from: secret, to: "{{secret}}" });
  for (const input of workflow.inputs) {
    if (input.default) out.push({ from: input.default, to: `{{${input.name}}}` });
  }
  for (const step of workflow.steps) {
    if (step.action === "type" && step.value && !step.value.includes("{{")) {
      out.push({ from: step.value, to: "{{literal}}" });
    }
  }
  return out;
}

function replaceToken(text: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^[\p{L}\p{N}]+$/u.test(from)) {
    return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"), to);
  }
  return text.split(from).join(to);
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function humans(value: unknown): HybridHuman[] {
  if (!Array.isArray(value)) return [];
  const out: HybridHuman[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as { id?: unknown; gate?: unknown };
    if (typeof row.id !== "string") continue;
    if (row.gate !== "login" && row.gate !== "confirm") continue;
    const gate: "login" | "confirm" = row.gate;
    out.push({ id: row.id, gate });
  }
  return out;
}
