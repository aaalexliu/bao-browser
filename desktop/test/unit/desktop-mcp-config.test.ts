import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import fs = require("node:fs");
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import { DesktopMcpInstaller, desktopMcpFile, editChatgpt, editClaude, type DesktopMcpClient } from "../../src/app/desktop-mcp-config";

const launcher = "/Applications/Bao.app/Contents/MacOS/bao-mcp";

function fixture() {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), "bao-desktop-install-")));
  return { home, installer: new DesktopMcpInstaller(home, process.execPath), close: () => rmSync(home, { recursive: true, force: true }) };
}

function plant(home: string, client: DesktopMcpClient, text: string, mode = 0o640): string {
  const file = desktopMcpFile(home, client);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, { mode });
  chmodSync(file, mode);
  return file;
}

test("Claude updates only owned values, keeping every other byte and JSON key", () => {
  const before = '{\r\n\t"mcpServers" : {"other": {"command":"keep"}, "bao" : {"command" : "old", "args" : ["old"], "env":{"KEEP":"same"}}},\r\n\t"preferences" : { "theme" : "dark" }\r\n}\r\n';
  const result = editClaude(before, launcher);
  assert.equal(result.existing, true);
  assert.equal(result.text, before.replace('"old"', JSON.stringify(launcher)).replace('["old"]', '[]').replace(', "env":{"KEEP":"same"}', ''));
  assert.equal(editClaude(result.text, launcher).text, result.text);
  for (const text of ['', '{}', '{"mcpServers":{}}', '{"mcpServers":{"other":{"command":"keep"}}}']) {
    const out = JSON.parse(editClaude(text, launcher).text) as { mcpServers: { bao: { command: string; args: unknown[] } } };
    assert.deepEqual(out.mcpServers.bao, { command: launcher, args: [] });
  }
});

test("Claude rejects malformed, duplicate, non-object and remote entries without guessing", () => {
  for (const text of ['{', '[]', '{"a":1,"a":2}', '{"mcpServers":null}', '{"mcpServers":{"bao":1}}', '{"mcpServers":{"bao":{"url":"https://example.test"}}}', '{/*comment*/}', '{"a":1,}']) {
    assert.throws(() => editClaude(text, launcher));
  }
});

test("ChatGPT keeps comments, other servers, explicit tool rules, CRLF and unknown Bao settings", () => {
  const before = '# keep this\r\nmodel = "keep"\r\n[mcp_servers."bao"] # header\r\ncommand = "old" # preserve comment\r\nargs = [\r\n  "old"\r\n]\r\ndefault_tools_approval_mode = "approve"\r\ntool_timeout_sec = 180\r\n[mcp_servers.bao.tools.search]\r\napproval_mode = "prompt"\r\n# next server\r\n[mcp_servers.other]\r\ncommand = "keep"\r\n';
  const out = editChatgpt(before, launcher);
  assert.equal(out.text, before.replace('"old"', JSON.stringify(launcher)).replace('[\r\n  "old"\r\n]', '[]'));
  assert.match(out.text, /default_tools_approval_mode = "approve"/);
  assert.match(out.text, /approval_mode = "prompt"/);
  assert.equal(editChatgpt(out.text, launcher).text, out.text);
  assert.equal(out.existing, true);
});

test("ChatGPT pre-approves Bao tools when the entry still says prompt, and keeps a per-tool rule", () => {
  const before = '[mcp_servers.bao]\ncommand = "old"\ndefault_tools_approval_mode = "prompt"\n[mcp_servers.bao.tools.search]\napproval_mode = "prompt"\n';
  const out = editChatgpt(before, launcher);
  assert.match(out.text, /default_tools_approval_mode = "approve"/);
  assert.doesNotMatch(out.text, /default_tools_approval_mode = "prompt"/);
  assert.match(out.text, /\[mcp_servers\.bao\.tools\.search\]\napproval_mode = "prompt"/);
  assert.equal(editChatgpt(out.text, launcher).text, out.text);
});

test("ChatGPT edits inline, dotted, quoted and implicit tables without duplicate servers", () => {
  const inputs = [
    '',
    '# config\nmodel="keep"\n',
    '[mcp_servers]\nother={command="keep"}\n',
    'mcp_servers = { other={command="keep"}, bao={command="old", args=["old"]} }\n',
    'mcp_servers = { other={command="keep"} }\n',
    'mcp_servers.bao.command = "old" # keep\n[mcp_servers.other]\ncommand="keep"\n',
    '[mcp_servers.bao.env]\nKEEP="same"\n',
    '[mcp_servers.bao]\n# empty bao\n[mcp_servers.other]\ncommand="keep"',
    '[mcp_servers.bao]\ncommand="old"',
    '"mcp_servers"."bao" = { command="old" }',
    'mcp_servers.bao.command = """old\n[mcp_servers.fake]\n"""\n',
    'mcp_servers = { bao={env={BAO_HOME="/old"}, command="old"}, other={command="keep"} }',
    'mcp_servers = { bao={command="old", env={BAO_HOME="/old"}} }',
    'mcp_servers.bao.env.BAO_HOME="/old"\n',
    '[mcp_servers.bao.env.nested]\nOLD="value"\n[mcp_servers.other]\ncommand="keep"',
  ];
  for (const before of inputs) {
    const out = editChatgpt(before, launcher).text;
    const parsed = getStaticTOMLValue(parseTOML(out, { tomlVersion: "1.0" })) as { mcp_servers: { bao: { command: string; args: unknown[]; default_tools_approval_mode: string; tool_timeout_sec: number; env?: unknown } } };
    assert.equal(parsed.mcp_servers.bao.command, launcher, before);
    assert.deepEqual(parsed.mcp_servers.bao.args, [], before);
    assert.equal(parsed.mcp_servers.bao.default_tools_approval_mode, "approve", before);
    assert.equal(parsed.mcp_servers.bao.tool_timeout_sec, 180, before);
    assert.equal(parsed.mcp_servers.bao.env, undefined, before);
    assert.equal(editChatgpt(out, launcher).text, out, before);
    if (before.includes('other={command="keep"}')) assert.ok(out.includes('other={command="keep"}'));
  }
});

test("ChatGPT rejects malformed TOML, duplicate entries and incompatible types", () => {
  for (const text of ['x = [', '[mcp_servers.bao]\ncommand="a"\ncommand="b"', 'mcp_servers=1', 'mcp_servers.bao=1', '[[mcp_servers.bao]]\ncommand="a"', '[mcp_servers.bao]\nurl="https://example.test"']) {
    assert.throws(() => editChatgpt(text, launcher), text);
  }
});

for (const client of ["claude", "chatgpt"] as const) {
  test(`${client} refuses missing, directory and non-executable launchers without writing`, () => {
    const f = fixture();
    try {
      const unavailable = path.join(f.home, "launcher");
      for (const state of ["missing", "directory", "file"] as const) {
        if (state === "directory") mkdirSync(unavailable);
        if (state === "file") { rmSync(unavailable, { recursive: true }); writeFileSync(unavailable, "not executable", { mode: 0o600 }); }
        const installer = new DesktopMcpInstaller(f.home, unavailable);
        assert.throws(() => installer.preview(client), /Install Bao.app/);
        assert.equal(existsSync(desktopMcpFile(f.home, client)), false);
      }
    } finally { f.close(); }
  });

  test(`${client} removes its backup when replacement fails`, (t) => {
    const f = fixture();
    try {
      const before = client === "claude" ? "{}" : "# keep\n";
      const file = plant(f.home, client, before);
      const preview = f.installer.preview(client);
      t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
      assert.throws(() => f.installer.confirm(preview.token!), /Nothing was written/);
      assert.equal(readFileSync(file, "utf8"), before);
      assert.deepEqual(readdirSync(path.dirname(file)), [path.basename(file)]);
    } finally { t.mock.restoreAll(); f.close(); }
  });
  test(`${client} previews without writes, backs up exact bytes, preserves mode and applies once`, () => {
    const f = fixture();
    try {
      const before = client === "claude" ? '{"preferences":{"keep":true}}\n' : '# keep\nmodel="keep"\n';
      const file = plant(f.home, client, before);
      const preview = f.installer.preview(client);
      assert.equal(readFileSync(file, "utf8"), before);
      assert.deepEqual(readdirSync(path.dirname(file)), [path.basename(file)]);
      assert.equal(preview.action, "add");
      assert.match(preview.diff, /Before/);
      assert.match(preview.diff, /After/);
      assert.ok(preview.token);
      assert.ok(preview.backup?.startsWith(file + '.bao-backup-'));
      const result = f.installer.confirm(preview.token);
      assert.equal(result.backup, preview.backup);
      assert.equal(readFileSync(result.backup!, "utf8"), before);
      assert.equal(statSync(file).mode & 0o777, 0o640);
      assert.equal(statSync(result.backup!).mode & 0o777, 0o640);
      assert.ok(readFileSync(file, "utf8").includes(process.execPath));
      assert.throws(() => f.installer.confirm(preview.token!), /expired|already used/);
      const noop = f.installer.preview(client);
      assert.equal(noop.action, "unchanged");
      assert.equal(noop.token, null);
      assert.equal(noop.backup, null);
      assert.equal(noop.diff, "");
      assert.equal(readdirSync(path.dirname(file)).length, 2);
    } finally { f.close(); }
  });

  test(`${client} creates missing config privately only after confirm`, () => {
    const f = fixture();
    try {
      const file = desktopMcpFile(f.home, client);
      const preview = f.installer.preview(client);
      assert.equal(existsSync(path.dirname(file)), false);
      assert.equal(preview.backup, null);
      f.installer.confirm(preview.token!);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      assert.equal(readdirSync(path.dirname(file)).length, 1);
    } finally { f.close(); }
  });

  test(`${client} refuses stale content, file mode, replacement identity and newly created files`, () => {
    for (const change of ['content', 'mode', 'identity', 'created'] as const) {
      const f = fixture();
      try {
        const before = client === "claude" ? '{}' : '# config\n';
        const file = change === 'created' ? desktopMcpFile(f.home, client) : plant(f.home, client, before);
        const preview = f.installer.preview(client);
        if (change === 'mode') chmodSync(file, 0o600);
        else if (change === 'identity') { rmSync(file); plant(f.home, client, before); }
        else plant(f.home, client, change === 'created' ? before : before + ' ');
        const current = readFileSync(file, "utf8");
        assert.throws(() => f.installer.confirm(preview.token!), /changed since this preview/);
        assert.equal(readFileSync(file, "utf8"), current);
        assert.equal(readdirSync(path.dirname(file)).length, 1);
      } finally { f.close(); }
    }
  });

  test(`${client} expires previews and refuses backup collisions without replacing the config`, () => {
    const f = fixture();
    const now = Date.now;
    try {
      const before = client === 'claude' ? '{}' : '# keep\n';
      const file = plant(f.home, client, before);
      const expired = f.installer.preview(client);
      Date.now = () => now() + 11 * 60_000;
      assert.throws(() => f.installer.confirm(expired.token!), /expired/);
      Date.now = now;
      assert.equal(readFileSync(file, 'utf8'), before);
      const collision = f.installer.preview(client);
      writeFileSync(collision.backup!, 'keep the existing backup');
      assert.throws(() => f.installer.confirm(collision.token!), /Cannot install Bao/);
      assert.equal(readFileSync(file, 'utf8'), before);
      assert.equal(readFileSync(collision.backup!, 'utf8'), 'keep the existing backup');
      assert.equal(readdirSync(path.dirname(file)).some((name) => name.endsWith('.tmp')), false);
    } finally { Date.now = now; f.close(); }
  });

  test(`${client} refuses hard links, oversized files and linked parent directories`, () => {
    const f = fixture();
    try {
      const before = client === 'claude' ? '{}' : '# keep';
      const file = plant(f.home, client, before);
      const linked = path.join(f.home, 'linked-config');
      linkSync(file, linked);
      assert.throws(() => f.installer.preview(client), /hard links/);
      assert.equal(readFileSync(file, 'utf8'), before);
      rmSync(linked);
      writeFileSync(file, Buffer.alloc(2 * 1024 * 1024 + 1, 0x20));
      assert.throws(() => f.installer.preview(client), /2 MiB/);
      assert.equal(statSync(file).size, 2 * 1024 * 1024 + 1);
      assert.deepEqual(readdirSync(path.dirname(file)), [path.basename(file)]);
      rmSync(path.dirname(file), { recursive: true });
      const target = path.join(f.home, 'real-config-directory');
      mkdirSync(target);
      writeFileSync(path.join(target, path.basename(file)), before);
      symlinkSync(target, path.dirname(file));
      assert.throws(() => f.installer.preview(client), /symbolic link/);
      assert.equal(readFileSync(file, 'utf8'), before);
      assert.deepEqual(readdirSync(target), [path.basename(file)]);
    } finally { f.close(); }
  });

  test(`${client} refuses symbolic links and malformed bytes without backup or replacement`, () => {
    const f = fixture();
    try {
      const file = plant(f.home, client, client === 'claude' ? '{}' : '# keep');
      const other = path.join(f.home, 'outside-config');
      writeFileSync(other, 'keep');
      const preview = f.installer.preview(client);
      rmSync(file);
      symlinkSync(other, file);
      assert.throws(() => f.installer.confirm(preview.token!), /symbolic link/);
      assert.equal(readFileSync(other, 'utf8'), 'keep');
      assert.throws(() => f.installer.preview(client), /symbolic link/);
      rmSync(file);
      writeFileSync(file, Buffer.from([0xff]));
      assert.throws(() => f.installer.preview(client), /preview/);
      assert.deepEqual(readFileSync(file), Buffer.from([0xff]));
      assert.equal(readdirSync(path.dirname(file)).length, 1);
    } finally { f.close(); }
  });
}
