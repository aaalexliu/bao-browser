// Heal is off unless a provider says it is available.
// The default policy is auto: apply the patch and keep going.
// approve pauses at the proposal. The saved workflow changes only if the user keeps the patch.

import { locatorsFromIdentity } from "./locators";
import type { HealMode, Identity, WorkflowStep, WorkflowV2 } from "./schema";

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
}

export interface HealProposal {
  patch: Partial<Pick<WorkflowStep, "identity" | "label" | "selection" | "timeoutMs" | "postcondition">>;
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
}

export interface HealProvider {
  available(): boolean;
  propose(failure: StepFailure, step: WorkflowStep): Promise<HealProposal | null>;
}

export interface HealSettings {
  /** Global default. Absent means auto. */
  heal?: HealMode;
}

export function effectiveMode(workflow: WorkflowV2, settings: HealSettings): HealMode {
  return workflow.heal ?? settings.heal ?? "auto";
}

export function maskText(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[secret]");
  }
  return out;
}

export function maskSnapshot(snapshot: FailureSnapshot, secrets: string[]): FailureSnapshot {
  return JSON.parse(maskText(JSON.stringify(snapshot), secrets)) as FailureSnapshot;
}

/** Text the model sees. The PNG stays on the audit record, not inside this string. */
export function promptSnapshot(snapshot: FailureSnapshot): FailureSnapshot {
  const { screenshot, ...rest } = snapshot;
  return {
    ...rest,
    screenshotRef: rest.screenshotRef || (screenshot ? `png:${screenshot.length}` : undefined),
  };
}

export function buildPrompt(failure: StepFailure, step: WorkflowStep, secrets: string[]): string {
  const body = [
    "A replay step missed its target or its postcondition.",
    `Intent: ${failure.intent}`,
    `Phase: ${failure.phase}`,
    `Reason: ${failure.reason}`,
    failure.brokenAttr ? `Attribute that broke: ${failure.brokenAttr}` : "",
    `Step: ${JSON.stringify(step)}`,
    `Snapshot: ${JSON.stringify(promptSnapshot(failure.snapshot))}`,
    "Reply with JSON { \"identity\": { ... } } using only identity fields. Do not include coordinates.",
  ].filter(Boolean).join("\n");
  return maskText(body, secrets);
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
      const prompt = buildPrompt(failure, step, []);
      if (openai) {
        const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${openai}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: env.BAO_OPENAI_MODEL || "gpt-4.1-mini",
            messages: [{ role: "user", content: prompt }],
          }),
        });
        const raw = await res.text();
        const name = env.BAO_OPENAI_MODEL || "gpt-4.1-mini";
        return {
          patch: patchFromText(raw),
          model: { provider: "openai", name, version: name },
          prompt,
          rawResponse: raw,
        };
      }
      const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropic || "",
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: env.BAO_ANTHROPIC_MODEL || "claude-sonnet-4-5",
          max_tokens: 800,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const raw = await res.text();
      const name = env.BAO_ANTHROPIC_MODEL || "claude-sonnet-4-5";
      return {
        patch: patchFromText(raw),
        model: { provider: "anthropic", name, version: name },
        prompt,
        rawResponse: raw,
      };
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
      const prompt = buildPrompt(failure, step, []);
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
 * Live Cursor heal. Writes the failure and waits for a response file.
 * This process does not invent the patch.
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
      const prompt = buildPrompt(failure, step, []);
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

function patchFromText(raw: string): HealProposal["patch"] {
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

export function applyPatch(step: WorkflowStep, patch: HealProposal["patch"]): WorkflowStep {
  const identity = patch.identity
    ? { ...patch.identity, path: patch.identity.path || [] }
    : step.identity;
  const next: WorkflowStep = { ...step, ...patch, identity };
  if (patch.identity) next.locators = locatorsFromIdentity(identity);
  return next;
}

export function keepPatch(workflow: WorkflowV2, stepId: string, patch: HealProposal["patch"]): WorkflowV2 {
  return {
    ...workflow,
    updatedAt: Date.now(),
    steps: workflow.steps.map((step) => step.id === stepId ? applyPatch(step, patch) : step),
  };
}

/** Put the failed step back. Used after a keep, and a no-op when nothing was kept. */
export function revertPatch(workflow: WorkflowV2, failedStep: WorkflowStep): WorkflowV2 {
  return {
    ...workflow,
    updatedAt: Date.now(),
    steps: workflow.steps.map((step) => step.id === failedStep.id ? failedStep : step),
  };
}
