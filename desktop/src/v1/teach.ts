// Teach mode. Interpret narrates each step as it lands. Corrections are an
// append-only log. The saved workflow is that narration after the log is applied.
// A note becomes the step's intent. Two demonstrations merge into one workflow,
// with a branch only where the steps differ.

import { oneTimeCodeField } from "../../../shared/saved-secrets";
import { explain, interpret, trailDrops, type InterpretMeta, type TrailEvent } from "./interpret";
import { finishInput, stepTitle, stepValueTemplate, stepSensitive, looksLikePath, stepCheck, stepInputName, stepQuery, stepTarget, validateWorkflow, WORKFLOW_SCHEMA_ID, type Identity, type WorkflowInput, type WorkflowStep, type WorkflowV2 } from "./schema";

export type NarratorKind = "heuristic" | "model";

export type CorrectionKind =
  | "rename"
  | "input"
  | "constant"
  | "secret"
  | "human"
  | "verify"
  | "drop"
  | "merge"
  | "note"
  | "check";

export interface TeachValue {
  role: "input" | "constant" | "secret";
  name: string;
  /** Chip text. Never a secret and never a path. */
  label: string;
}

export interface TeachCard {
  id: string;
  eventIds: string[];
  narrator: NarratorKind;
  modelName?: string;
  intent: string;
  outcome: string;
  human: boolean;
  verify: boolean;
  dropped: boolean;
  merged: boolean;
  note: string;
  /** The capture note is the workflow intent. The card still shows the step intent beside it. */
  noteAsIntent?: boolean;
  action: string;
  values: TeachValue[];
}

export interface TeachDecision {
  ts: number;
  cardId: string;
  kind: CorrectionKind;
  detail: string;
  intent?: string;
  name?: string;
  note?: string;
  outcome?: string;
}

export interface TeachCorrection {
  kind: CorrectionKind;
  cardId: string;
  intent?: string;
  name?: string;
  note?: string;
  outcome?: string;
}

export interface Spoken {
  narrator: NarratorKind;
  modelName?: string;
  intent: string;
  outcome: string;
}

export interface TeachNarrator {
  kind: "model";
  name: string;
  narrate(card: { action: string; intent: string; outcome: string }): Promise<{ intent: string; outcome: string } | null>;
}

export interface IntentEvalPair {
  schema: "bao.intent-eval/v1";
  id: string;
  rawTrail: TrailEvent[];
  decisions: TeachDecision[];
  baseline: WorkflowV2;
  workflow: WorkflowV2;
}

/** Serializable intent-eval case. The harness loads this; the corrected workflow is the label. */
export interface TeachIntentCase {
  schema: "bao.intent-case/v1";
  id: string;
  name: string;
  startUrl: string;
  events: TrailEvent[];
  secrets: string[];
  secretIds: string[];
  human: { id: string; gate: "login" | "confirm"; target: string }[];
  nodes: Identity[];
  replays: { texts: string[]; secret: string; file: string }[];
  decisions: TeachDecision[];
  workflow: WorkflowV2;
}

export interface TeachSummary {
  events: number;
  steps: number;
  inputs: number;
  dropped: { id: string; reason: string }[];
  line: string;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

interface Draft {
  id: string;
  events: TrailEvent[];
  step: WorkflowStep;
  card: TeachCard;
  dropped: boolean;
  merged: boolean;
}

export function projectTeach(
  events: readonly TrailEvent[],
  decisions: readonly TeachDecision[],
  meta: InterpretMeta,
  spoken?: ReadonlyMap<string, Spoken>,
): { cards: TeachCard[]; workflow: WorkflowV2; baseline: WorkflowV2 } {
  const { workflow: baseline, groups } = explain(events, meta);
  const drafts: Draft[] = baseline.steps.map((step, index) => {
    const group = groups[index] || [];
    const event = group[0];
    const id = event?.id || step.id;
    const intent = heuristicIntent(step, event);
    const outcome = heuristicOutcome(step, event);
    const voice = spoken?.get(id);
    const noted = attachedNote(group);
    const guess = fileText(voice?.intent || intent, events);
    const note = fileText(noted, events);
    const noteAsIntent = Boolean(note);
    const card: TeachCard = {
      id,
      eventIds: group.map((item) => item.id),
      narrator: voice?.narrator || "heuristic",
      modelName: voice?.modelName,
      intent: guess,
      outcome: fileText(voice?.outcome || outcome, events),
      human: step.action === "handoff",
      verify: step.action === "verify",
      dropped: false,
      merged: false,
      note,
      noteAsIntent,
      action: step.action,
      values: valuesOf(step, event),
    };
    return {
      id,
      events: group.map((item) => ({ ...item })),
      step: { ...step, caption: { ...step.caption, text: (noteAsIntent ? note : guess) || step.caption.text } },
      card,
      dropped: false,
      merged: false,
    };
  });
  const overrides = new Map<string, WorkflowInput>();
  for (const decision of decisions) applyDecision(drafts, decision, baseline.inputs, overrides, events);
  const kept = drafts.filter((draft) => !draft.dropped && !draft.merged);
  const steps = kept.map((draft, index) => ({
    ...draft.step,
    index,
    id: `${meta.id}-${index}`,
    caption: {
      ...draft.step.caption,
      text: draft.card.noteAsIntent ? (draft.card.note || draft.step.caption.text) : (draft.card.intent || draft.step.caption.text),
    },
  }));
  const inputs = inputsFor(steps, baseline.inputs, overrides);
  const workflow: WorkflowV2 = {
    ...baseline,
    id: meta.id,
    name: meta.name || baseline.name,
    startUrl: meta.startUrl || baseline.startUrl,
    inputs,
    steps,
  };
  const saved = { cards: drafts.map((draft) => draft.card), workflow, baseline };
  const errors = validateWorkflow(saved.workflow);
  if (errors.length) throw new Error(errors.join(", "));
  return saved;
}

export function decide(decisions: readonly TeachDecision[], correction: TeachCorrection, now: number): TeachDecision[] {
  const note = correction.note?.trim();
  const intent = correction.intent?.trim();
  const name = correction.name?.trim();
  if ((correction.kind === "input" || correction.kind === "secret") && name && !NAME_RE.test(name)) {
    throw new Error("parameter name");
  }
  if (correction.kind === "rename" && !intent) throw new Error("intent");
  if (correction.kind === "note" && !note) throw new Error("note");
  return [...decisions, {
    ts: now,
    cardId: correction.cardId,
    kind: correction.kind,
    detail: detailFor(correction),
    intent,
    name,
    note,
    outcome: correction.outcome?.trim(),
  }];
}

export function decisionEvent(decision: TeachDecision, index: number): TrailEvent {
  return {
    id: `dec-${index}`,
    ts: decision.ts,
    kind: "decision",
    op: "decision",
    decision: decision.kind,
    detail: decision.detail,
    cardId: decision.cardId,
    intent: decision.intent,
    name: decision.name,
    note: decision.note,
    outcome: decision.outcome,
  };
}

export function intentEvalPair(
  id: string,
  events: readonly TrailEvent[],
  decisions: readonly TeachDecision[],
  meta: InterpretMeta,
  spoken?: ReadonlyMap<string, Spoken>,
): IntentEvalPair {
  const projected = projectTeach(events, decisions, { ...meta, id }, spoken);
  return {
    schema: "bao.intent-eval/v1",
    id,
    rawTrail: publicTrail(events),
    decisions: decisions.map((decision) => ({ ...decision })),
    baseline: projected.baseline,
    workflow: projected.workflow,
  };
}

export function measureIntentPair(pair: IntentEvalPair): {
  corrections: number;
  intentChanges: { from: string; to: string }[];
  droppedSteps: number;
  humanSteps: number;
  checks: number;
  branches: number;
} {
  const intentChanges: { from: string; to: string }[] = [];
  const used = new Set<number>();
  for (const step of pair.baseline.steps) {
    const match = pair.workflow.steps.findIndex((item, index) => !used.has(index) && sameTarget(step, item));
    if (match < 0) continue;
    used.add(match);
    const from = stepTitle(step);
    const matched = pair.workflow.steps[match];
    const to = matched ? stepTitle(matched) : "";
    if (from !== to) intentChanges.push({ from, to });
  }
  return {
    corrections: pair.decisions.length,
    intentChanges,
    droppedSteps: Math.max(0, pair.baseline.steps.length - pair.workflow.steps.length),
    humanSteps: pair.workflow.steps.filter((step) => step.action === "handoff").length,
    checks: pair.workflow.steps.filter((step) => step.action === "verify").length,
    branches: pair.workflow.steps.filter((step) => step.when).length,
  };
}

/** Where a merged step's element crop was recorded, before ids are rewritten. */
export interface MergeShot {
  stepId: string;
  workflowId: string;
  sourceStepId: string;
}

/**
 * Fold demonstrations of one task into a single workflow.
 * Steps present in every take stay shared. A step that only some takes have
 * is kept once per take, selected by a choice input.
 * `shots` records the source workflow and step for each new id so the crop can move with it.
 */
export function mergeDemonstrations(
  docs: readonly WorkflowV2[],
  meta: { id: string; name: string; now?: number },
  shots?: MergeShot[],
): WorkflowV2 {
  if (docs.length < 2) throw new Error("need two demonstrations");
  const used = new Set<string>();
  const takes = docs.map((doc, index) => takeName(doc, index, used));
  let rows: Row[] = docs[0]!.steps.map((step) => ({ step: clone(step), takes: [takes[0]!], workflowId: docs[0]!.id }));
  for (let i = 1; i < docs.length; i++) rows = foldRows(rows, docs[i]!, takes[i]!);
  const route = freshName(docs.flatMap((doc) => doc.inputs.map((input) => input.name)), "route");
  const branched = rows.some((row) => row.takes.length !== takes.length);
  const inputs = docs.reduce<WorkflowInput[]>((all, doc) => unionInputs(all, doc.inputs), []);
  if (branched) {
    inputs.push({ name: route, type: "choice", label: "Which way", supply: "must", choices: [...takes] });
  }
  const steps: WorkflowStep[] = [];
  for (const row of rows) {
    const emit = (step: WorkflowStep) => {
      const id = `${meta.id}-${steps.length}`;
      shots?.push({ stepId: id, workflowId: row.workflowId, sourceStepId: row.step.id });
      steps.push({ ...step, index: steps.length, id });
    };
    if (!branched || row.takes.length === takes.length) {
      const step = clone(row.step);
      delete step.when;
      emit(step);
      continue;
    }
    for (const take of row.takes) emit({ ...clone(row.step), when: { input: route, value: take } });
  }
  const doc: WorkflowV2 = {
    schema: WORKFLOW_SCHEMA_ID,
    id: meta.id,
    name: meta.name,
    startUrl: docs[0]!.startUrl,
    inputs,
    steps,
    createdAt: meta.now ?? docs[0]!.createdAt,
  };
  const errors = validateWorkflow(doc);
  if (errors.length) throw new Error(errors.join(", "));
  return doc;
}

export function narratorFromEnv(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): TeachNarrator | null {
  if (env.BAO_TEACH_FIXTURE === "1") {
    return {
      kind: "model",
      name: "bao-teach-fixture",
      async narrate(card) {
        return { intent: card.intent, outcome: card.outcome };
      },
    };
  }
  const openai = env.OPENAI_API_KEY;
  const anthropic = env.ANTHROPIC_API_KEY;
  if (!openai && !anthropic) return null;
  const name = openai ? (env.BAO_OPENAI_MODEL || "gpt-4.1-mini") : (env.BAO_ANTHROPIC_MODEL || "claude-sonnet-4-5");
  return {
    kind: "model",
    name,
    async narrate(card) {
      const prompt = [
        "Name one recorded computer-use step.",
        "Reply with JSON {\"intent\":\"short imperative\",\"outcome\":\"what should be true after\"}.",
        "Do not include secrets, passwords, or file paths.",
        `Step: ${JSON.stringify({ action: card.action, intent: card.intent, outcome: card.outcome })}`,
      ].join("\n");
      try {
        const raw = openai
          ? await fetchImpl("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { authorization: `Bearer ${openai}`, "content-type": "application/json" },
            body: JSON.stringify({ model: name, messages: [{ role: "user", content: prompt }] }),
          }).then((res) => res.text())
          : await fetchImpl("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
              "x-api-key": anthropic || "",
              "anthropic-version": "2023-06-01",
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: name, max_tokens: 200, messages: [{ role: "user", content: prompt }] }),
          }).then((res) => res.text());
        return parseNarration(raw);
      } catch {
        return null;
      }
    },
  };
}

export function teachSummary(
  events: readonly TrailEvent[],
  decisions: readonly TeachDecision[],
  meta: InterpretMeta,
  spoken?: ReadonlyMap<string, Spoken>,
): TeachSummary {
  return teachSummaryFrom(events, projectTeach(events, decisions, meta, spoken));
}

export function teachSummaryFrom(
  events: readonly TrailEvent[],
  projected: { cards: TeachCard[]; workflow: WorkflowV2 },
): TeachSummary {
  const dropped = trailDrops(events);
  const seen = new Set(dropped.map((item) => item.id));
  for (const card of projected.cards) {
    if (!card.dropped && !card.merged) continue;
    const reason = card.dropped ? "dropped" : "merged into the previous step";
    for (const id of card.eventIds) {
      if (seen.has(id)) continue;
      dropped.push({ id, reason });
      seen.add(id);
    }
  }
  const inputs = projected.workflow.inputs.length;
  const line = `${events.length} events → ${projected.workflow.steps.length} steps, ${inputs} inputs found, ${dropped.length} dropped`;
  return {
    events: events.length,
    steps: projected.workflow.steps.length,
    inputs,
    dropped,
    line,
  };
}

export function teachIntentCase(
  id: string,
  events: readonly TrailEvent[],
  decisions: readonly TeachDecision[],
  meta: InterpretMeta,
  spoken?: ReadonlyMap<string, Spoken>,
): TeachIntentCase {
  const projected = projectTeach(events, decisions, { ...meta, id: meta.id || id }, spoken);
  const raw = publicTrail(events);
  const human = projected.cards.flatMap((card) => {
    if (card.dropped || card.merged || !card.human) return [];
    const gate: "login" | "confirm" = card.action === "login" ? "login" : "confirm";
    return [{ id: card.eventIds[0] || card.id, gate, target: card.intent || card.id }];
  });
  const nodes: Identity[] = [];
  const seen = new Set<string>();
  for (const event of raw) {
    const key = event.identity?.id || event.identity?.testId;
    if (!event.identity || !key || seen.has(key)) continue;
    seen.add(key);
    nodes.push(event.identity);
  }
  const texts = projected.workflow.inputs
    .filter((input) => input.type === "text" || input.type === "number")
    .map((input) => input.default || "");
  return {
    schema: "bao.intent-case/v1",
    id,
    name: meta.name || projected.workflow.name,
    startUrl: meta.startUrl || projected.workflow.startUrl,
    events: raw,
    secrets: [],
    secretIds: raw.filter((event) => event.sensitive || event.identity?.role === "password").map((event) => event.id),
    human,
    nodes,
    replays: [
      { texts, secret: "", file: "sample.txt" },
      { texts: [...texts], secret: "", file: "sample-b.txt" },
    ],
    decisions: decisions.map((decision) => ({
      ...decision,
      detail: fileText(decision.detail, events),
      intent: decision.intent ? fileText(decision.intent, events) : undefined,
      note: decision.note ? fileText(decision.note, events) : undefined,
      outcome: decision.outcome ? fileText(decision.outcome, events) : undefined,
    })),
    workflow: projected.workflow,
  };
}

export function publicTrail(events: readonly TrailEvent[]): TrailEvent[] {
  return events.map((event) => {
    const copy: TrailEvent = { ...event };
    delete copy.rawPath;
    if (copy.note) copy.note = fileText(copy.note, events);
    if (copy.intent) copy.intent = fileText(copy.intent, events);
    if (copy.detail) copy.detail = fileText(copy.detail, events);
    return copy;
  });
}

function applyDecision(
  drafts: Draft[],
  decision: TeachDecision,
  inputs: WorkflowInput[],
  overrides: Map<string, WorkflowInput>,
  events: readonly TrailEvent[],
): void {
  const draft = drafts.find((item) => item.id === decision.cardId);
  if (!draft || draft.dropped || draft.merged) return;
  if (decision.kind === "rename" && decision.intent) {
    const intent = fileText(decision.intent, events);
    draft.card.intent = intent;
    draft.card.noteAsIntent = false;
    draft.step.caption = { ...draft.step.caption, text: intent };
    return;
  }
  if (decision.kind === "note" && decision.note) {
    const intent = fileText(decision.note, events);
    draft.card.note = intent;
    draft.card.noteAsIntent = true;
    draft.step.caption = { ...draft.step.caption, text: intent };
    return;
  }
  if (decision.kind === "drop") {
    draft.dropped = true;
    draft.card.dropped = true;
    return;
  }
  if (decision.kind === "merge") {
    const previous = [...drafts].reverse().find((item) => item !== draft && !item.dropped && !item.merged && drafts.indexOf(item) < drafts.indexOf(draft));
    if (!previous) return;
    absorb(previous, draft);
    draft.merged = true;
    draft.card.merged = true;
    return;
  }
  if (decision.kind === "human") {
    const reason = draft.step.action === "handoff" && (draft.step.reason === "sign-in" || draft.step.reason === "code")
      ? draft.step.reason
      : "owner-press";
    const target = reason === "owner-press" ? stepTarget(draft.step) : undefined;
    const timeoutMs = Math.max(draft.step.timeoutMs || 0, 15000);
    draft.step = {
      id: draft.step.id,
      index: draft.step.index,
      action: "handoff",
      reason,
      timeoutMs,
      caption: { text: draft.card.intent || (reason === "sign-in" ? "Sign in" : reason === "code" ? "Enter the code" : "You press the button") },
      ...(target ? { target } : {}),
      ...(draft.card.outcome ? { check: { kind: "text" as const, match: draft.card.outcome, timeoutMs } } : {}),
    };
    draft.card.human = true;
    draft.card.action = draft.step.action;
    return;
  }
  if (decision.kind === "verify" || decision.kind === "check") {
    const match = fileText(decision.outcome || draft.card.outcome || "the check holds", events);
    draft.step = {
      id: draft.step.id,
      index: draft.step.index,
      action: "verify",
      timeoutMs: 8000,
      caption: { text: draft.card.intent || "Check" },
      check: { kind: "text", match, timeoutMs: 8000 },
    };
    draft.card.verify = true;
    draft.card.human = false;
    draft.card.action = "verify";
    draft.card.outcome = match;
    draft.card.values = [];
    return;
  }
  if (decision.kind === "constant") {
    const literal = draft.events.map((event) => event.value).filter(Boolean).pop();
    if (!literal || looksLikePath(literal)) return;
    if (draft.step.action === "type" || draft.step.action === "select" || draft.step.action === "digits") {
      draft.step.text = { literal };
      if (draft.step.action === "type") delete draft.step.sensitive;
    }
    draft.card.values = [{ role: "constant", name: "", label: literal.slice(0, 48) }];
    return;
  }
  if (decision.kind === "input" || decision.kind === "secret") {
    const secret = decision.kind === "secret" || draft.card.values.some((value) => value.role === "secret");
    const current = stepInputName(draft.step) || draft.card.values.find((value) => value.name)?.name || (secret ? "secret" : "text");
    const name = decision.name && NAME_RE.test(decision.name) ? decision.name : current;
    retarget(draft.step, stepInputName(draft.step), name);
    if (draft.step.action === "type" || draft.step.action === "select" || draft.step.action === "digits") {
      draft.step.text = { input: name };
      if (draft.step.action === "type" && secret) draft.step.sensitive = true;
    }
    const literal = draft.events.map((event) => event.value).filter((value) => value && !looksLikePath(value)).pop();
    const prior = overrides.get(current) || inputs.find((input) => input.name === current);
    overrides.set(name, finishInput({
      name,
      type: secret ? "secret" : prior?.type === "file" ? "file" : prior?.type === "number" ? "number" : "text",
      supply: "must",
      label: name,
      default: oneTimeCodeField(stepQuery(draft.step)) ? undefined : literal ?? prior?.default,
    }));
    draft.card.values = [{
      role: secret ? "secret" : "input",
      name,
      label: secret ? "secret" : `{{${name}}}`,
    }];
    draft.card.action = draft.step.action;
  }
}

function absorb(previous: Draft, current: Draft): void {
  const richer = ["type", "drop", "upload", "key", "verify", "digits", "check"].includes(current.step.action);
  if (previous.step.action === "click" && richer) {
    const intent = previous.card.intent;
    previous.step = { ...current.step, id: previous.step.id, index: previous.step.index };
    previous.card.action = previous.step.action;
    previous.card.values = current.card.values.map((value) => ({ ...value }));
    previous.card.human = current.card.human;
    previous.card.verify = current.card.verify;
    if (!previous.card.outcome) previous.card.outcome = current.card.outcome;
    previous.card.intent = intent || current.card.intent;
    previous.step.caption = { ...previous.step.caption, text: previous.card.intent };
  } else if (current.card.outcome) {
    setTextCheck(previous.step, current.card.outcome);
    previous.card.outcome = current.card.outcome;
  }
  previous.events = [...previous.events, ...current.events];
  previous.card.eventIds = previous.events.map((event) => event.id);
}

function setTextCheck(step: WorkflowStep, match: string): void {
  switch (step.action) {
    case "click":
    case "type":
    case "key":
    case "check":
    case "select":
    case "handoff":
    case "upload":
    case "drop":
    case "download":
    case "open":
    case "digits":
    case "pickDate":
    case "verify":
      step.check = { kind: "text", match, timeoutMs: 4000 };
      return;
    default:
      return;
  }
}

function retarget(step: WorkflowStep, from: string | undefined, to: string): void {
  if (!from || from === to) return;
  const swap = (value: string) => value.split(`{{${from}}}`).join(`{{${to}}}`);
  if (step.caption?.text) step.caption = { ...step.caption, text: swap(step.caption.text) };
  const checked = stepCheck(step);
  const match = checked && "match" in checked ? checked.match : undefined;
  if (match) setTextCheck(step, swap(match));
  if ((step.action === "type" || step.action === "select" || step.action === "digits") && "literal" in step.text) {
    step.text = { literal: swap(step.text.literal) };
  }
}

function inputsFor(steps: WorkflowStep[], existing: WorkflowInput[], overrides: Map<string, WorkflowInput>): WorkflowInput[] {
  const names: string[] = [];
  const push = (name?: string) => {
    if (name && NAME_RE.test(name) && !names.includes(name)) names.push(name);
  };
  for (const step of steps) {
    push(stepInputName(step));
    push(step.when?.input);
    const check = stepCheck(step);
    const match = check && "match" in check ? check.match : undefined;
    for (const token of tokens(stepValueTemplate(step), match, match, step.readBack?.match)) push(token);
  }
  return names.map((name) => {
    const override = overrides.get(name);
    const found = existing.find((input) => input.name === name);
    const input = override || found || { name, type: "text" as const, supply: "must" as const, label: name };
    return { ...input };
  });
}

function tokens(...values: (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const match of value.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g)) out.push(match[1] || "");
  }
  return out;
}

function valuesOf(step: WorkflowStep, event: TrailEvent | undefined): TeachValue[] {
  if (step.action === "drop" || step.action === "upload") {
    return [{ role: "input", name: stepInputName(step) || "file", label: `{{${stepInputName(step) || "file"}}}` }];
  }
  const input = stepInputName(step);
  const value = stepValueTemplate(step);
  if (stepSensitive(step) || event?.sensitive || step.action === "type" && /pass|secret/i.test(input || "")) {
    return [{ role: "secret", name: input || "secret", label: "secret" }];
  }
  if (input) return [{ role: "input", name: input, label: `{{${input}}}` }];
  if (value && !value.includes("{{") && !looksLikePath(value)) {
    return [{ role: "constant", name: "", label: value.slice(0, 48) }];
  }
  return [];
}

/** A capture-bar note folded into this step. Handoff lines are not intent. */
function attachedNote(group: readonly TrailEvent[]): string {
  const note = [...group].reverse().find((event) => event.op === "note" && event.afterText && !/^Handoff (started|ended)\b/.test(event.afterText));
  return (note?.afterText || "").replace(/\s+/g, " ").trim();
}

function targetName(event: TrailEvent | undefined): string {
  const identity = event?.identity;
  return (identity?.name || identity?.text || identity?.label || identity?.nameAttr || "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The interpret label, with a named target when that label is only "Click". */
function heuristicIntent(step: WorkflowStep, event: TrailEvent | undefined): string {
  if (step.action === "type") return typeIntent(step, event);
  const fromLabel = (stepTitle(step) || "").trim().replace(/^Click "(.+)"$/, "Click $1");
  if (fromLabel && fromLabel !== "Click") return fromLabel;
  const target = targetName(event);
  if (target) return `Click ${target}`;
  if (fromLabel) return fromLabel;
  if (step.action === "verify") return "Check";
  if (step.action === "handoff" && step.reason === "sign-in") return "Sign in";
  if (step.action === "drop") return "Drop file";
  if (step.action === "upload") return "Upload file";
  return "Click";
}

function typeIntent(step: WorkflowStep, event: TrailEvent | undefined): string {
  const where = fieldName(step, event);
  const secret = stepSensitive(step) || event?.sensitive || /pass|secret/i.test(stepInputName(step) || "");
  if (secret) return where ? `Type secret into ${where}` : "Type secret";
  const token = stepInputName(step) ? `{{${stepInputName(step)}}}` : (stepValueTemplate(step) || "").trim();
  if (token && where) return `Type ${token} into ${where}`;
  if (token) return token.startsWith("Type ") ? token : `Type ${token}`;
  return where ? `Type into ${where}` : "Type";
}

function fieldName(step: WorkflowStep, event: TrailEvent | undefined): string {
  const identity = event?.identity || stepQuery(step);
  const raw = [identity?.label, identity?.name, identity?.nameAttr, identity?.id].find((bit) => bit && bit.trim()) || "";
  const clean = raw.replace(/\s+/g, " ").trim();
  if (!clean || clean.includes("{{")) return "";
  if (/[A-Z]/.test(clean) || /\s/.test(clean)) return clean;
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function heuristicOutcome(step: WorkflowStep, event: TrailEvent | undefined): string {
  const check = stepCheck(step);
  if (step.action === "verify") return (check && "match" in check ? check.match : undefined) || event?.afterText || "the check holds";
  if (step.action === "drop" || step.action === "upload") return (check && "match" in check ? check.match : undefined) || "the file lands";
  if (step.action === "type" && (step.sensitive || event?.sensitive)) return "the secret is filled";
  const input = stepInputName(step);
  if (step.action === "type" && input) return `the field shows {{${input}}}`;
  if (event?.afterText) return event.afterText;
  if (check?.kind === "text" && check.match) return check.match;
  return "";
}

function detailFor(correction: TeachCorrection): string {
  if (correction.kind === "rename") return "renamed intent";
  if (correction.kind === "note") return "note became intent";
  if (correction.kind === "input") return `input {{${correction.name || "value"}}}`;
  if (correction.kind === "constant") return "marked constant";
  if (correction.kind === "secret") return "marked secret";
  if (correction.kind === "human") return "you do this";
  if (correction.kind === "verify") return "this is a check";
  if (correction.kind === "drop") return "dropped";
  if (correction.kind === "merge") return "merged into the previous step";
  return "added a check";
}

function fileText(value: string, events: readonly TrailEvent[]): string {
  let out = value;
  for (const event of events) {
    if (event.rawPath) out = out.split(event.rawPath).join("{{file}}");
  }
  return out;
}

function sameTarget(a: WorkflowStep, b: WorkflowStep): boolean {
  if (a.action !== b.action) return false;
  const left = stepQuery(a);
  const right = stepQuery(b);
  if (!left || !right) return a.action === b.action && !left && !right;
  return (left.id != null && left.id === right.id)
    || (left.testId != null && left.testId === right.testId)
    || (left.nameAttr != null && left.nameAttr === right.nameAttr);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

interface Row {
  step: WorkflowStep;
  takes: string[];
  workflowId: string;
}

function foldRows(rows: Row[], doc: WorkflowV2, take: string): Row[] {
  const incoming = doc.steps;
  const out: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < rows.length || j < incoming.length) {
    if (i < rows.length && j < incoming.length && mergeKey(rows[i]!.step) === mergeKey(incoming[j]!)) {
      out.push({ step: rows[i]!.step, takes: [...rows[i]!.takes, take], workflowId: rows[i]!.workflowId });
      i += 1;
      j += 1;
      continue;
    }
    const aAhead = j < incoming.length ? rows.slice(i, i + 6).findIndex((row) => mergeKey(row.step) === mergeKey(incoming[j]!)) : -1;
    const bAhead = i < rows.length ? incoming.slice(j, j + 6).findIndex((step) => mergeKey(step) === mergeKey(rows[i]!.step)) : -1;
    if (aAhead > 0 && (bAhead < 0 || aAhead <= bAhead)) {
      for (let n = 0; n < aAhead; n++) out.push(rows[i++]!);
      continue;
    }
    if (bAhead > 0) {
      for (let n = 0; n < bAhead; n++) out.push({ step: clone(incoming[j++]!), takes: [take], workflowId: doc.id });
      continue;
    }
    if (i < rows.length) out.push(rows[i++]!);
    if (j < incoming.length) out.push({ step: clone(incoming[j++]!), takes: [take], workflowId: doc.id });
  }
  return out;
}

function mergeKey(step: WorkflowStep): string {
  const identity = stepQuery(step);
  const target = identity?.testId || identity?.id || identity?.nameAttr || identity?.name || identity?.text || "";
  return `${step.action}|${target}`;
}

function takeName(doc: WorkflowV2, index: number, used: Set<string>): string {
  const base = doc.name?.trim() || `Take ${index + 1}`;
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base} ${n++}`;
  used.add(name);
  return name;
}

function freshName(used: string[], hint: string): string {
  let name = hint;
  let n = 2;
  while (used.includes(name)) name = `${hint}${n++}`;
  return name;
}

function unionInputs(left: WorkflowInput[], right: WorkflowInput[]): WorkflowInput[] {
  const out = left.map((input) => ({ ...input }));
  for (const input of right) {
    if (out.some((item) => item.name === input.name)) continue;
    out.push({ ...input });
  }
  return out;
}

function parseNarration(raw: string): { intent: string; outcome: string } | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { intent?: string; outcome?: string };
    if (!parsed.intent?.trim()) return null;
    return { intent: parsed.intent.trim(), outcome: parsed.outcome?.trim() || "" };
  } catch {
    return null;
  }
}

/** Baseline interpret, exported so tests can compare a corrected workflow with the raw pass. */
export function baselineWorkflow(events: readonly TrailEvent[], meta: InterpretMeta): WorkflowV2 {
  return interpret(events, meta);
}
