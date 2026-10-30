// Claude Code asks before each MCP tool call unless an allow rule in its settings names the
// tool. `claude mcp add` sets no rule, so bao adds one rule, "mcp__bao", to permissions.allow
// in the user settings. That rule covers every tool of the server named bao and nothing else.
// The edit keeps every other key and rule in order. It leaves deny and ask rules alone, so a
// user's own deny or ask rule for a bao tool still wins.

/** The Claude Code permission rule that matches every tool of the MCP server named bao. */
export const CLAUDE_BAO_RULE = "mcp__bao";

export class ClaudeSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeSettingsError";
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** settings.json text whose permissions.allow has CLAUDE_BAO_RULE. Text that has it already comes back unchanged. */
export function allowBaoTools(text: string): string {
  if (!text.trim()) return `${JSON.stringify({ permissions: { allow: [CLAUDE_BAO_RULE] } }, null, 2)}\n`;
  let settings: Json;
  try {
    settings = JSON.parse(text) as Json;
  } catch (err) {
    throw new ClaudeSettingsError(`is not JSON bao can read (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isObject(settings)) throw new ClaudeSettingsError("is not a JSON object");
  const permissions = settings.permissions ?? {};
  if (!isObject(permissions)) throw new ClaudeSettingsError("has a permissions value that is not an object");
  const allow = permissions.allow ?? [];
  if (!Array.isArray(allow)) throw new ClaudeSettingsError("has a permissions.allow value that is not a list");
  if (allow.includes(CLAUDE_BAO_RULE)) return text;
  permissions.allow = [...allow, CLAUDE_BAO_RULE];
  settings.permissions = permissions;
  const indent = /^([ \t]+)"/m.exec(text)?.[1] ?? "  ";
  return `${JSON.stringify(settings, null, indent)}\n`;
}
