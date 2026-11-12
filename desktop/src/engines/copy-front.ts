import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { guiChromeBrowserPid, processesNaming, type ProcessRow } from "../launch";

/** The packaged app keeps this beside bao-mcp. A checkout proof can set BAO_FRONT_TOOL. */
export function frontTool(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string | undefined {
  const fromEnv = env.BAO_FRONT_TOOL?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const beside = path.resolve(cwd, "../../MacOS/bao-front");
  return existsSync(beside) ? beside : undefined;
}

/** The copy's browser pid. A helper process, or any Chrome whose user-data-dir is not this copy, is not it. */
export function copyBrowserPid(exe: string, userDataDir: string, rows: readonly ProcessRow[]): number | undefined {
  if (!path.isAbsolute(userDataDir)) return undefined;
  return guiChromeBrowserPid(exe, path.resolve(userDataDir), rows.map((row) => ({
    ...row,
    command: row.command.replace(/--user-data-dir(?:=|\s+)(\S+)/, (_match, dir: string) => `--user-data-dir=${path.resolve(dir)}`),
  })));
}

/** Activate that one pid. Returns false when the tool is missing, the pid is not the copy's browser, or activation fails. */
export async function bringCopyFront(exe: string, userDataDir: string, rows?: readonly ProcessRow[]): Promise<boolean> {
  const tool = frontTool();
  if (!tool) {
    console.error("bao copy handoff did not bring the window to the front: bao-front is missing");
    return false;
  }
  let listed: readonly ProcessRow[];
  try { listed = rows ?? processesNaming(userDataDir); }
  catch (error) {
    console.error(`bao copy handoff did not bring the window to the front: ${error instanceof Error ? error.message : error}`);
    return false;
  }
  const pid = copyBrowserPid(exe, userDataDir, listed);
  if (!pid) {
    console.error("bao copy handoff did not bring the window to the front: the copy's browser pid was not found");
    return false;
  }
  return new Promise((resolve) => {
    execFile(tool, [String(pid)], { timeout: 3000 }, (error, _stdout, stderr) => {
      if (!error) { resolve(true); return; }
      const detail = stderr?.trim() || error.message;
      console.error(`bao copy handoff did not bring the window to the front: ${detail}`);
      resolve(false);
    });
  });
}
