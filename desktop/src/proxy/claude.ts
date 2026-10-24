// Claude computer use, toolset computer_toolset_20260801.
// https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
// One {"type":"computer_toolset_20260801"} entry yields 17 member tools. Each
// call is a tool_use whose name is the member and whose toolset_name is
// "computer". There is no action field. Coordinates are screenshot pixels.
// This adapter scales them back to viewport pixels before the executor acts,
// and stores the screenshot pixel as provenance.

import { normalizeKey } from "./focus";
import { fitPng, pngSize, scalePng } from "./png";
import type { AuditOrigin } from "./audit";
import type { ActResult, Executor, NeutralAction, Provenance } from "./neutral";

export const CLAUDE_TOOLSET = "computer_toolset_20260801";
export const CLAUDE_TOOLSET_NAME = "computer";

/** The screenshot this spike hands the model is half the viewport on each edge. */
export const CLAUDE_SCREENSHOT_SCALE = { numer: 1, denom: 2 } as const;

export const CLAUDE_MEMBERS = [
  "screenshot",
  "zoom",
  "left_click",
  "right_click",
  "middle_click",
  "double_click",
  "triple_click",
  "left_click_drag",
  "mouse_move",
  "left_mouse_down",
  "left_mouse_up",
  "cursor_position",
  "scroll",
  "type",
  "key",
  "hold_key",
  "wait",
] as const;

export type ClaudeComputerMember = (typeof CLAUDE_MEMBERS)[number];

export interface ClaudeToolUse {
  type: "tool_use";
  id: string;
  name: ClaudeComputerMember;
  toolset_name: "computer";
  input: {
    coordinate?: [number, number];
    start_coordinate?: [number, number];
    region?: [number, number, number, number];
    text?: string;
    scroll_direction?: "up" | "down" | "left" | "right";
    scroll_amount?: number;
    repeat?: number;
    duration?: number;
  };
}

export type ClaudeContent =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/png"; data: string } };

export interface ClaudeToolResult {
  type: "tool_result";
  tool_use_id: string;
  toolset_name: "computer";
  content: ClaudeContent[] | string;
  is_error?: boolean;
}

export interface DisplayFrame {
  image: { w: number; h: number };
  viewport: { w: number; h: number };
}

export interface ClaudeSession {
  frame: DisplayFrame | null;
  /** Last pointer, viewport pixels. */
  cursor: { x: number; y: number };
}

const SOURCE = { agent: "scripted-driver", vendor: "claude", adapter: "claude" };

const MODIFIERS: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  shift: "Shift",
  super: "Meta",
  meta: "Meta",
  cmd: "Meta",
  command: "Meta",
  win: "Meta",
};

export function createClaudeSession(): ClaudeSession {
  return { frame: null, cursor: { x: 0, y: 0 } };
}

export function toViewport(x: number, y: number, frame: DisplayFrame): { x: number; y: number } {
  return {
    x: x * (frame.viewport.w / frame.image.w),
    y: y * (frame.viewport.h / frame.image.h),
  };
}

export function toImage(x: number, y: number, frame: DisplayFrame): { x: number; y: number } {
  return {
    x: x * (frame.image.w / frame.viewport.w),
    y: y * (frame.image.h / frame.viewport.h),
  };
}

/** "Return" → Enter, "ctrl+s" → Control+s, "alt+Tab" → Alt+Tab. */
export function claudeChord(text: string): string {
  return text.split("+").map((part) => {
    const token = part.trim();
    const mod = MODIFIERS[token.toLowerCase()];
    return mod ?? normalizeKey(token);
  }).join("+");
}

function origin(use: ClaudeToolUse): AuditOrigin {
  return { source: SOURCE, raw: { name: use.name, ...use.input } };
}

function frameOf(session: ClaudeSession): DisplayFrame {
  if (!session.frame) throw new Error("coordinate action before a screenshot");
  return session.frame;
}

function imagePoint(
  coordinate: [number, number] | undefined,
  session: ClaudeSession,
): { x: number; y: number; provenance: Provenance } {
  const frame = frameOf(session);
  const image = coordinate
    ? { x: coordinate[0], y: coordinate[1] }
    : toImage(session.cursor.x, session.cursor.y, frame);
  const viewport = toViewport(image.x, image.y, frame);
  return { x: viewport.x, y: viewport.y, provenance: { x: image.x, y: image.y, space: "image" } };
}

function clickModifiers(text: string | undefined): string[] | undefined {
  if (!text) return undefined;
  return text.split("+").map((part) => MODIFIERS[part.trim().toLowerCase()] ?? part.trim());
}

function scrollDelta(direction: string, amount: number): { dx: number; dy: number } {
  const px = amount * 100;
  if (direction === "up") return { dx: 0, dy: -px };
  if (direction === "down") return { dx: 0, dy: px };
  if (direction === "left") return { dx: -px, dy: 0 };
  if (direction === "right") return { dx: px, dy: 0 };
  throw new Error(`scroll direction ${direction}`);
}

/** Map one member onto a neutral action. x,y on the action are viewport pixels. */
export function toNeutral(use: ClaudeToolUse, session: ClaudeSession): NeutralAction {
  const input = use.input ?? {};
  switch (use.name) {
    case "screenshot":
      return { op: "screenshot" };
    case "zoom": {
      const region = input.region;
      if (!region) return { op: "unsupported", vendor: "claude", type: "zoom" };
      const frame = frameOf(session);
      const a = toViewport(region[0], region[1], frame);
      const b = toViewport(region[2], region[3], frame);
      return { op: "zoom", x0: a.x, y0: a.y, x1: b.x, y1: b.y };
    }
    case "left_click":
    case "right_click":
    case "middle_click":
    case "double_click":
    case "triple_click": {
      const point = imagePoint(input.coordinate, session);
      const button = use.name === "right_click" ? "right" : use.name === "middle_click" ? "middle" : "left";
      const count = use.name === "double_click" ? 2 : use.name === "triple_click" ? 3 : 1;
      return {
        op: "click",
        x: point.x,
        y: point.y,
        button,
        count,
        modifiers: clickModifiers(input.text),
        provenance: point.provenance,
      };
    }
    case "left_click_drag": {
      if (!input.start_coordinate || !input.coordinate) {
        return { op: "unsupported", vendor: "claude", type: "left_click_drag" };
      }
      const start = imagePoint(input.start_coordinate, session);
      const end = imagePoint(input.coordinate, session);
      return {
        op: "drag",
        x0: start.x,
        y0: start.y,
        x1: end.x,
        y1: end.y,
        modifiers: clickModifiers(input.text),
        provenance: end.provenance,
      };
    }
    case "mouse_move": {
      const point = imagePoint(input.coordinate, session);
      return { op: "move", x: point.x, y: point.y, provenance: point.provenance };
    }
    case "left_mouse_down":
      return { op: "mousedown" };
    case "left_mouse_up":
      return { op: "mouseup" };
    case "cursor_position":
      return { op: "cursor" };
    case "scroll": {
      if (!input.scroll_direction || input.scroll_amount == null) {
        return { op: "unsupported", vendor: "claude", type: "scroll" };
      }
      const point = imagePoint(input.coordinate, session);
      const delta = scrollDelta(input.scroll_direction, input.scroll_amount);
      return { op: "scroll", x: point.x, y: point.y, ...delta, provenance: point.provenance };
    }
    case "type":
      if (typeof input.text !== "string") return { op: "unsupported", vendor: "claude", type: "type" };
      return { op: "type", text: input.text };
    case "key": {
      if (!input.text) return { op: "unsupported", vendor: "claude", type: "key" };
      const chord = claudeChord(input.text);
      const repeat = input.repeat ?? 1;
      return { op: "keypress", keys: Array.from({ length: repeat }, () => chord) };
    }
    case "hold_key": {
      if (!input.text || input.duration == null) return { op: "unsupported", vendor: "claude", type: "hold_key" };
      return { op: "keypress", keys: [claudeChord(input.text)], holdMs: input.duration * 1000 };
    }
    case "wait":
      if (input.duration == null) return { op: "unsupported", vendor: "claude", type: "wait" };
      return { op: "wait", ms: input.duration * 1000 };
    default:
      return { op: "unsupported", vendor: "claude", type: String((use as { name?: string }).name) };
  }
}

function textResult(id: string, text: string, isError = false): ClaudeToolResult {
  return {
    type: "tool_result",
    tool_use_id: id,
    toolset_name: "computer",
    is_error: isError || undefined,
    content: [{ type: "text", text }],
  };
}

function imageResult(id: string, png: Buffer): ClaudeToolResult {
  return {
    type: "tool_result",
    tool_use_id: id,
    toolset_name: "computer",
    content: [{
      type: "image",
      source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
    }],
  };
}

function rememberCursor(action: NeutralAction, session: ClaudeSession): void {
  if (action.op === "click" || action.op === "move" || action.op === "scroll") {
    session.cursor = { x: action.x, y: action.y };
  } else if (action.op === "drag") {
    session.cursor = { x: action.x1, y: action.y1 };
  }
}

export async function handleClaudeTool(
  use: ClaudeToolUse,
  executor: Executor,
  session: ClaudeSession,
): Promise<ClaudeToolResult> {
  if (use.toolset_name !== "computer") {
    return textResult(use.id, `toolset ${use.toolset_name} is not computer`, true);
  }
  try {
    const action = toNeutral(use, session);
    if (action.op === "unsupported") {
      return textResult(use.id, `${action.vendor} action ${action.type} is not performed in this spike`, true);
    }
    if (action.op === "screenshot") {
      const seen = await executor.observe(origin(use));
      const scaled = await scalePng(seen.png, CLAUDE_SCREENSHOT_SCALE.numer, CLAUDE_SCREENSHOT_SCALE.denom);
      const size = pngSize(scaled);
      session.frame = { image: size, viewport: seen.viewport };
      return imageResult(use.id, scaled);
    }
    if (action.op === "zoom") {
      const cropped = await executor.act(action, origin(use));
      if (!cropped.png || !session.frame) return textResult(use.id, "zoom returned no image", true);
      const fitted = await fitPng(cropped.png, session.frame.image);
      return imageResult(use.id, fitted);
    }
    if (action.op === "cursor") {
      const found = await executor.act(action, origin(use));
      const [x, y] = (found.text ?? "0,0").split(",").map(Number);
      const image = session.frame ? toImage(x, y, session.frame) : { x, y };
      return textResult(use.id, `[${Math.round(image.x)}, ${Math.round(image.y)}]`);
    }
    const result: ActResult = await executor.act(action, origin(use));
    rememberCursor(action, session);
    if (result.unresolved && (action.op === "scroll" || action.op === "drag")) {
      // Performed, and flagged on the trail. The tool itself ran.
      return textResult(use.id, "OK");
    }
    return textResult(use.id, "OK");
  } catch (err) {
    return textResult(use.id, err instanceof Error ? err.message : String(err), true);
  }
}

const HALTED = "Not executed: an earlier computer action in this turn failed.";

/** Run a turn in order. A thrown failure still answers every later tool_use. */
export async function handleClaudeTurn(
  uses: ClaudeToolUse[],
  executor: Executor,
  session: ClaudeSession,
): Promise<ClaudeToolResult[]> {
  const results: ClaudeToolResult[] = [];
  let halted = false;
  for (const use of uses) {
    if (halted) {
      results.push({
        type: "tool_result",
        tool_use_id: use.id,
        toolset_name: "computer",
        is_error: true,
        content: HALTED,
      });
      continue;
    }
    const result = await handleClaudeTool(use, executor, session);
    results.push(result);
    if (result.is_error) halted = true;
  }
  return results;
}
