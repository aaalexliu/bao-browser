// Type sketch for a Claude computer-use adapter. Not wired and not called.
// The current published tool is computer_toolset_20260801: each member is its
// own tool_use, with toolset_name "computer" and no action field.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
// An older computer_20251124 tool used one computer tool with an action field.
// Either one would be another VendorAdapter file. It would unpack into NeutralAction
// and hand the executor the same click the OpenAI adapter does.

import type { NeutralAction, VendorAdapter } from "./neutral";

export type ClaudeComputerMember =
  | "screenshot"
  | "zoom"
  | "left_click"
  | "right_click"
  | "middle_click"
  | "double_click"
  | "triple_click"
  | "left_click_drag"
  | "mouse_move"
  | "left_mouse_down"
  | "left_mouse_up"
  | "cursor_position"
  | "scroll"
  | "type"
  | "key"
  | "hold_key"
  | "wait";

export interface ClaudeToolUse {
  type: "tool_use";
  id: string;
  name: ClaudeComputerMember;
  toolset_name: "computer";
  input: {
    coordinate?: [number, number];
    start_coordinate?: [number, number];
    text?: string;
    region?: [number, number, number, number];
  };
}

export interface ClaudeToolResult {
  type: "tool_result";
  tool_use_id: string;
  toolset_name: "computer";
  content?: string;
  is_error?: boolean;
}

export type ClaudeAdapter = VendorAdapter<ClaudeToolUse, ClaudeToolResult>;

/** How a left_click would cross the boundary. Coordinate tuple becomes x,y. */
export function sketchClaudeLeftClick(input: ClaudeToolUse["input"]): NeutralAction {
  const coordinate = input.coordinate;
  if (!coordinate) return { op: "unsupported", vendor: "claude", type: "left_click" };
  return { op: "click", x: coordinate[0], y: coordinate[1], button: "left" };
}
