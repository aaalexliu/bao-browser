// File paths for agent-browser upload and download. Bao picks where a download lands and keeps only file names in the run.

import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { GLOBAL_BOOL_FLAGS, GLOBAL_VALUE_FLAGS } from "../v1/tab-command";

export type FileCommand = "upload" | "download";

export const isFileCommand = (command: unknown): command is FileCommand => command === "upload" || command === "download";

/** A file command's argv for the native CLI and for the run. */
export interface FileArgs {
  /** Sent to agent-browser: each file as an absolute path. */
  forwarded: string[];
  /** Kept in the run: each file as its name only. */
  recorded: string[];
  /** Path spellings that stored output must not keep. */
  hide: string[];
  /** Where a download writes its file. */
  saved?: string;
}

/** Indexes of the words that are not global flags or their values, as pinned agent-browser 0.41.0 reads them. */
function operandIndexes(args: readonly string[]): number[] {
  const at: number[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--restore=") || arg === "--restore") continue;
    if (GLOBAL_VALUE_FLAGS.has(arg)) { i += 1; continue; }
    if (GLOBAL_BOOL_FLAGS.has(arg)) {
      const next = args[i + 1];
      if (next === "true" || next === "false") i += 1;
      continue;
    }
    at.push(i);
  }
  return at;
}

/** The selector and the file words of an upload or download. */
export function fileOperands(args: readonly string[]): { selector?: string; files: string[] } {
  const [selector, ...files] = operandIndexes(args).map((i) => args[i]!);
  return { ...(selector !== undefined ? { selector } : {}), files };
}

/** `name.pdf`, then `name (2).pdf`, `name (3).pdf`, and so on, until one is free in `dir`. */
function freeName(dir: string, name: string): string {
  const { name: stem, ext } = path.parse(name);
  let candidate = name;
  for (let n = 2; existsSync(path.join(dir, candidate)); n++) candidate = `${stem} (${n})${ext}`;
  return candidate;
}

/** The path with its symlinks resolved, as Chrome and agent-browser print it. A missing file resolves through its folder. */
async function resolved(file: string): Promise<string> {
  try { return await realpath(file); } catch {}
  try { return path.join(await realpath(path.dirname(file)), path.basename(file)); } catch {}
  return file;
}

const bareName = (word: string) => word !== "" && word !== "." && word !== ".." && !word.includes("/");

/**
 * Rewrites the file words of an upload or download. A download takes a plain file name and lands in `downloads`. An upload takes
 * an absolute path, a `~/` path, or the name of a file already in `downloads`. Any other word is refused before the command runs.
 */
export async function fileArgs(command: FileCommand, args: readonly string[], downloads: string): Promise<FileArgs> {
  const operands = operandIndexes(args);
  const [, ...fileAt] = operands;
  const forwarded = [...args];
  const recorded = [...args];
  const hide = new Set<string>([downloads, await resolved(downloads)]);
  if (command === "download") {
    if (operands.length !== 2) throw new Error("download takes a selector and one file name, such as download @e5 statement.pdf.");
    const i = fileAt[0]!;
    const name = args[i]!;
    if (!bareName(name)) throw new Error(`download takes a plain file name, such as statement.pdf, not a path: ${name}. Bao saves the file in this run's downloads folder.`);
    await mkdir(downloads, { recursive: true });
    const saved = path.join(downloads, freeName(downloads, name));
    forwarded[i] = saved;
    recorded[i] = path.basename(saved);
    for (const spelling of [saved, await resolved(saved)]) hide.add(spelling);
    return { forwarded, recorded, hide: [...hide], saved };
  }
  if (!fileAt.length) throw new Error("upload takes a selector and at least one file, such as upload input[type=file] statement.pdf.");
  for (const i of fileAt) {
    const word = args[i]!;
    const file = path.isAbsolute(word) ? word
      : word.startsWith("~/") ? path.join(homedir(), word.slice(2))
        : bareName(word) ? path.join(downloads, word) : undefined;
    if (!file) throw new Error(`upload takes an absolute path, a ~/ path, or the name of a file this run downloaded, not ${word}.`);
    if (bareName(word) && !existsSync(file)) throw new Error(`This run downloaded no file named ${word}. Give an absolute path, a ~/ path, or the name of a file this run downloaded.`);
    forwarded[i] = file;
    recorded[i] = path.basename(file);
    for (const spelling of [word, file, await resolved(file)]) hide.add(spelling);
  }
  return { forwarded, recorded, hide: [...hide] };
}

/** Replaces each hidden path in `text` with its file name. Longer paths go first, so a file path wins over its folder. */
export function hidePaths(text: string, hide: readonly string[]): string {
  const paths = [...hide].filter((spelling) => spelling.includes("/")).sort((left, right) => right.length - left.length);
  return paths.reduce((out, spelling) => out.split(spelling).join(path.basename(spelling)), text);
}
