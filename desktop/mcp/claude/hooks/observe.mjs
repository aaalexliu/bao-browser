// Observer. Claude Code calls this hook with the built-in computer tool on stdin.
// Bao appends the call to a trail. It does not perform the action.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

const raw = readFileSync(0, "utf8");
let payload = {};
try { payload = JSON.parse(raw); } catch { payload = { raw }; }
const home = process.env.BAO_HOME || path.join(process.env.HOME || ".", ".local", "share", "bao");
mkdirSync(path.join(home, "observer"), { recursive: true });
appendFileSync(path.join(home, "observer", "trail.jsonl"), JSON.stringify({
  ts: Date.now(),
  kind: "observe",
  op: payload.tool_name || payload.tool || "computer",
  args: payload.tool_input || payload.input || payload,
}) + "\n");
process.exit(0);
