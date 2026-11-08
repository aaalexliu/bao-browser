// Heal is off unless a provider says it is available.
// The default policy is auto: apply the patch and keep going.
// approve pauses at the proposal. Keeping a patch stores a draft. The live workflow changes when that draft is promoted.

import type { SavedContext } from "../../../shared/outbound-secrets";
import type { IdentityView } from "../app/view-types";
import { locatorsFromIdentity } from "./locators";
import { changedAttrs, withHealVersion, withRevertVersion } from "./element-history";
import { hintFromIdentity, stepCheck, stepTarget, type Check, type HealMode, type Identity, type Target, type WorkflowStep, type WorkflowV2 } from "./schema";

export interface FailureSnapshot {
  /** PNG bytes, base64. This is the image that was captured for the heal. */
  screenshot?: string;
  screenshotRef?: string;
  dom?: unknown;
  ax?: unknown;
}

/** wait_for, then find, then action, then expect. `gone` fails in expect. `auth` is a login redirect and is not healed. */
export type ReplayPhase = "wait_for" | "find" | "action" | "expect" | "auth";

export interface StepFailure {
  stepId: string;
  index: number;
  intent: string;
  /** wait_for, find, action, expect, or auth. The reason is what failed inside that phase. */
  phase: ReplayPhase;
  reason: string;
  brokenAttr?: string;
  snapshot: FailureSnapshot;
  /** Ranked candidates from the lookup that stopped the step. */
  identity?: IdentityView;
  /** Locators tried for this step, highest score first is not required. 100 is a unique hit. */
  locators?: TriedLocator[];
  /** PNG from the start of the step, when the server asked for shots. */
  beforeShot?: string;
}

/** One locator the replay tried. Score 100 is a unique visible hit. */
export interface TriedLocator {
  kind: string;
  label: string;
  score: number;
}

export interface HealProposal {
  patch: { identity?: Identity };
  model: { provider: string; name: string; version?: string };
  prompt: string;
  rawResponse: string;
}

/** A later decision about a heal. The heal record itself is not rewritten. */
export interface HealDecision {
  ts: number;
  healId: string;
  decision: "keep" | "revert";
}

export interface HealRecord {
  id: string;
  ts: number;
  workflowId: string;
  runId: string;
  mode: HealMode;
  failedStep: WorkflowStep;
  intent: string;
  snapshot: FailureSnapshot;
  prompt: string;
  model?: { provider: string; name: string; version?: string };
  rawResponse?: string;
  proposedPatch?: HealProposal["patch"];
  executed?: { action: string; identity?: Identity };
  postconditionPassed?: boolean;
  kept?: boolean;
  /** PNG from the start of the failed step. Absent when shots were not captured. */
  beforeShot?: string;
  /** Candidates at the time of the miss. Keep and Revert do not change this. */
  identity?: IdentityView;
}

export type HealAttempt = HealProposal | (Omit<HealProposal, "patch"> & { patch?: undefined });

export interface HealProvider {
  available(): boolean;
  propose(failure: StepFailure, step: WorkflowStep, context?: SavedContext): Promise<HealAttempt | null>;
}

export type HealSource =
  | { kind: "none" }
  | { kind: "cursor-account" }
  | { kind: "api-key"; provider: "openai" | "anthropic"; key: string };

export type GlobalHealMode = HealMode | "never";

export interface HealSettings {
  /** Global default. Absent means auto. `never` stops without a heal. */
  heal?: GlobalHealMode;
  /** How long a person has to act. Absent keeps the step timeout. */
  actTimeoutMs?: number;
  /** Passing real runs required before a provisional heal is kept. */
  promoteAfter?: number;
  /** Failed runs inside the window that stop auto-heal. */
  circuitLimit?: number;
  circuitWindowMs?: number;
}

export type StepHeal = "auto" | "ask" | "never";

export function effectiveMode(workflow: WorkflowV2, settings: HealSettings): GlobalHealMode {
  return workflow.heal ?? settings.heal ?? "auto";
}

/** A step policy wins. `ask` is the approve pause. `never` does not call a model. */
export function stepPolicy(
  step: { heal?: string },
  workflow: WorkflowV2,
  settings: HealSettings,
): HealMode | "never" {
  if (step.heal === "never") return "never";
  if (step.heal === "ask") return "approve";
  if (step.heal === "auto") return "auto";
  return effectiveMode(workflow, settings);
}

/** Text the model sees. The PNG stays on the audit record, not inside this string. */
export function promptSnapshot(snapshot: FailureSnapshot): FailureSnapshot {
  const { screenshot, ...rest } = snapshot;
  return {
    ...rest,
    screenshotRef: rest.screenshotRef || (screenshot ? `png:${screenshot.length}` : undefined),
  };
}

export function buildPrompt(failure: StepFailure, step: WorkflowStep): string {
  return [
    "A replay step missed its target or its postcondition.",
    `Intent: ${failure.intent}`,
    `Phase: ${failure.phase}`,
    `Reason: ${failure.reason}`,
    failure.brokenAttr ? `Attribute that broke: ${failure.brokenAttr}` : "",
    `Step: ${JSON.stringify(step)}`,
    `Snapshot: ${JSON.stringify(promptSnapshot(failure.snapshot))}`,
    "Reply with JSON { \"identity\": { ... } } using only identity fields. Do not include coordinates.",
  ].filter(Boolean).join("\n");
}

/** No key, no heal. propose() does not call the network. */
export function llmHealFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): HealProvider {
  const openai = env.OPENAI_API_KEY;
  const anthropic = env.ANTHROPIC_API_KEY;
  return {
    available() {
      return !!(openai || anthropic);
    },
    async propose(failure, step) {
      if (!openai && !anthropic) return null;
      const prompt = buildPrompt(failure, step);
      const provider = openai ? "openai" : "anthropic";
      const name = openai
        ? env.BAO_OPENAI_MODEL || "gpt-4.1-mini"
        : env.BAO_ANTHROPIC_MODEL || "claude-sonnet-4-5";
      const attempt: HealAttempt = { model: { provider, name, version: name }, prompt, rawResponse: "" };
      try {
        const res = await fetchImpl(openai
          ? "https://api.openai.com/v1/chat/completions"
          : "https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: openai
            ? { authorization: `Bearer ${openai}`, "content-type": "application/json" }
            : { "x-api-key": anthropic || "", "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({
            model: name,
            ...(!openai ? { max_tokens: 800 } : {}),
            messages: [{ role: "user", content: prompt }],
          }),
        });
        attempt.rawResponse = await res.text();
        if (!res.ok) return attempt;
        const body = JSON.parse(attempt.rawResponse) as {
          choices?: { message?: { content?: string } }[];
          content?: { type: string; text?: string }[];
        };
        let text: unknown;
        if (openai) {
          if (!Array.isArray(body?.choices)) return attempt;
          text = body.choices[0]?.message?.content;
        } else {
          if (!Array.isArray(body?.content)) return attempt;
          const blocks = body.content.filter((block) => block?.type === "text");
          if (blocks.some((block) => typeof block.text !== "string")) return attempt;
          text = blocks.map((block) => block.text).join("\n");
        }
        if (typeof text !== "string") return attempt;
        const patch = patchFromText(text);
        if (!patch.identity) return attempt;
        return { ...attempt, patch };
      } catch {
        return attempt;
      }
    },
  };
}

export function scriptedHeal(proposal: HealProposal): HealProvider {
  return {
    available: () => true,
    propose: async () => proposal,
  };
}

export function unavailableHeal(): HealProvider {
  return { available: () => false, propose: async () => null };
}

/** No vendor key. The proposal text was written by the Cursor session that is
 * already running. This does not open a login and does not call OpenAI or Anthropic. */
export function cursorSessionHeal(readResponse: () => string): HealProvider {
  return {
    available: () => true,
    async propose(failure, step) {
      const prompt = buildPrompt(failure, step);
      let raw = "";
      try {
        raw = readResponse();
      } catch {
        return null;
      }
      if (!raw.trim()) return null;
      return {
        patch: patchFromText(raw),
        model: { provider: "cursor", name: "cursor-session", version: "1" },
        prompt,
        rawResponse: raw,
      };
    },
  };
}

/**
 * File handoff. Writes the failure and waits for a response file.
 * This process does not invent the patch. The Cursor CLI path calls this
 * only when print mode cannot run.
 */
export function cursorHeal(dir: string, env: NodeJS.ProcessEnv = process.env): HealProvider {
  return {
    available: () => true,
    async propose(failure, step) {
      const { mkdirSync, readFileSync, unlinkSync, writeFileSync } = await import("node:fs");
      const path = await import("node:path");
      mkdirSync(dir, { recursive: true });
      if (failure.snapshot.screenshot) {
        writeFileSync(path.join(dir, "heal-shot.png"), Buffer.from(failure.snapshot.screenshot, "base64"));
      }
      const prompt = buildPrompt(failure, step);
      writeFileSync(path.join(dir, "heal-request.json"), JSON.stringify({
        intent: failure.intent,
        phase: failure.phase,
        reason: failure.reason,
        step,
        dom: failure.snapshot.dom,
        prompt,
      }, null, 2));
      const responsePath = path.join(dir, "heal-response.json");
      try { unlinkSync(responsePath); } catch { /* first request */ }
      const deadline = Date.now() + Number(env.BAO_HEAL_WAIT_MS || 180000);
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 300));
        let raw = "";
        try { raw = readFileSync(responsePath, "utf8"); } catch { continue; }
        if (!raw.trim()) continue;
        try {
          const parsed = JSON.parse(raw) as { identity?: Identity; note?: string };
          if (!parsed.identity) return null;
          return {
            patch: { identity: parsed.identity },
            model: { provider: "cursor", name: "cursor", version: "live" },
            prompt,
            rawResponse: raw,
          };
        } catch {
          continue;
        }
      }
      return null;
    },
  };
}

export function patchFromText(raw: string): HealProposal["patch"] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { identity?: Identity };
    if (!parsed.identity) return {};
    return { identity: parsed.identity };
  } catch {
    return {};
  }
}

function retargetCheck(step: WorkflowStep, current: Target | undefined, target: Target): Check | undefined {
  const check = stepCheck(step);
  if (!check || !("locators" in check) || !current?.locators) return undefined;
  if (JSON.stringify(check.locators) !== JSON.stringify(current.locators)) return undefined;
  return { ...check, locators: target.locators };
}

export function applyPatch(step: WorkflowStep, patch: HealProposal["patch"]): WorkflowStep {
  if (!patch.identity) return step;
  const identity: Identity = { ...patch.identity, path: patch.identity.path ?? [] };
  const current = stepTarget(step);
  const target: Target = {
    locators: locatorsFromIdentity(identity) ?? [],
    hint: hintFromIdentity(identity),
    reveal: current?.reveal,
    history: current?.history,
  };
  const check = retargetCheck(step, current, target);
  switch (step.action) {
    case "click":
    case "type":
    case "check":
    case "select":
    case "upload":
    case "drop":
    case "key":
    case "digits":
    case "pickDate":
    case "download":
    case "handoff":
      return { ...step, target, ...(check ? { check } : {}) };
    case "extract":
    case "finish":
    case "for_each":
    case "navigate":
    case "note":
    case "open":
    case "verify":
    case "wait":
      return step;
  }
}

export function keepPatch(
  workflow: WorkflowV2,
  stepId: string,
  patch: HealProposal["patch"],
  meta: { at?: number; runId?: string; score?: number } = {},
): WorkflowV2 {
  const at = meta.at ?? Date.now();
  return {
    ...workflow,
    updatedAt: at,
    steps: workflow.steps.map((step) => {
      if (step.id !== stepId) return step;
      const patched = applyPatch(step, patch);
      if (changedAttrs(step, patched).length === 0) return step;
      return withHealVersion(step, patched, { at, recordedAt: workflow.createdAt, runId: meta.runId, score: meta.score });
    }),
  };
}

/** Put the failed step back and append a revert row. Older versions stay. */
export function revertPatch(
  workflow: WorkflowV2,
  failedStep: WorkflowStep,
  meta: { at?: number; runId?: string } = {},
): WorkflowV2 {
  const at = meta.at ?? Date.now();
  return {
    ...workflow,
    updatedAt: at,
    steps: workflow.steps.map((step) => step.id === failedStep.id
      ? withRevertVersion(step, failedStep, { at, recordedAt: workflow.createdAt, runId: meta.runId })
      : step),
  };
}
