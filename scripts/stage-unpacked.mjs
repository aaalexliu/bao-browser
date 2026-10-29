import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = ".bao-stage";

function isFileRef(value) {
  if (value.includes("*") || value.includes(" ") || value.startsWith("<")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  if (/^[\d.]+$/.test(value)) return false;
  return /\.(html|js|mjs|cjs|css|png|svg|json)$/.test(value);
}

function walk(value, out) {
  if (typeof value === "string") {
    if (isFileRef(value)) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) walk(item, out);
  }
}

function htmlRefs(text) {
  const refs = [];
  for (const match of text.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)) {
    const ref = match[1].split("?")[0].split("#")[0];
    if (!ref || ref.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(ref)) continue;
    refs.push(ref);
  }
  return refs;
}

function childRel(fromFile, ref) {
  if (ref.includes("..")) return "";
  const base = path.posix.dirname(fromFile);
  const joined = path.posix.normalize(path.posix.join(base === "." ? "" : base, ref));
  if (!joined || joined.startsWith("..") || joined.startsWith("/")) return "";
  return joined;
}

function requiredFiles(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
  const files = new Set(["manifest.json"]);
  walk(manifest, files);
  const pending = [...files].filter((file) => file.endsWith(".html"));
  const seenHtml = new Set();
  while (pending.length) {
    const rel = pending.pop();
    if (!rel || seenHtml.has(rel)) continue;
    seenHtml.add(rel);
    const full = path.join(root, rel);
    if (!existsSync(full)) continue;
    for (const ref of htmlRefs(readFileSync(full, "utf8"))) {
      const next = childRel(rel, ref);
      if (!next) continue;
      files.add(next);
      if (next.endsWith(".html")) pending.push(next);
    }
  }
  return files;
}

function addDist(root, files) {
  const dist = path.join(root, "dist");
  if (!existsSync(dist) || !statSync(dist).isDirectory()) return;
  const walkDir = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walkDir(abs);
      else files.add(path.relative(root, abs).split(path.sep).join("/"));
    }
  };
  walkDir(dist);
}

function filesToStage(root) {
  const files = requiredFiles(root);
  addDist(root, files);
  return [...files].sort();
}

function missing(root, files) {
  return files.filter((file) => !existsSync(path.join(root, file)));
}

function report(kind, files) {
  console.error(`${kind} extension is missing ${files.join(", ")}`);
  process.exit(1);
}

function refuse(stageReal, reason) {
  console.error(`refusing to replace ${stageReal} because it ${reason}`);
  process.exit(1);
}

function resolvePath(target) {
  const abs = path.resolve(target);
  try {
    return realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    try {
      return path.join(realpathSync(parent), path.basename(abs));
    } catch {
      return abs;
    }
  }
}

function sameOrInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function assertSafeStage(source, stage) {
  const sourceReal = resolvePath(source);
  const stageReal = resolvePath(stage);
  const homeReal = resolvePath(process.env.HOME || homedir());
  const repoReal = resolvePath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  if (stageReal === path.parse(stageReal).root) refuse(stageReal, "is the filesystem root");
  if (stageReal === homeReal) refuse(stageReal, "is the home directory");
  if (stageReal === repoReal) refuse(stageReal, "is the repo");
  if (sameOrInside(stageReal, sourceReal)) refuse(stageReal, "contains the source tree");
  if (existsSync(stageReal)) {
    const info = statSync(stageReal);
    if (!info.isDirectory()) refuse(stageReal, "is not a directory");
    const names = readdirSync(stageReal);
    const previous = names.includes(MARKER);
    if (names.length > 0 && !previous) {
      const force = process.env.BAO_STAGE_FORCE === "1" || process.argv.includes("--force");
      if (!force) refuse(stageReal, "is not a previous Bao stage. Set BAO_STAGE_FORCE=1 to replace it");
    }
  }
  console.error(`Replacing ${stageReal}`);
  return stageReal;
}

function finish(stageReal) {
  writeFileSync(path.join(stageReal, MARKER), "bao-stage\n");
}

const [mode, sourceOrDir, stage] = process.argv.slice(2);

if (mode === "check") {
  const gone = missing(sourceOrDir, filesToStage(sourceOrDir));
  if (gone.length) report("unpacked", gone);
  process.exit(0);
}

if (mode === "copy") {
  const files = filesToStage(sourceOrDir);
  const gone = missing(sourceOrDir, files);
  if (gone.length) report("source", gone);
  const stageReal = assertSafeStage(sourceOrDir, stage);
  rmSync(stageReal, { recursive: true, force: true });
  for (const file of files) {
    const dest = path.join(stageReal, file);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(sourceOrDir, file), dest);
  }
  const staged = missing(stageReal, filesToStage(stageReal));
  if (staged.length) report("staged", staged);
  finish(stageReal);
  process.exit(0);
}

if (mode === "sync") {
  const files = filesToStage(sourceOrDir);
  const gone = missing(sourceOrDir, files);
  if (gone.length) report("source", gone);
  const stageReal = assertSafeStage(sourceOrDir, stage);
  rmSync(stageReal, { recursive: true, force: true });
  cpSync(sourceOrDir, stageReal, { recursive: true });
  const staged = missing(stageReal, filesToStage(stageReal));
  if (staged.length) report("staged", staged);
  finish(stageReal);
  process.exit(0);
}

console.error("usage: stage-unpacked.mjs copy <source> <stage> [--force] | sync <source> <stage> [--force] | check <dir>");
process.exit(2);
