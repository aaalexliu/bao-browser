// macOS 27 and later let a process read Google Chrome's folder only when the app responsible for it
// has System Settings > Privacy & Security > Files & Folders > Google Chrome turned on. Without it,
// stat works and every open or listing fails with EPERM, and macOS shows no prompt.
// desktop/packaging/macos/bao-run-node.h picks that app and names it in BAO_RESPONSIBLE_EXE.

import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { chromeAccessSwitch, FILES_AND_FOLDERS_PANE } from "./chrome-switch";

export { chromeAccessSwitch, FILES_AND_FOLDERS_PANE } from "./chrome-switch";

const DENIED = new Set(["EPERM", "EACCES"]);

/** The app macOS asks when this process reads Google Chrome's folder, as Files & Folders lists it. */
export function askedApp(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const exe = env.BAO_RESPONSIBLE_EXE;
  if (!exe) return undefined;
  return /\/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/.exec(exe)?.[1] ?? path.basename(exe);
}

/** What to turn on so Bao can read Google Chrome's folder, for the app macOS asks. */
export function chromeAccessFix(env: NodeJS.ProcessEnv = process.env): string {
  const app = askedApp(env);
  if (!app) return "Turn on Google Chrome for the app that started Bao, such as your terminal or agent app, under System Settings > Privacy & Security > Files & Folders, then try again.";
  const asked = app === "Bao" ? "" : `macOS asks ${app}, the app that started Bao. `;
  // An ad-hoc grant names one build, so after an update the switch can look on and not apply.
  const again = app === "Bao" && env.BAO_CERT_SIGNED !== "1" ? " If it is already on, turn it off and on again: macOS ties the switch to one build of an ad-hoc signed Bao." : "";
  return `${asked}Turn on ${chromeAccessSwitch(app)}, then try again.${again}`;
}

/** Whose switch agents use, for setup, doctor and Settings. Empty outside Bao.app. */
export function agentsNote(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BAO_CERT_SIGNED === "1") return "Agents that start Bao use this switch too.";
  if (askedApp(env) !== "Bao") return "";
  return "Agents use the switch of the app that starts them, such as ChatGPT for Codex.";
}

/** The app macOS blocked. A certificate-signed Bao also names its own Files & Folders switch. */
export function chromeFolderDeniedMessage(reason: string, file: string, env: NodeJS.ProcessEnv = process.env): string {
  const app = askedApp(env) ?? "the app that started Bao";
  const blocked = `macOS blocked ${app} from reading Chrome's data (${reason} on ${file}).`;
  if (env.BAO_CERT_SIGNED !== "1") return blocked;
  return `${blocked} Turn on ${chromeAccessSwitch("Bao")}, then try again.`;
}

export type SettingsOpener = (url: string) => void;

function defaultSettingsOpener(url: string): void {
  // Tests set BAO_TEST_BROWSER. This opener must not open System Settings on the machine that runs them.
  if (process.env.BAO_TEST_BROWSER) return;
  spawnSync("/usr/bin/open", [url], { stdio: "ignore", timeout: 10_000 });
}

/** macOS blocked the responsible app from reading a file in Google Chrome's folder. */
export class ChromeFolderDenied extends Error {
  readonly certSigned: boolean;
  private opened = false;
  constructor(readonly reason: string, readonly file: string, env: NodeJS.ProcessEnv = process.env) {
    super(chromeFolderDeniedMessage(reason, file, env));
    this.name = "ChromeFolderDenied";
    this.certSigned = env.BAO_CERT_SIGNED === "1";
  }

  /** Opens Files & Folders once, and only for a certificate-signed Bao. An ad-hoc denial opens nothing. */
  present(open: SettingsOpener = defaultSettingsOpener): this {
    if (!this.certSigned || this.opened) return this;
    this.opened = true;
    try { open(FILES_AND_FOLDERS_PANE); }
    catch { /* The denial is still the answer. A failed open must not hide it. */ }
    return this;
  }
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The error as ChromeFolderDenied when it is EPERM or EACCES on a file under root, else undefined. */
export function chromeDenied(error: unknown, root: string, env: NodeJS.ProcessEnv = process.env): ChromeFolderDenied | undefined {
  if (error instanceof ChromeFolderDenied) return error;
  const { code, path: file } = (error ?? {}) as NodeJS.ErrnoException;
  if (!code || !DENIED.has(code)) return undefined;
  if (file && !inside(root, file)) return undefined;
  return new ChromeFolderDenied(code, file ?? root, env);
}

/** The folder's real path, or the resolved path when macOS refuses the read. Callers that share a hold must agree. */
export function chromeDataPath(root: string): string {
  const resolved = path.resolve(root);
  try { return realpathSync(resolved); }
  catch (error) {
    if (chromeDenied(error, resolved)) return resolved;
    throw error;
  }
}

/** Lists dir, the read macOS refuses, and throws ChromeFolderDenied when it is refused. */
export function assertChromeReadable(dir: string, root = dir): void {
  try { readdirSync(dir); }
  catch (error) { throw chromeDenied(error, root) ?? error; }
}

export type ChromeAccess =
  | { state: "allowed"; root: string }
  | { state: "missing"; root: string }
  | { state: "denied"; root: string; message: string }
  | { state: "unreadable"; root: string; message: string };

/** Whether this process can read Google Chrome's folder now. Reads only its list of names. */
export function chromeFolderAccess(root: string, env: NodeJS.ProcessEnv = process.env): ChromeAccess {
  try {
    readdirSync(root);
    return { state: "allowed", root };
  } catch (error) {
    const denied = chromeDenied(error, root, env);
    if (denied) return { state: "denied", root, message: denied.message };
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing", root };
    return { state: "unreadable", root, message: error instanceof Error ? error.message : String(error) };
  }
}
