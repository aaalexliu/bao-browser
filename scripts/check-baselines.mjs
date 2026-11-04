import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const base = process.env.BASELINE_REF || "origin/main";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const pathFromRoot = (file) => new URL(`../${file}`, import.meta.url);

function counts(file, value) {
  const result = new Map();
  if (file === "eslint-suppressions.json") {
    for (const [path, rules] of Object.entries(value)) {
      for (const [rule, entry] of Object.entries(rules)) {
        if (!Number.isSafeInteger(entry.count) || entry.count < 1) {
          throw new Error(`Invalid suppression count: ${path}: ${rule}`);
        }
        result.set(JSON.stringify([path, rule]), entry.count);
      }
    }
  } else {
    for (const entry of value) {
      if (entry.type !== "dependency" || !entry.from || !entry.to || !entry.rule?.name) {
        throw new Error(`Invalid graph baseline entry: ${JSON.stringify(entry)}`);
      }
      const key = JSON.stringify([entry.from, entry.to, entry.rule.name]);
      result.set(key, (result.get(key) || 0) + 1);
    }
  }
  return result;
}

let failed = false;
git("rev-parse", "--verify", `${base}^{commit}`); // Missing base must fail closed.
for (const file of ["eslint-suppressions.json", ".dependency-cruiser-known-violations.json"]) {
  const current = counts(file, JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), "utf8")));
  if (file === "eslint-suppressions.json") {
    for (const key of current.keys()) {
      const [source] = JSON.parse(key);
      if (!existsSync(pathFromRoot(source))) {
        console.error(`${file}: unused suppression for missing file ${source}`);
        failed = true;
      }
    }
  }
  if (!git("ls-tree", "--name-only", base, "--", file)) {
    console.log(`${file}: initial baseline; review this first addition in full`);
    continue;
  }
  const previous = counts(file, JSON.parse(git("show", `${base}:${file}`)));
  for (const [key, count] of current) {
    if (count > (previous.get(key) || 0)) {
      console.error(`${file}: baseline growth ${key}: ${previous.get(key) || 0} -> ${count}`);
      failed = true;
    }
  }
}
if (failed) process.exitCode = 1;
