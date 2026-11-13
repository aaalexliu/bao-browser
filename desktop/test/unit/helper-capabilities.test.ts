import assert from "node:assert/strict";
import test from "node:test";
import { rail } from "../../src/app/views";
import { chromeHelper } from "../../src/cdp-live/ax";
import { capabilityReport, remoteDebuggingBlock, usesScreenRecording } from "../../src/helper-capabilities";
import { MacOsHelper } from "../../src/proxy/os-macos";

test("remote-debugging CLI ignores Screen Recording", () => {
  for (const screenCapture of [true, false]) {
    assert.equal(remoteDebuggingBlock({ accessibility: true, screenCapture, prompted: false }), undefined);
  }
});

test("remote-debugging CLI still requires Accessibility and refuses a permission prompt", () => {
  assert.equal(remoteDebuggingBlock({ accessibility: false, screenCapture: true }), "Device Control and Data Access is not on for Bao");
  assert.equal(remoteDebuggingBlock({ accessibility: true, prompted: true, screenCapture: false }), "helper asked for a permission prompt");
});

test("Chrome helper rejects window capture without calling it", async () => {
  assert.equal(usesScreenRecording([["permissions"], ["nodes", "--bundle", "com.google.Chrome"], ["press"]]), false);
  assert.equal(usesScreenRecording([["shot", "--bundle", "com.google.Chrome", "--out", "/tmp/bao-live.png"]]), true);
  const live = chromeHelper();
  await assert.rejects(
    () => MacOsHelper.prototype.shot.call(live, "com.google.Chrome", "/tmp/bao-live.png"),
    /live Chrome does not use screen recording/,
  );
  await assert.rejects(
    () => live.exec(["shot", "--bundle", "com.google.Chrome", "--out", "/tmp/bao-live.png"]),
    /live Chrome does not use screen recording/,
  );
  const wiped = live as Omit<MacOsHelper, "shot"> & { shot?: MacOsHelper["shot"] };
  delete wiped.shot;
  await assert.rejects(
    () => live.shot("com.google.Chrome", "/tmp/bao-live.png"),
    /live Chrome does not use screen recording/,
  );
  assert.equal(live.calls.some((call) => call[0] === "shot"), false);
  const other = new MacOsHelper(live.bin);
  assert.equal(other.refuseWindowShot, false);
});

test("Chrome helper refuses nodes outside stable Chrome before launching the helper", async () => {
  const live = chromeHelper();
  for (const bundle of [
    "com.apple.UserNotificationCenter", "", "com.google.Chrome.helper", "com.google.Chrome.evil",
    "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary", "com.google.chrome.for.testing",
  ]) {
    await assert.rejects(live.nodes(bundle), /target bundle must be com\.google\.Chrome/);
  }
  for (const args of [
    ["nodes"],
    ["nodes", "--pid", "123"],
    ["nodes", "--bundle"],
    ["nodes", "--bundle", "com.google.Chrome", "--bundle", "com.apple.UserNotificationCenter"],
    ["nodes", "--bundle", "com.google.Chrome", "--bundle", "com.google.Chrome"],
  ]) {
    await assert.rejects(live.exec(args), /target bundle must be com\.google\.Chrome/);
  }
  await assert.rejects(live.windows("com.google.Chrome"), /Screen Recording is not used/);
  await assert.rejects(live.permissions(true), /Screen Recording is not used/);
  assert.deepEqual(live.calls, []);
});

test("Chrome helper accepts stable Chrome nodes and skips ScreenCapture preflight", async (t) => {
  const sent: string[][] = [];
  t.mock.method(MacOsHelper.prototype, "exec", async (args: string[]) => {
    sent.push(args);
    return { ok: true };
  });
  const live = chromeHelper();
  await live.nodes("com.google.Chrome", 42);
  await live.nodes("com.google.Chrome");
  await live.permissions(false);
  assert.deepEqual(sent, [
    ["nodes", "--bundle", "com.google.Chrome", "--pid", "42"],
    ["nodes", "--bundle", "com.google.Chrome"],
    ["permissions-ax"],
  ]);
});

test("Chrome helper leaves other commands' bundle handling to the native helper", async (t) => {
  const sent: string[][] = [];
  t.mock.method(MacOsHelper.prototype, "exec", async (args: string[]) => {
    sent.push(args);
    return { ok: true };
  });
  const live = chromeHelper();
  for (const bundle of ["com.google.Chrome", "com.google.chrome.for.testing", "com.example.test", ""]) {
    await live.press({ platform: "macos", app: bundle, role: "AXButton", name: "Allow", path: [] }, 42);
    await live.hit(10, 20, bundle);
    await live.focused(bundle);
    assert.deepEqual(sent.slice(-3), [
      ["press", "--bundle", bundle, "--role", "AXButton", "--name", "Allow", "--pid", "42"],
      ["hit", "--x", "10", "--y", "20", "--allow-bundle", bundle],
      ["focus", "--allow-bundle", bundle],
    ]);
  }
  for (const command of [
    "read", "set-value", "focus-role", "move-window", "key", "type-keys", "cg-key", "cg-type",
    "fixture", "windows-brief", "close-window", "raise-window", "set-window-text", "confirm-text",
  ]) {
    const args = [command, "--bundle", "com.example.test"];
    await live.exec(args);
    assert.deepEqual(sent.at(-1), args);
  }
  await live.moveWindow("", { x: 50, y: 50, w: 550, h: 500 }, { pid: 42, frontmost: true });
  assert.deepEqual(sent.at(-1), ["move-window", "--pid", "42", "--frontmost", "--x", "50", "--y", "50", "--w", "550", "--h", "500"]);
});

test("only current optional native capabilities remain, independent of Chrome Automation", () => {
  for (const accessibility of [false, true]) {
    for (const screenCapture of [false, true]) {
      const helper = capabilityReport({ platform: "darwin", helperPresent: true, accessibility, screenCapture });
      assert.equal(helper.label, "helper available");
      assert.equal(helper.accessibility, accessibility);
      assert.equal(helper.screenCapture, screenCapture);
      assert.deepEqual(helper.capabilities.map((row) => row.id), ["window-capture", "mcp-ax"]);
      assert.ok(helper.capabilities.every((row) => row.optional));
      assert.equal(helper.capabilities[0].status, screenCapture ? "window capture ready" : "optional window capture needs Screen Recording (not needed for Chrome)");
      assert.equal(helper.capabilities[1].status, accessibility && screenCapture ? "MCP driver ready" : "optional native-app MCP driver needs Accessibility and Screen Recording (not needed for Chrome)");
      const html = rail({ helper });
      assert.equal(html.includes('aria-label="Optional Mac permissions not granted"'), false);
      assert.match(html, /Nothing running/);
      assert.doesNotMatch(html, /needs permission|AX press|live Chrome|perm-dot|Automation|Screen Recording|helper-jobs/);
    }
  }
});

test("helper off means absent or unsupported, not missing optional grants", () => {
  for (const [platform, helperPresent] of [["linux", true], ["darwin", false]] as const) {
    const helper = capabilityReport({ platform, helperPresent, accessibility: true, screenCapture: true });
    assert.deepEqual(helper, { label: "helper off", platform, accessibility: false, screenCapture: false, capabilities: [] });
    assert.doesNotMatch(rail({ helper }), /place-warning|helper-status/);
  }
  assert.match(rail({}), /Nothing running/);
});
