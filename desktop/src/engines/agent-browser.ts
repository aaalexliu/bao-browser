import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";

export type PageEngineName = "old" | "agent-browser";

export function pageEngineName(value?: string): PageEngineName {
  if (!value || value === "old") return "old";
  if (value === "agent-browser") return value;
  throw new Error("page engine must be old or agent-browser");
}

export function agentBrowserExecutable(override?: string): string {
  const executable = override || process.env.BAO_AGENT_BROWSER
    || path.resolve(__dirname, "../../../agent-browser/agent-browser");
  if (!path.isAbsolute(executable) || !existsSync(executable)) throw new Error("pinned native agent-browser is missing; stage it before selecting this engine");
  try { accessSync(executable, constants.X_OK); }
  catch { throw new Error("pinned native agent-browser is not executable; stage it before selecting this engine"); }
  return executable;
}
