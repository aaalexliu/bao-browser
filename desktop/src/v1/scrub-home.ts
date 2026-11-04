import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scrubSaved } from "./saved-secrets";
import type { WorkflowV2 } from "./schema";

export interface ScrubReport {
  mode: "dry-run" | "write";
  files: string[];
  skipped: { file: string; reason: string }[];
  backup?: string;
}

/** Only saved text artifacts, never browser profiles, config, screenshots or videos. */
export function scrubHome(home: string, write = false): ScrubReport {
  const root = path.resolve(home);
  if (!lstatSync(root).isDirectory()) throw new Error("Bao home must be a directory, not a symlink");
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && /\.jsonl?$/.test(entry.name)) files.push(file);
    }
  };
  for (const name of ["workflows", "trails", "runs", "inputs", "promotions", "conflicts", "evals", "reports", "resumes", "versions", "heals", "observer", "relay-results"]) {
    const dir = path.join(root, name);
    try { if (!lstatSync(dir).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    walk(dir);
  }
  for (const name of ["trail.jsonl", "live-session/trail.jsonl", "live-session/session.json", "pending-prompt.json", "last-view.json"]) {
    const file = path.join(root, name);
    const dir = path.dirname(file);
    try { if (lstatSync(dir).isDirectory() && lstatSync(file).isFile()) files.push(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const skipped: ScrubReport["skipped"] = [];
  const artifacts = files.sort().filter((file) => {
    if (!/(?:^|\.)receipts\.jsonl$/.test(path.basename(file))) return true;
    skipped.push({ file: path.relative(root, file), reason: "Append-only receipt chain; historical secrets may remain. Never rewritten." });
    return false;
  }).map((file) => {
    const before = readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = file.endsWith(".jsonl") ? before.split(/\r?\n/).filter((line) => line.trim()).map((line): unknown => JSON.parse(line)) : JSON.parse(before);
    } catch { throw new Error(`Cannot scrub invalid JSON: ${path.relative(root, file)}`); }
    return { file, before, parsed };
  });
  const workflows = new Map<string, WorkflowV2>();
  for (const { file, parsed } of artifacts) {
    if (path.dirname(file) !== path.join(root, "workflows")) continue;
    if (parsed && typeof parsed === "object" && "id" in parsed && typeof parsed.id === "string") workflows.set(parsed.id, parsed as WorkflowV2);
  }
  const associated = artifacts.map(({ file, before, parsed }) => {
    const node = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    const ask = node.ask && typeof node.ask === "object" ? node.ask as Record<string, unknown> : {};
    const inputs = path.dirname(file) === path.join(root, "inputs");
    const named = inputs || path.dirname(file) === path.join(root, "trails");
    const id = named ? path.basename(file, path.extname(file)) : node.workflowId ?? ask.workflowId;
    const args = inputs ? [node] : [node.inputs, node.publicInputs, node.args].filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item));
    return { file, before, parsed, id: typeof id === "string" ? id : undefined, args };
  });
  const argumentsByWorkflow = new Map<string, Record<string, unknown>[]>();
  for (const { id, args } of associated) {
    if (id) argumentsByWorkflow.set(id, [...(argumentsByWorkflow.get(id) ?? []), ...args]);
  }
  const changes = associated.flatMap(({ file, before, parsed, id }) => {
    const workflow = id ? workflows.get(id) : undefined;
    const clean = scrubSaved(parsed, { workflow, args: id ? argumentsByWorkflow.get(id) : undefined });
    if (JSON.stringify(parsed) === JSON.stringify(clean)) return [];
    const after = file.endsWith(".jsonl") ? (clean as unknown[]).map((row) => JSON.stringify(row)).join("\n") + "\n" : JSON.stringify(clean, null, 2) + "\n";
    return [{ file, before, after }];
  });
  const report: ScrubReport = { mode: write ? "write" : "dry-run", files: changes.map(({ file }) => path.relative(root, file)), skipped };
  if (!write || !changes.length) return report;
  const backupRoot = path.join(root, "secret-scrub-backups");
  try {
    mkdirSync(backupRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!lstatSync(backupRoot).isDirectory()) throw new Error("Secret backup directory must not be a symlink");
  }
  const backup = path.join(backupRoot, `${Date.now()}-${randomUUID()}`);
  // Back up the entire change set before replacing even the first saved file.
  mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const change of changes) {
    const dest = path.join(backup, path.relative(root, change.file));
    mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    writeFileSync(dest, change.before, { flag: "wx", mode: 0o600 });
  }
  report.backup = backup;
  for (const change of changes) {
    if (!lstatSync(change.file).isFile() || readFileSync(change.file, "utf8") !== change.before) {
      throw new Error(`Saved file changed during scrub: ${path.relative(root, change.file)}. Backup: ${backup}`);
    }
    const temp = `${change.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, change.after, { flag: "wx", mode: 0o600 });
      renameSync(temp, change.file);
    } finally { rmSync(temp, { force: true }); }
  }
  return report;
}
