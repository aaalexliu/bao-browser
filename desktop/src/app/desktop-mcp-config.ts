import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import { findNodeAtLocation, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { parseTOML, getStaticTOMLValue, type AST } from "toml-eslint-parser";

export type DesktopMcpClient = "claude" | "chatgpt";

export interface DesktopMcpPreview {
  client: DesktopMcpClient;
  file: string;
  action: "add" | "update" | "unchanged";
  diff: string;
  backup: string | null;
  token: string | null;
}

interface FileSnapshot {
  text: string;
  mode: number;
  identity: string;
}

interface InstallPlan {
  preview: DesktopMcpPreview;
  before: FileSnapshot;
  after: string;
  expires: number;
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

const RECOVER = "Nothing was written. Fix the file or its permissions, then preview again.";

export function desktopMcpFile(home: string, client: DesktopMcpClient): string {
  return client === "claude"
    ? path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : path.join(home, ".codex", "config.toml");
}

export class DesktopMcpInstaller {
  private readonly plans = new Map<string, InstallPlan>();

  private readonly home: string;

  constructor(home: string, private readonly launcher: string) {
    this.home = realpathSync(home);
  }

  preview(client: DesktopMcpClient): DesktopMcpPreview {
    const file = desktopMcpFile(this.home, client);
    try {
      const before = snapshot(file);
      const edited = client === "claude" ? editClaude(before.text, this.launcher) : editChatgpt(before.text, this.launcher);
      const changed = before.text !== edited.text;
      const token = changed ? randomUUID() : null;
      const backup = changed && before.identity ? `${file}.bao-backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}` : null;
      const preview: DesktopMcpPreview = {
        client, file, action: changed ? edited.existing ? "update" : "add" : "unchanged",
        diff: changed ? createTwoFilesPatch(path.basename(file), path.basename(file), before.text, edited.text, "Before", "After", { context: 3 }) : "",
        backup, token,
      };
      for (const [id, plan] of this.plans) if (plan.expires < Date.now()) this.plans.delete(id);
      if (this.plans.size >= 16) this.plans.delete(this.plans.keys().next().value!);
      if (token) this.plans.set(token, { preview, before, after: edited.text, expires: Date.now() + 10 * 60_000 });
      return preview;
    } catch (err) {
      throw new Error(`Cannot preview ${file}. ${detail(err)} ${RECOVER}`);
    }
  }

  confirm(token: string): { file: string; backup: string | null; client: DesktopMcpClient } {
    const plan = this.plans.get(token);
    this.plans.delete(token);
    if (!plan || plan.expires < Date.now()) throw new Error("This preview expired or was already used. Preview the change again.");
    const { file, backup, client } = plan.preview;
    let temp = "";
    try {
      assertCurrent(file, plan.before);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      temp = `${file}.bao-${randomUUID()}.tmp`;
      writeDurable(temp, plan.after, plan.before.mode);
      assertCurrent(file, plan.before);
      if (backup) writeDurable(backup, plan.before.text, plan.before.mode);
      assertCurrent(file, plan.before);
      renameSync(temp, file);
      temp = "";
      return { file, backup, client };
    } catch (err) {
      throw new Error(`Cannot install Bao. ${detail(err)} ${RECOVER}`);
    } finally {
      if (temp) rmSync(temp, { force: true });
    }
  }
}

function detail(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function assertNoLinks(file: string): void {
  for (let part = file; ; part = path.dirname(part)) {
    try {
      if (lstatSync(part).isSymbolicLink()) throw new Error("This path contains a symbolic link. Edit the config manually instead.");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (path.dirname(part) === part) break;
  }
}

function snapshot(file: string): FileSnapshot {
  assertNoLinks(file);
  try {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("The config must be a regular file with no hard links.");
    if (stat.size > 2 * 1024 * 1024) throw new Error("The config exceeds the 2 MiB preview limit. Edit it manually instead.");
    const bytes = readFileSync(file);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text, mode: stat.mode & 0o7777, identity: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}` };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { text: "", mode: 0o600, identity: "" };
    throw err;
  }
}

function assertCurrent(file: string, before: FileSnapshot): void {
  const current = snapshot(file);
  if (current.text !== before.text || current.mode !== before.mode || current.identity !== before.identity) {
    throw new Error("The config changed since this preview. Preview again to see the new diff.");
  }
}

function writeDurable(file: string, text: string, mode: number): void {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    fchmodSync(fd, mode);
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function applyEdits(text: string, edits: TextEdit[]): string {
  for (const edit of edits.sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

function jsonObject(text: string): JsonNode {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (!tree || tree.type !== "object" || errors.length) throw new Error("The config must contain a valid JSON object.");
  const check = (node: JsonNode): void => {
    if (node.type === "object") {
      const keys = new Set<string>();
      for (const prop of node.children || []) {
        const key = String(prop.children?.[0]?.value);
        if (keys.has(key)) throw new Error("The config has duplicate JSON keys. Remove the duplicates first.");
        keys.add(key);
      }
    }
    for (const child of node.children || []) check(child);
  };
  check(tree);
  return tree;
}

function setJson(text: string, keys: string[], value: unknown): string {
  const tree = jsonObject(text);
  const found = findNodeAtLocation(tree, keys);
  const replacement = JSON.stringify(value);
  if (found) {
    if (JSON.stringify(JSON.parse(text.slice(found.offset, found.offset + found.length))) === replacement) return text;
    return applyEdits(text, [{ start: found.offset, end: found.offset + found.length, text: replacement }]);
  }
  const parentKeys = keys.slice(0, -1);
  const parent = findNodeAtLocation(tree, parentKeys);
  if (!parent) return setJson(text, parentKeys, { [keys[keys.length - 1]!]: value });
  if (parent.type !== "object") throw new Error(`${parentKeys.join(".")} must be an object.`);
  const last = parent.children?.at(-1);
  const at = last ? last.offset + last.length : parent.offset + 1;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /(?:\r?\n)([\t ]+)"/.exec(text)?.[1] || "  ";
  const padding = indent.repeat(keys.length);
  const inserted = JSON.stringify(value, null, indent).replace(/\n/g, eol + padding);
  return applyEdits(text, [{ start: at, end: at, text: `${last ? "," : ""}${eol}${padding}${JSON.stringify(keys.at(-1))}: ${inserted}` }]);
}

export function editClaude(input: string, launcher: string): { text: string; existing: boolean } {
  let text = input || "{\n}\n";
  const tree = jsonObject(text);
  const servers = findNodeAtLocation(tree, ["mcpServers"]);
  if (servers && servers.type !== "object") throw new Error("mcpServers must be an object.");
  const bao = findNodeAtLocation(tree, ["mcpServers", "bao"]);
  if (bao && bao.type !== "object") throw new Error("mcpServers.bao must be an object.");
  if (bao && findNodeAtLocation(bao, ["url"])) throw new Error("The existing Bao entry uses a URL. Convert it to a local stdio entry manually first.");
  text = setJson(text, ["mcpServers", "bao", "command"], launcher);
  text = setJson(text, ["mcpServers", "bao", "args"], []);
  jsonObject(text);
  return { text, existing: !!bao };
}

function keyParts(key: AST.TOMLKey): string[] {
  return key.keys.map((part) => part.type === "TOMLBare" ? part.name : part.value);
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function editChatgpt(text: string, launcher: string): { text: string; existing: boolean } {
  const ast = parseTOML(text, { tomlVersion: "1.0" });
  const data = getStaticTOMLValue(ast);
  if (!object(data) || (data.mcp_servers !== undefined && !object(data.mcp_servers))) throw new Error("mcp_servers must be a TOML table.");
  const bao = object(data.mcp_servers) ? data.mcp_servers.bao : undefined;
  if (bao !== undefined && !object(bao)) throw new Error("mcp_servers.bao must be a TOML table.");
  if (object(bao) && "url" in bao) throw new Error("The existing Bao entry uses a URL. Convert it to a local stdio entry manually first.");
  const values = new Map<string, AST.TOMLKeyValue>();
  const containers = new Map<string, AST.TOMLInlineTable | AST.TOMLTable>();
  const pathKey = (keys: string[]): string => JSON.stringify(keys);
  const collect = (items: AST.TOMLKeyValue[], prefix: string[]): void => {
    for (const item of items) {
      const keys = [...prefix, ...keyParts(item.key)];
      values.set(pathKey(keys), item);
      if (item.value.type === "TOMLInlineTable") {
        containers.set(pathKey(keys), item.value);
        collect(item.value.body, keys);
      }
    }
  };
  for (const item of ast.body[0].body) {
    if (item.type === "TOMLKeyValue") collect([item], []);
    else {
      if (item.kind === "standard") containers.set(pathKey(item.resolvedKey as string[]), item);
      collect(item.body, item.resolvedKey as string[]);
    }
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (bao === undefined && containers.get(pathKey(["mcp_servers"]))?.type !== "TOMLInlineTable") {
    const gap = !text || text.endsWith(eol + eol) ? "" : text.endsWith(eol) ? eol : eol + eol;
    const block = `[mcp_servers.bao]${eol}command = ${JSON.stringify(launcher)}${eol}args = []${eol}default_tools_approval_mode = "prompt"${eol}`;
    const out = text + gap + block;
    parseTOML(out, { tomlVersion: "1.0" });
    return { text: out, existing: false };
  }
  const edits: TextEdit[] = [];
  const inserts = new Map<string, { container?: AST.TOMLInlineTable | AST.TOMLTable; entries: string[] }>();
  const settings: Record<string, unknown> = { command: launcher, args: [], default_tools_approval_mode: "prompt" };
  for (const [key, value] of Object.entries(settings)) {
    const keys = ["mcp_servers", "bao", key];
    const found = values.get(pathKey(keys));
    if (found) {
      if (JSON.stringify(getStaticTOMLValue(found.value)) !== JSON.stringify(value)) {
        edits.push({ start: found.value.range[0], end: found.value.range[1], text: JSON.stringify(value) });
      }
      continue;
    }
    let prefix = keys.slice(0, -1);
    while (prefix.length && !containers.has(pathKey(prefix))) prefix = prefix.slice(0, -1);
    const id = pathKey(prefix);
    const group = inserts.get(id) || { container: containers.get(id), entries: [] };
    group.entries.push(`${keys.slice(prefix.length).map((part) => JSON.stringify(part)).join(".")} = ${JSON.stringify(value)}`);
    inserts.set(id, group);
  }
  for (const { container, entries } of inserts.values()) {
    if (container?.type === "TOMLInlineTable") {
      const last = container.body.at(-1);
      const at = last ? last.range[1] : container.range[0] + 1;
      edits.push({ start: at, end: at, text: `${last ? ", " : " "}${entries.join(", ")}` });
    } else {
      const firstTable = ast.body[0].body.find((item) => item.type === "TOMLTable");
      const start = container ? container.body.at(-1)?.range[1] ?? container.key.range[1] : firstTable?.range[0] ?? text.length;
      const nextLine = container ? text.indexOf("\n", start) : -1;
      const at = nextLine >= 0 ? nextLine + 1 : start === text.length || !container ? start : text.length;
      edits.push({ start: at, end: at, text: `${at > 0 && text[at - 1] !== "\n" ? eol : ""}${entries.join(eol)}${eol}` });
    }
  }
  const out = applyEdits(text, edits);
  parseTOML(out, { tomlVersion: "1.0" });
  return { text: out, existing: bao !== undefined };
}
