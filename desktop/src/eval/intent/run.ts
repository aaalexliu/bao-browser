// bao eval intent. Deterministic condense always runs.
// The model-only pass and the hybrid pass run when a key is set.
// Hybrid keeps condense's steps, params, and secret tags. The model drops
// noise, writes intent text, and flags human steps.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyHybrid, isNoiseStep, parseHybrid } from "../../v1/hybrid";
import { interpret } from "../../v1/interpret";
import type { TrailEvent } from "../../v1/interpret";
import type { WorkflowV2 } from "../../v1/schema";
import { validateWorkflow } from "../../v1/schema";
import { INTENT_CASES, noisyTrail, type IntentCase } from "./cases";
import { caseJudgePrompt, calibrationPrompt, HAND_LABELS } from "./labels";
import { complete, configuredModel, parseCaseJudge, parseDecision, parseFlagMap } from "./model";
import {
  deterministicWorkflow,
  expectedHuman,
  humanKeys,
  keepEvents,
  multisetScore,
  replayCase,
  scoreParams,
  stepSignature,
  targetOf,
  truthWorkflow,
} from "./score";

export interface IntentRow {
  caseId: string;
  condenser: string;
  stepPrecision: number | null;
  stepRecall: number | null;
  paramRecall: number | null;
  secret: number | null;
  humanPrecision: number | null;
  humanRecall: number | null;
  modelHumanRecall: number | null;
  modelSecretRecall: number | null;
  judge: number | null;
  replay: string;
  modelCalls: number | null;
  tokens: number | null;
  note: string;
}

export interface CalibrationRow {
  id: string;
  good: boolean;
  judge: boolean | null;
  match: boolean;
}

function fmt(n: number | null): string {
  if (n == null) return "";
  return n.toFixed(2);
}

function eventTarget(event: TrailEvent): string {
  const id = event.identity;
  return id?.testId || id?.id || id?.name || id?.nameAttr || "";
}

function promptFor(events: TrailEvent[]): string {
  const lines = events.map((event) => {
    const bits = [event.id, event.kind, event.op, eventTarget(event) || "-", event.value || "-", event.key || "-"];
    return bits.join(" ");
  });
  return [
    "Condense this UI trail into the intended workflow.",
    "Drop reads, scrolls, a value that was wiped with Backspace, a repeated click, a Help click, and a Coupon path that ends at Cancel.",
    "Keep the actions that finish the task, in order.",
    "Password and pin typing, and a Log in or Sign in click, are human gate login.",
    "A Confirm click is human gate confirm.",
    "Password and pin events are secrets.",
    "Reply with JSON only: {\"keep\":[\"id\"],\"human\":[{\"id\":\"id\",\"gate\":\"login\"}],\"secrets\":[\"id\"]}",
    "Events, one per line: id kind op target value key",
    ...lines,
  ].join("\n");
}

function hybridPrompt(workflow: WorkflowV2): string {
  const lines = workflow.steps.map((step) => [
    step.id,
    step.action,
    targetOf(step) || "-",
    step.input || "-",
    step.gate || "-",
    step.label,
  ].join(" "));
  return [
    "This workflow was condensed deterministically. Step identity, inputs, and secret tags are fixed.",
    "You may only drop noise steps, write intent text, and flag human steps.",
    "Drop a step only when its target is help. Keep every other id.",
    "Intent text is one concrete sentence. Refer to a typed value as {{its input name}}. Do not write a password, a pin, or the captured text.",
    "Flag human as login for a password or pin step and for a Log in or Sign in click. Flag human as confirm for a Confirm click.",
    "Reply with JSON only: {\"drop\":[\"id\"],\"summary\":\"one sentence\",\"steps\":[{\"id\":\"id\",\"intent\":\"sentence\"}],\"human\":[{\"id\":\"id\",\"gate\":\"login\"}]}",
    "Every kept step appears in steps. drop contains only ids from this list.",
    "id action target input gate label",
    ...lines,
  ].join("\n");
}

async function scoreWorkflow(item: IntentCase, workflow: WorkflowV2, replayIt: boolean): Promise<Pick<IntentRow, "stepPrecision" | "stepRecall" | "paramRecall" | "secret" | "humanPrecision" | "humanRecall" | "replay" | "modelCalls" | "note">> {
  const truth = truthWorkflow(item);
  const steps = multisetScore(truth.steps.map(stepSignature), workflow.steps.map(stepSignature));
  const params = scoreParams(workflow, item);
  const human = multisetScore(expectedHuman(item), humanKeys(workflow));
  const errors = validateWorkflow(workflow);
  let replay = "not run";
  let modelCalls: number | null = null;
  let note = errors.length ? `invalid workflow ${errors.join(",")}` : "";
  if (replayIt && errors.length === 0) {
    const runs = [];
    for (const spec of item.replays) {
      const outcome = await replayCase(workflow, item, spec);
      runs.push(outcome);
      if (outcome.modelCalls) modelCalls = (modelCalls || 0) + outcome.modelCalls;
    }
    modelCalls = modelCalls || 0;
    const passed = runs.every((run) => run.status === "passed" && run.oracle == null);
    replay = passed ? "pass" : runs.map((run) => run.oracle || run.reason || run.status).join("; ");
  }
  return {
    stepPrecision: steps.precision,
    stepRecall: steps.recall,
    paramRecall: params.recall,
    secret: params.secret,
    humanPrecision: human.precision,
    humanRecall: human.recall,
    replay,
    modelCalls,
    note,
  };
}

function blankScores(): Pick<IntentRow, "stepPrecision" | "stepRecall" | "paramRecall" | "secret" | "humanPrecision" | "humanRecall" | "modelHumanRecall" | "modelSecretRecall" | "judge" | "replay" | "modelCalls" | "tokens" | "note"> {
  return {
    stepPrecision: 0,
    stepRecall: 0,
    paramRecall: 0,
    secret: 0,
    humanPrecision: 0,
    humanRecall: 0,
    modelHumanRecall: 0,
    modelSecretRecall: null,
    judge: null,
    replay: "fail",
    modelCalls: null,
    tokens: null,
    note: "",
  };
}

async function askHybrid(base: WorkflowV2): Promise<{ raw: unknown; tokens: number }> {
  const allowed = new Set(base.steps.map((step) => step.id));
  const prompt = hybridPrompt(base);
  let tokens = 0;
  let last = "hybrid did not return JSON";
  let raw: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const reply = await complete(attempt === 0 ? prompt : `${prompt}\n${last}\nReply with JSON only.`);
    tokens += reply.tokens || 0;
    try {
      raw = JSON.parse(extract(reply.text));
      const edit = parseHybrid(reply.text, allowed);
      const missed = base.steps.filter(isNoiseStep).map((step) => step.id).filter((id) => !edit.drop.includes(id));
      if (missed.length && attempt < 2) {
        last = `Constraint failed: drop these help step ids and do not drop any other id: ${missed.join(", ")}.`;
        continue;
      }
      return { raw, tokens };
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(last);
}

function extract(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return JSON");
  return text.slice(start, end + 1);
}

function judgeFraction(summary: boolean, steps: Record<string, boolean>, ids: string[]): number {
  const marks = [summary, ...ids.map((id) => steps[id] === true)];
  return marks.filter(Boolean).length / marks.length;
}

export async function evalIntent(args: string[] = []): Promise<{ markdown: string; rows: IntentRow[] }> {
  const out = flag(args, "--out") || path.join("docs", "eval", "intent.md");
  const rows: IntentRow[] = [];
  for (const item of INTENT_CASES) {
    const workflow = deterministicWorkflow(item);
    const scored = await scoreWorkflow(item, workflow, true);
    rows.push({
      caseId: item.id,
      condenser: "condense",
      modelHumanRecall: null,
      modelSecretRecall: null,
      judge: null,
      tokens: null,
      ...scored,
    });
  }

  const info = configuredModel();
  let modelNote = info.reason;
  let calibration: CalibrationRow[] = [];
  let calibrationTokens: number | null = null;
  if (!info.available) {
    for (const item of INTENT_CASES) {
      rows.push(notRun(item.id, "model", modelNote));
      rows.push(notRun(item.id, "hybrid", modelNote));
    }
  } else {
    try {
      const ping = await complete("Reply with the single word pong");
      modelNote = `${info.provider} / ${info.model}; ping tokens ${ping.tokens ?? "n/a"}`;
    } catch (err) {
      modelNote = `${info.provider} / ${info.model} not run: ${err instanceof Error ? err.message : String(err)}`;
      for (const item of INTENT_CASES) {
        rows.push(notRun(item.id, info.model || "model", modelNote));
        rows.push(notRun(item.id, "hybrid", modelNote));
      }
      return finish(out, rows, modelNote, calibration, calibrationTokens);
    }
    try {
      const reply = await complete(calibrationPrompt());
      calibrationTokens = reply.tokens;
      const scores = parseFlagMap(reply.text);
      calibration = HAND_LABELS.map((label) => ({
        id: label.id,
        good: label.good,
        judge: Object.prototype.hasOwnProperty.call(scores, label.id) ? scores[label.id]! : null,
        match: scores[label.id] === label.good,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      calibration = HAND_LABELS.map((label) => ({ id: label.id, good: label.good, judge: null, match: false }));
      modelNote += `. judge calibration failed: ${message.slice(0, 180)}`;
    }
    for (const item of INTENT_CASES) {
      rows.push(await modelOnlyRow(item, info));
    }
    for (const item of INTENT_CASES) {
      rows.push(await hybridRow(item, info));
    }
  }
  return finish(out, rows, modelNote, calibration, calibrationTokens);
}

async function modelOnlyRow(item: IntentCase, info: { provider: string; model: string }): Promise<IntentRow> {
  const noisy = noisyTrail(item.events, item.noise);
  try {
    const reply = await complete(promptFor(noisy));
    const decision = parseDecision(reply.text);
    const kept = keepEvents(noisy, decision.keep, decision.human, decision.secrets);
    const workflow = interpret(kept, { id: item.id, name: item.name, startUrl: item.startUrl, secrets: item.secrets });
    const scored = await scoreWorkflow(item, workflow, true);
    const human = multisetScore(item.human.map((mark) => mark.id + "|" + mark.gate), decision.human.map((mark) => mark.id + "|" + mark.gate));
    const secret = multisetScore(item.secretIds, decision.secrets);
    return {
      caseId: item.id,
      condenser: `${info.provider}/${info.model}`,
      modelHumanRecall: human.recall,
      modelSecretRecall: secret.recall,
      judge: null,
      tokens: reply.tokens,
      ...scored,
    };
  } catch (err) {
    return {
      caseId: item.id,
      condenser: `${info.provider}/${info.model}`,
      ...blankScores(),
      note: (err instanceof Error ? err.message : String(err)).slice(0, 240),
    };
  }
}

async function hybridRow(item: IntentCase, info: { provider: string; model: string }): Promise<IntentRow> {
  const condenser = `hybrid/${info.provider}/${info.model}`;
  try {
    const base = deterministicWorkflow(item);
    const asked = await askHybrid(base);
    const applied = applyHybrid(base, asked.raw, item.secrets);
    const scored = await scoreWorkflow(item, applied.workflow, true);
    const predicted = applied.human.flatMap((mark) => {
      const step = base.steps.find((itemStep) => itemStep.id === mark.id);
      return step ? [`${mark.gate}|${targetOf(step)}`] : [];
    });
    const human = multisetScore(expectedHuman(item), predicted);
    let judge: number | null = null;
    let tokens = asked.tokens;
    let judgeNote = "";
    try {
      const reply = await complete(caseJudgePrompt(
        applied.workflow.summary || "",
        applied.workflow.steps.map((step) => ({ id: step.id, intent: step.intent || "" })),
      ));
      tokens += reply.tokens || 0;
      const parsed = parseCaseJudge(reply.text);
      judge = judgeFraction(parsed.summary, parsed.steps, applied.workflow.steps.map((step) => step.id));
    } catch (err) {
      judgeNote = err instanceof Error ? err.message : String(err);
    }
    const notes = [
      scored.note,
      applied.refused.length ? `refused drop ${applied.refused.join(",")}` : "",
      applied.ignored.length ? `ignored ${applied.ignored.join(",")}` : "",
      judgeNote ? `judge ${judgeNote}` : "",
    ].filter(Boolean);
    return {
      caseId: item.id,
      condenser,
      modelHumanRecall: human.recall,
      modelSecretRecall: null,
      judge,
      tokens,
      ...scored,
      note: notes.join("; ").slice(0, 240),
    };
  } catch (err) {
    return {
      caseId: item.id,
      condenser,
      ...blankScores(),
      note: (err instanceof Error ? err.message : String(err)).slice(0, 240),
    };
  }
}

function notRun(caseId: string, condenser: string, reason: string): IntentRow {
  return {
    caseId,
    condenser,
    stepPrecision: null,
    stepRecall: null,
    paramRecall: null,
    secret: null,
    humanPrecision: null,
    humanRecall: null,
    modelHumanRecall: null,
    modelSecretRecall: null,
    judge: null,
    replay: "not run",
    modelCalls: null,
    tokens: null,
    note: reason,
  };
}

function finish(
  out: string,
  rows: IntentRow[],
  modelNote: string,
  calibration: CalibrationRow[],
  calibrationTokens: number | null,
): { markdown: string; rows: IntentRow[] } {
  const markdown = render(rows, modelNote, calibration, calibrationTokens);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, markdown);
  return { markdown, rows };
}

function render(rows: IntentRow[], modelNote: string, calibration: CalibrationRow[], calibrationTokens: number | null): string {
  const agreed = calibration.filter((row) => row.match).length;
  const calibrationLine = calibration.length
    ? `Judge calibration on ${calibration.length} hand labels: ${agreed}/${calibration.length} agree. Calibration tokens ${calibrationTokens ?? "n/a"}.`
    : "Judge calibration did not run.";
  const header = [
    "# Intent eval",
    "",
    `Model access: ${modelNote}.`,
    "",
    calibrationLine,
    "",
    "The condenser `condense` is deterministic and calls no model. The model condenser edits the raw trail. `hybrid` starts from `condense`: the model may drop a Help step, write a summary and per-step intent, and flag human steps. Unknown ids are ignored. A drop is refused when the step has an input, a gate, a secret tag, or a text, url, or value postcondition. Intent text is scrubbed of secret literals and of captured defaults. Hybrid human precision and recall are the gates condense already set. Model human on a hybrid row is the flags the model returned, matched by target. Judge scores the hybrid intent text from 0 to 1. Step precision and recall compare workflow steps with the ground-truth steps. A Help click is left in the deterministic trail on purpose. Param recall is typed values, literal currency or unit values, and secret and file inputs. Secret is 0 if a secret literal survived in the workflow. Replay is two runs with new inputs. Model calls are heal calls during those replays. Hybrid tokens include the judge call.",
    "",
    "| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const body = rows.map((row) => [
    row.caseId,
    row.condenser,
    fmt(row.stepPrecision),
    fmt(row.stepRecall),
    fmt(row.paramRecall),
    fmt(row.secret),
    fmt(row.humanPrecision),
    fmt(row.humanRecall),
    fmt(row.modelHumanRecall),
    fmt(row.modelSecretRecall),
    fmt(row.judge),
    row.replay,
    row.modelCalls == null ? "" : String(row.modelCalls),
    row.tokens == null ? "" : String(row.tokens),
    row.note.replace(/\|/g, "/"),
  ].join(" | "));
  const lines = body.map((line) => `| ${line} |`);
  const labels = calibration.length ? renderCalibration(calibration) : [];
  return [...header, ...lines, "", ...labels, ""].join("\n");
}

function renderCalibration(rows: CalibrationRow[]): string[] {
  const header = [
    "## Judge calibration",
    "",
    "Hand labels are fixed in `desktop/src/eval/intent/labels.ts`. The judge does not see the good column.",
    "",
    "| id | hand | judge | match |",
    "| --- | --- | --- | --- |",
  ];
  const body = rows.map((row) => `| ${row.id} | ${row.good ? "good" : "bad"} | ${row.judge == null ? "" : row.judge ? "good" : "bad"} | ${row.match ? "yes" : "no"} |`);
  return [...header, ...body];
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
