import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { allowBaoTools, CLAUDE_BAO_RULE } from "../../src/app/claude-settings";
import { CODEX_APPROVAL_MODE, CODEX_TOOL_TIMEOUT_SEC, codexServerBlock, upsertCodexServer } from "../../src/app/codex-config";

const cli = path.join(process.cwd(), "desktop/dist/desktop/src/app/cli.js");

interface Lab {
  root: string;
  /** HOME for every child. It starts empty, so a stray write shows up. */
  user: string;
  app: string;
  launcher: string;
  bin: string;
  claudeLog: string;
}

/** A temp HOME, a Bao.app whose bao-mcp is a stub, and a fake claude that logs its arguments. */
function lab(t: TestContext, prefix: string, withLauncher = true): Lab {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const user = path.join(root, "user");
  const app = path.join(root, "Bao Test.app");
  const launcher = path.join(app, "Contents", "MacOS", "bao-mcp");
  const bin = path.join(root, "bin");
  const claudeLog = path.join(root, "claude.log");
  mkdirSync(user);
  mkdirSync(bin);
  if (withLauncher) {
    mkdirSync(path.dirname(launcher), { recursive: true });
    writeFileSync(launcher, "#!/bin/sh\nexit 0\n");
    chmodSync(launcher, 0o755);
  }
  // remove succeeds only when the log says an add already happened, like the real CLI.
  writeFileSync(path.join(bin, "claude"), [
    "#!/bin/sh",
    "prior=0",
    "[ -f \"$CLAUDE_LOG\" ] && grep -q '^add$' \"$CLAUDE_LOG\" && prior=1",
    "for arg in \"$@\"; do printf '%s\\n' \"$arg\" >> \"$CLAUDE_LOG\"; done",
    "printf -- '---\\n' >> \"$CLAUDE_LOG\"",
    "if [ \"$2\" = remove ]; then",
    "  [ \"$prior\" = 1 ] && { echo 'Removed MCP server bao from user config'; exit 0; }",
    "  echo 'No user-scoped MCP server found with name: bao' >&2; exit 1",
    "fi",
    "[ -n \"$CLAUDE_ADD_FAIL\" ] && { echo 'add broke' >&2; exit 1; }",
    "echo \"Added stdio MCP server bao with command: $7 to user config\"",
    "",
  ].join("\n"));
  chmodSync(path.join(bin, "claude"), 0o755);
  return { root, user, app, launcher, bin, claudeLog };
}

function run(l: Lab, args: string[], extra: Record<string, string | undefined> = {}): { status: number; stdout: string; stderr: string } {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: l.user, PATH: `${l.bin}:/usr/bin:/bin`, CLAUDE_LOG: l.claudeLog };
  delete env.CODEX_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.BAO_HOME;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(process.execPath, [cli, "agent", ...args], { cwd: l.root, env, encoding: "utf8", timeout: 30_000 });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function claudeCalls(l: Lab): string[][] {
  if (!existsSync(l.claudeLog)) return [];
  return readFileSync(l.claudeLog, "utf8").split("---\n").filter(Boolean).map((call) => call.trimEnd().split("\n"));
}

function block(launcher: string): string {
  return codexServerBlock(launcher);
}

function claudeEntry(l: Lab, settings = path.join(l.user, ".claude", "settings.json")): string {
  return `claude mcp add --scope user bao -- '${l.launcher}'\n# Then add "mcp__bao" to permissions.allow in ${settings}\n`;
}

const APPROVE = "default_tools_approval_mode = \"approve\"\n";

test("the Codex entry runs the launcher with the long tool timeout and bao's tools pre-approved", () => {
  assert.equal(CODEX_TOOL_TIMEOUT_SEC, 180);
  assert.equal(CODEX_APPROVAL_MODE, "approve");
  assert.equal(
    codexServerBlock("/Applications/Bao.app/Contents/MacOS/bao-mcp"),
    `[mcp_servers.bao]\ncommand = "/Applications/Bao.app/Contents/MacOS/bao-mcp"\ntool_timeout_sec = 180\n${APPROVE}`,
  );
  assert.equal(
    codexServerBlock("/A \"q\"\\b\t.app/bao-mcp"),
    `[mcp_servers.bao]\ncommand = "/A \\"q\\"\\\\b\\u0009.app/bao-mcp"\ntool_timeout_sec = 180\n${APPROVE}`,
  );
});

test("a new bao table goes at the end of config.toml", () => {
  const entry = block("/L");
  assert.equal(upsertCodexServer("", "/L"), entry);
  assert.equal(upsertCodexServer("model = \"o3\"\n", "/L"), `model = "o3"\n\n${entry}`);
  assert.equal(upsertCodexServer("model = \"o3\"", "/L"), `model = "o3"\n\n${entry}`);
  assert.equal(upsertCodexServer("model = \"o3\"\n\n", "/L"), `model = "o3"\n\n${entry}`);
});

test("bao replaces only the keys it owns and keeps the user's keys and tool approvals", () => {
  const before = [
    "model = \"o3\" # keep",
    "",
    "[mcp_servers.alpha]",
    "command = \"a\"",
    "",
    "# bao from an old checkout",
    "[mcp_servers.bao]",
    "enabled = true",
    "command = \"node\" # old",
    "startup_timeout_sec = 20",
    "args = [",
    "  \"/old/cli.js\",",
    "  \"mcp\",",
    "]",
    "tool_timeout_sec = 60",
    "default_tools_approval_mode = \"prompt\"",
    "tools.run_workflow.approval_mode = \"approve\"",
    "",
    "[mcp_servers.bao.env]",
    "BAO_HOME = \"/old\"",
    "",
    "# approvals Codex saved",
    "[mcp_servers.bao.tools.live_click]",
    "approval_mode = \"approve\"",
    "",
    "# zeta keeps this comment",
    "[mcp_servers.zeta]",
    "command = \"z\"",
    "",
  ].join("\n");
  const after = upsertCodexServer(before, "/L");
  assert.equal(after, [
    "model = \"o3\" # keep",
    "",
    "[mcp_servers.alpha]",
    "command = \"a\"",
    "",
    "# bao from an old checkout",
    "[mcp_servers.bao]",
    "enabled = true",
    "command = \"/L\"",
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    "default_tools_approval_mode = \"approve\"",
    "startup_timeout_sec = 20",
    "tools.run_workflow.approval_mode = \"approve\"",
    "",
    "# approvals Codex saved",
    "[mcp_servers.bao.tools.live_click]",
    "approval_mode = \"approve\"",
    "",
    "# zeta keeps this comment",
    "[mcp_servers.zeta]",
    "command = \"z\"",
    "",
  ].join("\n"));
  assert.equal(upsertCodexServer(after, "/L"), after);
  assert.equal(upsertCodexServer(after, "/M"), after.replace("command = \"/L\"", "command = \"/M\""));
});

test("a bao table with none of bao's keys gets them under its header", () => {
  const tools = "[mcp_servers.bao.tools.live_click]\napproval_mode = \"approve\"\n";
  const lines = block("/L").replace("[mcp_servers.bao]\n", "");
  assert.equal(upsertCodexServer(`[mcp_servers.bao]\nenabled = true\n\n${tools}`, "/L"), `[mcp_servers.bao]\n${lines}enabled = true\n\n${tools}`);
  assert.equal(upsertCodexServer("[mcp_servers.bao]", "/L"), `[mcp_servers.bao]\n${lines}`);
  // Approvals with no bao table: the table goes at the end, which TOML allows after its sub-tables.
  assert.equal(upsertCodexServer(tools, "/L"), `${tools}\n${block("/L")}`);
});

test("quoted keys, an env sub-table far below, and header lookalikes in values", () => {
  const before = [
    "[ mcp_servers . \"bao\" ] # spaced and quoted",
    "command = \"old\"",
    "[profiles.x]",
    "notes = \"\"\"",
    "[mcp_servers.bao]",
    "\"\"\"",
    "nested = [",
    "  [\"mcp_servers\"],",
    "]",
    "['mcp_servers'.'bao'.env]",
    "A = \"1\"",
  ].join("\n");
  const lines = block("/L").replace("[mcp_servers.bao]\n", "");
  assert.equal(
    upsertCodexServer(before, "/L"),
    `[ mcp_servers . "bao" ] # spaced and quoted\n${lines}[profiles.x]\nnotes = """\n[mcp_servers.bao]\n"""\nnested = [\n  ["mcp_servers"],\n]\n`,
  );
});

test("a bao entry in another TOML form is refused", () => {
  const entry = block("/L");
  for (const text of [
    "mcp_servers = { bao = { command = \"x\" } }\n",
    "mcp_servers.bao.command = \"x\"\n",
    "[mcp_servers]\nbao = { command = \"x\" }\n",
    "[mcp_servers]\n\"bao\".command = \"x\"\n",
    "[mcp_servers]\nbao.tools.live_click.approval_mode = \"approve\"\n",
    "[mcp_servers.bao]\ncommand = \"a\"\n[mcp_servers.bao]\ncommand = \"b\"\n",
    "[mcp_servers.bao\n",
    "key = \"no end\n",
  ]) {
    assert.throws(() => upsertCodexServer(text, "/L"), { name: "CodexConfigError" }, text);
  }
  // Other servers next to a new bao table are fine, in any form TOML allows.
  assert.equal(upsertCodexServer("[mcp_servers]\nother = { command = \"o\" }\n", "/L"), `[mcp_servers]\nother = { command = "o" }\n\n${entry}`);
});

test("bao agent config prints the entries and writes nothing", (t) => {
  const l = lab(t, "bao-agent-print-");
  const claude = run(l, ["config", "claude", "--app", l.app]);
  assert.equal(claude.status, 0, claude.stderr);
  assert.equal(claude.stdout, claudeEntry(l));
  assert.equal(claude.stderr, "");
  const configDir = path.join(l.root, "claude-config");
  const moved = run(l, ["config", "claude", "--app", l.app], { CLAUDE_CONFIG_DIR: configDir });
  assert.equal(moved.stdout, claudeEntry(l, path.join(configDir, "settings.json")));
  const codex = run(l, ["config", "codex", "--app", l.app]);
  assert.equal(codex.status, 0, codex.stderr);
  assert.equal(codex.stdout, block(l.launcher));
  assert.deepEqual(readdirSync(l.user), []);
  assert.deepEqual(claudeCalls(l), []);
});

test("bao agent config names a missing launcher and --write then refuses", (t) => {
  const l = lab(t, "bao-agent-missing-", false);
  const printed = run(l, ["config", "codex", "--app", l.app]);
  assert.equal(printed.status, 0);
  assert.equal(printed.stdout, block(l.launcher));
  assert.match(printed.stderr, /bao-mcp is missing\. Install a Bao\.app built with bao-mcp/);
  for (const agent of ["claude", "codex"]) {
    const wrote = run(l, ["config", agent, "--app", l.app, "--write"]);
    assert.equal(wrote.status, 1);
    assert.match(wrote.stderr, /Nothing was written\./);
  }
  assert.deepEqual(readdirSync(l.user), []);
  assert.deepEqual(claudeCalls(l), []);
});

test("bao agent config codex --write keeps the rest of config.toml and runs twice the same", (t) => {
  const l = lab(t, "bao-agent-codex-");
  const file = path.join(l.user, ".codex", "config.toml");
  mkdirSync(path.dirname(file));
  const mine = "model = \"o3\"\n\n[mcp_servers.alpha]\ncommand = \"a\"\n\n[mcp_servers.bao]\ncommand = \"node\"\nargs = [\"/old/cli.js\", \"mcp\"]\n";
  writeFileSync(file, mine, { mode: 0o644 });
  const first = run(l, ["config", "codex", "--app", l.app, "--write"]);
  assert.equal(first.status, 0, first.stderr);
  const expected = `model = "o3"\n\n[mcp_servers.alpha]\ncommand = "a"\n\n${block(l.launcher)}`;
  assert.equal(readFileSync(file, "utf8"), expected);
  assert.match(first.stdout, new RegExp(`Wrote this table to ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const second = run(l, ["config", "codex", "--app", l.app, "--write"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, `${file} already has this bao entry. Nothing changed.\n`);
  assert.equal(readFileSync(file, "utf8"), expected);
  assert.deepEqual(readdirSync(path.dirname(file)), ["config.toml"]);
});

test("bao agent config codex --write pre-approves bao's tools, keeps saved tool approvals and the user's keys, and a re-run changes no byte", (t) => {
  const l = lab(t, "bao-agent-codex-approvals-");
  const codexHome = path.join(l.root, "codex-home");
  const file = path.join(codexHome, "config.toml");
  mkdirSync(codexHome);
  const global = "approval_policy = \"on-request\"\n\n[mcp_servers.alpha]\ncommand = \"a\"\ndefault_tools_approval_mode = \"prompt\"\n\n";
  const approvals = "[mcp_servers.bao.tools.live_click]\napproval_mode = \"prompt\"\n";
  writeFileSync(file, `${global}[mcp_servers.bao]\ncommand = "node"\nargs = ["/old/cli.js", "mcp"]\nenv = { BAO_HOME = "/old" }\ndefault_tools_approval_mode = "prompt"\nstartup_timeout_sec = 20\n\n${approvals}`);
  const first = run(l, ["config", "codex", "--app", l.app, "--write"], { CODEX_HOME: codexHome });
  assert.equal(first.status, 0, first.stderr);
  const written = readFileSync(file);
  // Only bao's server is pre-approved. The global policy, alpha, and the saved live_click choice stay.
  assert.equal(
    written.toString("utf8"),
    `${global}${block(l.launcher)}startup_timeout_sec = 20\n\n${approvals}`,
  );
  assert.match(written.toString("utf8"), /\[mcp_servers\.bao\]\ncommand = .*\ntool_timeout_sec = 180\ndefault_tools_approval_mode = "approve"\n/);
  const second = run(l, ["config", "codex", "--app", l.app, "--write"], { CODEX_HOME: codexHome });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, `${file} already has this bao entry. Nothing changed.\n`);
  assert.ok(readFileSync(file).equals(written));
  assert.deepEqual(readdirSync(codexHome), ["config.toml"]);
  assert.deepEqual(readdirSync(l.user), []);
});

test("bao agent config codex --write follows CODEX_HOME", (t) => {
  const l = lab(t, "bao-agent-codex-home-");
  const codexHome = path.join(l.root, "codex-home");
  const wrote = run(l, ["config", "codex", "--app", l.app, "--write"], { CODEX_HOME: codexHome });
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.equal(readFileSync(path.join(codexHome, "config.toml"), "utf8"), block(l.launcher));
  assert.deepEqual(readdirSync(l.user), []);
});

test("bao agent config codex --write keeps a linked config.toml linked, and a read-only one unchanged", (t) => {
  const l = lab(t, "bao-agent-codex-link-");
  const dotfiles = path.join(l.root, "dotfiles");
  const real = path.join(dotfiles, "codex.toml");
  const file = path.join(l.user, ".codex", "config.toml");
  mkdirSync(dotfiles);
  mkdirSync(path.dirname(file));
  writeFileSync(real, "model = \"o3\"\n");
  symlinkSync(real, file);
  const wrote = run(l, ["config", "codex", "--app", l.app, "--write"]);
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.equal(lstatSync(file).isSymbolicLink(), true);
  assert.equal(readFileSync(real, "utf8"), `model = "o3"\n\n${block(l.launcher)}`);

  // root writes into a read-only directory anyway.
  if (process.getuid?.() === 0) return;
  writeFileSync(real, "model = \"o3\"\n");
  chmodSync(dotfiles, 0o555);
  try {
    const refused = run(l, ["config", "codex", "--app", l.app, "--write"]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /EACCES[\s\S]*Nothing was written\. Put this table in by hand:/);
  } finally {
    chmodSync(dotfiles, 0o755);
  }
  assert.equal(readFileSync(real, "utf8"), "model = \"o3\"\n");
  assert.deepEqual(readdirSync(dotfiles), ["codex.toml"]);
});

test("bao agent config codex --write leaves a bao entry it cannot rewrite alone", (t) => {
  const l = lab(t, "bao-agent-codex-inline-");
  const file = path.join(l.user, ".codex", "config.toml");
  mkdirSync(path.dirname(file));
  const mine = "mcp_servers = { bao = { command = \"x\" } }\n";
  writeFileSync(file, mine);
  const wrote = run(l, ["config", "codex", "--app", l.app, "--write"]);
  assert.equal(wrote.status, 1);
  assert.match(wrote.stderr, /line 1 sets mcp_servers outside a \[mcp_servers\.bao\] table\. Nothing was written\. Put this table in by hand:/);
  assert.ok(wrote.stderr.endsWith(block(l.launcher)), wrote.stderr);
  assert.equal(readFileSync(file, "utf8"), mine);
});

test("Claude settings get the bao allow rule and keep everything else", () => {
  assert.equal(CLAUDE_BAO_RULE, "mcp__bao");
  const only = "{\n  \"permissions\": {\n    \"allow\": [\n      \"mcp__bao\"\n    ]\n  }\n}\n";
  assert.equal(allowBaoTools(""), only);
  assert.equal(allowBaoTools(" \n"), only);
  assert.equal(allowBaoTools("{}"), only);
  // Key order, other rules, deny and ask rules, and the file's indent all stay.
  const mine = {
    model: "sonnet",
    permissions: { allow: ["Bash(git status)", "mcp__bao__live_click"], deny: ["WebFetch", "mcp__bao__run_workflow"], ask: ["mcp__other"] },
    env: { A: "1" },
  };
  const tabbed = `${JSON.stringify(mine, null, "\t")}\n`;
  const after = allowBaoTools(tabbed);
  assert.equal(after, `${JSON.stringify({ ...mine, permissions: { ...mine.permissions, allow: [...mine.permissions.allow, "mcp__bao"] } }, null, "\t")}\n`);
  assert.equal(allowBaoTools(after), after);
  assert.equal(
    allowBaoTools("{\n    \"model\": \"sonnet\"\n}"),
    "{\n    \"model\": \"sonnet\",\n    \"permissions\": {\n        \"allow\": [\n            \"mcp__bao\"\n        ]\n    }\n}\n",
  );
  // A file that has the rule comes back byte for byte, whatever its layout.
  const compact = "{\"permissions\":{\"allow\":[\"mcp__bao\"]}}";
  assert.equal(allowBaoTools(compact), compact);
  for (const text of ["{\"a\": 1,}", "// c\n{}", "[]", "null", "\"s\"", "{\"permissions\": []}", "{\"permissions\": {\"allow\": \"mcp__bao\"}}"]) {
    assert.throws(() => allowBaoTools(text), { name: "ClaudeSettingsError" }, text);
  }
});

test("bao agent config claude --write adds bao at user scope with its tools pre-approved, and again replaces it", (t) => {
  const l = lab(t, "bao-agent-claude-");
  const settings = path.join(l.user, ".claude", "settings.json");
  const first = run(l, ["config", "claude", "--app", l.app, "--write"]);
  assert.equal(first.status, 0, first.stderr);
  const add = ["mcp", "add", "--scope", "user", "bao", "--", l.launcher];
  const remove = ["mcp", "remove", "--scope", "user", "bao"];
  assert.deepEqual(claudeCalls(l), [remove, add]);
  assert.match(first.stdout, /Added stdio MCP server bao/);
  assert.ok(first.stdout.endsWith(`Added mcp__bao to permissions.allow in ${settings}, so Claude Code runs bao's tools without asking.\n`), first.stdout);
  assert.doesNotMatch(first.stdout, /Replaced/);
  const written = readFileSync(settings);
  assert.deepEqual(JSON.parse(written.toString("utf8")), { permissions: { allow: ["mcp__bao"] } });
  const second = run(l, ["config", "claude", "--app", l.app, "--write"]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(claudeCalls(l), [remove, add, remove, add]);
  assert.match(second.stdout, /Replaced the earlier bao entry in Claude Code's user config\./);
  assert.ok(second.stdout.endsWith(`${settings} already allows mcp__bao.\n`), second.stdout);
  assert.ok(readFileSync(settings).equals(written));
  assert.deepEqual(readdirSync(l.user), [".claude"]);
  assert.deepEqual(readdirSync(path.dirname(settings)), ["settings.json"]);
});

test("bao agent config claude --write merges into the user's settings under CLAUDE_CONFIG_DIR, and a re-run changes no byte", (t) => {
  const l = lab(t, "bao-agent-claude-merge-");
  const configDir = path.join(l.root, "claude-config");
  const settings = path.join(configDir, "settings.json");
  mkdirSync(configDir);
  const mine = "{\n  \"model\": \"sonnet\",\n  \"permissions\": {\n    \"allow\": [\n      \"Bash(git status)\"\n    ],\n    \"deny\": [\n      \"WebFetch\"\n    ],\n    \"defaultMode\": \"default\"\n  },\n  \"hooks\": {}\n}\n";
  writeFileSync(settings, mine, { mode: 0o644 });
  const first = run(l, ["config", "claude", "--app", l.app, "--write"], { CLAUDE_CONFIG_DIR: configDir });
  assert.equal(first.status, 0, first.stderr);
  const written = readFileSync(settings);
  assert.equal(written.toString("utf8"), mine.replace("\"Bash(git status)\"\n", "\"Bash(git status)\",\n      \"mcp__bao\"\n"));
  assert.equal(lstatSync(settings).mode & 0o777, 0o644);
  const second = run(l, ["config", "claude", "--app", l.app, "--write"], { CLAUDE_CONFIG_DIR: configDir });
  assert.equal(second.status, 0, second.stderr);
  assert.ok(readFileSync(settings).equals(written));
  assert.deepEqual(readdirSync(configDir), ["settings.json"]);
  assert.deepEqual(readdirSync(l.user), []);
});

test("bao agent config claude --write keeps a linked settings.json linked", (t) => {
  const l = lab(t, "bao-agent-claude-link-");
  const dotfiles = path.join(l.root, "dotfiles");
  const real = path.join(dotfiles, "claude.json");
  const settings = path.join(l.user, ".claude", "settings.json");
  mkdirSync(dotfiles);
  mkdirSync(path.dirname(settings));
  writeFileSync(real, "{\n  \"model\": \"sonnet\"\n}\n");
  symlinkSync(real, settings);
  const wrote = run(l, ["config", "claude", "--app", l.app, "--write"]);
  assert.equal(wrote.status, 0, wrote.stderr);
  assert.equal(lstatSync(settings).isSymbolicLink(), true);
  assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { model: "sonnet", permissions: { allow: ["mcp__bao"] } });
  assert.deepEqual(readdirSync(dotfiles), ["claude.json"]);
});

test("bao agent config claude --write leaves settings it cannot read alone and runs no claude command", (t) => {
  const l = lab(t, "bao-agent-claude-bad-");
  const settings = path.join(l.user, ".claude", "settings.json");
  mkdirSync(path.dirname(settings));
  const mine = "{\n  // a comment\n  \"model\": \"sonnet\"\n}\n";
  writeFileSync(settings, mine);
  const wrote = run(l, ["config", "claude", "--app", l.app, "--write"]);
  assert.equal(wrote.status, 1);
  assert.match(wrote.stderr, /settings\.json is not JSON bao can read \(.*\)\. Nothing was written\. Run this yourself:\n/);
  assert.ok(wrote.stderr.endsWith(claudeEntry(l)), wrote.stderr);
  assert.equal(readFileSync(settings, "utf8"), mine);
  assert.deepEqual(claudeCalls(l), []);
});

test("bao agent config claude --write says when a failed add leaves no bao entry", (t) => {
  const fresh = lab(t, "bao-agent-claude-fail-");
  const none = run(fresh, ["config", "claude", "--app", fresh.app, "--write"], { CLAUDE_ADD_FAIL: "1" });
  assert.equal(none.status, 1);
  assert.equal(none.stderr, `add broke\nclaude mcp add failed. Run this yourself:\n${claudeEntry(fresh)}`);
  assert.deepEqual(readdirSync(fresh.user), []);

  const l = lab(t, "bao-agent-claude-lost-");
  assert.equal(run(l, ["config", "claude", "--app", l.app, "--write"]).status, 0);
  const lost = run(l, ["config", "claude", "--app", l.app, "--write"], { CLAUDE_ADD_FAIL: "1" });
  assert.equal(lost.status, 1);
  assert.equal(
    lost.stderr,
    `add broke\nclaude mcp add failed. The earlier bao entry was removed, so Claude Code has no bao server now. Run this yourself:\n${claudeEntry(l)}`,
  );
  assert.doesNotMatch(lost.stdout, /Replaced/);
});

test("bao agent config claude --write without claude on PATH prints the command to run", (t) => {
  const l = lab(t, "bao-agent-noclaude-");
  const wrote = run(l, ["config", "claude", "--app", l.app, "--write"], { PATH: "/usr/bin:/bin" });
  assert.equal(wrote.status, 1);
  assert.equal(wrote.stderr, `claude is not on PATH. Nothing was written. Run this yourself:\n${claudeEntry(l)}`);
  assert.deepEqual(readdirSync(l.user), []);
});

test("bao agent without a known command or agent prints usage", (t) => {
  const l = lab(t, "bao-agent-usage-");
  for (const args of [[], ["config"], ["config", "cursor"], ["list"], ["config", "codex", "--app"], ["config", "codex", "--home", "/srv/lib"], ["config", "codex", "--force"]]) {
    const result = run(l, args);
    assert.equal(result.status, 1, args.join(" "));
    assert.match(result.stderr, /usage: bao agent config claude\|codex \[--write\]/);
  }
  assert.deepEqual(readdirSync(l.user), []);
});
