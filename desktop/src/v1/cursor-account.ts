// Heal through the Cursor account when `agent` is already logged in.
// The prompt goes on stdin. This file never reads or passes an API key.
// File handoff stays the fallback when print mode cannot run.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildPrompt,
  cursorHeal,
  llmHealFromEnv,
  patchFromText,
  type HealProposal,
  type HealProvider,
  type StepFailure,
} from "./heal";
import type { WorkflowStep } from "./schema";
import { resolveHome } from "../home";

export interface AgentStatus {
  authenticated: boolean;
  /** `login` is a stored `agent login`. `env` means the CLI used a key it already had. bao never sets that. */
  source: "login" | "env" | "none";
}

interface PrintResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Arguments after the binary. Tests check that the prompt and --api-key are absent. */
  args: string[];
}

export interface CursorAgentRun {
  status(bin: string, env: NodeJS.ProcessEnv): Promise<RunResult>;
  print(bin: string, prompt: string, env: NodeJS.ProcessEnv, workspace: string, model: string | undefined, timeoutMs: number): Promise<RunResult>;
}

const CACHE_MS = 15_000;

let cached: { at: number; bin: string; status: AgentStatus } | null = null;

export function resetCursorAccountCache(): void {
  cached = null;
}

export function findAgentBin(env: NodeJS.ProcessEnv): string {
  const explicit = env.BAO_CURSOR_AGENT;
  if (explicit) return explicit;
  const names = ["agent", "cursor-agent"];
  for (const dir of (env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = path.join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return "";
}

/** `agent status --format json` from CLI 2026.10.19. Logged out is exit 0. */
export function parseAgentStatus(stdout: string): AgentStatus {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{")) return { authenticated: false, source: "none" };
  try {
    const body = JSON.parse(trimmed) as { status?: string; isAuthenticated?: boolean };
    if (body.isAuthenticated === true && body.status === "authenticated") {
      return { authenticated: true, source: "login" };
    }
  } catch {
    return { authenticated: false, source: "none" };
  }
  return { authenticated: false, source: "none" };
}

export function parseAgentPrint(stdout: string): { text: string; model?: string; source?: string } | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line.startsWith("{"));
  let text = "";
  let model: string | undefined;
  let source: string | undefined;
  for (const line of lines) {
    let event: { type?: string; subtype?: string; result?: string; model?: string; apiKeySource?: string; is_error?: boolean };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "system" && event.subtype === "init") {
      if (typeof event.model === "string" && event.model) model = event.model;
      if (event.apiKeySource === "login" || event.apiKeySource === "env" || event.apiKeySource === "flag") {
        source = event.apiKeySource;
      }
    }
    if (event.type === "result" && event.subtype === "success" && event.is_error !== true && typeof event.result === "string") {
      text = event.result;
    }
  }
  if (!text) {
    const trimmed = stdout.trim();
    if (trimmed.startsWith("{")) {
      try {
        const one = JSON.parse(trimmed) as { type?: string; result?: string; is_error?: boolean };
        if (one.type === "result" && one.is_error !== true && typeof one.result === "string") text = one.result;
      } catch {
        return null;
      }
    }
  }
  if (!text) return null;
  return { text, model, source };
}

/** Drop key material before the CLI sees the environment. Login is a stored `agent login`. */
function cursorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(next)) {
    if (/API_KEY|API_TOKEN/i.test(key)) delete next[key];
  }
  return next;
}

function run(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number, input?: string, cwd?: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: cwd || process.cwd(),
      env: cursorEnv(env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", () => undefined);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, args });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function realCursorAgent(): CursorAgentRun {
  return {
    status(bin, env) {
      return run(bin, ["status", "--format", "json"], env, 8000);
    },
    print(bin, prompt, env, workspace, model, timeoutMs) {
      const args = [
        "--print",
        "--mode", "ask",
        "--trust",
        "--sandbox", "enabled",
        "--output-format", "stream-json",
        "--workspace", workspace,
      ];
      if (model) args.push("--model", model);
      return run(bin, args, env, timeoutMs, prompt, workspace);
    },
  };
}

export async function readCursorAccount(env: NodeJS.ProcessEnv = process.env, agent: CursorAgentRun = realCursorAgent()): Promise<AgentStatus> {
  if (env.BAO_HEAL_CURSOR_ACCOUNT === "0") return { authenticated: false, source: "none" };
  const bin = findAgentBin(env);
  if (!bin || !existsSync(bin)) return { authenticated: false, source: "none" };
  if (cached && cached.bin === bin && (cached.status.authenticated || Date.now() - cached.at < CACHE_MS)) return cached.status;
  try {
    const result = await agent.status(bin, env);
    const status = result.code === 0 ? parseAgentStatus(result.stdout) : { authenticated: false, source: "none" as const };
    cached = { at: Date.now(), bin, status };
    return status;
  } catch {
    cached = { at: Date.now(), bin, status: { authenticated: false, source: "none" } };
    return cached.status;
  }
}

export function cursorAccountModelLabel(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BAO_HEAL_CURSOR_ACCOUNT === "0") return "";
  const bin = findAgentBin(env);
  if (!bin || !cached || cached.bin !== bin || !cached.status.authenticated) return "";
  return "cursor account";
}

export interface CursorAsk {
  text: string;
  model: string;
  source: "login" | "env";
}

/** One prompt on stdin, billed to the logged-in Cursor account. No API key is read or passed. */
export async function askCursorAgent(
  prompt: string,
  env: NodeJS.ProcessEnv = process.env,
  agent: CursorAgentRun = realCursorAgent(),
  timeoutMs = Number(env.BAO_HEAL_WAIT_MS || 180000),
): Promise<CursorAsk | null> {
  const status = await readCursorAccount(env, agent);
  if (!status.authenticated) return null;
  const bin = findAgentBin(env);
  if (!bin || !existsSync(bin)) return null;
  const workspace = mkdtempSync(path.join(tmpdir(), "bao-cursor-ask-"));
  try {
    const result = await agent.print(bin, prompt, cursorEnv(env), workspace, env.BAO_CURSOR_MODEL, timeoutMs);
    if (result.code !== 0) return null;
    if (result.args.includes("--api-key")) return null;
    const printed = parseAgentPrint(result.stdout);
    if (!printed || printed.source === "flag") return null;
    return {
      text: printed.text,
      model: printed.model || "cursor-agent",
      source: printed.source === "env" ? "env" : "login",
    };
  } catch {
    return null;
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function cursorPrintHeal(env: NodeJS.ProcessEnv, secrets: string[], agent: CursorAgentRun): HealProvider {
  const bin = findAgentBin(env);
  return {
    available() {
      return cursorAccountModelLabel(env) === "cursor account" && !!bin;
    },
    async propose(failure, step) {
      if (!bin || cursorAccountModelLabel(env) !== "cursor account") return null;
      const prompt = [
        buildPrompt(failure, step, secrets),
        "Do not edit files. Do not call tools. Reply with the JSON object only.",
      ].join("\n");
      const asked = await askCursorAgent(prompt, env, agent);
      if (!asked) return null;
      const patch = patchFromText(asked.text);
      if (!patch.identity) return null;
      return {
        patch,
        model: { provider: "cursor", name: asked.model, version: asked.source },
        prompt,
        rawResponse: asked.text,
      } satisfies HealProposal;
    },
  };
}

function chainHeal(providers: HealProvider[]): HealProvider {
  return {
    available() {
      return providers.some((provider) => provider.available());
    },
    async propose(failure: StepFailure, step: WorkflowStep) {
      for (const provider of providers) {
        if (!provider.available()) continue;
        const proposal = await provider.propose(failure, step);
        if (proposal) return proposal;
      }
      return null;
    },
  };
}

/** CLI print first. `BAO_HEAL_CURSOR=1` waits for heal-response.json when print cannot run. Vendor keys are last. */
export async function cursorAccountHeal(
  env: NodeJS.ProcessEnv = process.env,
  secrets: string[] = [],
  agent: CursorAgentRun = realCursorAgent(),
): Promise<HealProvider> {
  await readCursorAccount(env, agent);
  const providers: HealProvider[] = [cursorPrintHeal(env, secrets, agent)];
  if (env.BAO_HEAL_CURSOR === "1") {
    const dir = env.BAO_HEAL_DIR || resolveHome({ env });
    providers.push(cursorHeal(dir, env, secrets));
  }
  providers.push(llmHealFromEnv(env, fetch, secrets));
  return chainHeal(providers);
}
