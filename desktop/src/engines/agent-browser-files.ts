// File paths for agent-browser upload and download. Bao picks where a download lands.

import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { operandIndexes } from "../v1/file-operands";

export type FileCommand = "upload" | "download";

export const isFileCommand = (command: unknown): command is FileCommand => command === "upload" || command === "download";

/** A file a step saved or attached: its path, and its size and SHA-256 when Bao could read it after the step. */
export type FileFact = { path: string } & ({ bytes: number; sha256: string } | { unread: string });

/** How an upload or download moved its files, kept on the run's step as evidence. */
export type FileTransfer =
  | { command: "download"; source: "download"; url?: string; files: FileFact[] }
  | { command: "download"; source: "pdf-viewer"; url: string; files: FileFact[] }
  | { command: "download"; source: "link"; url: string; files: FileFact[] }
  | { command: "upload"; source: "file-input" | "file-chooser"; files: FileFact[] };

/** Size and SHA-256 of each file. A file Bao cannot read is kept with the reason. */
export async function fileFacts(files: readonly string[]): Promise<FileFact[]> {
  return Promise.all(files.map(async (file): Promise<FileFact> => {
    try {
      const { size } = await stat(file);
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
      return { path: file, bytes: size, sha256: hash.digest("hex") };
    } catch (error) {
      return { path: file, unread: error instanceof Error ? error.message : String(error) };
    }
  }));
}

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
