import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const mac = path.resolve("desktop/packaging/macos");

test("reopen recovers a crashed window's server without killing other listeners", { skip: process.platform !== "darwin" }, async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "bao-recovery-")));
  const children = [];
  let unrelated;
  let orphan;
  try {
    const contents = path.join(root, "Bao.app/Contents");
    const resources = path.join(contents, "Resources");
    const appRoot = path.join(resources, "bao");
    const home = path.join(root, "library");
    const launcher = path.join(contents, "MacOS/bao");
    const browser = path.join(resources, "Chromium.app/Contents/MacOS/Chromium");
    mkdirSync(path.dirname(launcher), { recursive: true });
    mkdirSync(path.dirname(browser), { recursive: true });
    mkdirSync(path.join(appRoot, "src/app"), { recursive: true });
    mkdirSync(home);
    writeFileSync(browser, "#!/bin/sh\n");
    chmodSync(browser, 0o755);
    writeFileSync(path.join(appRoot, "src/print-home.cjs"), "console.log('ok\\n' + process.env.BAO_HOME);\n");
    writeFileSync(path.join(appRoot, "src/app/cli.js"), `
      const net = require('node:net');
      net.createServer().listen(Number(process.argv[6]), '127.0.0.1', () => console.log('server ' + process.pid));
    `);
    const stub = path.join(root, "window.c");
    writeFileSync(stub, `
      #include <signal.h>
      #include <stdio.h>
      #include <stdlib.h>
      #include <sys/wait.h>
      #include <unistd.h>
      void bao_show_alert(const char *title, const char *body) { fprintf(stderr, "%s: %s\\n", title, body); }
      void bao_focus_pid(int pid) { printf("focus %d\\n", pid); }
      int bao_notify_prepare(const char *path) { (void)path; return -1; }
      int bao_permissions_show(const void *opts) { (void)opts; return 1; }
      int bao_window_run(const char *url, int pid) {
        (void)url;
        puts("window"); fflush(stdout);
        if (getenv("BAO_TEST_PAUSE")) for (;;) pause();
        kill(pid, SIGTERM);
        waitpid(pid, NULL, 0);
        return 0;
      }
    `);
    execFileSync("cc", ["-Wall", "-Wextra", "-Werror", path.join(mac, "bao-main.c"), path.join(mac, "bao-launch.c"), path.join(mac, "bao-run-node.c"), stub, "-o", launcher], { stdio: "inherit" });
    unrelated = net.createServer();
    unrelated.listen(0, "127.0.0.1");
    await once(unrelated, "listening");
    const port = String(unrelated.address().port);
    const env = { ...process.env, HOME: root, CFFIXED_USER_HOME: root, BAO_HOME: home, BAO_PORT: port, BAO_NODE: process.execPath, BAO_HEAL_CURSOR_ACCOUNT: "0" };
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GROQ_API_KEY", "XAI_API_KEY", "CURSOR_API_KEY"]) delete env[name];
    const run = (extra = {}) => {
      const child = spawn(launcher, [], { env: { ...env, ...extra } });
      children.push(child);
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { err += chunk; });
      const done = once(child, "exit");
      return { child, done, out: () => out, err: () => err };
    };
    const blocked = run();
    assert.equal((await blocked.done)[0], 1);
    assert.match(blocked.err(), /local port is in use/);
    assert.doesNotMatch(blocked.err(), /already open/);
    const probe = net.connect(Number(port), "127.0.0.1");
    await once(probe, "connect");
    probe.destroy();
    await new Promise((resolve) => unrelated.close(resolve));
    unrelated = undefined;

    const first = run({ BAO_TEST_PAUSE: "1" });
    const deadline = Date.now() + 10000;
    while ((!first.out().includes("window\n") || !/server \d+/.test(first.out())) && Date.now() < deadline && first.child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(first.out(), /window\n/, first.err());
    orphan = Number(first.out().match(/server (\d+)/)?.[1]);
    assert.ok(orphan > 0);
    const duplicate = run();
    assert.equal((await duplicate.done)[0], 0);
    assert.match(duplicate.out(), new RegExp(`focus ${first.child.pid}\\n`));
    first.child.kill("SIGKILL");
    await first.done;
    process.kill(orphan, 0);
    const reopened = run();
    assert.equal((await reopened.done)[0], 0, reopened.err());
    assert.match(reopened.out(), /window\n/);
    assert.notEqual(Number(reopened.out().match(/server (\d+)/)?.[1]), orphan);
    assert.throws(() => process.kill(orphan, 0), { code: "ESRCH" });
    orphan = undefined;
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (orphan) { try { process.kill(orphan, "SIGKILL"); } catch {} }
    unrelated?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
