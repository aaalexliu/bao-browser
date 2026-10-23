// One model pass when a recording is saved. The deterministic title is the floor.
// A missing key, a bad reply, or a timeout leaves that title and does not fail the save.
// The result is stored on the workflow so the pass does not run again.

import { isSensitiveValue } from "../../../src/mask";
import type { WorkflowV2 } from "./schema";
import { primaryHost, type NameSource } from "./workflow-name";

export interface SaveCompleter {
  provider: string;
  model: string;
  complete(prompt: string): Promise<string>;
}

export interface SaveIntentSource extends NameSource {
  floorTitle: string;
  groups?: { beforeUrl?: string; afterUrl?: string }[][];
}

export interface PromptStep {
  id: string;
  action: string;
  url?: string;
  label?: string;
}

const SAVE_TIMEOUT_MS = 8000;

export function secretValues(events: { sensitive?: boolean; value?: string; dialogValue?: string; identity?: { role?: string } }[]): string[] {
  const out: string[] = [];
  const add = (value: string | undefined, force: boolean) => {
    if (!value || value.length < 4 || out.includes(value)) return;
    if (force || isSensitiveValue(value) || /\d{6,}/.test(value)) out.push(value);
  };
  for (const event of events) {
    const password = !!event.sensitive || event.identity?.role === "password";
    add(event.value, password);
    add(event.dialogValue, false);
  }
  return out;
}

export function redactModelText(text: string, secrets: string[]): string {
  let out = text;
  const ordered = secrets.filter((secret) => secret.length >= 4).sort((a, b) => b.length - a.length);
  for (const secret of ordered) out = out.split(secret).join("[redacted]");
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted]");
  out = out.replace(/\d{6,}/g, "[code]");
  return out;
}

export function saveIntentPrompt(input: {
  floorTitle: string;
  host?: string;
  pageTitle?: string;
  steps: PromptStep[];
  secrets?: string[];
}): string {
  const secrets = input.secrets || [];
  const lines = input.steps.map((step) => {
    const url = redactModelText(step.url || "-", secrets);
    const label = redactModelText(step.label || "-", secrets);
    return [step.id, step.action, url, label].join(" | ");
  });
  const page = input.pageTitle ? redactModelText(input.pageTitle, secrets) : "";
  return [
    "Name this recorded workflow and say what the person is doing.",
    "Reply with JSON only: {\"title\":\"short human title\",\"summary\":\"one line of what this does\",\"intent\":\"what the user is trying to accomplish\",\"steps\":[{\"id\":\"id\",\"intent\":\"one sentence\"}]}",
    "title is a short name. summary is one line. intent is the goal. Every step id is listed once.",
    "Do not include a password, a pin, a secret, or a numeric code.",
    `Deterministic title: ${redactModelText(input.floorTitle, secrets)}`,
    `Host: ${input.host || "-"}`,
    page ? `Page title: ${page}` : "",
    "id | action | url | visible label",
    ...lines,
  ].filter(Boolean).join("\n");
}

export function cleanSaveField(value: unknown, secrets: string[], max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text === "Captured workflow") return "";
  if (secrets.some((secret) => secret.length >= 4 && text.includes(secret))) return "";
  if (/\d{6,}/.test(text) || isSensitiveValue(text)) return "";
  return text.slice(0, max);
}

export function applySaveEdits(
  workflow: WorkflowV2,
  edits: { name?: string; summary?: string; intent?: string },
  secrets: string[] = [],
  floor = "",
): WorkflowV2 {
  const next: WorkflowV2 = {
    ...workflow,
    steps: workflow.steps.map((step) => ({ ...step })),
    updatedAt: Date.now(),
  };
  const name = cleanSaveField(edits.name ?? "", secrets, 80);
  const current = workflow.name && workflow.name !== "Captured workflow" ? workflow.name : "";
  const floorName = floor && floor !== "Captured workflow" ? floor : "";
  next.name = name || current || floorName || "Untitled workflow";
  if ("summary" in edits) {
    const summary = cleanSaveField(edits.summary ?? "", secrets, 200);
    if (summary) next.summary = summary;
    else delete next.summary;
  }
  if ("intent" in edits) {
    const intent = cleanSaveField(edits.intent ?? "", secrets, 280);
    if (intent) next.intent = intent;
    else delete next.intent;
  }
  return next;
}

export async function inferSavedWorkflow(
  workflow: WorkflowV2,
  source: SaveIntentSource,
  completer: SaveCompleter | null,
  now = Date.now(),
): Promise<WorkflowV2> {
  if (workflow.inference) return workflow;
  const secrets = source.secrets || [];
  const floor = source.floorTitle && source.floorTitle !== "Captured workflow"
    ? source.floorTitle
    : (workflow.name && workflow.name !== "Captured workflow" ? workflow.name : "Untitled workflow");
  const base: WorkflowV2 = stripSecrets({ ...workflow, name: floor }, secrets);
  const skipped = (provider: string, model: string): WorkflowV2 => ({
    ...base,
    inference: { at: now, provider, model, status: "skipped" },
  });
  if (!completer) return skipped("none", "");
  const prompt = saveIntentPrompt({
    floorTitle: floor,
    host: primaryHost(source),
    pageTitle: source.pageTitle,
    steps: promptSteps(workflow, source.groups, secrets),
    secrets,
  });
  let text = "";
  try {
    text = await withTimeout(completer.complete(prompt), SAVE_TIMEOUT_MS);
  } catch {
    return skipped(completer.provider, completer.model);
  }
  const parsed = parseSaveIntent(text, new Set(workflow.steps.map((step) => step.id)), secrets);
  if (!parsed) return skipped(completer.provider, completer.model);
  const next: WorkflowV2 = {
    ...base,
    name: parsed.title || floor,
    steps: base.steps.map((step) => {
      const intent = parsed.steps.get(step.id);
      return intent ? { ...step, intent } : step;
    }),
    inference: { at: now, provider: completer.provider, model: completer.model, status: "ok" },
  };
  if (parsed.summary) next.summary = parsed.summary;
  else delete next.summary;
  if (parsed.intent) next.intent = parsed.intent;
  else delete next.intent;
  return stripSecrets(next, secrets);
}

function promptSteps(
  workflow: WorkflowV2,
  groups: { beforeUrl?: string; afterUrl?: string }[][] | undefined,
  secrets: string[],
): PromptStep[] {
  return workflow.steps.map((step, index) => {
    const group = groups?.[index] || [];
    const event = [...group].reverse().find((item) => item.afterUrl || item.beforeUrl);
    const visible = [step.identity?.name, step.identity?.text, step.identity?.label, step.label]
      .filter((item): item is string => typeof item === "string" && !!item.trim() && !leaks(item, secrets))
      .join(" · ");
    return {
      id: step.id,
      action: step.action,
      url: event?.afterUrl || event?.beforeUrl || "",
      label: visible || step.action,
    };
  });
}

const STRUCTURAL = new Set(["id", "action", "input", "key", "surface", "role", "kind", "schema", "op", "tag", "type", "provider", "model", "status"]);

/** Drop a known secret from stored text. Structural fields such as action and id stay. */
function stripSecrets(workflow: WorkflowV2, secrets: string[]): WorkflowV2 {
  const list = secrets.filter((secret) => secret.length >= 4).sort((a, b) => b.length - a.length);
  if (!list.length) return workflow;
  const steps = workflow.steps.map((step) => replaceSecrets(step, list, "") as WorkflowV2["steps"][number]);
  return steps.every((step, index) => step === workflow.steps[index]) ? workflow : { ...workflow, steps };
}

function replaceSecrets(value: unknown, secrets: string[], key: string): unknown {
  if (typeof value === "string") {
    if (STRUCTURAL.has(key) || !secrets.some((secret) => value.includes(secret))) return value;
    let out = value;
    for (const secret of secrets) out = out.split(secret).join("[redacted]");
    return out;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const child = replaceSecrets(item, secrets, "");
      if (child !== item) changed = true;
      return child;
    });
    return changed ? next : value;
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [childKey, item] of Object.entries(value as Record<string, unknown>)) {
      const child = replaceSecrets(item, secrets, childKey);
      if (child !== item) changed = true;
      out[childKey] = child;
    }
    return changed ? out : value;
  }
  return value;
}

function leaks(text: string, secrets: string[]): boolean {
  if (secrets.some((secret) => secret.length >= 4 && text.includes(secret))) return true;
  if (/\d{6,}/.test(text)) return true;
  return isSensitiveValue(text);
}

function parseSaveIntent(
  text: string,
  ids: ReadonlySet<string>,
  secrets: string[],
): { title: string; summary: string; intent: string; steps: Map<string, string> } | null {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    const body = JSON.parse(text.slice(start, end + 1)) as {
      title?: unknown;
      summary?: unknown;
      intent?: unknown;
      steps?: unknown;
    };
    const title = cleanSaveField(body.title, secrets, 80);
    const summary = cleanSaveField(body.summary, secrets, 200);
    const intent = cleanSaveField(body.intent, secrets, 280);
    const steps = new Map<string, string>();
    if (Array.isArray(body.steps)) {
      for (const item of body.steps) {
        if (!item || typeof item !== "object") continue;
        const row = item as { id?: unknown; intent?: unknown };
        if (typeof row.id !== "string" || !ids.has(row.id)) continue;
        const line = cleanSaveField(row.intent, secrets, 240);
        if (line) steps.set(row.id, line);
      }
    }
    if (!title && !summary && !intent && !steps.size) return null;
    return { title, summary, intent, steps };
  } catch {
    return null;
  }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("model timed out")), ms);
    work.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
