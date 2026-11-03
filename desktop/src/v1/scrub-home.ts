import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { scrubSaved } from "./saved-secrets";

export interface ScrubReport {
  mode: "dry-run" | "write";
  files: string[];
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
  for (const name of ["workflows", "trails", "runs", "inputs", "promotions", "conflicts", "evals", "reports", "resumes", "versions", "heals"]) {
    const dir = path.join(root, name);
    try { if (!lstatSync(dir).isDirectory()) continue; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    walk(dir);
  }
  for (const name of ["trail.jsonl", "live-session/trail.jsonl", "live-session/session.json"]) {
    const file = path.join(root, name);
    const dir = path.dirname(file);
    try { if (lstatSync(dir).isDirectory() && lstatSync(file).isFile()) files.push(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const changes = files.sort().flatMap((file) => {
    const before = readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = file.endsWith(".jsonl") ? before.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)) : JSON.parse(before);
    } catch { throw new Error(`Cannot scrub invalid JSON: ${path.relative(root, file)}`); }
    const clean = scrubSaved(parsed);
    if (JSON.stringify(parsed) === JSON.stringify(clean)) return [];
    const after = file.endsWith(".jsonl") ? (clean as unknown[]).map((row) => JSON.stringify(row)).join("\n") + "\n" : JSON.stringify(clean, null, 2) + "\n";
    return [{ file, before, after }];
  });
  const report: ScrubReport = { mode: write ? "write" : "dry-run", files: changes.map(({ file }) => path.relative(root, file)) };
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
