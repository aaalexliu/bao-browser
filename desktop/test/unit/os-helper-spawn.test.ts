import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MacOsHelper, helperExecutable } from "../../src/proxy/os-macos";

async function fakeHelperApp(root: string, script: string): Promise<string> {
  const app = path.join(root, "FakeHelper.app");
  const exe = helperExecutable(app);
  await mkdir(path.dirname(exe), { recursive: true });
  await writeFile(exe, `#!/bin/sh\n${script}\n`);
  await chmod(exe, 0o755);
  return app;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!alive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  return false;
}

async function pids(file: string): Promise<number[]> {
  for (let i = 0; i < 100; i++) {
    const raw = await readFile(file, "utf8").catch(() => "");
    const found = raw.split(/\s+/).filter(Boolean).map(Number);
    if (found.length === 2) return found;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`no pids in ${file}`);
}

test("a helper bundle runs its executable directly with the exact arguments", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-helper-spawn-"));
  try {
    const app = await fakeHelperApp(root, `printf '{"ok":true,"value":"%s"}' "$*"`);
    const hit = await new MacOsHelper(app).exec(["nodes", "--bundle", "com.google.Chrome"]);
    assert.equal(hit.value, "nodes --bundle com.google.Chrome");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a stopped helper that times out is killed with its whole process group", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-helper-spawn-"));
  try {
    const record = path.join(root, "pids");
    // The child stays stopped like a launch LaunchServices never resumed; its own child keeps running.
    const app = await fakeHelperApp(root, `sleep 30 &\necho "$$ $!" > "${record}"\nkill -STOP $$`);
    const started = Date.now();
    const pending = new MacOsHelper(app).exec(["debug-allow", "--pid", "1", "--press"], 6_000);
    const [helper, grandchild] = await pids(record).catch(async (error: unknown) => {
      await pending.catch(() => {});
      throw error;
    });
    await assert.rejects(pending, /os helper timed out: debug-allow/);
    assert.ok(Date.now() - started < 10_000);
    assert.equal(await gone(helper!), true, "the stopped helper survived its timeout");
    assert.equal(await gone(grandchild!), true, "the helper's child survived its timeout");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a permissions report from a helper that did not disclaim fails closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-helper-spawn-"));
  try {
    const exe = "/Applications/Bao.app/Contents/Resources/BaoOSHelper.app/Contents/MacOS/BaoOSHelper";
    const caller = "/Applications/Bao.app/Contents/MacOS/bao";
    const undisclaimed = await fakeHelperApp(root, `printf '%s\n' '${JSON.stringify({ ok: true, accessibility: false, exe, parentExe: caller })}'`);
    await assert.rejects(new MacOsHelper(undisclaimed).exec(["permissions-ax"]), /BaoOSHelper is older than this Bao; rebuild it/);
    const omitted = await fakeHelperApp(path.join(root, "omitted"), `printf '%s\n' '${JSON.stringify({ ok: true, accessibility: false, exe })}'`);
    await assert.rejects(new MacOsHelper(omitted).permissions(false), /BaoOSHelper is older than this Bao; rebuild it/);
    const disclaimed = await fakeHelperApp(path.join(root, "disclaimed"), `printf '%s\n' '${JSON.stringify({ ok: true, accessibility: false, exe, parentExe: exe })}'`);
    const hit = await new MacOsHelper(disclaimed).exec(["permissions-ax"]);
    assert.equal(hit.accessibility, false);
    assert.equal(hit.parentExe, exe);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a helper that cannot start fails at once instead of waiting out the timeout", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bao-helper-spawn-"));
  try {
    const started = Date.now();
    await assert.rejects(new MacOsHelper(path.join(root, "Missing.app")).exec(["permissions-ax"], 30_000), /could not start Missing: .*ENOENT/);
    const app = await fakeHelperApp(root, `printf '{"ok":false,"error":"could not start the helper: errno 1"}'\nexit 1`);
    await assert.rejects(new MacOsHelper(app).exec(["permissions-ax"], 30_000), /could not start the helper: errno 1/);
    assert.ok(Date.now() - started < 5000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
