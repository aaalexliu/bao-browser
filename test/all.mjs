// Run the full fixture suite in order, forwarding CLI flags to every suite —
// npm appends extra args ("npm test -- --headed") only to the LAST command of a
// && chain, so a chain can't propagate --headed; this runner can. Any suite
// failing stops the run with its exit code, same as the old && chain.
//
// Run: npm test            (headless)
//      npm test -- --headed   (or -H: watch every suite drive a real window)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const suites = [
  "e2e", "list", "blindspots", "virtual", "frames", "forceopen", "editable",
  "spa", "nav", "check", "keyboard", "pointerdown", "assert", "download",
  "grounding", "golden", "snapshot", "workflows", "sidepanel", "dashboard",
];

const args = process.argv.slice(2);
for (const suite of suites) {
  console.log(`\n── test/${suite}.mjs ──`);
  const r = spawnSync(process.execPath, [resolve(__dirname, `${suite}.mjs`), ...args], { stdio: "inherit" });
  if (r.status) process.exit(r.status);
}
console.log(`\n✓ all ${suites.length} suites passed`);
