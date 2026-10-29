// Observer. Claude Code calls this hook with the built-in computer tool on stdin.
// Bao appends the call to a trail. It does not perform the action.
// Copied from desktop/src/home.ts. This hook is plain JavaScript and cannot import that module.

import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const raw = readFileSync(0, "utf8");
let payload = {};
try { payload = JSON.parse(raw); } catch { payload = { raw }; }
const home = libraryHome();
mkdirSync(path.join(home, "observer"), { recursive: true });
appendFileSync(path.join(home, "observer", "trail.jsonl"), JSON.stringify({
  ts: Date.now(),
  kind: "observe",
  op: payload.tool_name || payload.tool || "computer",
  args: payload.tool_input || payload.input || payload,
}) + "\n");
process.exit(0);

function libraryHome() {
  const env = process.env;
  const platform = process.platform;
  const user = platform === "win32" ? (env.USERPROFILE || env.HOME || "/tmp") : (env.HOME || "/tmp");
  const rawHome = env.BAO_HOME;
  if (rawHome && rawHome.includes("\0")) process.exit(1);
  let picked = rawHome || (platform === "darwin"
    ? path.join(user, "Library", "Application Support", "bao")
    : path.join(user, ".local", "share", "bao"));
  if (picked === "~") picked = user;
  else if (picked.startsWith("~/")) picked = path.join(user, picked.slice(2));
  const resolved = path.resolve(picked);
  if (hasWorkflows(resolved)) return resolved;
  const legacies = [
    path.resolve(user, ".local", "share", "bao"),
    path.resolve(process.cwd(), ".bao-mcp"),
  ];
  for (const legacy of legacies) {
    if (legacy !== resolved && hasWorkflows(legacy)) return legacy;
  }
  return resolved;
}

function hasWorkflows(dir) {
  let names;
  try { names = readdirSync(path.join(dir, "workflows")); } catch { return false; }
  return names.some((name) => {
    if (!name.endsWith(".json")) return false;
    try { return statSync(path.join(dir, "workflows", name)).isFile(); } catch { return false; }
  });
}
