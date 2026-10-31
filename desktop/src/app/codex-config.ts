// Codex reads its MCP servers from ~/.codex/config.toml. `codex mcp add` cannot set a tool
// timeout or an approval mode, so bao writes its own [mcp_servers.bao] table. bao owns command, args, env,
// tool_timeout_sec, and default_tools_approval_mode in that table, and an
// [mcp_servers.bao.env] sub-table. The edit replaces those, or appends the table, and leaves
// every other line as it was, including the user's own keys in the table and the tool
// approvals Codex saves in [mcp_servers.bao.tools.*].
// A bao entry in any other TOML form is refused, not rewritten.

/**
 * Codex gives up on a tool call after 60 s unless tool_timeout_sec says otherwise. A live call
 * on the daily Chrome waits for the Allow press, 8 to 50 s (docs/permissions.md), and a live
 * replay presses Allow on its own connection before its steps run.
 */
export const CODEX_TOOL_TIMEOUT_SEC = 180;

export class CodexConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexConfigError";
  }
}

/**
 * Codex asks before each call to a server's tools unless default_tools_approval_mode says
 * otherwise, and `codex exec` with approval_policy never refuses every call it would ask about.
 * "approve" covers bao's server only. A per-tool approval_mode in [mcp_servers.bao.tools.*]
 * still wins, and bao's own refusals, such as a checkout click, still apply.
 */
export const CODEX_APPROVAL_MODE = "approve";

const OWNED = new Set(["command", "args", "env", "tool_timeout_sec", "default_tools_approval_mode"]);

function ownedLines(command: string): string {
  return [
    `command = ${tomlString(command)}`,
    `tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    `default_tools_approval_mode = ${tomlString(CODEX_APPROVAL_MODE)}`,
    "",
  ].join("\n");
}

export function codexServerBlock(command: string): string {
  return `[mcp_servers.bao]\n${ownedLines(command)}`;
}

export function tomlString(value: string): string {
  let out = "\"";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\"") out += "\\\"";
    else if (ch === "\\") out += "\\\\";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

interface Edit {
  start: number;
  end: number;
  insert: string;
  /** A removed table. The blank lines on both sides of it become one. */
  table: boolean;
}

/** config.toml text whose [mcp_servers.bao] runs command, with every key and sub-table bao does not own kept. */
export function upsertCodexServer(text: string, command: string): string {
  const items = scan(text);
  const lines = ownedLines(command);
  const edits: Edit[] = [];
  let table: Item | undefined;
  let main: Item | undefined;
  let written = false;
  for (const [index, item] of items.entries()) {
    if (item.kind === "table") {
      table = item;
      if (!isBao(item.key)) continue;
      if (item.key.length === 2) {
        if (main) throw new CodexConfigError(`line ${lineOf(text, item.start)} defines [mcp_servers.bao] a second time`);
        main = item;
      } else if (item.key[2] === "env") {
        const next = items.slice(index + 1).find((later) => later.kind === "table");
        edits.push({ start: item.start, end: contentEnd(text, item.start, next ? next.start : text.length), insert: "", table: true });
      }
      continue;
    }
    if (main && table === main && OWNED.has(item.key[0] as string)) {
      edits.push({ start: item.start, end: item.end, insert: written ? "" : lines, table: false });
      written = true;
      continue;
    }
    const key = table ? table.key : [];
    if (isBao(key)) continue;
    const full = [...key, ...item.key];
    if (isBao(full) || (full.length === 1 && full[0] === "mcp_servers")) {
      throw new CodexConfigError(`line ${lineOf(text, item.start)} sets ${full.join(".")} outside a [mcp_servers.bao] table`);
    }
  }
  if (main && !written) {
    edits.push({ start: main.end, end: main.end, insert: text[main.end - 1] === "\n" ? lines : `\n${lines}`, table: false });
  }
  const out = apply(text, edits);
  if (main) return out;
  const gap = out === "" || out.endsWith("\n\n") ? "" : out.endsWith("\n") ? "\n" : "\n\n";
  return `${out}${gap}${codexServerBlock(command)}`;
}

function apply(text: string, edits: Edit[]): string {
  let out = "";
  let at = 0;
  for (const edit of [...edits].sort((a, b) => a.start - b.start || a.end - b.end)) {
    out += text.slice(at, edit.start) + edit.insert;
    at = edit.end;
    if (!edit.table) continue;
    const rest = text.slice(at);
    if (!rest.trim()) {
      out = out.replace(/\n+$/, "\n");
      at = text.length;
    } else if (out === "" || out.endsWith("\n\n")) {
      at += rest.length - rest.replace(/^\n+/, "").length;
    }
  }
  return out + text.slice(at);
}

function isBao(key: readonly string[]): boolean {
  return key.length >= 2 && key[0] === "mcp_servers" && key[1] === "bao";
}

interface Item {
  kind: "table" | "key";
  /** Offset of the line the header or key starts on. */
  start: number;
  /** Offset just past the header line, or past the last line of the key's value. */
  end: number;
  key: string[];
}

/** Table headers and top-level keys in order. Strings, comments, and multi-line arrays are skipped. */
function scan(text: string): Item[] {
  const items: Item[] = [];
  let i = 0;
  let depth = 0;
  let lineStart = 0;
  let fresh = true;
  let value: Item | undefined;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "\n") {
      i += 1;
      lineStart = i;
      fresh = true;
      if (value && depth === 0) {
        value.end = i;
        value = undefined;
      }
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }
    if (ch === "#") {
      i = lineEnd(text, i);
      continue;
    }
    if (fresh && depth === 0) {
      fresh = false;
      const end = lineEnd(text, i);
      const line = text.slice(i, end);
      if (ch === "[") {
        const key = headerKey(line);
        if (!key) throw new CodexConfigError(`line ${lineOf(text, i)} is not a table header bao can read`);
        items.push({ kind: "table", start: lineStart, end: Math.min(end + 1, text.length), key });
        i = end;
        continue;
      }
      const eq = keyLength(line);
      const key = eq > 0 ? parseKey(line.slice(0, eq)) : undefined;
      if (!key) throw new CodexConfigError(`line ${lineOf(text, i)} is not a key bao can read`);
      value = { kind: "key", start: lineStart, end: text.length, key };
      items.push(value);
      i += eq + 1;
      continue;
    }
    fresh = false;
    if (ch === "\"" || ch === "'") {
      i = stringEnd(text, i);
      continue;
    }
    if (ch === "[" || ch === "{") depth += 1;
    else if ((ch === "]" || ch === "}") && depth > 0) depth -= 1;
    i += 1;
  }
  return items;
}

function lineEnd(text: string, from: number): number {
  const nl = text.indexOf("\n", from);
  return nl < 0 ? text.length : nl;
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** The end of a table's last line that is not blank or a comment, so the next table keeps its leading comments. */
function contentEnd(text: string, start: number, end: number): number {
  const headerEnd = Math.min(lineEnd(text, start) + 1, end);
  let cut = end;
  while (cut > headerEnd) {
    const from = text.lastIndexOf("\n", cut - 2) + 1;
    const line = text.slice(Math.max(from, headerEnd), cut).trim();
    if (line && !line.startsWith("#")) break;
    cut = Math.max(from, headerEnd);
  }
  return cut;
}

function stringEnd(text: string, at: number): number {
  const fail = (): never => {
    throw new CodexConfigError(`line ${lineOf(text, at)} has a string that does not end`);
  };
  if (text.startsWith("\"\"\"", at)) {
    let j = at + 3;
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text.startsWith("\"\"\"", j)) {
        j += 3;
        while (text[j] === "\"") j += 1;
        return j;
      }
      j += 1;
    }
    return fail();
  }
  if (text.startsWith("'''", at)) {
    const close = text.indexOf("'''", at + 3);
    if (close < 0) return fail();
    let j = close + 3;
    while (text[j] === "'") j += 1;
    return j;
  }
  const quote = text[at];
  let j = at + 1;
  while (j < text.length && text[j] !== "\n") {
    if (quote === "\"" && text[j] === "\\") {
      j += 2;
      continue;
    }
    if (text[j] === quote) return j + 1;
    j += 1;
  }
  return fail();
}

/** Length of the key before "=", outside quotes. -1 when the line has no "=". */
function keyLength(line: string): number {
  let quote = "";
  for (let j = 0; j < line.length; j++) {
    const c = line[j];
    if (quote) {
      if (quote === "\"" && c === "\\") j += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "=") return j;
  }
  return -1;
}

function headerKey(line: string): string[] | undefined {
  const array = line.startsWith("[[");
  const open = array ? 2 : 1;
  let quote = "";
  let j = open;
  for (; j < line.length; j++) {
    const c = line[j];
    if (quote) {
      if (quote === "\"" && c === "\\") j += 1;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "\"" || c === "'") quote = c;
    else if (c === "]") break;
  }
  if (j >= line.length || (array && line[j + 1] !== "]")) return undefined;
  const rest = line.slice(j + open).trim();
  if (rest && !rest.startsWith("#")) return undefined;
  return parseKey(line.slice(open, j));
}

/** A dotted key of bare, "basic", and 'literal' parts. */
function parseKey(text: string): string[] | undefined {
  const parts: string[] = [];
  let i = 0;
  const blank = (): void => {
    while (text[i] === " " || text[i] === "\t") i += 1;
  };
  for (;;) {
    blank();
    const c = text[i];
    if (c === "\"") {
      let j = i + 1;
      while (j < text.length && text[j] !== "\"") j += text[j] === "\\" ? 2 : 1;
      if (j >= text.length) return undefined;
      try {
        parts.push(JSON.parse(text.slice(i, j + 1)) as string);
      } catch {
        return undefined;
      }
      i = j + 1;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return undefined;
      parts.push(text.slice(i + 1, close));
      i = close + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(text.slice(i))?.[0];
      if (!bare) return undefined;
      parts.push(bare);
      i += bare.length;
    }
    blank();
    if (i >= text.length) return parts;
    if (text[i] !== ".") return undefined;
    i += 1;
  }
}
