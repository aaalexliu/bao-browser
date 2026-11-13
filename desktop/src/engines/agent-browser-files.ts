// File paths for agent-browser upload and download. Bao picks where a download lands.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { GLOBAL_BOOL_FLAGS, GLOBAL_VALUE_FLAGS } from "../v1/tab-command";

export type FileCommand = "upload" | "download";

export const isFileCommand = (command: unknown): command is FileCommand => command === "upload" || command === "download";

/** A file command's argv for the native CLI and the run, with each file as an absolute path. */
export interface FileArgs {
  forwarded: string[];
  /** The global flags and selector without the files: the click that opens a file chooser. */
  click: string[];
  /** The upload's files. */
  files: string[];
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

const bareName = (word: string) => word !== "" && word !== "." && word !== ".." && !word.includes("/");

/**
 * Rewrites the file words of an upload or download. A download takes a plain file name and lands in `downloads`. An upload takes
 * an absolute path, a `~/` path, or the name of a file already in `downloads`. Any other word is refused before the command runs.
 */
export async function fileArgs(command: FileCommand, args: readonly string[], downloads: string): Promise<FileArgs> {
  const operands = operandIndexes(args);
  const [, ...fileAt] = operands;
  const forwarded = [...args];
  const click = args.filter((_, i) => !fileAt.includes(i));
  if (command === "download") {
    if (operands.length !== 2) throw new Error("download takes a selector and one file name, such as download @e5 statement.pdf.");
    const i = fileAt[0]!;
    const name = args[i]!;
    if (!bareName(name)) throw new Error(`download takes a plain file name, such as statement.pdf, not a path: ${name}. Bao saves the file in this run's downloads folder.`);
    await mkdir(downloads, { recursive: true });
    const saved = path.join(downloads, freeName(downloads, name));
    forwarded[i] = saved;
    return { forwarded, click, files: [], saved };
  }
  if (!fileAt.length) throw new Error("upload takes a selector and at least one file, such as upload @e3 statement.pdf.");
  const files = fileAt.map((i) => {
    const word = args[i]!;
    const file = path.isAbsolute(word) ? word
      : word.startsWith("~/") ? path.join(homedir(), word.slice(2))
        : bareName(word) ? path.join(downloads, word) : undefined;
    if (!file) throw new Error(`upload takes an absolute path, a ~/ path, or the name of a file this run downloaded, not ${word}.`);
    if (bareName(word) && !existsSync(file)) throw new Error(`This run downloaded no file named ${word}. Give an absolute path, a ~/ path, or the name of a file this run downloaded.`);
    forwarded[i] = file;
    return file;
  });
  return { forwarded, click, files };
}
