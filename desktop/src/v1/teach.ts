// Teach mode. Interpret narrates each step as it lands. Corrections are an
// append-only log. The saved workflow is that narration after the log is applied.
// A note becomes the step's intent. Two demonstrations merge into one workflow,
// with a branch only where the steps differ.

import { explain, interpret, type InterpretMeta, type TrailEvent } from "./interpret";
import { looksLikePath, validateWorkflow, type WorkflowInput, type WorkflowStep, type WorkflowV2 } from "./schema";

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
  | "check"
  | "splice";

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
  const secrets = secretValues(events);
  const drafts: Draft[] = baseline.steps.map((step, index) => {
    const group = groups[index] || [];
    const event = group[0];
    const id = event?.id || step.id;
    const intent = heuristicIntent(step, event);
    const outcome = heuristicOutcome(step, event);
    const voice = spoken?.get(id);
    const card: TeachCard = {
      id,
      eventIds: group.map((item) => item.id),
      narrator: voice?.narrator || "heuristic",
      modelName: voice?.modelName,
      intent: scrub(voice?.intent || intent, secrets, events),
      outcome: scrub(voice?.outcome || outcome, secrets, events),
      human: step.human === true || step.action === "login" || step.action === "confirm",
      verify: step.action === "verify",
      dropped: false,
      merged: false,
      note: "",
      action: step.action,
      values: valuesOf(step, event),
    };
    return {
      id,
      events: group.map((item) => ({ ...item })),
      step: { ...step, intent: card.intent },
      card,
      dropped: false,
      merged: false,
    };
  });
  const overrides = new Map<string, WorkflowInput>();
  for (const decision of decisions) applyDecision(drafts, decision, baseline.inputs, overrides, secrets, events);
  const kept = drafts.filter((draft) => !draft.dropped && !draft.merged);
  const steps = kept.map((draft, index) => ({ ...draft.step, index, id: `${meta.id}-${index}`, intent: draft.card.intent || draft.step.intent }));
  const inputs = inputsFor(steps, baseline.inputs, overrides);
  const workflow: WorkflowV2 = {
    ...baseline,
    id: meta.id,
    name: meta.name || baseline.name,
    startUrl: meta.startUrl || baseline.startUrl,
    inputs,
    steps,
  };
  const errors = validateWorkflow(workflow);
  if (errors.length) throw new Error(errors.join(", "));
  return { cards: drafts.map((draft) => draft.card), workflow, baseline };
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
    const from = step.intent || step.label;
    const to = pair.workflow.steps[match]?.intent || pair.workflow.steps[match]?.label || "";
    if (from !== to) intentChanges.push({ from, to });
  }
  return {
    corrections: pair.decisions.length,
    intentChanges,
    droppedSteps: Math.max(0, pair.baseline.steps.length - pair.workflow.steps.length),
    humanSteps: pair.workflow.steps.filter((step) => step.human || step.action === "confirm" || step.action === "login").length,
    checks: pair.workflow.steps.filter((step) => step.action === "verify").length,
    branches: pair.workflow.steps.filter((step) => step.when).length,
  };
}

/** Replace the failed step with the steps the person just taught. */
export function spliceFix(workflow: WorkflowV2, failedStepId: string, taught: WorkflowV2, now = Date.now()): WorkflowV2 {
  const at = workflow.steps.findIndex((step) => step.id === failedStepId);
  if (at < 0) throw new Error("missing step");
  const incoming = taught.steps.map((step, index) => ({
    ...clone(step),
    id: `${workflow.id}-fix-${at}-${index}`,
    when: undefined,
  }));
  const steps = [...workflow.steps.slice(0, at), ...incoming, ...workflow.steps.slice(at + 1)]
    .map((step, index) => ({ ...step, index }));
  const doc: WorkflowV2 = {
    ...workflow,
    inputs: unionInputs(workflow.inputs, taught.inputs),
    steps,
    updatedAt: now,
  };
  const errors = validateWorkflow(doc);
  if (errors.length) throw new Error(errors.join(", "));
  return doc;
}

/**
 * Fold demonstrations of one task into a single workflow.
 * Steps present in every take stay shared. A step that only some takes have
 * is kept once per take, selected by a choice input.
 */
export function mergeDemonstrations(docs: readonly WorkflowV2[], meta: { id: string; name: string; now?: number }): WorkflowV2 {
  if (docs.length < 2) throw new Error("need two demonstrations");
  const used = new Set<string>();
  const takes = docs.map((doc, index) => takeName(doc, index, used));
  let rows: Row[] = docs[0]!.steps.map((step) => ({ step: clone(step), takes: [takes[0]!] }));
  for (let i = 1; i < docs.length; i++) rows = foldRows(rows, docs[i]!, takes[i]!);
  const route = freshName(docs.flatMap((doc) => doc.inputs.map((input) => input.name)), "route");
  const branched = rows.some((row) => row.takes.length !== takes.length);
  const inputs = docs.reduce<WorkflowInput[]>((all, doc) => unionInputs(all, doc.inputs), []);
  if (branched) {
    inputs.push({ name: route, type: "choice", label: "Which way", required: true, choices: [...takes] });
  }
  const steps: WorkflowStep[] = [];
  for (const row of rows) {
    if (!branched || row.takes.length === takes.length) {
      const step = clone(row.step);
      delete step.when;
      steps.push(step);
      continue;
    }
    for (const take of row.takes) {
      steps.push({ ...clone(row.step), when: { input: route, value: take } });
    }
  }
  const doc: WorkflowV2 = {
    schema: "bao.workflow/v2",
    version: 2,
    id: meta.id,
    name: meta.name,
    startUrl: docs[0]!.startUrl,
    inputs,
    steps: steps.map((step, index) => ({ ...step, index, id: `${meta.id}-${index}` })),
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

export function publicTrail(events: readonly TrailEvent[]): TrailEvent[] {
  const secrets = secretValues(events);
  return events.map((event) => {
    const copy: TrailEvent = { ...event };
    if (copy.sensitive || copy.identity?.role === "password") delete copy.value;
    if (copy.value && secrets.includes(copy.value)) delete copy.value;
    delete copy.rawPath;
    if (copy.note) copy.note = scrub(copy.note, secrets, events);
    if (copy.intent) copy.intent = scrub(copy.intent, secrets, events);
    if (copy.detail) copy.detail = scrub(copy.detail, secrets, events);
    return copy;
  });
}

function applyDecision(
  drafts: Draft[],
  decision: TeachDecision,
  inputs: WorkflowInput[],
  overrides: Map<string, WorkflowInput>,
  secrets: string[],
  events: readonly TrailEvent[],
): void {
  const draft = drafts.find((item) => item.id === decision.cardId);
  if (!draft || draft.dropped || draft.merged) return;
  if (decision.kind === "rename" && decision.intent) {
    const intent = scrub(decision.intent, secrets, events);
    draft.card.intent = intent;
    draft.step.intent = intent;
    draft.step.label = intent;
    return;
  }
  if (decision.kind === "note" && decision.note) {
    const intent = scrub(decision.note, secrets, events);
    draft.card.note = intent;
    draft.card.intent = intent;
    draft.step.intent = intent;
    draft.step.label = intent;
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
    const login = draft.step.action === "login"
      || draft.step.identity?.role === "password"
      || /login/i.test(draft.step.identity?.testId || "")
      || /login/i.test(draft.step.identity?.id || "");
    draft.step.action = login ? "login" : "confirm";
    draft.step.human = true;
    delete draft.step.provenance;
    draft.step.timeoutMs = Math.max(draft.step.timeoutMs || 0, 15000);
    const intent = draft.card.intent || (login ? "you sign in" : "you confirm");
    draft.step.intent = intent;
    draft.step.label = intent;
    if (draft.card.outcome) {
      draft.step.postcondition = { kind: "text", match: draft.card.outcome, timeoutMs: draft.step.timeoutMs };
    }
    draft.card.human = true;
    draft.card.action = draft.step.action;
    return;
  }
  if (decision.kind === "verify" || decision.kind === "check") {
    const match = scrub(decision.outcome || draft.card.outcome || "the check holds", secrets, events);
    draft.step.action = "verify";
    draft.step.human = undefined;
    delete draft.step.provenance;
    delete draft.step.input;
    delete draft.step.value;
    delete draft.step.sensitive;
    draft.step.expect = { kind: "text", match, timeoutMs: 8000 };
    draft.step.postcondition = { kind: "text", match, timeoutMs: 8000 };
    draft.step.intent = draft.card.intent || "check the outcome";
    draft.step.label = draft.step.intent;
    draft.card.verify = true;
    draft.card.human = false;
    draft.card.action = "verify";
    draft.card.outcome = match;
    draft.card.values = [];
    return;
  }
  if (decision.kind === "constant") {
    const literal = draft.events.map((event) => event.value).filter(Boolean).pop();
    if (!literal || draft.card.values.some((value) => value.role === "secret") || looksLikePath(literal)) return;
    delete draft.step.input;
    delete draft.step.sensitive;
    draft.step.value = literal;
    draft.card.values = [{ role: "constant", name: "", label: literal.slice(0, 48) }];
    return;
  }
  if (decision.kind === "input" || decision.kind === "secret") {
    const secret = decision.kind === "secret" || draft.card.values.some((value) => value.role === "secret");
    const current = draft.step.input || draft.card.values.find((value) => value.name)?.name || (secret ? "secret" : "text");
    const name = decision.name && NAME_RE.test(decision.name) ? decision.name : current;
    retarget(draft.step, draft.step.input, name);
    draft.step.input = name;
    draft.step.value = `{{${name}}}`;
    draft.step.sensitive = secret || undefined;
    const literal = secret ? undefined : draft.events.map((event) => event.value).filter((value) => value && !looksLikePath(value)).pop();
    const prior = overrides.get(current) || inputs.find((input) => input.name === current);
    overrides.set(name, {
      name,
      type: secret ? "secret" : prior?.type === "file" ? "file" : prior?.type === "number" ? "number" : "text",
      required: true,
      label: name,
      default: secret ? undefined : literal || (prior?.type === "secret" ? undefined : prior?.default),
    });
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
    previous.step.intent = previous.card.intent;
  } else if (current.card.outcome && (!previous.step.postcondition || previous.step.postcondition.kind === "element")) {
    previous.step.postcondition = { kind: "text", match: current.card.outcome, timeoutMs: 4000 };
    previous.card.outcome = current.card.outcome;
  }
  previous.events = [...previous.events, ...current.events];
  previous.card.eventIds = previous.events.map((event) => event.id);
}

function retarget(step: WorkflowStep, from: string | undefined, to: string): void {
  if (!from || from === to) return;
  const swap = (value?: string) => value?.split(`{{${from}}}`).join(`{{${to}}}`);
  step.value = swap(step.value);
  if (step.postcondition?.match) step.postcondition = { ...step.postcondition, match: swap(step.postcondition.match) };
  if (step.expect?.match) step.expect = { ...step.expect, match: swap(step.expect.match) };
}

function inputsFor(steps: WorkflowStep[], existing: WorkflowInput[], overrides: Map<string, WorkflowInput>): WorkflowInput[] {
  const names: string[] = [];
  const push = (name?: string) => {
    if (name && NAME_RE.test(name) && !names.includes(name)) names.push(name);
  };
  for (const step of steps) {
    push(step.input);
    push(step.when?.input);
    for (const token of tokens(step.value, step.postcondition?.match, step.expect?.match, step.readBack?.match)) push(token);
  }
  return names.map((name) => {
    const override = overrides.get(name);
    const found = existing.find((input) => input.name === name);
    const input = override || found || { name, type: "text" as const, required: true, label: name };
    if (input.type === "secret") {
      const copy = { ...input };
      delete copy.default;
      return copy;
    }
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
    return [{ role: "input", name: step.input || "file", label: `{{${step.input || "file"}}}` }];
  }
  if (step.sensitive || event?.sensitive || step.action === "type" && /pass|secret/i.test(step.input || "")) {
    return [{ role: "secret", name: step.input || "secret", label: "secret" }];
  }
  if (step.input) return [{ role: "input", name: step.input, label: `{{${step.input}}}` }];
  if (step.value && !step.value.includes("{{") && !looksLikePath(step.value)) {
    return [{ role: "constant", name: "", label: step.value.slice(0, 48) }];
  }
  return [];
}

function heuristicIntent(step: WorkflowStep, event: TrailEvent | undefined): string {
  if (step.action === "verify") return "check the outcome";
  if (step.action === "confirm") return "you confirm";
  if (step.action === "login") return "you sign in";
  if (step.action === "drop") return "drop the file";
  if (step.action === "upload") return "upload the file";
  if (step.action === "digits") return "enter the number";
  if (step.action === "type" && (step.sensitive || event?.sensitive)) return "type the secret";
  if (step.action === "type") {
    const name = step.input || event?.identity?.nameAttr || "text";
    if (/note/i.test(name)) return "type the note";
    if (/user|email/i.test(name)) return "type the username";
    if (/pass|secret/i.test(name)) return "type the secret";
    return `type the ${name.replace(/[_-]/g, " ")}`;
  }
  if (step.action === "key") return `press ${step.key || "key"}`;
  if (step.action === "check") return step.checked === false ? "uncheck" : "check the box";
  const name = event?.identity?.text || event?.identity?.name || event?.identity?.label || "";
  return name ? `click ${name}` : "click";
}

function heuristicOutcome(step: WorkflowStep, event: TrailEvent | undefined): string {
  if (step.action === "verify") return step.expect?.match || event?.afterText || "the check holds";
  if (step.action === "drop" || step.action === "upload") return step.postcondition?.match || "the file lands";
  if (step.action === "type" && (step.sensitive || event?.sensitive)) return "the secret is filled";
  if (step.action === "type" && step.input) return `the field shows {{${step.input}}}`;
  if (event?.afterText) return event.afterText;
  if (step.postcondition?.kind === "text" && step.postcondition.match) return step.postcondition.match;
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
  if (correction.kind === "check") return "added a check";
  return "spliced the fix";
}

function secretValues(events: readonly TrailEvent[]): string[] {
  const out: string[] = [];
  for (const event of events) {
    const secret = event.sensitive || event.identity?.role === "password";
    if (secret && event.value && event.value.length >= 8 && !out.includes(event.value)) out.push(event.value);
  }
  return out;
}

function scrub(value: string, secrets: string[], events: readonly TrailEvent[]): string {
  let out = value;
  for (const secret of secrets) if (secret) out = out.split(secret).join("[secret]");
  for (const event of events) {
    if (event.rawPath) out = out.split(event.rawPath).join("{{file}}");
  }
  return out;
}

function sameTarget(a: WorkflowStep, b: WorkflowStep): boolean {
  if (a.action !== b.action) return false;
  const left = a.identity;
  const right = b.identity;
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
}

function foldRows(rows: Row[], doc: WorkflowV2, take: string): Row[] {
  const incoming = doc.steps;
  const out: Row[] = [];
  let i = 0;
  let j = 0;
  while (i < rows.length || j < incoming.length) {
    if (i < rows.length && j < incoming.length && stepKey(rows[i]!.step) === stepKey(incoming[j]!)) {
      out.push({ step: rows[i]!.step, takes: [...rows[i]!.takes, take] });
      i += 1;
      j += 1;
      continue;
    }
    const aAhead = j < incoming.length ? rows.slice(i, i + 6).findIndex((row) => stepKey(row.step) === stepKey(incoming[j]!)) : -1;
    const bAhead = i < rows.length ? incoming.slice(j, j + 6).findIndex((step) => stepKey(step) === stepKey(rows[i]!.step)) : -1;
    if (aAhead > 0 && (bAhead < 0 || aAhead <= bAhead)) {
      for (let n = 0; n < aAhead; n++) out.push(rows[i++]!);
      continue;
    }
    if (bAhead > 0) {
      for (let n = 0; n < bAhead; n++) out.push({ step: clone(incoming[j++]!), takes: [take] });
      continue;
    }
    if (i < rows.length) out.push(rows[i++]!);
    if (j < incoming.length) out.push({ step: clone(incoming[j++]!), takes: [take] });
  }
  return out;
}

function stepKey(step: WorkflowStep): string {
  const identity = step.identity;
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
    const copy = { ...input };
    if (copy.type === "secret") delete copy.default;
    out.push(copy);
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
