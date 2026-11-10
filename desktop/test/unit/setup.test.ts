import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";
import { doctorChecks, signer } from "../../src/app/doctor";
import { applyTarget, chosenByFlags, detectOthers, detectTargets, parseSetup, pickInTerminal, setupMain, type Probe, type SetupIo, type Target } from "../../src/app/setup";

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
  assert.deepEqual(chosenByFlags(targets, { app: "", yes: true, none: false }), []);
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
  const yes = chosenByFlags(targets, { app: "", yes: true, none: false });
  assert.deepEqual(yes?.map((target) => target.id), ["claude-code", "codex", "claude-desktop", "cursor"]);
});

test("flags pick targets by name and refuse unknown or blocked ones", (t) => {
  const { probe } = lab(t);
  const targets = detectTargets(probe);
  const options = parseSetup(["--agents", "codex,cursor"], "/nowhere/cli.js");
  assert.deepEqual(chosenByFlags(targets, options)?.map((target) => target.id), ["codex", "cursor"]);
  assert.equal(chosenByFlags(targets, parseSetup([], "/nowhere/cli.js")), undefined);
  assert.deepEqual(chosenByFlags(targets, parseSetup(["--none"], "/nowhere/cli.js")), []);
  assert.throws(() => chosenByFlags(targets, parseSetup(["--agents", "emacs"], "/nowhere/cli.js")), /unknown agent: emacs/);
  for (const name of ["claude", "chatgpt", "all", "*"]) assert.throws(() => chosenByFlags(targets, parseSetup(["--agents", name], "/nowhere/cli.js")), /unknown agent/);
  assert.throws(() => chosenByFlags(targets, parseSetup(["--agents", "claude-code"], "/nowhere/cli.js")), /Claude Code needs the claude command on PATH/);
  assert.throws(() => parseSetup(["--yes", "--none"]), /only one of/);
  for (const short of ["-y", "-a"]) assert.throws(() => parseSetup([short, "codex"]), /unknown argument/);
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

test("writing Cursor through a linked mcp.json keeps the link and edits the file it names", (t) => {
  const { probe, app, launcher } = lab(t);
  const out: string[] = [];
  const io = { env: probe.env, out: (text: string) => out.push(text), err: (text: string) => out.push(text) };
  const real = path.join(probe.home, "dotfiles", "cursor-mcp.json");
  mkdirSync(path.dirname(real));
  writeFileSync(real, `{ "mcpServers": {} }\n`);
  const link = path.join(probe.home, ".cursor", "mcp.json");
  mkdirSync(path.dirname(link));
  symlinkSync(real, link);
  assert.ok(applyTarget(byId(detectTargets(probe), "cursor"), app, probe.home, io), out.join(""));
  assert.ok(lstatSync(link).isSymbolicLink());
  const cursor = JSON.parse(readFileSync(real, "utf8")) as { mcpServers: Record<string, { command: string }> };
  assert.equal(cursor.mcpServers.bao?.command, launcher);
  assert.ok(readdirSync(path.dirname(link)).some((file) => file.startsWith("mcp.json.bao-backup-")));
});

test("the picker keeps every line inside a narrow terminal, so a redraw moves up over exactly what it drew", async (t) => {
  const { probe, apps, launcher } = lab(t);
  mkdirSync(path.join(apps, "ChatGPT.app"));
  mkdirSync(path.join(apps, "Codex.app"));
  mkdirSync(path.join(probe.home, ".codex"));
  const targets = detectTargets(probe);
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin });
  const written: string[] = [];
  const stdout = { columns: 40, isTTY: true, write: (text: string) => written.push(text) };
  const io = { env: probe.env, out: () => {}, err: () => {}, stdin, stdout } as unknown as SetupIo;
  const picked = pickInTerminal(targets, launcher, io);
  stdin.write("\u001b[B");
  await new Promise((resolve) => setImmediate(resolve));
  stdin.write("\r");
  assert.deepEqual((await picked)?.map((target) => target.id), ["codex"]);
  const screen = written.join("");
  const up = /\u001b\[(\d+)A/.exec(screen);
  assert.ok(up, "the second draw moves up");
  const firstDraw = screen.slice(0, up.index).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
  const rows = firstDraw.split("\n").slice(0, -1);
  assert.equal(Number(up[1]), rows.length);
  for (const row of screen.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n")) assert.ok(row.length < 40, row);
});

test("with no terminal, setup lists a command for each agent it can set up, not one that would fail", async (t) => {
  const { probe, app } = lab(t);
  const out: string[] = [];
  const io = { env: probe.env, out: (text: string) => out.push(text), err: (text: string) => out.push(text), stdin: { isTTY: false }, stdout: { isTTY: false } } as unknown as SetupIo;
  assert.equal(await setupMain(["--app", app], io, probe), 0);
  const bao = path.join(app, "Contents", "MacOS", "bao-cli");
  assert.equal(out.join(""), `No terminal to ask in, so Bao changed no agent config. Run one of these:\n${["codex", "claude-desktop", "cursor"].map((id) => `  ${bao} setup --agents ${id}`).join("\n")}\n`);
});

test("setup with --none names the command that runs setup from this shell", async (t) => {
  const { probe, app, bin } = lab(t);
  const said = async (): Promise<string> => {
    const out: string[] = [];
    const io = { env: probe.env, out: (text: string) => out.push(text), err: (text: string) => out.push(text) } as unknown as SetupIo;
    assert.equal(await setupMain(["--app", app, "--none"], io, probe), 0);
    return out.join("");
  };
  const cli = path.join(app, "Contents", "MacOS", "bao-cli");
  assert.equal(await said(), `No app was changed. Run \`${cli} setup\` any time to add Bao to an agent.\n`);
  writeFileSync(cli, "#!/bin/sh\nexit 0\n");
  chmodSync(cli, 0o755);
  const link = path.join(probe.home, ".local", "bin", "bao");
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(cli, link);
  assert.equal(await said(), `No app was changed. Run \`${link} setup\` any time to add Bao to an agent.\n`);
  tool(bin, "bao");
  assert.equal(await said(), `No app was changed. Run \`${link} setup\` any time to add Bao to an agent.\n`);
  rmSync(path.join(bin, "bao"));
  symlinkSync(link, path.join(bin, "bao"));
  assert.equal(await said(), "No app was changed. Run `bao setup` any time to add Bao to an agent.\n");
});

test("doctor tells the owner what Claude Code is missing instead of a setup command that would fail", async (t) => {
  const { probe, app, launcher } = lab(t);
  writeFileSync(launcher, `#!/bin/sh\nread line\nprintf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}'\nread line\nread line\nprintf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}'\n`);
  mkdirSync(path.join(probe.home, ".claude"));
  const detail = async (): Promise<string | undefined> => (await doctorChecks(app, probe)).find((check) => check.name === "claude-code")?.detail;
  assert.equal(await detail(), "found (~/.claude) but not set up. Claude Code needs the claude command on PATH");
  const servers = path.join(probe.home, ".claude.json");
  writeFileSync(servers, JSON.stringify({ mcpServers: { bao: { command: "/Applications/Other.app/Contents/MacOS/bao-mcp" } } }));
  assert.equal(await detail(), `${servers} starts /Applications/Other.app/Contents/MacOS/bao-mcp. Claude Code needs the claude command on PATH`);
  const cli = path.join(app, "Contents", "MacOS", "bao-cli");
  assert.equal((await doctorChecks(app, probe)).find((check) => check.name === "codex")?.detail, undefined);
  mkdirSync(path.join(probe.home, ".codex"));
  assert.equal((await doctorChecks(app, probe)).find((check) => check.name === "codex")?.detail, `found (~/.codex) but not set up. Run ${cli} setup --agents codex`);
});

test("setup asks for Files & Folders > Bao > Google Chrome only when Bao cannot read Chrome's folder, and the owner can skip it", async (t) => {
  const { probe, app } = lab(t);
  const chromeRoot = path.join(probe.home, "Library", "Application Support", "Google", "Chrome");
  mkdirSync(path.join(chromeRoot, "Default"), { recursive: true });
  const opened: string[] = [];
  const env = { ...probe.env, BAO_RESPONSIBLE_EXE: "/Applications/Bao.app/Contents/MacOS/bao", BAO_CERT_SIGNED: "1" };
  const withChrome: Probe = { ...probe, env, chromeRoot, openUrl: (url) => opened.push(url) };
  const run = async (keys: string[], tty = true): Promise<string> => {
    const out: string[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: tty, setRawMode: () => stdin });
    const io = { env, out: (text: string) => out.push(text), err: (text: string) => out.push(text), stdin, stdout: { isTTY: tty, columns: 80, write: () => true } } as unknown as SetupIo;
    const done = setupMain(["--app", app, "--none"], io, withChrome);
    for (const key of keys) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (key === "allow") chmodSync(chromeRoot, 0o700);
      else stdin.write(key);
    }
    assert.equal(await done, 0);
    return out.join("");
  };
  const intro = `No app was changed. Run \`${path.join(app, "Contents", "MacOS", "bao-cli")} setup\` any time to add Bao to an agent.\n\n== Google Chrome's folder (optional)\n`;
  assert.equal(await run([]), `${intro}Bao can read your Chrome profiles in ${chromeRoot}. Nothing to do. Agents that start Bao use this switch too.\n`);

  chmodSync(chromeRoot, 0o000);
  try {
    const why = `${intro}Bao reads your Chrome profiles to import a site's sign-in and to use Running Chrome. macOS 27 and later ask before an app reads them.\n`
      + `Now: Bao cannot read them. Turn on System Settings > Privacy & Security > Files & Folders > Bao > Google Chrome, then try again. Agents that start Bao use this switch too.\n`
      + "Skip this and Bao still opens its own profile. It tells the agent what to turn on when a step needs Chrome's folder.\n";
    const prompt = "o opens System Settings, c checks again, enter skips: ";
    assert.equal(await run(["\r"]), `${why}${prompt}\nSkipped.\n`);
    assert.equal(await run(["o", "c", "allow", "c"]), `${why}${prompt}\n${prompt}\nNow: Bao still cannot read them.\n${prompt}\nNow: Bao can read your Chrome profiles.\n`);
    assert.deepEqual(opened, ["x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders"]);
    chmodSync(chromeRoot, 0o000);
    assert.equal(await run([], false), why, "with no terminal, setup says what to turn on and asks nothing");
  } finally { chmodSync(chromeRoot, 0o700); }
});

test("doctor says whether Bao can read Chrome's folder and names the switch when it cannot", async (t) => {
  const { probe, app, launcher } = lab(t);
  writeFileSync(launcher, `#!/bin/sh\nread line\nprintf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}'\nread line\nread line\nprintf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}'\n`);
  const chromeRoot = path.join(probe.home, "Chrome");
  mkdirSync(chromeRoot);
  const env = { ...probe.env, BAO_RESPONSIBLE_EXE: "/Applications/Bao.app/Contents/MacOS/bao" };
  const check = async () => (await doctorChecks(app, { ...probe, env, chromeRoot })).find((row) => row.name === "chrome folder");
  assert.deepEqual(await check(), { level: "ok", name: "chrome folder",
    detail: `Bao can read ${chromeRoot}. Agents use the switch of the app that starts them, such as ChatGPT for Codex.` });
  chmodSync(chromeRoot, 0o000);
  try {
    const refused = await check();
    assert.equal(refused?.level, "warn");
    assert.match(refused?.detail ?? "", /^macOS did not let Bao read Google Chrome's folder \(EACCES on .+\/Chrome\)\. Turn on System Settings > Privacy & Security > Files & Folders > Bao > Google Chrome, then try again\. If it is already on, turn it off and on again/);
  } finally { chmodSync(chromeRoot, 0o700); }
  assert.equal(await doctorChecks(app, { ...probe, env, chromeRoot: path.join(probe.home, "absent") }).then((rows) => rows.find((row) => row.name === "chrome folder")), undefined);
});

test("doctor warns that Running Chrome, the default, needs the helper when it is missing", async (t) => {
  const { probe, app, launcher } = lab(t);
  writeFileSync(launcher, `#!/bin/sh\nread line\nprintf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}'\nread line\nread line\nprintf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[]}}'\n`);
  const checks = await doctorChecks(app, probe);
  const helper = checks.find((row) => row.name === "helper");
  assert.equal(helper?.level, "warn");
  assert.equal(helper?.detail, "not installed. Running Chrome is the default and needs the helper's Accessibility grant for the Allow press. A Bao profile or a copy does not need the helper.");
  mkdirSync(path.join(app, "Contents", "Resources", "BaoOSHelper.app"), { recursive: true });
  const present = (await doctorChecks(app, probe)).find((row) => row.name === "helper");
  assert.match(present?.detail ?? "", /Running Chrome \(browser=current\) is the default and uses it to press the Allow sheet, with an Accessibility grant\. Optional: the native Mac app driver \(bao mcp-ax\) and bao remote-debugging$/);
  assert.doesNotMatch(present?.detail ?? "", /Optional: Running Chrome/);
  const chrome = checks.find((row) => row.name === "chrome");
  assert.equal(chrome?.level, "warn");
  assert.equal(chrome?.detail, "Google Chrome is not installed. Every agent_browser route starts installed Google Chrome. A Bao profile and a copy are not a way around a missing Chrome.");
  const installed = path.join(probe.appDirs[0], "Google Chrome.app");
  mkdirSync(installed);
  const found = (await doctorChecks(app, probe)).find((row) => row.name === "chrome");
  assert.deepEqual(found, { level: "ok", name: "chrome", detail: installed });
});
