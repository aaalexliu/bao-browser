// Starts Bao.app/Contents/MacOS/bao-mcp the way an agent does and checks one MCP exchange.
// HOME is a temp directory that holds only the test library planted below, and PATH has no
// node, so the check reads no one's real library and needs no shell profile.
// Usage: node prove-mcp-launcher.mjs path/to/Bao.app
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const app = realpathSync(path.resolve(process.argv[2] || ""));
const launcher = path.join(app, "Contents", "MacOS", "bao-mcp");
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-mcp-launcher-")));
const user = path.join(scratch, "user");
const agentDir = path.join(scratch, "agent");

function plant(dir, id) {
  mkdirSync(path.join(dir, "workflows"), { recursive: true });
  const workflow = { schema: "bao.workflow/v2", version: 2, id, name: id, startUrl: "https://example.com/", inputs: [], steps: [], createdAt: 1 };
  writeFileSync(path.join(dir, "workflows", `${id}.json`), `${JSON.stringify(workflow)}\n`);
}

// The app's library under this HOME, and a .bao-mcp library in the agent's working directory.
// The launcher must read the first and never the second.
plant(path.join(user, "Library", "Application Support", "bao"), "launcher-home");
plant(path.join(agentDir, ".bao-mcp"), "launcher-cwd");

const env = { ...process.env, HOME: user, PATH: "/usr/bin:/bin", BAO_NODE: process.execPath };
for (const key of Object.keys(env)) {
  if (key.startsWith("BAO_") && key !== "BAO_NODE") delete env[key];
}
delete env.NODE_PATH;
delete env.NODE_OPTIONS;

const started = Date.now();
const child = spawn(launcher, [], { cwd: agentDir, env, stdio: ["pipe", "pipe", "pipe"] });
const replies = [];
let out = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  out += chunk.toString("utf8");
  let nl = out.indexOf("\n");
  while (nl >= 0) {
    const line = out.slice(0, nl).trim();
    out = out.slice(nl + 1);
    if (line) replies.push(JSON.parse(line));
    nl = out.indexOf("\n");
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

let nextId = 1;
async function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const hit = replies.find((reply) => reply.id === id);
    if (hit) return hit;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no reply to ${method}. stderr: ${stderr.trim() || "(empty)"}`);
}

async function tool(name, args = {}) {
  const reply = await request("tools/call", { name, arguments: args });
  return { text: reply.result?.content?.[0]?.text || "", isError: reply.result?.isError === true };
}

function check(ok, what) {
  if (!ok) throw new Error(what);
}

try {
  const init = await request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "prove-mcp-launcher", version: "0" } });
  const initMs = Date.now() - started;
  check(init.result?.serverInfo?.name === "bao", `initialize did not name the bao server: ${JSON.stringify(init)}`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const names = ((await request("tools/list")).result?.tools || []).map((item) => item.name);
  for (const name of ["search_workflows", "run_workflow", "live_session_start", "live_stop"]) {
    check(names.includes(name), `tools/list has no ${name}: ${names.join(", ")}`);
  }
  const search = await tool("search_workflows", { query: "launcher" });
  const ids = (JSON.parse(search.text).hits || []).map((hit) => hit.id);
  check(ids.includes("launcher-home"), `search did not read the app's library: ${search.text}`);
  check(!ids.includes("launcher-cwd"), `search read the agent's .bao-mcp library: ${search.text}`);
  const live = await tool("live_snapshot");
  const expected = `Bao is not running. Open the Bao app, or run: open `;
  check(live.isError && live.text.startsWith(expected) && live.text.includes(app), `live tool without the app: ${live.text}`);
  child.stdin.end();
  const end = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(undefined), 10_000).unref())]);
  check(end?.code === 0, `bao-mcp did not exit 0 within 10 s of stdin closing: ${JSON.stringify(end)}`);
  console.log(`MCP_LAUNCHER ok ${launcher} initialize ${initMs} ms, ${names.length} tools`);
} catch (err) {
  child.kill("SIGKILL");
  console.error(`MCP_LAUNCHER failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
