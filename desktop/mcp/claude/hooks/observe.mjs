// Observer. Claude Code calls this hook with the built-in computer tool on stdin.
// Bao appends the call to a trail. It does not perform the action.
// The directory comes from desktop/src/library-home.cjs, the same resolver as the app.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raw = readFileSync(0, "utf8");
let payload = {};
try { payload = JSON.parse(raw); } catch { payload = { raw }; }

const here = path.dirname(fileURLToPath(import.meta.url));
const shared = path.join(here, "../../../src/library-home.cjs");
let resolveLibraryHome;
try {
  ({ resolveLibraryHome } = createRequire(import.meta.url)(shared));
} catch {
  process.stderr.write("bao: library home resolver is missing\n");
  process.exit(1);
}

let home;
try {
  home = resolveLibraryHome({ warn() {} });
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : "bao: home"}\n`);
  process.exit(1);
}

mkdirSync(path.join(home, "observer"), { recursive: true });
appendFileSync(path.join(home, "observer", "trail.jsonl"), JSON.stringify({
  ts: Date.now(),
  kind: "observe",
  op: payload.tool_name || payload.tool || "computer",
  args: payload.tool_input || payload.input || payload,
}) + "\n");
process.exit(0);
