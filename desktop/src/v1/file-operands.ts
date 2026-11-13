// The words of an agent-browser upload or download. No Node imports: the app's browser bundle reads these through captions.

import { GLOBAL_BOOL_FLAGS, GLOBAL_VALUE_FLAGS } from "./tab-command";

/** Indexes of the words that are not global flags or their values, as pinned agent-browser 0.41.0 reads them. */
export function operandIndexes(args: readonly string[]): number[] {
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

/** The last segment of a path, for a sentence that names a file. */
export function fileName(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}
