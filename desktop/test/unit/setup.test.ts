import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { signer } from "../../src/app/doctor";
import { applyTarget, chosenByFlags, detectOthers, detectTargets, parseSetup, type Probe, type Target } from "../../src/app/setup";

interface Lab {
  probe: Probe;
  app: string;
  launcher: string;
  apps: string;
  bin: string;
}

/** An empty HOME, an empty Applications folder, an empty PATH directory, and a Bao.app whose bao-mcp is a stub. */
function lab(t: TestContext): Lab {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-setup-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  const apps = path.join(root, "Applications");
  const bin = path.join(root, "bin");
  const app = path.join(apps, "Bao.app");
  const launcher = path.join(app, "Contents", "MacOS", "bao-mcp");
  for (const dir of [home, bin, path.dirname(launcher)]) mkdirSync(dir, { recursive: true });
  writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
  chmodSync(launcher, 0o755);
  return { probe: { home, env: { HOME: home, PATH: bin }, pathDirs: [bin], appDirs: [apps] }, app, launcher, apps, bin };
}

function tool(dir: string, name: string): void {
  writeFileSync(path.join(dir, name), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(dir, name), 0o755);
}

function byId(targets: readonly Target[], id: Target["id"]): Target {
  const target = targets.find((item) => item.id === id);
  assert.ok(target, id);
  return target;
}

test("an empty Mac shows every target as not found, and Claude Code as blocked without its CLI", (t) => {
  const { probe } = lab(t);
  const targets = detectTargets(probe);
  assert.deepEqual(targets.map((target) => target.id), ["claude-code", "codex", "claude-desktop", "cursor"]);
  assert.ok(targets.every((target) => target.found === "" && target.command === ""));
  assert.equal(byId(targets, "claude-code").blocked, "needs the claude command on PATH");
  assert.deepEqual(detectOthers(probe), []);
  assert.deepEqual(chosenByFlags(targets, { app: "", yes: true, none: false, list: false }), []);
});

test("setup finds CLIs on PATH, app bundles, and config folders", (t) => {
  const { probe, apps, bin } = lab(t);
  tool(bin, "claude");
  tool(bin, "opencode");
  mkdirSync(path.join(apps, "ChatGPT.app"));
  mkdirSync(path.join(apps, "Claude.app"));
  mkdirSync(path.join(probe.home, ".cursor"));
  const targets = detectTargets(probe);
  assert.equal(byId(targets, "claude-code").found, "claude on PATH");
  assert.equal(byId(targets, "claude-code").blocked, "");
  assert.equal(byId(targets, "codex").found, path.join(apps, "ChatGPT.app"));
  assert.equal(byId(targets, "claude-desktop").found, path.join(apps, "Claude.app"));
  assert.equal(byId(targets, "cursor").found, "~/.cursor");
  assert.deepEqual(detectOthers(probe), [{ label: "opencode", found: "opencode on PATH" }]);
  const yes = chosenByFlags(targets, { app: "", yes: true, none: false, list: false });
  assert.deepEqual(yes?.map((target) => target.id), ["claude-code", "codex", "claude-desktop", "cursor"]);
});

test("flags pick targets by name and refuse unknown or blocked ones", (t) => {
  const { probe } = lab(t);
  const targets = detectTargets(probe);
  const options = parseSetup(["--agents", "chatgpt,cursor"], "/nowhere/cli.js");
  assert.deepEqual(chosenByFlags(targets, options)?.map((target) => target.id), ["codex", "cursor"]);
  assert.equal(chosenByFlags(targets, parseSetup([], "/nowhere/cli.js")), undefined);
  assert.deepEqual(chosenByFlags(targets, parseSetup(["--none"], "/nowhere/cli.js")), []);
  assert.throws(() => chosenByFlags(targets, parseSetup(["--agents", "emacs"], "/nowhere/cli.js")), /unknown agent: emacs/);
  assert.throws(() => chosenByFlags(targets, parseSetup(["-a", "claude"], "/nowhere/cli.js")), /Claude Code needs the claude command on PATH/);
  assert.throws(() => parseSetup(["--yes", "--none"]), /only one of/);
});

test("the app comes from the server copy that runs setup, unless --app names one", () => {
  assert.equal(parseSetup([], "/Applications/Bao.app/Contents/Resources/bao/src/app/setup.js").app, "/Applications/Bao.app");
  assert.equal(parseSetup([], "/repo/desktop/dist/desktop/src/app/setup.js").app, "/Applications/Bao.app");
  assert.equal(parseSetup(["--app", "/nowhere/Other Bao.app"]).app, "/nowhere/Other Bao.app");
});

test("doctor names how a bundle is signed", () => {
  assert.equal(signer("Identifier=dev.bao.desktop\nSignature=adhoc\nTeamIdentifier=not set\n"), "signed ad-hoc, with no certificate");
  assert.equal(signer("Authority=bao dev signing\nTeamIdentifier=not set\n"), "signed by bao dev signing (self-signed, not notarized)");
  assert.equal(signer("Authority=Developer ID Application: Example (ABC123)\nAuthority=Apple Root CA\nTeamIdentifier=ABC123\n"), "signed by Developer ID Application: Example (ABC123) (team ABC123)");
  assert.equal(signer("code object is not signed at all\n"), "unsigned");
});

test("writing Codex and Cursor names this app's launcher, and a second run changes nothing", (t) => {
  const { probe, app, launcher } = lab(t);
  const out: string[] = [];
  const io = { env: probe.env, out: (text: string) => out.push(text), err: (text: string) => out.push(text) };
  const cursorFile = path.join(probe.home, ".cursor", "mcp.json");
  mkdirSync(path.dirname(cursorFile));
  writeFileSync(cursorFile, `{\n  "mcpServers": {\n    "other": { "command": "x" }\n  }\n}\n`);
  for (const id of ["codex", "cursor"] as const) assert.ok(applyTarget(byId(detectTargets(probe), id), app, probe.home, io), out.join(""));
  const after = detectTargets(probe);
  assert.equal(byId(after, "codex").command, launcher);
  assert.equal(byId(after, "cursor").command, launcher);
  const cursor = JSON.parse(readFileSync(cursorFile, "utf8")) as { mcpServers: Record<string, { command: string; args?: string[] }> };
  assert.deepEqual(cursor.mcpServers.other, { command: "x" });
  assert.deepEqual(cursor.mcpServers.bao, { command: launcher, args: [] });
  const before = [readFileSync(cursorFile, "utf8"), readFileSync(byId(after, "codex").file, "utf8")];
  for (const id of ["codex", "cursor"] as const) assert.ok(applyTarget(byId(after, id), app, probe.home, io));
  assert.deepEqual([readFileSync(cursorFile, "utf8"), readFileSync(byId(after, "codex").file, "utf8")], before);
});
