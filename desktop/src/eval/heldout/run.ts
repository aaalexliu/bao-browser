// Score held-out trails. Prompts match desktop/src/eval/intent/run.ts.
// This file does not change the condenser. It only reads a captured dir.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { applyHybrid, isNoiseStep, parseHybrid } from "../../v1/hybrid";
import { interpret, type TrailEvent } from "../../v1/interpret";
import { condense, droppedNoEffectIds } from "../../v1/condense";
import { BrowserDriver } from "../../v1/browser-driver";
import { launchOwnedChrome } from "../../launch";
import { replay, type RunResult } from "../../v1/replay";
import type { TrajectoryStep } from "../../v1/trajectory";
import type { ReplayArgs, WorkflowStep, WorkflowV2 } from "../../v1/schema";
import { validateWorkflow } from "../../v1/schema";
import type { IntentCase } from "../intent/cases";
import { GOOD_INTENTS } from "../intent/good-intents";
import { lintIntent, type LintTarget } from "../intent/lint";
import { caseJudgePrompt } from "../intent/labels";
import { complete, configuredModel, parseCaseJudge, parseDecision, parseFlagMap } from "../intent/model";
import { HYBRID_GATE_RULE, modelCondensePrompt, reviseDecision, reviseStepGates } from "../intent/revise";
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
  /** Set when the site cannot satisfy the oracle. Empty means the row counts. */
  invalid: string;
}

export interface BadJudgeRow {
  id: string;
  text: string;
  judge: boolean | null;
  low: boolean;
  lint: string;
}

function fmt(n: number | null): string {
  if (n == null) return "";
  return n.toFixed(2);
}

function promptFor(events: TrailEvent[]): string {
  return modelCondensePrompt(events);
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
    HYBRID_GATE_RULE,
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

interface ReplayTrace {
  line: string;
  modelCalls: number;
  steps: { stepId: string; passed: boolean; detail: string }[];
  trajectory: TrajectoryStep[];
}

function replayTrace(line: string, modelCalls: number, result?: RunResult): ReplayTrace {
  return {
    line,
    modelCalls,
    steps: (result?.steps || []).map((step) => ({
      stepId: step.id,
      passed: step.status === "passed",
      detail: step.reason || "",
    })),
    trajectory: result?.trajectory || [],
  };
}

async function replayHeld(
  context: Awaited<ReturnType<typeof launchOwnedChrome>>,
  truth: HeldTruth,
  workflow: WorkflowV2,
  spec: HeldTruth["replays"][number],
): Promise<ReplayTrace> {
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
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const winner = await Promise.race([
    guarded,
    new Promise<{ kind: "timeout" }>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: "timeout" }), 45000);
    }),
  ]);
  clearTimeout(timeout);
  try {
    if (winner.kind === "timeout") return replayTrace("timeout", modelCalls);
    if (winner.kind === "error") return replayTrace(winner.reason.slice(0, 180), modelCalls);
    if (winner.result.status !== "passed") {
      return replayTrace((winner.result.failure?.reason || winner.result.status).slice(0, 180), modelCalls, winner.result);
    }
    const miss = await pageOracle(context, page, truth.oracle, spec);
    return replayTrace(miss || "pass", modelCalls, winner.result);
  } finally {
    const home = context.pages()[0];
    for (const item of context.pages()) {
      if (item !== home) await item.close().catch(() => undefined);
    }
  }
}

export interface FrozenCase {
  caseId: string;
  passed: boolean;
  detail: string;
  steps: { stepId: string; passed: boolean; detail: string }[];
  trajectory: TrajectoryStep[];
}

/** Deterministic condense and replay of frozen trails. No model call. */
export async function frozenHeldout(batches: { name: string; dir: string }[]): Promise<FrozenCase[]> {
  const { mkdtemp } = await import("node:fs/promises");
  const profile = await mkdtemp(path.join("/tmp", "bao-frozen-"));
  const context = await launchOwnedChrome({
    userDataDir: profile,
    headless: true,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });
  const cases: FrozenCase[] = [];
  try {
    for (const batch of batches) {
      for (const item of loadBundle(batch.dir)) {
        const caseId = `heldout/${batch.name}/${item.truth.id}`;
        try {
          const workflow = condense(item.events, metaOf(item.truth));
          const runs: string[] = [];
          let steps: FrozenCase["steps"] = [];
          let trajectory: TrajectoryStep[] = [];
          for (let i = 0; i < item.truth.replays.length; i++) {
            const outcome = await replayHeld(context, item.truth, workflow, item.truth.replays[i]!);
            runs.push(outcome.line);
            if (i === 0) {
              steps = outcome.steps;
              trajectory = outcome.trajectory;
            }
          }
          const detail = runs.every((line) => line === "pass") ? "pass" : runs.join("; ");
          const passed = detail === "pass";
          if (!passed && steps.every((step) => step.passed)) {
            steps = [...steps, { stepId: "oracle", passed: false, detail }];
          }
          cases.push({ caseId, passed, detail, steps, trajectory });
          console.log(`${caseId} ${detail}`);
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          cases.push({
            caseId,
            passed: false,
            detail,
            steps: [{ stepId: "replay", passed: false, detail }],
            trajectory: [],
          });
          console.log(`${caseId} ${detail}`);
        }
      }
    }
  } finally {
    await context.close().catch(() => undefined);
  }
  return cases;
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
    invalid: "",
  };
}

export async function evalHeldout(args: string[] = []): Promise<{ markdown: string; rows: HeldRow[]; bad: BadJudgeRow[] }> {
  if (args.includes("--judge")) {
    const out = flag(args, "--out") || path.join("docs", "eval", "heldout", "lint-judge.md");
    const info = configuredModel();
    const judged = await scoreBadTexts();
    const goods = goodRejects();
    const low = judged.rows.filter((row) => row.low).length;
    const markdown = [
      "# Intent lint and bad texts",
      "",
      `Model access: ${info.available ? `${info.provider} / ${info.model}` : info.reason}. ${judged.note}`,
      "",
      "The lint runs first. It rejects a generic verb-only sentence, a destructive verb the step does not do, a Help goal, and a literal that matches a secret or a param slot. The rubric is unchanged. The model scores only the texts the lint passes. The earlier 5/10 table stays in `bad-judge.md`.",
      "",
      `${low}/${judged.rows.length} bad texts caught. ${goods.length}/${GOOD_INTENTS.length} good intents falsely rejected.`,
      "",
      "| id | lint | judge | caught | text |",
      "| --- | --- | --- | --- | --- |",
      ...judged.rows.map((row) => `| ${row.id} | ${row.lint || ""} | ${row.judge == null ? "" : row.judge ? "good" : "bad"} | ${row.low ? "yes" : "no"} | ${row.text.replace(/\|/g, "/")} |`),
      "",
      goods.length ? `False rejects: ${goods.map((item) => `${item.id} ${item.reason}`).join(", ")}.` : "False rejects: none.",
      "",
    ].join("\n");
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, markdown);
    return { markdown, rows: [], bad: judged.rows };
  }
  const dir = flag(args, "--dir") || path.join("docs", "eval", "heldout", "batch1");
  const out = flag(args, "--out") || path.join("docs", "eval", "heldout", "batch1.md");
  const bundle = loadBundle(dir);
  const drops = effectDrops(bundle);
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
    let bad: BadJudgeRow[] = BAD_INTENT_TEXTS.map((label) => {
      const lint = lintBad(label) || "";
      return { id: label.id, text: label.text, judge: lint ? false as const : null, low: !!lint, lint };
    });
    if (!info.available) {
      for (const item of bundle) {
        rows.push({ caseId: item.truth.id, condenser: "model", ...blank(modelNote) });
        rows.push({ caseId: item.truth.id, condenser: "hybrid", ...blank(modelNote) });
      }
      const markdown = render(rows, bad, modelNote, drops);
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
      const markdown = render(rows, bad, modelNote, drops);
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, markdown);
      return { markdown, rows, bad };
    }
    const judged = await scoreBadTexts();
    bad = judged.rows;
    if (judged.note) modelNote += `. ${judged.note}`;
    for (const item of bundle) rows.push(await modelOnlyRow(item.truth, item.events, info, context));
    for (const item of bundle) rows.push(await hybridRow(item.truth, item.events, info, context));
    const markdown = render(rows, bad, modelNote, drops);
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
    return { caseId: truth.id, condenser: "condense", modelHumanRecall: null, modelSecretRecall: null, judge: null, tokens: null, invalid: fixtureCell(truth), ...scored };
  } catch (err) {
    return { caseId: truth.id, condenser: "condense", ...blank(err instanceof Error ? err.message : String(err)), replay: "fail", invalid: fixtureCell(truth) };
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
    const decision = reviseDecision(events, parseDecision(reply.text));
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
      invalid: fixtureCell(truth),
      ...scored,
    };
  } catch (err) {
    return { caseId: truth.id, condenser, ...blank(err instanceof Error ? err.message : String(err)), replay: "fail", invalid: fixtureCell(truth) };
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
    const humanMarks = reviseStepGates(base.steps, applied.human);
    const predicted = humanMarks.flatMap((mark) => {
      const step = base.steps.find((itemStep) => itemStep.id === mark.id);
      return step ? [`${mark.gate}|${targetOf(step)}`] : [];
    });
    const human = multisetScore(expectedHuman(item), predicted);
    let judge: number | null = null;
    let tokens = asked.tokens;
    let judgeNote = "";
    try {
      const judged = await judgeHybrid(applied.workflow, truth.secrets);
      judge = judged.score;
      tokens += judged.tokens;
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
      invalid: fixtureCell(truth),
      ...scored,
      note: notes.join("; ").slice(0, 400),
    };
  } catch (err) {
    return { caseId: truth.id, condenser, ...blank(err instanceof Error ? err.message : String(err)), replay: "fail", invalid: fixtureCell(truth) };
  }
}

function lintBad(label: (typeof BAD_INTENT_TEXTS)[number]): string | null {
  return lintIntent(label.text, label.target, label.secrets || []);
}

async function scoreBadTexts(): Promise<{ rows: BadJudgeRow[]; note: string }> {
  const pending = BAD_INTENT_TEXTS.filter((label) => !lintBad(label));
  let scores: Record<string, boolean> = {};
  let note = pending.length ? "" : "lint rejected every bad text before the model";
  if (pending.length) {
    try {
      const reply = await complete(badJudgePrompt(pending));
      scores = parseFlagMap(reply.text);
      if (!pending.some((label) => Object.prototype.hasOwnProperty.call(scores, label.id))) {
        note = `bad-text judge keys: ${Object.keys(scores).join(", ") || "none"}`;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      note = `bad-text judge failed: ${message.slice(0, 180)}`;
    }
  }
  const rows = BAD_INTENT_TEXTS.map((label) => {
    const lint = lintBad(label) || "";
    if (lint) return { id: label.id, text: label.text, judge: false, low: true, lint };
    const judge = Object.prototype.hasOwnProperty.call(scores, label.id) ? scores[label.id]! : null;
    return { id: label.id, text: label.text, judge, low: judge === false, lint };
  });
  return { rows, note };
}

function goodRejects(): { id: string; reason: string }[] {
  return GOOD_INTENTS.flatMap((item) => {
    const reason = lintIntent(item.text, item.target, item.secrets || []);
    return reason ? [{ id: item.id, reason }] : [];
  });
}

function effectDrops(bundle: { truth: HeldTruth; events: TrailEvent[] }[]): { caseId: string; eventId: string }[] {
  const out: { caseId: string; eventId: string }[] = [];
  for (const item of bundle) {
    const dropped = new Set(droppedNoEffectIds(item.events));
    for (const id of item.truth.keep) {
      if (dropped.has(id)) out.push({ caseId: item.truth.id, eventId: id });
    }
  }
  return out;
}

async function judgeHybrid(workflow: WorkflowV2, secrets: string[]): Promise<{ score: number; tokens: number }> {
  const failed = new Set<string>();
  const passing: { id: string; intent: string }[] = [];
  for (const step of workflow.steps) {
    const input = workflow.inputs.find((item) => item.name === step.input);
    const target: LintTarget = {
      action: step.action,
      name: step.identity?.name || step.identity?.text || step.identity?.label,
      label: step.identity?.label,
      text: step.identity?.text,
      input: step.input,
      literal: input?.default,
    };
    if (lintIntent(step.intent || "", target, secrets)) failed.add(step.id);
    else passing.push({ id: step.id, intent: step.intent || "" });
  }
  const summary = workflow.summary || "";
  const summaryFail = lintIntent(summary, undefined, secrets);
  const ids = workflow.steps.map((step) => step.id);
  if (summaryFail && passing.length === 0) return { score: 0, tokens: 0 };
  const reply = await complete(caseJudgePrompt(summaryFail ? "" : summary, passing));
  const parsed = parseCaseJudge(reply.text);
  const steps = { ...parsed.steps };
  for (const id of failed) steps[id] = false;
  return { score: judgeFraction(summaryFail ? false : parsed.summary, steps, ids), tokens: reply.tokens || 0 };
}

function fixtureCell(truth: HeldTruth): string {
  if (!truth.invalid) return "";
  return `${truth.invalid.reason} ${truth.invalid.evidence}`.replace(/\|/g, "/");
}

function rowKind(row: HeldRow): "condense" | "model" | "hybrid" {
  if (row.condenser === "condense") return "condense";
  if (row.condenser.startsWith("hybrid/")) return "hybrid";
  return "model";
}

/** Step precision, recall, and replay. Invalid fixtures drop out when includeInvalid is false. */
export function heldAverages(rows: readonly HeldRow[], includeInvalid: boolean): { condenser: string; n: number; precision: number; recall: number; replay: string }[] {
  return (["condense", "model", "hybrid"] as const).map((kind) => {
    const mine = rows.filter((row) => rowKind(row) === kind && (includeInvalid || !row.invalid));
    const scored = mine.filter((row) => row.stepPrecision != null && row.stepRecall != null);
    const precision = scored.length ? scored.reduce((sum, row) => sum + (row.stepPrecision || 0), 0) / scored.length : 0;
    const recall = scored.length ? scored.reduce((sum, row) => sum + (row.stepRecall || 0), 0) / scored.length : 0;
    const pass = mine.filter((row) => row.replay === "pass").length;
    return { condenser: kind, n: mine.length, precision, recall, replay: `${pass}/${mine.length || 0}` };
  });
}

function formatRates(rates: ReturnType<typeof heldAverages>): string {
  return rates.map((rate) => `${rate.condenser} P ${rate.precision.toFixed(3)} R ${rate.recall.toFixed(3)} replay ${rate.replay}`).join("; ");
}

function replayPasses(rows: HeldRow[], pred: (row: HeldRow) => boolean): string {
  const mine = rows.filter(pred);
  const ok = mine.filter((row) => row.replay === "pass").length;
  return `${ok}/${mine.length || 0}`;
}

function render(
  rows: HeldRow[],
  bad: BadJudgeRow[],
  modelNote: string,
  drops: { caseId: string; eventId: string }[] = [],
): string {
  const low = bad.filter((row) => row.low).length;
  const goods = goodRejects();
  const dropText = drops.length
    ? drops.map((item) => `${item.caseId} ${item.eventId}`).join(", ")
    : "none";
  const header = [
    "# Held-out intent",
    "",
    "Trails were captured from public pages and the ground truth was committed before this run. Replay uses multi-locator lookup and the search-toggle reveal. A click is dropped only when the trail shows no url, checked, value, subtree change, or JS dialog, and no later step sits in its subtree. A Help click is kept.",
    "",
    "A step expects the effect the trail recorded: text that appeared in the target subtree, then a value or checked change, then a url change. A url template uses a param only when the recorded url contained that typed value. When none of those happened, the step expects no error and the page settled, and it is marked low-confidence.",
    "",
    `Effect filter wrongly dropped ${drops.length} true keep steps: ${dropText}.`,
    "",
    rows.some((row) => row.invalid)
      ? [
          "Invalid fixtures stay in the table and are not counted as bao misses.",
          `Including invalid fixtures: ${formatRates(heldAverages(rows, true))}.`,
          `Excluding invalid fixtures: ${formatRates(heldAverages(rows, false))}.`,
        ].join("\n\n")
      : `Replay pass rate: condense ${replayPasses(rows, (row) => row.condenser === "condense")}, model ${replayPasses(rows, (row) => row.condenser !== "condense" && !row.condenser.startsWith("hybrid/"))}, hybrid ${replayPasses(rows, (row) => row.condenser.startsWith("hybrid/"))}.`,
    "",
    `Intent lint caught ${low}/${bad.length} bad texts and falsely rejected ${goods.length}/${GOOD_INTENTS.length} good intents.`,
    "",
    `Model access: ${modelNote}.`,
    "",
    "Step precision and recall use action, id, name attribute, accessible name, text (60 chars), css path, gate, input, and key. Param recall, secret, and human gates use the same scorers as `bao eval intent`. Replay is two runs in a real browser with new inputs. A replay that misses its page oracle is not a pass. Model calls are heal calls. The judge rubric is the one in `desktop/src/eval/intent/labels.ts`, unchanged.",
    "",
    "| case | condenser | step P | step R | param | secret | human P | human R | model human | model secret | judge | replay | model calls | tokens | note | invalid fixture |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
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
    row.invalid.replace(/\|/g, "/"),
  ].join(" | "));
  const lines = body.map((line) => `| ${line} |`);
  const judgeHeader = [
    "",
    "## Bad intent texts",
    "",
    `Lint runs before the judge. ${low}/${bad.length} bad texts were caught. ${goods.length}/${GOOD_INTENTS.length} good intents were falsely rejected. The rubric was not edited.`,
    "",
    "| id | lint | judge | caught | text |",
    "| --- | --- | --- | --- | --- |",
  ];
  const judgeLines = bad.map((row) => `| ${row.id} | ${row.lint || ""} | ${row.judge == null ? "" : row.judge ? "good" : "bad"} | ${row.low ? "yes" : "no"} | ${row.text.replace(/\|/g, "/")} |`);
  return [...header, ...lines, ...judgeHeader, ...judgeLines, ""].join("\n");
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
