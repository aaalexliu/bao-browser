import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import path from "node:path";

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
  return [...files].sort();
}

function missing(root, files) {
  return files.filter((file) => !existsSync(path.join(root, file)));
}

function report(kind, files) {
  console.error(`${kind} extension is missing ${files.join(", ")}`);
  process.exit(1);
}

const [mode, sourceOrDir, stage] = process.argv.slice(2);

if (mode === "check") {
  const gone = missing(sourceOrDir, requiredFiles(sourceOrDir));
  if (gone.length) report("unpacked", gone);
  process.exit(0);
}

if (mode === "copy") {
  const files = requiredFiles(sourceOrDir);
  const gone = missing(sourceOrDir, files);
  if (gone.length) report("source", gone);
  rmSync(stage, { recursive: true, force: true });
  for (const file of files) {
    const dest = path.join(stage, file);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(sourceOrDir, file), dest);
  }
  const staged = missing(stage, requiredFiles(stage));
  if (staged.length) report("staged", staged);
  process.exit(0);
}

if (mode === "sync") {
  const files = requiredFiles(sourceOrDir);
  const gone = missing(sourceOrDir, files);
  if (gone.length) report("source", gone);
  rmSync(stage, { recursive: true, force: true });
  cpSync(sourceOrDir, stage, { recursive: true });
  const staged = missing(stage, requiredFiles(stage));
  if (staged.length) report("staged", staged);
  process.exit(0);
}

console.error("usage: stage-unpacked.mjs copy <source> <stage> | sync <source> <stage> | check <dir>");
process.exit(2);
