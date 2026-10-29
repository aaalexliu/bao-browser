import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const destBao = process.argv[2];
if (!destBao) {
  process.stderr.write("usage: stage-deps.mjs DEST_BAO\n");
  process.exit(2);
}

const names = JSON.parse(readFileSync(path.join(here, "runtime-packages.json"), "utf8")).packages;
const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const dependencies = {};
for (const name of names) {
  const entry = lock.packages[`node_modules/${name}`];
  if (!entry?.version) {
    process.stderr.write(`stage-deps: ${name} is not in package-lock.json\n`);
    process.exit(1);
  }
  dependencies[name] = entry.version;
}

const stage = mkdtempSync(path.join(tmpdir(), "bao-runtime-"));
writeFileSync(path.join(stage, "package.json"), `${JSON.stringify({
  name: "bao-runtime",
  private: true,
  dependencies,
}, null, 2)}\n`);
const npm = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: stage,
  env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
  stdio: "inherit",
});
if (npm.status !== 0) process.exit(npm.status || 1);
cpSync(path.join(stage, "node_modules"), path.join(destBao, "node_modules"), { recursive: true });
rmSync(stage, { recursive: true, force: true });
