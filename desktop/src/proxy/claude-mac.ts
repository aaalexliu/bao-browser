// Thin Claude computer-use handler for the macOS spike.
// screenshot, left_click, and type only. The published toolset sketch stays
// in claude.ts. This file does not call the Anthropic API.

import type { AuditOrigin } from "./audit";
import type { ClaudeToolResult, ClaudeToolUse } from "./claude";
import type { Executor } from "./neutral";

const SOURCE = { agent: "scripted-driver", vendor: "claude", adapter: "claude-mac" };

function origin(raw: unknown): AuditOrigin {
  return { source: SOURCE, raw };
}

export async function handleClaudeTool(call: ClaudeToolUse, executor: Executor): Promise<ClaudeToolResult> {
  if (call.name === "screenshot") {
    const seen = await executor.observe(origin(call));
    return result(call, `screenshot ${seen.png.length}`, false);
  }
  if (call.name === "left_click") {
    const coordinate = call.input.coordinate;
    if (!coordinate) return result(call, "left_click needs a coordinate", true);
    const acted = await executor.act(
      { op: "click", x: coordinate[0], y: coordinate[1], button: "left" },
      origin(call),
    );
    return result(call, acted.unresolved ? (acted.reason ?? "unresolved") : "pressed", acted.unresolved);
  }
  if (call.name === "type") {
    if (typeof call.input.text !== "string") return result(call, "type needs text", true);
    const acted = await executor.act({ op: "type", text: call.input.text }, origin(call));
    return result(call, acted.unresolved ? (acted.reason ?? "unresolved") : "typed", acted.unresolved);
  }
  const acted = await executor.act({ op: "unsupported", vendor: "claude", type: call.name }, origin(call));
  return result(call, acted.reason ?? `${call.name} is not performed on the macOS plane`, true);
}

function result(call: ClaudeToolUse, content: string, isError: boolean): ClaudeToolResult {
  return {
    type: "tool_result",
    tool_use_id: call.id,
    toolset_name: "computer",
    content,
    is_error: isError || undefined,
  };
}
