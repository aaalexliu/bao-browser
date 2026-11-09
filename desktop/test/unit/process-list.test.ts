import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { baoAgentProfileDir } from "../../src/engines/bao-profile";
import { closeRetainedChrome, pidsForDataDir, pinTestBrowser } from "../../src/launch";
import { LIST_TARGETS } from "../support/fake-agent-browser";

const cli = path.resolve(__dirname, "../../src/app/cli.js");
interface Result { isError?: boolean; content?: { text: string }[] }

/** The failing Mac's listing: 285 Chrome renderers, 1,074,450 bytes, over Node's 1 MiB default pipe buffer. */
function largeListing(): string {
  const row = (pid: number) => {
    const head = `${90000 + pid} 1 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer --enable-features=`;
    return `${head}${"x".repeat(3769 - head.length)}\n`;
  };
  return Array.from({ length: 285 }, (_, pid) => row(pid)).join("");
}

function which(name: string): string {
  return execFileSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
}

/** `ps` and `pgrep` on PATH: a full `ps` listing gets the large fake rows; `pgrep` fails while the flag file exists. */
async function shims(root: string): Promise<{ dir: string; failList: string }> {
  const dir = path.join(root, "bin");
  const listing = path.join(root, "listing.txt");
  const failList = path.join(root, "fail-list");
  await mkdir(dir);
  const padding = largeListing();
  assert.ok(Buffer.byteLength(padding) >= 1_074_410);
  await writeFile(listing, padding);
  await writeFile(path.join(dir, "ps"), `#!/bin/sh
case "$1" in -a*|-A|-e) ${which("ps")} "$@"; cat ${JSON.stringify(listing)}; exit 0;; esac
exec ${which("ps")} "$@"
`, { mode: 0o755 });
  await writeFile(path.join(dir, "pgrep"), `#!/bin/sh
if [ -e ${JSON.stringify(failList)} ]; then echo "pgrep: cannot read the process table" >&2; exit 3; fi
exec ${which("pgrep")} "$@"
`, { mode: 0o755 });
  return { dir, failList };
}

function client(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [cli, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";
  let sequence = 0;
  const pending = new Map<number, (result: Result) => void>();
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk; });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const reply = JSON.parse(buffer.slice(0, newline)) as { id: number; result: Result };
      buffer = buffer.slice(newline + 1);
      pending.get(reply.id)?.(reply.result);
      pending.delete(reply.id);
    }
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const request = (method: string, params = {}): Promise<Result> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return {
    stderr: () => stderr,
    request,
    browser: (command: string, args: string[] = []) => request("tools/call", { name: "agent_browser", arguments: { command, args } }),
    finish: () => request("tools/call", { name: "finish_task", arguments: { outcome: "passed", reason: "Fixture task done." } }),
    async close() { child.stdin.end(); await Promise.race([exited, delay(20_000)]); if (child.exitCode === null) child.kill("SIGKILL"); },
  };
}

async function gone(profile: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (pidsForDataDir(profile).length && Date.now() < deadline) await delay(50);
  assert.deepEqual(pidsForDataDir(profile), [], "Bao's Chrome exited");
}

test("a process list over 1 MiB never breaks open, close, or finish_task, and an unreadable list never breaks close or finish_task", { timeout: 180_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-process-list-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Synthetic", user_name: "owner@example.test" } } } }));
  const executable = path.join(root, "native");
  await writeFile(executable, `#!${process.execPath}
${LIST_TARGETS}
const args = process.argv.slice(2);
if (args.includes('--json')) {
  const endpoint = new URL(args[args.indexOf('--cdp') + 1]);
  listTargets(endpoint.href).then(tabs => {
    process.stdout.write(JSON.stringify({ data: { tabs: tabs.filter(t => t.type === 'page').map(t => ({ active: true, targetId: t.id })) } }));
  });
} else process.stdout.write('native success\\n');
`, { mode: 0o700 });
  const { dir, failList } = await shims(root);
  const profile = baoAgentProfileDir(home);
  const env: NodeJS.ProcessEnv = {
    PATH: `${dir}${path.delimiter}${process.env.PATH}`, TMPDIR: process.env.TMPDIR, HOME: root, BAO_HOME: home,
    BAO_HEAL_CURSOR_ACCOUNT: "0", BAO_TEST_BROWSER: pinTestBrowser(), PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
    BAO_AGENT_BROWSER: executable, BAO_AGENT_BROWSER_PROFILE_ROOT: sourceRoot,
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
    ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
  };
  assert.throws(() => execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { env, encoding: "utf8" }), /ENOBUFS/, "the shim reproduces the overflow");
  const mcp = client(env);
  t.after(async () => {
    await mcp.close();
    await closeRetainedChrome(profile).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await mcp.request("initialize");

  const opened = await mcp.browser("open", ["about:blank"]);
  assert.equal(opened.isError, false, mcp.stderr());
  assert.match(opened.content!.map((block) => block.text).join("\n"), /Browser: Bao profile, the default\./);
  const closed = await mcp.browser("close");
  assert.equal(closed.isError, false, mcp.stderr());
  await gone(profile);

  assert.equal((await mcp.browser("open", ["about:blank"])).isError, false, mcp.stderr());
  const finished = await mcp.finish();
  assert.equal(finished.isError, false, mcp.stderr());
  assert.match(finished.content![0]!.text, /^Passed/);
  await gone(profile);

  for (const end of ["close", "finish_task"] as const) {
    assert.equal((await mcp.browser("open", ["about:blank"])).isError, false, mcp.stderr());
    await writeFile(failList, "");
    const ended = end === "close" ? await mcp.browser("close") : await mcp.finish();
    assert.equal(ended.isError, false, `${end} with an unreadable process list: ${mcp.stderr()}`);
    await rm(failList);
    await gone(profile);
  }
  assert.match(mcp.stderr(), /bao process list unavailable/, "close and finish_task ran with the list unreadable");
  assert.doesNotMatch(mcp.stderr(), /ENOBUFS/);
});
