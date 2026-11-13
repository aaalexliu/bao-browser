import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { scaledMs } from "../runtime";

// macOS asks the app responsible for a process before it reads Google Chrome's folder.
// These tests build a Bao.app from the real launchers and check which process macOS would ask.

const MACOS = path.join(process.cwd(), "desktop/packaging/macos");

function skip(): string | false {
  if (process.platform !== "darwin") return "responsibility is a macOS feature";
  const cc = spawnSync("cc", ["--version"], { encoding: "utf8" });
  return cc.error || cc.status !== 0 ? "needs cc on PATH" : false;
}

interface Seen {
  pid: number;
  ppid: number;
  argv: string[];
  /** The process macOS holds responsible for the stand-in server, read from the kernel. */
  responsible: { pid: number; exe: string };
  env: { exe?: string; cert?: string };
}

const C_FLAGS = ["-Wall", "-Wextra", "-Werror"];

/** A Bao.app whose bao, bao-mcp and bao-cli are the real launchers, with a stand-in cli.js. */
function bundle(root: string, cert: boolean): { bao: string; mcp: string; cli: string } {
  const macos = path.join(root, "Bao.app/Contents/MacOS");
  const server = path.join(root, "Bao.app/Contents/Resources/bao/src/app/cli.js");
  mkdirSync(macos, { recursive: true });
  mkdirSync(path.dirname(server), { recursive: true });
  // The bundled Node, as a release build carries it.
  const node = path.join(root, "Bao.app/Contents/Resources/node/bin/node");
  mkdirSync(path.dirname(node), { recursive: true });
  symlinkSync(process.execPath, node);
  const stub = path.join(root, "window-stub.c");
  writeFileSync(stub, [
    "#include <stdio.h>",
    "void bao_show_alert(const char *title, const char *body) { fprintf(stderr, \"%s: %s\\n\", title, body); }",
    "void bao_focus_pid(int pid) { (void)pid; }",
    "int bao_notify_prepare(const char *path) { (void)path; return -1; }",
    "int bao_window_run(const char *url, int pid) { (void)url; (void)pid; return 1; }",
    "int bao_permissions_show(const void *opts) { (void)opts; return 1; }",
  ].join("\n"));
  const compile = (args: string[]) => execFileSync("cc", [...C_FLAGS, ...args], { stdio: "inherit", timeout: scaledMs(60_000) });
  const bao = path.join(macos, "bao");
  compile([...cert ? ["-DBAO_CERT_SIGNED"] : [], path.join(MACOS, "bao-main.c"), path.join(MACOS, "bao-launch.c"), path.join(MACOS, "bao-run-node.c"), stub, "-o", bao]);
  compile([path.join(MACOS, "bao-mcp.c"), path.join(MACOS, "bao-launch.c"), "-o", path.join(macos, "bao-mcp")]);
  compile(["-DBAO_CLI", path.join(MACOS, "bao-mcp.c"), path.join(MACOS, "bao-launch.c"), "-o", path.join(macos, "bao-cli")]);
  const probe = path.join(root, "probe");
  writeFileSync(`${probe}.c`, [
    "#include <libproc.h>",
    "#include <stdio.h>",
    "#include <stdlib.h>",
    "extern pid_t responsibility_get_pid_responsible_for_pid(pid_t);",
    "int main(int argc, char *argv[]) {",
    "  pid_t r = responsibility_get_pid_responsible_for_pid(atoi(argv[argc - 1]));",
    "  char exe[PROC_PIDPATHINFO_MAXSIZE] = \"\";",
    "  proc_pidpath(r, exe, sizeof exe);",
    "  printf(\"{\\\"pid\\\":%d,\\\"exe\\\":\\\"%s\\\"}\", r, exe);",
    "  return 0;",
    "}",
  ].join("\n"));
  compile([`${probe}.c`, "-o", probe]);
  // One JSON line about how the server was started, then stdin echoed back. SIGTERM prints "term".
  writeFileSync(server, `
    const { execFileSync } = require("node:child_process");
    const responsible = JSON.parse(execFileSync(${JSON.stringify(probe)}, [String(process.pid)], { encoding: "utf8" }));
    const seen = { pid: process.pid, ppid: process.ppid, argv: process.argv.slice(1), responsible,
      env: { exe: process.env.BAO_RESPONSIBLE_EXE, cert: process.env.BAO_CERT_SIGNED } };
    process.stdout.write(JSON.stringify(seen) + "\\n");
    const exit = process.argv.indexOf("--exit");
    if (exit > 0) process.exit(Number(process.argv[exit + 1]));
    process.on("SIGTERM", () => { process.stdout.write("term\\n"); process.exit(0); });
    process.stdin.pipe(process.stdout);
  `);
  return { bao, mcp: path.join(macos, "bao-mcp"), cli: path.join(macos, "bao-cli") };
}

/** host: starts its command so that it answers to macOS for itself, as an app that the Dock opened does. */
function host(root: string): string {
  const file = path.join(root, "host");
  writeFileSync(`${file}.c`, [
    "#include <spawn.h>",
    "#include <sys/wait.h>",
    "extern char **environ;",
    "extern int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);",
    "int main(int argc, char *argv[]) {",
    "  (void)argc;",
    "  posix_spawnattr_t attr;",
    "  posix_spawnattr_init(&attr);",
    "  responsibility_spawnattrs_setdisclaim(&attr, 1);",
    "  pid_t pid;",
    "  if (posix_spawn(&pid, argv[1], NULL, &attr, argv + 1, environ) != 0) return 127;",
    "  int status = 0;",
    "  waitpid(pid, &status, 0);",
    "  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;",
    "}",
  ].join("\n"));
  execFileSync("cc", [...C_FLAGS, `${file}.c`, "-o", file], { stdio: "inherit", timeout: scaledMs(60_000) });
  return file;
}

/** agent.js: the agent app. It prints its pid and the launcher's, starts the launcher, and passes on SIGTERM. */
function agent(root: string): string {
  const file = path.join(root, "agent.js");
  writeFileSync(file, `
    const { spawn } = require("node:child_process");
    const child = spawn(process.argv[2], process.argv.slice(3), { stdio: "inherit" });
    process.stdout.write(JSON.stringify({ agent: process.pid, launcher: child.pid }) + "\\n");
    child.on("exit", (code) => process.exit(code ?? 1));
  `);
  return file;
}

function env(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env, HOME: root, PATH: "/usr/bin:/bin", BAO_NODE: process.execPath };
  for (const key of Object.keys(out)) if (key.startsWith("BAO_") && key !== "BAO_NODE") delete out[key];
  delete out.NODE_OPTIONS;
  delete out.NODE_PATH;
  return { ...out, ...extra };
}

/** Runs the launcher under an agent app and returns what the agent and the stand-in server saw. */
function underAgent(root: string, launcher: string, args: string[] = [], input = "ping\n") {
  const ran = spawnSync(host(root), [process.execPath, agent(root), launcher, ...args], { env: env(root), input, encoding: "utf8", timeout: scaledMs(20_000) });
  const [first, second, ...rest] = ran.stdout.split("\n");
  return { status: ran.status, stderr: ran.stderr, agent: JSON.parse(first!) as { agent: number; launcher: number }, seen: JSON.parse(second!) as Seen, rest };
}

test("in an ad-hoc build, macOS asks the agent's app for bao-mcp and asks Bao for bao-cli", { skip: skip() }, () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-responsible-adhoc-")));
  try {
    const app = bundle(root, false);
    const mcp = underAgent(root, app.mcp, ["--home", "/srv/bao lib"]);
    assert.equal(mcp.status, 0, mcp.stderr);
    assert.equal(mcp.seen.pid, mcp.agent.launcher, "bao-mcp becomes the server, so the agent's own pid stays its child");
    assert.deepEqual(mcp.seen.responsible, { pid: mcp.agent.agent, exe: realpathSync(process.execPath) });
    assert.deepEqual(mcp.seen.env, { exe: realpathSync(process.execPath) }, "no BAO_CERT_SIGNED");
    assert.deepEqual(mcp.seen.argv.slice(1), ["mcp", "--home", "/srv/bao lib"]);
    assert.equal(mcp.rest[0], "ping", "stdin and stdout still reach the agent");

    const cli = underAgent(root, app.cli, ["doctor"]);
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(cli.seen.responsible, { pid: cli.seen.ppid, exe: app.bao }, "a Bao copy that answers for itself stays the server's parent");
    assert.notEqual(cli.seen.ppid, cli.agent.launcher);
    assert.deepEqual(cli.seen.env, { exe: app.bao });
    assert.deepEqual(cli.seen.argv.slice(1), ["doctor"]);
    assert.equal(cli.rest[0], "ping");

    // Claude Desktop starts bao-mcp through a helper that makes it answer for itself. Bao, not Node, then answers.
    const direct = spawnSync(host(root), [app.mcp], { env: env(root), input: "", encoding: "utf8", timeout: scaledMs(20_000) });
    assert.equal(direct.status, 0, direct.stderr);
    const seen = JSON.parse(direct.stdout.split("\n")[0]!) as Seen;
    assert.deepEqual(seen.responsible, { pid: seen.ppid, exe: app.bao });
    assert.equal(seen.env.exe, app.bao);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("in a certificate build, bao-mcp answers as Bao and passes on exit codes and SIGTERM", { skip: skip() }, async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-responsible-cert-")));
  try {
    const app = bundle(root, true);
    const mcp = underAgent(root, app.mcp);
    assert.equal(mcp.status, 0, mcp.stderr);
    assert.deepEqual(mcp.seen.responsible, { pid: mcp.seen.ppid, exe: app.bao });
    assert.notEqual(mcp.seen.ppid, mcp.agent.launcher, "the launcher waits for a Bao copy, which waits for the server");
    assert.deepEqual(mcp.seen.env, { exe: app.bao, cert: "1" });
    assert.equal(mcp.rest[0], "ping");

    assert.equal(underAgent(root, app.mcp, ["--exit", "3"]).status, 3);

    const child = spawn(host(root), [process.execPath, agent(root), app.mcp], { env: env(root), stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    const exited = once(child, "exit");
    while (out.split("\n").length < 3) await new Promise((resolve) => setTimeout(resolve, 20));
    const started = JSON.parse(out.split("\n")[0]!) as { launcher: number };
    process.kill(started.launcher, "SIGTERM");
    const [code] = await exited as [number | null];
    assert.equal(code, 0);
    assert.equal(out.split("\n")[2], "term", "SIGTERM to the launcher reaches the server through both Bao processes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Code a caller would like to run under Bao's grant. Each piece touches its own file in root when it runs. */
function intruders(root: string): { node: string; preload: string; ran: () => string[] } {
  const node = path.join(root, "not-node");
  writeFileSync(node, `#!/bin/sh\nif [ "$1" = -v ]; then echo v24.0.0; exit 0; fi\ntouch ${JSON.stringify(path.join(root, "ran-not-node"))}\n`);
  chmodSync(node, 0o755);
  const preload = path.join(root, "preload.cjs");
  writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "ran-preload"))}, "");\n`);
  return { node, preload, ran: () => ["ran-not-node", "ran-preload", "ran-shell"].filter((name) => existsSync(path.join(root, name))) };
}

test("bao --run-node runs only the bundle's cli.js, with Bao's own Node and no caller's NODE_OPTIONS", { skip: skip() }, () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-responsible-refuse-")));
  try {
    const app = bundle(root, true);
    const bad = intruders(root);
    const shell = spawnSync(app.bao, ["--run-node", "--own", "/bin/sh", "-c", `touch ${JSON.stringify(path.join(root, "ran-shell"))}`],
      { env: env(root), encoding: "utf8", timeout: scaledMs(20_000) });
    assert.equal(shell.status, 2);
    assert.match(shell.stderr, /^bao: --run-node runs only .+\/Bao\.app\/Contents\/Resources\/bao\/src\/app\/cli\.js, not \/bin\/sh\n$/);

    const other = path.join(root, "other.js");
    writeFileSync(other, `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "ran-shell"))}, "");\n`);
    const script = spawnSync(app.bao, ["--run-node", other], { env: env(root), encoding: "utf8", timeout: scaledMs(20_000) });
    assert.equal(script.status, 2);
    assert.match(script.stderr, /runs only .+cli\.js, not .+other\.js/);

    // An agent that names its own Node and preload gets Bao's Node, without the preload.
    const mcp = spawnSync(app.mcp, [], { env: env(root, { BAO_NODE: bad.node, NODE_OPTIONS: `--require ${bad.preload}` }), input: "ping\n", encoding: "utf8", timeout: scaledMs(20_000) });
    assert.equal(mcp.status, 0, mcp.stderr);
    const [first, echoed] = mcp.stdout.split("\n");
    const seen = JSON.parse(first!) as Seen;
    assert.deepEqual(seen.responsible, { pid: seen.ppid, exe: app.bao });
    assert.equal(echoed, "ping");
    assert.deepEqual(bad.ran(), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bao --run-helper starts only the bundled helper and refuses a caller path", { skip: skip() }, () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-run-helper-")));
  try {
    const app = bundle(root, false);
    const helperExe = path.join(root, "Bao.app/Contents/Resources/BaoOSHelper.app/Contents/MacOS/BaoOSHelper");
    mkdirSync(path.dirname(helperExe), { recursive: true });
    const marker = path.join(root, "helper-ran");
    writeFileSync(helperExe, `#!/bin/sh\nprintf '%s\\n' "$BAO_HELPER_INHERIT" "$@" > ${JSON.stringify(marker)}\n`);
    chmodSync(helperExe, 0o755);
    const reader = path.join(root, "Reader.app/Contents/MacOS/Reader");
    mkdirSync(path.dirname(reader), { recursive: true });
    const foreign = path.join(root, "foreign-ran");
    writeFileSync(reader, `#!/bin/sh\nprintf 'ran\\n' > ${JSON.stringify(foreign)}\n`);
    chmodSync(reader, 0o755);
    const bundled = path.join(root, "Bao.app/Contents/Resources/BaoOSHelper.app");

    const refused = spawnSync(app.bao, ["--run-helper", reader, "--", "stolen"], { env: env(root), encoding: "utf8", timeout: scaledMs(20_000) });
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /starts only Bao's own BaoOSHelper\.app/);
    assert.equal(existsSync(foreign), false, "a caller-chosen helper ran");
    assert.equal(existsSync(marker), false, "the bundled helper ran for a refused path");

    const named = spawnSync(app.bao, ["--run-helper", bundled, "--", "named"], { env: env(root), encoding: "utf8", timeout: scaledMs(20_000) });
    assert.equal(named.status, 2);
    assert.equal(existsSync(marker), false, "passing the bundled path still ran it");

    const ran = spawnSync(app.bao, ["--run-helper", "--", "hello"], { env: env(root), encoding: "utf8", timeout: scaledMs(20_000) });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(readFileSync(marker, "utf8"), "1\nhello\n");
    assert.equal(existsSync(foreign), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
