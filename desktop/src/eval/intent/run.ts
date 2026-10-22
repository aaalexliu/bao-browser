// bao eval intent. Deterministic condense always runs.
// The model pass runs only when a key is set, and the table names that model.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { interpret } from "../../v1/interpret";
import type { TrailEvent } from "../../v1/interpret";
import { validateWorkflow } from "../../v1/schema";
import { INTENT_CASES, noisyTrail, type IntentCase } from "./cases";
import { complete, configuredModel, parseDecision } from "./model";
import {
  argsFor,
  deterministicWorkflow,
  expectedHuman,
  humanKeys,
  keepEvents,
  multisetScore,
  replayCase,
  scoreParams,
  stepSignature,
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
  replay: string;
  modelCalls: number | null;
  tokens: number | null;
  note: string;
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

async function scoreWorkflow(item: IntentCase, workflow: ReturnType<typeof truthWorkflow>, replayIt: boolean): Promise<Pick<IntentRow, "stepPrecision" | "stepRecall" | "paramRecall" | "secret" | "humanPrecision" | "humanRecall" | "replay" | "modelCalls" | "note">> {
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
      tokens: null,
      ...scored,
    });
  }

  const info = configuredModel();
  let modelNote = info.reason;
  if (!info.available) {
    for (const item of INTENT_CASES) {
      rows.push(notRun(item.id, "model", modelNote));
    }
  } else {
    try {
      const ping = await complete("Reply with the single word pong");
      modelNote = `${info.provider} / ${info.model}; ping tokens ${ping.tokens ?? "n/a"}`;
    } catch (err) {
      modelNote = `${info.provider} / ${info.model} not run: ${err instanceof Error ? err.message : String(err)}`;
      for (const item of INTENT_CASES) rows.push(notRun(item.id, info.model || "model", modelNote));
      return finish(out, rows, modelNote);
    }
    for (const item of INTENT_CASES) {
      const noisy = noisyTrail(item.events);
      try {
        const reply = await complete(promptFor(noisy));
        const decision = parseDecision(reply.text);
        const kept = keepEvents(noisy, decision.keep, decision.human, decision.secrets);
        const workflow = interpret(kept, { id: item.id, name: item.name, startUrl: item.startUrl, secrets: item.secrets });
        const scored = await scoreWorkflow(item, workflow, true);
        const human = multisetScore(item.human.map((mark) => mark.id + "|" + mark.gate), decision.human.map((mark) => mark.id + "|" + mark.gate));
        const secret = multisetScore(item.secretIds, decision.secrets);
        rows.push({
          caseId: item.id,
          condenser: `${info.provider}/${info.model}`,
          modelHumanRecall: human.recall,
          modelSecretRecall: secret.recall,
          tokens: reply.tokens,
          ...scored,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        rows.push({
          caseId: item.id,
          condenser: `${info.provider}/${info.model}`,
          stepPrecision: 0,
          stepRecall: 0,
          paramRecall: 0,
          secret: 0,
          humanPrecision: 0,
          humanRecall: 0,
          modelHumanRecall: 0,
          modelSecretRecall: 0,
          replay: "fail",
          modelCalls: null,
          tokens: null,
          note: message.slice(0, 240),
        });
      }
    }
  }
  return finish(out, rows, modelNote);
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
    replay: "not run",
    modelCalls: null,
    tokens: null,
    note: reason,
  };
}

function finish(out: string, rows: IntentRow[], modelNote: string): { markdown: string; rows: IntentRow[] } {
  const markdown = render(rows, modelNote);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, markdown);
  return { markdown, rows };
}

function render(rows: IntentRow[], modelNote: string): string {
  const header = [
    "# Intent eval",
    "",
    `Model access: ${modelNote}.`,
    "",
    "The condenser `condense` is deterministic and calls no model. The other condenser is the configured model. Step precision and recall compare workflow steps with the ground-truth steps. A Help click is left in the trail on purpose, so deterministic precision is below 1. Param recall is typed values, file inputs, and secret inputs. Secret is 0 if a secret literal survived in the workflow. Human precision and recall are login and confirm tags on the workflow. Model human and model secret are the ids the model returned, before interpret tags fields itself. Replay is two runs with new inputs. Model calls are heal calls during those replays.",
    "",
    "| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | replay | model calls | tokens | note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
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
    row.replay,
    row.modelCalls == null ? "" : String(row.modelCalls),
    row.tokens == null ? "" : String(row.tokens),
    row.note.replace(/\|/g, "/"),
  ].join(" | "));
  const lines = body.map((line) => `| ${line} |`);
  return [...header, ...lines, ""].join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export { argsFor };
