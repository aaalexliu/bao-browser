import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { frameRpc } from "../../src/mcp/frame";
import { openCopiedChrome } from "../../src/engines/chrome-profile-copy";
import { readDevToolsActivePort } from "../../src/cdp-live/endpoint";
import { ACCOUNT_CHROME_MAC, pinTestBrowser } from "../../src/launch";
import { Library } from "../../src/v1/store";
import type { RecordedAgentBrowserCommand } from "../../src/engines/agent-browser-record";

const binary = process.env.AGENT_BROWSER_PROXY_BINARY;
const installed = process.env.AGENT_BROWSER_PROXY_INSTALLED_CHROME === "1";
const run = promisify(execFile);
interface Result { content: { type: string; text: string }[]; isError: boolean }

function mcp(env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [path.resolve(__dirname, "../../src/app/cli.js"), "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let sequence = 0;
  const pending = new Map<number, (result: Result) => void>();
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline)) as { id: number; result: Result };
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message.result);
      pending.delete(message.id);
    }
  });
  const request = (method: string, params = {}): Promise<Result> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP timed out: ${stderr}`)); }, 60_000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    child.stdin.write(frameRpc({ jsonrpc: "2.0", id, method, params }, "json"));
  });
  const exited = new Promise<void>((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`MCP exited ${code}: ${stderr}`))));
  return {
    request,
    call: (command: string, args: string[] = []) => request("tools/call", { name: "agent_browser", arguments: { command, args } }),
    async close() { child.stdin.end(); await exited; },
    async stop() { child.kill("SIGTERM"); await exited; },
  };
}

async function source(root: string) {
  const sourceRoot = path.join(root, "source");
  await mkdir(path.join(sourceRoot, "Default"), { recursive: true });
  await writeFile(path.join(sourceRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { name: "Proxy fixture" } } } }));
  await writeFile(path.join(sourceRoot, "Default", "Preferences"), "{}");
  return sourceRoot;
}

function copies(home: string): string {
  const namespace = createHash("sha256").update(path.resolve(home)).digest("hex").slice(0, 20);
  return path.join(tmpdir(), `bao-profile-copies-${namespace}`);
}

async function currentCopy(home: string) {
  const root = copies(home);
  const entries = await readdir(root);
  assert.equal(entries.length, 1);
  return path.join(root, entries[0]!);
}

function envFor(root: string, sourceRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, HOME: root, BAO_HOME: path.join(root, "library"), BAO_HEAL_CURSOR_ACCOUNT: "0",
    BAO_AGENT_BROWSER: binary, BAO_AGENT_BROWSER_PROFILE_ROOT: sourceRoot,
    ...(!installed ? { BAO_TEST_BROWSER: pinTestBrowser() } : {}),
    ...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
  };
}

test("Bao MCP and raw native agent-browser return the same output for the same local commands", { skip: !binary || installed, timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-parity-"));
  const sourceRoot = await source(root);
  const env = envFor(root, sourceRoot);
  const home = env.BAO_HOME!;
  const rawHome = path.join(root, "raw-home");
  const rawChrome = await openCopiedChrome({ sourceRoot, directory: "Default", home: rawHome });
  const rawEndpoint = await readDevToolsActivePort(rawChrome.target.portFile);
  const nativeState = path.join(root, "native-state");
  await mkdir(nativeState);
  const config = path.join(nativeState, "config.json");
  await writeFile(config, "{}");
  const rawEnv = { HOME: nativeState, PATH: "/usr/bin:/bin", TMPDIR: nativeState, LANG: "en_US.UTF-8", AGENT_BROWSER_SOCKET_DIR: nativeState, AGENT_BROWSER_AUTOSAVE_INTERVAL_MS: "0", DISPLAY: process.env.DISPLAY };
  const flags = ["--session", "bao", "--config", config, "--cdp", `ws://127.0.0.1:${rawEndpoint.port}${rawEndpoint.browserPath}`, "--idle-timeout", "0"];
  const native = (command: string, args: string[]) => run(binary!, [...flags, command, ...args], { cwd: nativeState, env: rawEnv, maxBuffer: 16 * 1024 * 1024 });
  const server = createServer((req, res) => res.end(req.url?.includes("?static") ? '<!doctype html><title>Static fixture</title><h1>Stable screenshot</h1>' : `<!doctype html><title>Proxy fixture</title>
<label>Name <input id="name"></label><label>Password <input id="password" type="password"></label>
<button id="save" onclick="document.querySelector('#result').textContent='Saved '+document.querySelector('#name').value">Save</button>
<p id="result">Not saved</p><p id="identity"></p><div style="height:3000px">Scroll fixture</div>
<script>if(location.search.includes('signed-in'))sessionStorage.setItem('login','synthetic-token');document.querySelector('#identity').textContent=sessionStorage.getItem('login')?'Signed in':'Signed out';</script>`));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const client = mcp(env);
  const transcript: unknown[] = [];
  let proxyCopy = "";
  try {
    await client.request("initialize");
    const commands: [string, string[], RegExp?][] = [
      ["open", [url]], ["snapshot", ["-i"]], ["fill", ["#name", "Ada 'quoted' \"name\""]],
      ["fill", ["#password", "synthetic-password"]], ["press", ["Tab"]], ["click", ["#save"]],
      ["snapshot", [], /Saved Ada/], ["scroll", ["down", "100"]], ["screenshot", [path.join(root, "page.png")]],
      ["open", [url + "?static"]],
      ["screenshot", ["--if-changed", path.join(root, "page.png")]],
      ["screenshot", ["--if-changed", path.join(root, "page.png")]],
      ["open", [url]],
      ["tab", ["new", url + "?signed-in"]], ["open", [url + "?signed-in"]], ["tab", ["list"]],
      ["tab", ["t1"]], ["snapshot", ["-s", "#identity"], /Signed out/],
      ["tab", ["t2"]], ["snapshot", ["-s", "#identity"], /Signed in/], ["close", []],
    ];
    for (const [command, args, expectedText] of commands) {
      const actual = await client.call(command, args);
      assert.equal(actual.isError, false, JSON.stringify(actual));
      if (command === "screenshot") {
        const image = await readFile(args.at(-1)!);
        assert.equal(image.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
        if (process.env.AGENT_BROWSER_PROXY_ARTIFACTS) {
          await mkdir(process.env.AGENT_BROWSER_PROXY_ARTIFACTS, { recursive: true });
          await writeFile(path.join(process.env.AGENT_BROWSER_PROXY_ARTIFACTS, "proxy-page.png"), image);
        }
      }
      const expected = await native(command, args);
      const output = [expected.stdout, expected.stderr].filter(Boolean);
      const content = actual.content.map((item) => item.text);
      assert.deepEqual(command === "open" ? content.slice(0, -1) : content, output, command);
      if (command === "open") {
        assert.ok(content.at(-1)!.includes(url), "open returns the site's tabs");
        if (args[0]!.includes("signed-in")) assert.equal(content.at(-1)!.match(/\[t\d+\]/g)?.length, 2, "open lists both same-host tabs");
        proxyCopy = await currentCopy(home);
      }
      if (expectedText) assert.match(content[0]!, expectedText);
      transcript.push({ command, args, bao: content, raw: output });
    }
    await assert.rejects(access(proxyCopy), /ENOENT/);
    const library = new Library(home);
    assert.equal(library.list().length, 0, "the pass-through does not save a workflow");
    const saved = library.listRuns();
    assert.equal(saved.length, 1);
    assert.equal(saved[0]!.status, "passed");
    const steps = saved[0]!.steps as RecordedAgentBrowserCommand[];
    assert.deepEqual(steps.map((step) => [step.native.command, step.native.args]), commands.map(([command, args]) => [command, args]));
    for (const [index, step] of steps.entries()) {
      const reply = (transcript[index] as { bao: string[] }).bao;
      assert.deepEqual(step.native.results.flatMap((result) => [result.stdout, result.stderr].filter(Boolean)), reply);
      assert.equal(step.native.isError, false);
      assert.ok(step.endedAt! >= step.startedAt);
      if (step.native.command === "close") assert.match(step.afterShotError!, /Session closed/);
      else assert.equal((await readFile(path.join(home, "shots", "runs", saved[0]!.id, step.afterShot!))).subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    }
    await client.call("open", [url]);
    proxyCopy = await currentCopy(home);
    await client.close();
    await assert.rejects(access(proxyCopy), /ENOENT/, "disconnect removes the owned copy");
    assert.equal(library.listRuns().length, 2);
    assert.ok(library.listRuns().every((run) => run.status === "passed"), "disconnect finalizes its own run");
    if (process.env.AGENT_BROWSER_PROXY_ARTIFACTS) {
      await mkdir(process.env.AGENT_BROWSER_PROXY_ARTIFACTS, { recursive: true });
      await writeFile(path.join(process.env.AGENT_BROWSER_PROXY_ARTIFACTS, "parity.json"), JSON.stringify(transcript, null, 2));
    }
  } finally {
    await client.close();
    await native("close", []).catch(() => undefined);
    await rawChrome.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rmdir(copies(home)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(copies(rawHome));
    await rm(root, { recursive: true, force: true });
  }
});

test("relative, implicit and JPEG native screenshots survive MCP close, disconnect and agent termination", { skip: !binary || installed, timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-record-"));
  const env = envFor(root, await source(root));
  const home = env.BAO_HOME!;
  const server = createServer((_req, res) => res.end('<!doctype html><title>Recorded fixture</title><h1>Durable screenshot</h1>'));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const library = new Library(home);
  try {
    for (const ending of ["close", "disconnect", "signal"]) {
      const client = mcp(env);
      try {
        await client.request("initialize");
        assert.equal((await client.call("open", [url])).isError, false);
        const replies: Result[] = [];
        for (const args of [["relative.png"], ["--json"], ["--json", "--screenshot-format", "jpeg", "relative.jpg"]]) {
          const reply = await client.call("screenshot", args);
          assert.equal(reply.isError, false, JSON.stringify(reply));
          replies.push(reply);
        }
        const partial = library.listRuns().find((run) => run.status === "recording")!;
        assert.ok(partial, "commands persist before finalization");
        const steps = partial.steps as RecordedAgentBrowserCommand[];
        assert.equal(steps.length, 4);
        for (const [index, step] of steps.slice(1).entries()) {
          assert.deepEqual(step.native.results.flatMap((result) => [result.stdout, result.stderr].filter(Boolean)), replies[index]!.content.map((item) => item.text));
          assert.equal(step.native.screenshots.length, 1);
          const artifact = step.native.screenshots[0]!;
          const implicit = JSON.parse(steps[2]!.native.results[0]!.stdout) as { data: { path: string } };
          const stateDir = implicit.data.path;
          const original = path.isAbsolute(artifact.path) ? artifact.path : path.resolve(stateDir.split(`${path.sep}.agent-browser${path.sep}`)[0]!, artifact.path);
          assert.deepEqual(await readFile(path.join(home, "shots", "runs", partial.id, artifact.file)), await readFile(original));
        }
        const copy = await currentCopy(home);
        if (ending === "close") await client.call("close");
        else if (ending === "signal") await client.stop();
        else await client.close();
        await assert.rejects(access(copy), /ENOENT/);
        const finalized = library.readRun(partial.id);
        assert.equal(finalized.status, "passed");
        for (const step of finalized.steps as RecordedAgentBrowserCommand[]) {
          for (const artifact of step.native.screenshots) await access(path.join(home, "shots", "runs", partial.id, artifact.file));
        }
        if (process.env.AGENT_BROWSER_PROXY_ARTIFACTS) {
          const dest = path.join(process.env.AGENT_BROWSER_PROXY_ARTIFACTS, ending);
          await mkdir(dest, { recursive: true });
          await writeFile(path.join(dest, "run.json"), JSON.stringify(finalized, null, 2));
        }
      } finally { await client.close(); }
    }
    assert.equal(library.listRuns().length, 3);
    assert.equal(library.list().length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rmdir(copies(home)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await rm(root, { recursive: true, force: true });
  }
});

test("a throwaway marked profile opens headed in installed Google Chrome through MCP", { skip: !binary || !installed || process.platform !== "darwin", timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-proxy-installed-"));
  const sourceRoot = await source(root);
  const env = envFor(root, sourceRoot);
  const client = mcp(env);
  const artifacts = process.env.AGENT_BROWSER_PROXY_ARTIFACTS || root;
  await mkdir(artifacts, { recursive: true });
  try {
    await client.request("initialize");
    const opened = await client.call("open", ["chrome://version/"]);
    assert.equal(opened.isError, false, JSON.stringify(opened));
    assert.ok(opened.content.at(-1)!.text.includes("chrome://version"));
    const copy = await currentCopy(env.BAO_HOME!);
    const snapshot = await client.call("snapshot");
    const text = snapshot.content[0]!.text;
    assert.ok(text.includes(ACCOUNT_CHROME_MAC), text);
    assert.ok(text.includes(copy), text);
    assert.ok(!text.includes("--headless"), text);
    assert.ok(text.includes("--disable-sync"), text);
    assert.ok(!text.includes("--use-mock-keychain"), text);
    assert.ok(!text.includes("--password-store"), text);
    const preferences = JSON.parse(await readFile(path.join(copy, "Default", "Preferences"), "utf8")) as { profile: { name: string; avatar_index: number } };
    assert.equal(preferences.profile.name, "Bao copy of Proxy fixture");
    assert.equal(preferences.profile.avatar_index, 31);
    await client.call("screenshot", [path.join(artifacts, "installed-chrome-version.png")]);
    await client.call("open", ["chrome://settings/manageProfile"]);
    await client.call("screenshot", [path.join(artifacts, "installed-chrome-profile.png")]);
    await writeFile(path.join(artifacts, "installed-launch.json"), JSON.stringify({ opened, snapshot, name: preferences.profile.name, avatar: preferences.profile.avatar_index, copy, restoresSavedTabs: text.includes("--restore-last-session") }, null, 2));
    assert.equal((await client.call("close")).isError, false);
    await assert.rejects(access(copy), /ENOENT/);
    assert.equal(await readFile(path.join(sourceRoot, "Default", "Preferences"), "utf8"), "{}");
  } finally {
    await client.close();
    await rmdir(copies(env.BAO_HOME!)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    await rm(root, { recursive: true, force: true });
  }
});
