// Score held-out trails. Prompts match desktop/src/eval/intent/run.ts.
// This file does not change the condenser. It only reads a captured dir.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyHybrid, isNoiseStep, parseHybrid } from "../../v1/hybrid";
import { interpret, type TrailEvent } from "../../v1/interpret";
import { condense } from "../../v1/condense";
import { BrowserDriver } from "../../v1/browser-driver";
import { launchOwnedChrome } from "../../launch";
import { replay } from "../../v1/replay";
import type { ReplayArgs, WorkflowStep, WorkflowV2 } from "../../v1/schema";
import { validateWorkflow } from "../../v1/schema";
import type { IntentCase } from "../intent/cases";
import { caseJudgePrompt } from "../intent/labels";
import { complete, configuredModel, parseCaseJudge, parseDecision, parseFlagMap } from "../intent/model";
import {
  expectedHuman,
  humanKeys,
  keepEvents,
  multisetScore,
  scoreParams,
  targetOf,
  textDefaults,
  truthTexts,
} from "../intent/score";
import { BAD_INTENT_TEXTS, badJudgePrompt } from "./bad-judge";
import type { HeldTruth } from "./capture";
import type { Oracle } from "./tasks";

export interface HeldRow {
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

export interface BadJudgeRow {
  id: string;
  text: string;
  judge: boolean | null;
  low: boolean;
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

function heldSignature(step: WorkflowStep): string {
  const id = step.identity;
  const text = (id?.text || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return [
    step.action,
    id?.id || "",
    id?.nameAttr || "",
    id?.name || "",
    text,
    id?.cssPath || "",
    step.gate || "-",
    step.input || "-",
    step.action === "key" ? step.key || "" : "",
  ].join("|");
}

function loadBundle(dir: string): { truth: HeldTruth; events: TrailEvent[] }[] {
  const truths = JSON.parse(readFileSync(path.join(dir, "truth.json"), "utf8")) as HeldTruth[];
  return truths.map((truth) => ({
    truth,
    events: JSON.parse(readFileSync(path.join(dir, `${truth.id}.json`), "utf8")) as TrailEvent[],
  }));
}

function keptEvents(truth: HeldTruth, events: TrailEvent[]): TrailEvent[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  return truth.keep.flatMap((id) => {
    const event = byId.get(id);
    return event ? [event] : [];
  });
}

function asCase(truth: HeldTruth, events: TrailEvent[]): IntentCase {
  const kept = keptEvents(truth, events);
  const byId = new Map(events.map((event) => [event.id, event]));
  return {
    id: truth.id,
    name: truth.name,
    startUrl: truth.startUrl,
    events: kept,
    secrets: truth.secrets,
    secretIds: truth.secretIds,
    human: truth.human.map((mark) => ({
      id: mark.id,
      gate: mark.gate,
      target: targetOf({ identity: byId.get(mark.id)?.identity }),
    })),
    nodes: [],
    replays: truth.replays,
    oracle: () => null,
  };
}

function metaOf(truth: HeldTruth) {
  return { id: truth.id, name: truth.name, startUrl: truth.startUrl, secrets: truth.secrets };
}

interface Scored {
  stepPrecision: number;
  stepRecall: number;
  paramRecall: number;
  secret: number;
  humanPrecision: number;
  humanRecall: number;
  replay: string;
  modelCalls: number | null;
  note: string;
}

async function scoreWorkflow(
  truth: HeldTruth,
  events: TrailEvent[],
  workflow: WorkflowV2,
  replayIt: boolean,
  context: Awaited<ReturnType<typeof launchOwnedChrome>> | null,
): Promise<Scored> {
  const item = asCase(truth, events);
  const truthWf = interpret(keptEvents(truth, events), metaOf(truth));
  const steps = multisetScore(truthWf.steps.map(heldSignature), workflow.steps.map(heldSignature));
  const params = scoreParams(workflow, item);
  const human = multisetScore(expectedHuman(item), humanKeys(workflow));
  const errors = validateWorkflow(workflow);
  const extraDefaults = multisetScore(truthTexts(item), textDefaults(workflow)).extras;
  const bits = [
    errors.length ? `invalid workflow ${errors.join(",")}` : "",
    steps.missing.length ? `missing ${steps.missing.slice(0, 4).join(" ; ")}` : "",
    steps.extras.length ? `extra ${steps.extras.slice(0, 4).join(" ; ")}` : "",
    extraDefaults.length ? `extra defaults ${extraDefaults.slice(0, 4).join(",")}` : "",
  ].filter(Boolean);
  let replay = "not run";
  let modelCalls: number | null = null;
  if (replayIt && errors.length === 0 && context) {
    const runs: string[] = [];
    modelCalls = 0;
    for (const spec of truth.replays) {
      const outcome = await replayHeld(context, truth, workflow, spec);
      modelCalls += outcome.modelCalls;
      runs.push(outcome.line);
    }
    replay = runs.every((line) => line === "pass") ? "pass" : runs.join("; ");
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
    note: bits.join("; ").slice(0, 400),
  };
}

function argsFor(workflow: WorkflowV2, spec: HeldTruth["replays"][number]): ReplayArgs {
  const texts = spec.texts.slice();
  const args: ReplayArgs = {};
  for (const input of workflow.inputs) {
    if (input.type === "secret") args[input.name] = spec.secret;
    else if (input.type === "file") {
      const name = spec.file || "held-out.txt";
      const filePath = path.join("/tmp", name);
      writeFileSync(filePath, "held out replay\n");
      args[input.name] = { name, path: filePath };
    } else args[input.name] = texts.shift() ?? "";
  }
  return args;
}

async function replayHeld(
  context: Awaited<ReturnType<typeof launchOwnedChrome>>,
  truth: HeldTruth,
  workflow: WorkflowV2,
  spec: HeldTruth["replays"][number],
): Promise<{ line: string; modelCalls: number }> {
  const page = await context.newPage();
  let modelCalls = 0;
  const pending = (async () => {
    await page.goto(truth.startUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => undefined);
    const heal = {
      available: () => false,
      propose: async () => {
        modelCalls += 1;
        return null;
      },
    };
    return replay(workflow, argsFor(workflow, spec), new BrowserDriver(page), {
      heal,
      settings: { heal: "approve" },
    });
  })();
  const guarded = pending.then(
    (result) => ({ kind: "done" as const, result }),
    (err) => ({ kind: "error" as const, reason: err instanceof Error ? err.message : String(err) }),
  );
  const winner = await Promise.race([
    guarded,
    new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 45000)),
  ]);
  try {
    if (winner.kind === "timeout") return { line: "timeout", modelCalls };
    if (winner.kind === "error") return { line: winner.reason.slice(0, 180), modelCalls };
    if (winner.result.status !== "passed") {
      return { line: (winner.result.failure?.reason || winner.result.status).slice(0, 180), modelCalls };
    }
    const miss = await pageOracle(context, page, truth.oracle, spec);
    return { line: miss || "pass", modelCalls };
  } finally {
    const home = context.pages()[0];
    for (const item of context.pages()) {
      if (item !== home) await item.close().catch(() => undefined);
    }
  }
}

function fill(template: string, spec: HeldTruth["replays"][number]): string {
  return template
    .replaceAll("{{0}}", spec.texts[0] || "")
    .replaceAll("{{1}}", spec.texts[1] || "")
    .replaceAll("{{secret}}", spec.secret)
    .replaceAll("{{file}}", spec.file);
}

async function pageOracle(
  context: Awaited<ReturnType<typeof launchOwnedChrome>>,
  page: import("playwright").Page,
  oracle: Oracle,
  spec: HeldTruth["replays"][number],
): Promise<string | null> {
  const deadline = Date.now() + 8000;
  let miss = "oracle";
  while (Date.now() <= deadline) {
    miss = await oracleOnce(context, page, oracle, spec);
    if (!miss) return null;
    await page.waitForTimeout(250).catch(() => undefined);
  }
  return miss;
}

async function oracleOnce(
  context: Awaited<ReturnType<typeof launchOwnedChrome>>,
  page: import("playwright").Page,
  oracle: Oracle,
  spec: HeldTruth["replays"][number],
): Promise<string> {
  if (oracle.kind === "url") {
    const want = fill(oracle.includes, spec);
    return page.url().includes(want) ? "" : `url missing ${want}`;
  }
  if (oracle.kind === "value") {
    const want = fill(oracle.equals, spec);
    const got = await page.locator(oracle.selector).first().inputValue().catch(() => "");
    return got === want ? "" : `value ${got} != ${want}`;
  }
  if (oracle.kind === "checked") {
    const got = await page.locator(oracle.selector).first().isChecked().catch(() => false);
    return got ? "" : `unchecked ${oracle.selector}`;
  }
  if (oracle.kind === "any-body") {
    const want = fill(oracle.includes, spec);
    for (const item of context.pages()) {
      const body = await item.locator("body").innerText().catch(() => "");
      if (body.includes(want)) return "";
    }
    return `body missing ${want}`;
  }
  const want = fill(oracle.includes, spec);
  const body = await page.locator("body").innerText().catch(() => "");
  return body.includes(want) ? "" : `body missing ${want}`;
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

function blank(note: string): Omit<HeldRow, "caseId" | "condenser"> {
  return {
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
    note: note.slice(0, 400),
  };
}

export async function evalHeldout(args: string[] = []): Promise<{ markdown: string; rows: HeldRow[]; bad: BadJudgeRow[] }> {
  if (args.includes("--judge")) {
    const out = flag(args, "--out") || path.join("docs", "eval", "heldout", "bad-judge.md");
    const info = configuredModel();
    const judged = info.available ? await scoreBadTexts() : { rows: BAD_INTENT_TEXTS.map((label) => ({ id: label.id, text: label.text, judge: null, low: false })), note: info.reason };
    const low = judged.rows.filter((row) => row.low).length;
    const markdown = [
      "# Bad intent texts",
      "",
      `Model access: ${info.available ? `${info.provider} / ${info.model}` : info.reason}. ${judged.note}`,
      "",
      "This call uses the same rubric as calibration. The example JSON uses b1 and b2, because the first held-out call followed the calibration example keys l1-l10 and left these rows blank. That first table is in `batch1.md` and is unchanged.",
      "",
      `${low}/${judged.rows.length} scored bad.`,
      "",
      "| id | judge | low | text |",
      "| --- | --- | --- | --- |",
      ...judged.rows.map((row) => `| ${row.id} | ${row.judge == null ? "" : row.judge ? "good" : "bad"} | ${row.judge == null ? "" : row.low ? "yes" : "no"} | ${row.text.replace(/\|/g, "/")} |`),
      "",
    ].join("\n");
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, markdown);
    return { markdown, rows: [], bad: judged.rows };
  }
  const dir = flag(args, "--dir") || path.join("docs", "eval", "heldout", "batch1");
  const out = flag(args, "--out") || path.join("docs", "eval", "heldout", "batch1.md");
  const bundle = loadBundle(dir);
  const rows: HeldRow[] = [];
  const profile = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join("/tmp", "bao-held-replay-")));
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  try {
    for (const item of bundle) {
      rows.push(await deterministicRow(item.truth, item.events, context));
    }
    const info = configuredModel();
    let modelNote = info.reason;
    let bad: BadJudgeRow[] = BAD_INTENT_TEXTS.map((label) => ({ id: label.id, text: label.text, judge: null, low: false }));
    if (!info.available) {
      for (const item of bundle) {
        rows.push({ caseId: item.truth.id, condenser: "model", ...blank(modelNote) });
        rows.push({ caseId: item.truth.id, condenser: "hybrid", ...blank(modelNote) });
      }
      bad = BAD_INTENT_TEXTS.map((label) => ({ id: label.id, text: label.text, judge: null, low: false }));
      const markdown = render(rows, bad, modelNote);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, markdown);
      return { markdown, rows, bad };
    }
    try {
      const ping = await complete("Reply with the single word pong");
      modelNote = `${info.provider} / ${info.model}; ping tokens ${ping.tokens ?? "n/a"}`;
    } catch (err) {
      modelNote = `${info.provider} / ${info.model} not run: ${err instanceof Error ? err.message : String(err)}`;
      for (const item of bundle) {
        rows.push({ caseId: item.truth.id, condenser: info.model || "model", ...blank(modelNote) });
        rows.push({ caseId: item.truth.id, condenser: "hybrid", ...blank(modelNote) });
      }
      const markdown = render(rows, bad, modelNote);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, markdown);
      return { markdown, rows, bad };
    }
    const judged = await scoreBadTexts();
    bad = judged.rows;
    if (judged.note) modelNote += `. ${judged.note}`;
    for (const item of bundle) rows.push(await modelOnlyRow(item.truth, item.events, info, context));
    for (const item of bundle) rows.push(await hybridRow(item.truth, item.events, info, context));
    const markdown = render(rows, bad, modelNote);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, markdown);
    return { markdown, rows, bad };
  } finally {
    await context.close().catch(() => undefined);
  }
}

async function deterministicRow(
  truth: HeldTruth,
  events: TrailEvent[],
  context: Awaited<ReturnType<typeof launchOwnedChrome>>,
): Promise<HeldRow> {
  try {
    const workflow = condense(events, metaOf(truth));
    const scored = await scoreWorkflow(truth, events, workflow, true, context);
    return { caseId: truth.id, condenser: "condense", modelHumanRecall: null, modelSecretRecall: null, judge: null, tokens: null, ...scored };
  } catch (err) {
    return { caseId: truth.id, condenser: "condense", ...blank(err instanceof Error ? err.message : String(err)), replay: "fail" };
  }
}

async function modelOnlyRow(
  truth: HeldTruth,
  events: TrailEvent[],
  info: { provider: string; model: string },
  context: Awaited<ReturnType<typeof launchOwnedChrome>>,
): Promise<HeldRow> {
  const condenser = `${info.provider}/${info.model}`;
  try {
    const reply = await complete(promptFor(events));
    const decision = parseDecision(reply.text);
    const kept = keepEvents(events, decision.keep, decision.human, decision.secrets);
    const workflow = interpret(kept, metaOf(truth));
    const scored = await scoreWorkflow(truth, events, workflow, true, context);
    const human = multisetScore(
      truth.human.map((mark) => mark.id + "|" + mark.gate),
      decision.human.map((mark) => mark.id + "|" + mark.gate),
    );
    const secret = multisetScore(truth.secretIds, decision.secrets);
    return {
      caseId: truth.id,
      condenser,
      modelHumanRecall: human.recall,
      modelSecretRecall: secret.recall,
      judge: null,
      tokens: reply.tokens,
      ...scored,
    };
  } catch (err) {
    return { caseId: truth.id, condenser, ...blank(err instanceof Error ? err.message : String(err)), replay: "fail" };
  }
}

async function hybridRow(
  truth: HeldTruth,
  events: TrailEvent[],
  info: { provider: string; model: string },
  context: Awaited<ReturnType<typeof launchOwnedChrome>>,
): Promise<HeldRow> {
  const condenser = `hybrid/${info.provider}/${info.model}`;
  try {
    const base = condense(events, metaOf(truth));
    const asked = await askHybrid(base);
    const applied = applyHybrid(base, asked.raw, truth.secrets);
    const scored = await scoreWorkflow(truth, events, applied.workflow, true, context);
    const item = asCase(truth, events);
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
      caseId: truth.id,
      condenser,
      modelHumanRecall: human.recall,
      modelSecretRecall: null,
      judge,
      tokens,
      ...scored,
      note: notes.join("; ").slice(0, 400),
    };
  } catch (err) {
    return { caseId: truth.id, condenser, ...blank(err instanceof Error ? err.message : String(err)), replay: "fail" };
  }
}

async function scoreBadTexts(): Promise<{ rows: BadJudgeRow[]; note: string }> {
  try {
    const reply = await complete(badJudgePrompt());
    const scores = parseFlagMap(reply.text);
    const rows = BAD_INTENT_TEXTS.map((label) => {
      const judge = Object.prototype.hasOwnProperty.call(scores, label.id) ? scores[label.id]! : null;
      return { id: label.id, text: label.text, judge, low: judge === false };
    });
    const note = rows.some((row) => row.judge != null) ? "" : `bad-text judge keys: ${Object.keys(scores).join(", ") || "none"}`;
    return { rows, note };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      rows: BAD_INTENT_TEXTS.map((label) => ({ id: label.id, text: label.text, judge: null, low: false })),
      note: `bad-text judge failed: ${message.slice(0, 180)}`,
    };
  }
}

function render(rows: HeldRow[], bad: BadJudgeRow[], modelNote: string): string {
  const low = bad.filter((row) => row.low).length;
  const header = [
    "# Held-out intent",
    "",
    "Trails were captured from public pages and the ground truth was committed before this run. Deterministic, model-only, and hybrid ran with no condenser changes in between. Numbers below are that run.",
    "",
    `Model access: ${modelNote}.`,
    "",
    "Step precision and recall use action, id, name attribute, accessible name, text (60 chars), css path, gate, input, and key. Param recall, secret, and human gates use the same scorers as `bao eval intent`. Replay is two runs in a real browser with new inputs. A replay that misses its page oracle is not a pass. Model calls are heal calls. The judge rubric is the one in `desktop/src/eval/intent/labels.ts`, unchanged.",
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
    row.replay.replace(/\|/g, "/"),
    row.modelCalls == null ? "" : String(row.modelCalls),
    row.tokens == null ? "" : String(row.tokens),
    row.note.replace(/\|/g, "/"),
  ].join(" | "));
  const lines = body.map((line) => `| ${line} |`);
  const judgeHeader = [
    "",
    "## Bad intent texts",
    "",
    `The judge scored ${bad.length} texts written to be bad. ${low}/${bad.length} came back bad (low). The rubric was not edited, and these texts were not added to the calibration set. A concrete wrong verb or a non-secret value can still score good under that rubric.`,
    "",
    "| id | judge | low | text |",
    "| --- | --- | --- | --- |",
  ];
  const judgeLines = bad.map((row) => `| ${row.id} | ${row.judge == null ? "" : row.judge ? "good" : "bad"} | ${row.judge == null ? "" : row.low ? "yes" : "no"} | ${row.text.replace(/\|/g, "/")} |`);
  return [...header, ...lines, ...judgeHeader, ...judgeLines, ""].join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
