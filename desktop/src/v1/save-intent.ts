// One model pass when a recording is saved. The deterministic title is the floor.
// The logged-in Cursor account answers first. A vendor key is the fallback.
// No provider, a bad reply, or a timeout leaves that title and does not fail the save.
// The result is stored on the workflow so the pass does not run again.

import { completeFor, saveModel } from "../eval/intent/model";
import { askCursorAgent, readCursorAccount, realCursorAgent, type CursorAgentRun } from "./cursor-account";
import { projectStep } from "./schema";
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

export function saveIntentPrompt(input: {
  floorTitle: string;
  host?: string;
  pageTitle?: string;
  steps: PromptStep[];
}): string {
  const lines = input.steps.map((step) => [step.id, step.action, step.url || "-", step.label || "-"].join(" | "));
  const page = input.pageTitle || "";
  return [
    "Name this recorded workflow and say what the person is doing.",
    "Reply with JSON only: {\"title\":\"short human title\",\"summary\":\"one line of what this does\",\"intent\":\"what the user is trying to accomplish\",\"steps\":[{\"id\":\"id\",\"intent\":\"one sentence\"}]}",
    "title is a short name. summary is one line. intent is the goal. Every step id is listed once.",
    `Deterministic title: ${input.floorTitle}`,
    `Host: ${input.host || "-"}`,
    page ? `Page title: ${page}` : "",
    "id | action | url | visible label",
    ...lines,
  ].filter(Boolean).join("\n");
}

export function cleanSaveField(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/g, " ").trim();
  if (!text || text === "Captured workflow") return "";
  return text.slice(0, max);
}

export function applySaveEdits(
  workflow: WorkflowV2,
  edits: { name?: string; summary?: string; intent?: string },
  floor = "",
): WorkflowV2 {
  const next: WorkflowV2 = {
    ...workflow,
    steps: workflow.steps.map((step) => ({ ...step })),
    updatedAt: Date.now(),
  };
  const name = cleanSaveField(edits.name ?? "", 80);
  const current = workflow.name && workflow.name !== "Captured workflow" ? workflow.name : "";
  const floorName = floor && floor !== "Captured workflow" ? floor : "";
  next.name = name || current || floorName || "Untitled workflow";
  if ("summary" in edits) {
    const summary = cleanSaveField(edits.summary ?? "", 200);
    if (summary) next.summary = summary;
    else delete next.summary;
  }
  if ("intent" in edits) {
    const intent = cleanSaveField(edits.intent ?? "", 280);
    if (intent) next.intent = intent;
    else delete next.intent;
  }
  return next;
}

/**
 * Cursor account via the CLI when it is logged in, then XAI_API_KEY (grok),
 * then Groq, OpenAI, and Anthropic. Null when none of those can run.
 * `BAO_HEAL_CURSOR_ACCOUNT=0` skips the account. `BAO_CURSOR_MODEL` selects its model.
 */
export async function saveCompleter(
  env: NodeJS.ProcessEnv = process.env,
  agent: CursorAgentRun = realCursorAgent(),
): Promise<SaveCompleter | null> {
  const account = await readCursorAccount(env, agent);
  const vendor = () => saveModel(env);
  if (!account.authenticated && !vendor().available) return null;
  const picked = account.authenticated
    ? { provider: "cursor", model: env.BAO_CURSOR_MODEL || "cursor-agent" }
    : vendor();
  const completer: SaveCompleter = {
    provider: picked.provider,
    model: picked.model,
    async complete(prompt: string) {
      if (account.authenticated) {
        const asked = await askCursorAgent(prompt, env, agent, SAVE_TIMEOUT_MS);
        if (asked) {
          completer.provider = "cursor";
          completer.model = asked.model;
          return asked.text;
        }
      }
      const info = vendor();
      if (!info.available) throw new Error(info.reason);
      completer.provider = info.provider;
      completer.model = info.model;
      return (await completeFor(info, prompt, env)).text;
    },
  };
  return completer;
}

export async function inferSavedWorkflow(
  workflow: WorkflowV2,
  source: SaveIntentSource,
  completer: SaveCompleter | null,
  now = Date.now(),
): Promise<WorkflowV2> {
  if (workflow.inference) return workflow;
  const floor = source.floorTitle && source.floorTitle !== "Captured workflow"
    ? source.floorTitle
    : (workflow.name && workflow.name !== "Captured workflow" ? workflow.name : "Untitled workflow");
  const base = structuredClone({ ...workflow, name: floor });
  const skipped = (provider: string, model: string): WorkflowV2 => ({
    ...base,
    inference: { at: now, provider, model, status: "skipped" },
  });
  if (!completer) return skipped("none", "");
  const prompt = saveIntentPrompt({
    floorTitle: floor,
    host: primaryHost(source),
    pageTitle: source.pageTitle,
    steps: promptSteps(workflow, source.groups),
  });
  let text = "";
  try {
    text = await withTimeout(completer.complete(prompt), SAVE_TIMEOUT_MS);
  } catch {
    return skipped(completer.provider, completer.model);
  }
  const parsed = parseSaveIntent(text, new Set(workflow.steps.map((step) => step.id)));
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
  return next;
}

function promptSteps(
  workflow: WorkflowV2,
  groups: { beforeUrl?: string; afterUrl?: string }[][] | undefined,
): PromptStep[] {
  return workflow.steps.map((step, index) => {
    const group = groups?.[index] || [];
    const event = [...group].reverse().find((item) => item.afterUrl || item.beforeUrl);
    const visible = [projectStep(step).identity?.name, projectStep(step).identity?.text, projectStep(step).identity?.label, projectStep(step).label]
      .filter((item): item is string => typeof item === "string" && !!item.trim())
      .join(" · ");
    return {
      id: step.id,
      action: step.action,
      url: event?.afterUrl || event?.beforeUrl || "",
      label: visible || step.action,
    };
  });
}

function parseSaveIntent(
  text: string,
  ids: ReadonlySet<string>,
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
    const title = cleanSaveField(body.title, 80);
    const summary = cleanSaveField(body.summary, 200);
    const intent = cleanSaveField(body.intent, 280);
    const steps = new Map<string, string>();
    if (Array.isArray(body.steps)) {
      for (const item of body.steps) {
        if (!item || typeof item !== "object") continue;
        const row = item as { id?: unknown; intent?: unknown };
        if (typeof row.id !== "string" || !ids.has(row.id)) continue;
        const line = cleanSaveField(row.intent, 240);
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
