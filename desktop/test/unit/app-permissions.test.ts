import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { startApp } from "../../src/app/server";
import { MacOsHelper } from "../../src/proxy/os-macos";
import automation = require("../../src/cdp-live/automation");

test("app status reads only Accessibility and Automation, never Screen Recording", { skip: process.platform !== "darwin" }, async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "bao-permissions-"));
  const previous = process.env.BAO_OS_HELPER;
  process.env.BAO_OS_HELPER = __filename;
  const calls: string[][] = [];
  t.mock.method(MacOsHelper.prototype, "exec", async (args: string[]) => {
    calls.push(args);
    return { ok: true, accessibility: true };
  });
  t.mock.method(automation, "readAutomation", async () => ({ state: "granted", message: "allowed" }));
  const app = await startApp({ home, port: 0, extensionHost: false, chromeProfilesRoot: path.join(home, "profiles") });
  try {
    const state = await fetch(`http://127.0.0.1:${app.port}/api/state`).then((res) => res.json()) as {
      helper: { label: string; accessibility: boolean; screenCapture: boolean };
    };
    assert.equal(state.helper.label, "helper ok");
    assert.equal(state.helper.accessibility, true);
    assert.equal(state.helper.screenCapture, false);
    assert.deepEqual(calls, [["permissions-ax"]]);
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.BAO_OS_HELPER;
    else process.env.BAO_OS_HELPER = previous;
    await rm(home, { recursive: true, force: true });
  }
});
