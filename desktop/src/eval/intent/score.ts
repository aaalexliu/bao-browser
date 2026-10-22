// Score a condensed workflow against a ground-truth case, then replay it.

import { interpret, isConstantType } from "../../v1/interpret";
import { replay, type Driver } from "../../v1/replay";
import type { Identity, ReplayArgs, WorkflowStep, WorkflowV2 } from "../../v1/schema";
import { condense } from "../../v1/condense";
import { INTENT_CASES, noisyTrail, type IntentCase, type World } from "./cases";
import type { TrailEvent } from "../../v1/interpret";

export function targetOf(step: { identity?: Identity }): string {
  const id = step.identity;
  return id?.testId || id?.id || id?.name || id?.nameAttr || "";
}

export function stepSignature(step: WorkflowStep): string {
  return [step.action, targetOf(step), step.gate || "-", step.input || "-"].join("|");
}

export function multisetScore(expected: string[], predicted: string[]): {
  precision: number;
  recall: number;
  extras: string[];
  missing: string[];
} {
  const bag = new Map<string, number>();
  for (const item of predicted) bag.set(item, (bag.get(item) || 0) + 1);
  const missing: string[] = [];
  let hit = 0;
  for (const item of expected) {
    const n = bag.get(item) || 0;
    if (n > 0) {
      hit += 1;
      bag.set(item, n - 1);
    } else missing.push(item);
  }
  const extras: string[] = [];
  for (const [item, n] of bag) {
    for (let i = 0; i < n; i++) extras.push(item);
  }
  return {
    precision: predicted.length ? hit / predicted.length : expected.length ? 0 : 1,
    recall: expected.length ? hit / expected.length : 1,
    extras,
    missing,
  };
}

export function textDefaults(workflow: WorkflowV2): string[] {
  return workflow.inputs.filter((input) => input.type === "text" || input.type === "number").map((input) => input.default || "");
}

export function truthTexts(item: IntentCase): string[] {
  return item.events.filter((event) => event.op === "type" && !event.sensitive && !isConstantType(event)).map((event) => event.value || "");
}

export function truthLiterals(item: IntentCase): string[] {
  return item.events.filter((event) => isConstantType(event)).map((event) => event.value || "");
}

export function stepLiterals(workflow: WorkflowV2): string[] {
  return workflow.steps.filter((step) => step.action === "type" && !step.input).map((step) => step.value || "");
}

export interface ParamScore {
  recall: number;
  secret: number;
  leaked: string[];
}

export function scoreParams(workflow: WorkflowV2, item: IntentCase): ParamScore {
  const got = textDefaults(workflow);
  const want = truthTexts(item);
  const text = multisetScore(want, got);
  const blob = JSON.stringify(workflow);
  const leaked = item.secrets.filter((secret) => secret && blob.includes(secret));
  const secretInputs = workflow.inputs.filter((input) => input.type === "secret" && !input.default).length;
  const fileInputs = workflow.inputs.filter((input) => input.type === "file").length;
  const fileWant = item.events.filter((event) => event.op === "upload" || event.op === "drop").length;
  const secretRecall = item.secrets.length ? Math.min(secretInputs, item.secrets.length) / item.secrets.length : secretInputs === 0 ? 1 : 0;
  const fileRecall = fileWant ? Math.min(fileInputs, fileWant) / fileWant : fileInputs === 0 ? 1 : 0;
  const literalWant = truthLiterals(item);
  const parts: number[] = [];
  if (want.length) parts.push(text.recall);
  if (item.secrets.length) parts.push(secretRecall);
  if (fileWant) parts.push(fileRecall);
  if (literalWant.length) {
    parts.push(multisetScore(literalWant, stepLiterals(workflow)).recall);
    const lifted = literalWant.filter((value) => got.includes(value)).length;
    parts.push(1 - lifted / literalWant.length);
  }
  const recall = parts.length ? parts.reduce((sum, n) => sum + n, 0) / parts.length : 1;
  const secret = item.secrets.length === 0 ? (leaked.length ? 0 : 1) : (leaked.length ? 0 : secretRecall);
  return { recall, secret, leaked };
}

export function humanKeys(workflow: WorkflowV2): string[] {
  return workflow.steps.filter((step) => step.gate).map((step) => `${step.gate}|${targetOf(step)}`);
}

export function expectedHuman(item: IntentCase): string[] {
  return item.human.map((mark) => `${mark.gate}|${mark.target}`);
}

const CLICK_TEXT: Record<string, string> = {
  save: "Saved",
  "save-profile": "Saved",
  "save-drop": "Saved",
  send: "Sent",
  continue: "Continued",
  finish: "Done",
  apply: "Applied",
  open: "Opened",
  unlock: "Unlocked",
  confirm: "Confirmed",
  "confirm-pay": "Confirmed",
  delete: "Armed",
  pay: "Paying",
  browse: "Dialog",
  "row-30": "Picked",
  buy: "Bought",
};

export function applyWorld(world: World, kind: string, node: Identity | undefined, text: string): void {
  const id = node?.id || "";
  if (kind === "type" || kind === "check") world.values[id] = text;
  if (kind === "upload" || kind === "drop") {
    world.values[id] = text;
    world.texts.push(kind === "drop" ? `Dropped file: ${text}` : text);
    world.texts.push("Uploaded");
  }
  if (kind === "key") world.texts.push("Found");
  if (kind === "click") {
    if (id === "login-btn" || id === "signin-btn") {
      world.url = "https://fixture.test/secure";
      world.texts.push(`Welcome ${world.values.username || ""}`);
    }
    const mark = CLICK_TEXT[id];
    if (mark) world.texts.push(mark === "Opened" ? `Opened ${world.values.filename || ""}` : mark === "Unlocked" ? `Unlocked ${world.values.account || ""}` : mark);
  }
}

export interface ReplayOutcome {
  status: string;
  modelCalls: number;
  oracle: string | null;
  reason?: string;
}

export async function replayCase(workflow: WorkflowV2, item: IntentCase, spec: IntentCase["replays"][number]): Promise<ReplayOutcome> {
  const world: World = { url: item.startUrl, texts: [], values: {} };
  let modelCalls = 0;
  const driver: Driver = {
    async tree() {
      const values = item.nodes.flatMap((node) => {
        const value = world.values[node.id || ""];
        return value != null ? [{ identity: node, value }] : [];
      });
      return { nodes: item.nodes, url: world.url, texts: world.texts.slice(), values };
    },
    async snapshot() {
      return {};
    },
    async click(node) {
      applyWorld(world, "click", node, "");
    },
    async fill(node, text) {
      applyWorld(world, "type", node, text);
    },
    async key() {
      applyWorld(world, "key", undefined, "");
    },
    async upload(node, files) {
      applyWorld(world, "upload", node, files[0]?.name || "");
    },
    async drop(node, files) {
      applyWorld(world, "drop", node, files[0]?.name || "");
    },
    async digits() {
      throw new Error("digits are not in these fixtures");
    },
    async check(node, checked) {
      applyWorld(world, "check", node, checked ? "on" : "off");
    },
    async notify() {},
  };
  const heal = {
    available: () => false,
    propose: async () => {
      modelCalls += 1;
      return null;
    },
  };
  const result = await replay(workflow, argsFor(workflow, spec), driver, {
    heal: heal.available() ? heal : { ...heal, available: () => false },
    settings: { heal: "approve" },
  });
  // available() is false, so propose must not run. Count a call if it does.
  const guarded = modelCalls;
  return {
    status: result.status,
    modelCalls: guarded,
    oracle: result.status === "passed" ? item.oracle(world, spec) : result.failure?.reason || result.status,
    reason: result.failure?.reason,
  };
}

export function argsFor(workflow: WorkflowV2, spec: IntentCase["replays"][number]): ReplayArgs {
  const texts = spec.texts.slice();
  const args: ReplayArgs = {};
  for (const input of workflow.inputs) {
    if (input.type === "secret") args[input.name] = spec.secret;
    else if (input.type === "file") args[input.name] = { name: spec.file, path: `/tmp/${spec.file}` };
    else args[input.name] = texts.shift() ?? "";
  }
  return args;
}

export function truthWorkflow(item: IntentCase): WorkflowV2 {
  return interpret(item.events, { id: item.id, name: item.name, startUrl: item.startUrl, secrets: item.secrets });
}

export function deterministicWorkflow(item: IntentCase): WorkflowV2 {
  return condense(noisyTrail(item.events, item.noise), { id: item.id, name: item.name, startUrl: item.startUrl, secrets: item.secrets });
}

export function keepEvents(events: readonly TrailEvent[], keep: readonly string[], human: { id: string; gate: "login" | "confirm" }[], secrets: readonly string[]): TrailEvent[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  const gates = new Map(human.map((mark) => [mark.id, mark.gate]));
  const secretIds = new Set(secrets);
  const out: TrailEvent[] = [];
  for (const id of keep) {
    const event = byId.get(id);
    if (!event) continue;
    const copy: TrailEvent = { ...event, identity: event.identity ? { ...event.identity, path: event.identity.path.map((seg) => ({ ...seg })) } : undefined };
    if (secretIds.has(id)) copy.sensitive = true;
    const gate = gates.get(id);
    if (gate) copy.gate = gate;
    out.push(copy);
  }
  return out;
}

export { INTENT_CASES, noisyTrail };
