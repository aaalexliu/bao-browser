import { readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentBrowserCommandResult, AgentBrowserProxy } from "../engines/agent-browser-proxy";
import type { RecordedAgentBrowserCommand } from "../engines/agent-browser-record";
import { shotFormat } from "../v1/shots";

export interface BrowserToolCard {
  command: string;
  status: "complete" | "failed" | "waiting";
  caption: string;
  runId: string | null;
  stepId: string | null;
  picture: { kind: "captured"; data: string; mimeType: string; phase: "before" | "after" | "previous"; target?: RecordedAgentBrowserCommand["target"] }
    | { kind: "unavailable"; reason: string };
}

export const BROWSER_RESULT_SCHEMA = {
  type: "object", required: ["command", "status", "results", "run_id", "step_id"],
  properties: {
    command: { type: "string" }, status: { type: "string", enum: ["complete", "failed", "waiting"] },
    results: { type: "array", items: { type: "object", required: ["stdout", "stderr", "exitCode"], properties: {
      stdout: { type: "string" }, stderr: { type: "string" }, exitCode: { type: "integer" },
    } } },
    run_id: { type: ["string", "null"] }, step_id: { type: ["string", "null"] }, error: { type: "string" },
  },
};

function ownerOutcome(results: AgentBrowserCommandResult[]): string | undefined {
  try {
    const value = JSON.parse(results[0]?.stdout || "") as { outcome?: string };
    return ["halted", "waiting", "ready", "closed"].includes(value.outcome || "") ? value.outcome : undefined;
  } catch { return undefined; }
}

function caption(command: string, failed: boolean, outcome?: string): string {
  if (outcome === "halted" || outcome === "waiting") return "Bao is waiting for you in its Chrome window. Complete the sign-in or check there.";
  if (outcome === "ready") return "The page is ready to inspect. Read it again before continuing.";
  if (outcome === "closed") return "The Bao browser window closed. This session cannot continue.";
  if (failed) return command === "open" ? "Could not open the page. Check the address and try again."
    : "Could not complete this command. Read the page again before retrying, or start with open if no session is running.";
  switch (command) {
    case "open": return "Opened the page in Bao Chrome.";
    case "snapshot": return "Read the current page. No click or page change.";
    case "click": return "Clicked the requested element.";
    case "fill": return "Entered text in the requested field.";
    case "press": return "Sent the requested key to the page.";
    case "scroll": return "Scrolled the page.";
    case "tab": return "Read or selected the requested browser tab.";
    case "screenshot": return "Captured the current page.";
    case "close": return "Closed the Bao browser session.";
    default: return "Browser command completed.";
  }
}

export async function browserToolResult(home: string, command: string, results: AgentBrowserCommandResult[],
  evidence: AgentBrowserProxy["lastCommand"], previous?: BrowserToolCard, error?: string) {
  const failed = error !== undefined || results.some((result) => result.exitCode !== 0);
  const outcome = ownerOutcome(results);
  const status = outcome === "halted" || outcome === "waiting" ? "waiting" : failed ? "failed" : "complete";
  const runId = evidence?.runId ?? ((outcome || command === "close") ? previous?.runId : null) ?? null;
  const step = evidence?.step;
  let picture: BrowserToolCard["picture"] = { kind: "unavailable", reason: outcome ? "No new picture was taken during the owner handoff." : step?.afterShotError || "No page picture is available for this call." };
  if (!outcome && command !== "close" && evidence && step) {
    const before = !failed && step.beforeShot && step.target;
    const file = before ? step.beforeShot : step.afterShot;
    if (file) {
      try {
        const bytes = await readFile(path.join(home, "shots", "runs", evidence.runId, file));
        const format = shotFormat(bytes);
        if (format) picture = { kind: "captured", data: bytes.toString("base64"), mimeType: format === "png" ? "image/png" : "image/jpeg", phase: before ? "before" : "after", ...(before ? { target: step.target } : {}) };
      } catch { /* The command result does not depend on its picture. */ }
    }
  }
  if (picture.kind === "unavailable" && previous?.picture.kind === "captured" && runId === previous.runId) {
    picture = { kind: "captured", data: previous.picture.data, mimeType: previous.picture.mimeType, phase: "previous" };
  }
  const card: BrowserToolCard = { command, status, caption: caption(command, failed, outcome), runId, stepId: step?.id ?? null, picture };
  return {
    content: [{ type: "text", text: card.caption }],
    structuredContent: { command, status, results, run_id: runId, step_id: card.stepId, ...(error === undefined ? {} : { error }) },
    _meta: { baoToolCard: card },
    isError: failed,
  };
}
