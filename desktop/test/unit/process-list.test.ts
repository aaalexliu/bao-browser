import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { baoDriver } from "../helpers/driver";
import { baoFixtureEnv, syntheticChromeProfile } from "../helpers/fixtures";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { baoAgentProfileDir } from "../../src/engines/bao-profile";
import { closeRetainedChrome, pidsForDataDir } from "../../src/launch";
import { LIST_TARGETS } from "../support/fake-agent-browser";
import { scaledMs } from "../runtime";

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
  const driver = baoDriver<Result>(env);
  // Like an agent, the client sends back the run id from its latest agent_browser result.
  let run: string | undefined;
  return {
    stderr: driver.stderr,
    initialize: driver.initialize,
    async browser(command: string, args: string[] = []) {
      const result = await driver.tool("agent_browser", { command, args, ...command === "open" ? { browser: "bao" } : {}, ...(run ? { run_id: run } : {}) });
      run = result.content?.map((block) => /^Run (\S+)$/.exec(block.text)?.[1]).find(Boolean) ?? run;
      return result;
    },
    finish: () => driver.tool("finish_task", { outcome: "passed", reason: "Fixture task done.", run_id: run }),
    close: driver.close,
  };
}

async function gone(profile: string): Promise<void> {
  const deadline = Date.now() + scaledMs(20_000);
  while (pidsForDataDir(profile).length && Date.now() < deadline) await delay(50);
  assert.deepEqual(pidsForDataDir(profile), [], "Bao's Chrome exited");
}

test("a process list over 1 MiB never breaks open, close, or finish_task, and an unreadable list never breaks close or finish_task", { timeout: scaledMs(180_000) }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-process-list-"));
  const home = path.join(root, "home");
  const sourceRoot = path.join(root, "source");
  await syntheticChromeProfile(sourceRoot, { name: "Synthetic", user_name: "owner@example.test" });
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
    ...baoFixtureEnv({ user: root, library: home, profiles: sourceRoot }),
    PATH: `${dir}${path.delimiter}${process.env.PATH}`,
    BAO_AGENT_BROWSER: executable,
  };
  assert.throws(() => execFileSync("ps", ["-axww", "-o", "pid=,ppid=,command="], { env, encoding: "utf8" }), /ENOBUFS/, "the shim reproduces the overflow");
  const mcp = client(env);
  t.after(async () => {
    await mcp.close();
    await closeRetainedChrome(profile).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  await mcp.initialize();

  const opened = await mcp.browser("open", ["about:blank"]);
  assert.equal(opened.isError, false, mcp.stderr());
  assert.match(opened.content!.map((block) => block.text).join("\n"), /Browser: Bao profile, named by the agent\./);
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
