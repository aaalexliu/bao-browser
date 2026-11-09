import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.resolve(process.argv[2] || path.join(root, "desktop/packaging/macos/dist/bao.mcpb"));
const stage = mkdtempSync(path.join(tmpdir(), "bao-mcpb-"));
const cli = path.join(root, "node_modules/.bin/mcpb");
try {
  mkdirSync(path.dirname(output), { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(root, "desktop/packaging/mcpb/manifest.json"), "utf8"));
  manifest.version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  writeFileSync(path.join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  copyFileSync(path.join(root, "desktop/packaging/mcpb/server.cjs"), path.join(stage, "server.cjs"));
  for (const args of [["validate", path.join(stage, "manifest.json")], ["pack", stage, output], ["info", output]]) {
    const result = spawnSync(cli, args, { stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`mcpb ${args[0]} failed with status ${result.status}`);
  }
  console.log(`WROTE ${output}`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
