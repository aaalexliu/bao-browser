// OpenAI computer tool, as published in
// https://developers.openai.com/api/docs/guides/tools-computer-use
// A computer_call carries an ordered actions array. The app returns one
// computer_call_output screenshot for that call_id. This file only translates.

import type { AuditOrigin } from "./audit";
import type { ActResult, Executor, VendorAdapter } from "./neutral";

export type ComputerButton = "left" | "right" | "wheel" | "back" | "forward";

export type ComputerAction =
  | { type: "screenshot" }
  | { type: "click"; button: ComputerButton; x: number; y: number; keys?: string[] }
  | { type: "double_click"; x: number; y: number }
  | { type: "drag"; path: { x: number; y: number }[] }
  | { type: "move"; x: number; y: number }
  | { type: "scroll"; x: number; y: number; scroll_x: number; scroll_y: number }
  | { type: "keypress"; keys: string[] }
  | { type: "type"; text: string }
  | { type: "wait" };

export interface ComputerCall {
  type: "computer_call";
  call_id: string;
  actions: ComputerAction[];
  status: "in_progress" | "completed" | "incomplete";
}

export interface ComputerCallOutput {
  type: "computer_call_output";
  call_id: string;
  output: {
    type: "computer_screenshot";
    image_url: string;
    detail: "original";
  };
}

export const openaiAdapter: VendorAdapter<ComputerCall, ComputerCallOutput> = {
  vendor: "openai",
  handle: handleComputerCall,
};

const SOURCE = { agent: "scripted-driver", vendor: "openai", adapter: "openai" };

function origin(raw: unknown): AuditOrigin {
  return { source: SOURCE, raw };
}

export async function handleComputerCall(call: ComputerCall, executor: Executor): Promise<ComputerCallOutput> {
  if (call.type !== "computer_call") {
    throw new Error(`expected computer_call, got ${(call as { type?: string }).type}`);
  }
  for (const action of call.actions) {
    await applyAction(action, executor);
  }
  // One computer_screenshot for the whole call, after the batch. A screenshot
  // action above already observed; this second shot is the same pixels when
  // the page did not change, and trim drops it.
  const seen = await executor.observe(origin({ type: "screenshot", call_id: call.call_id }));
  return {
    type: "computer_call_output",
    call_id: call.call_id,
    output: {
      type: "computer_screenshot",
      image_url: `data:image/png;base64,${seen.png.toString("base64")}`,
      detail: "original",
    },
  };
}

async function applyAction(action: ComputerAction, executor: Executor): Promise<ActResult | void> {
  if (action.type === "screenshot") {
    await executor.observe(origin(action));
    return;
  }
  if (action.type === "click" && !(action.keys && action.keys.length > 0)) {
    return executor.act({ op: "click", x: action.x, y: action.y, button: action.button }, origin(action));
  }
  if (action.type === "type") {
    return executor.act({ op: "type", text: action.text }, origin(action));
  }
  if (action.type === "keypress") {
    return executor.act({ op: "keypress", keys: action.keys }, origin(action));
  }
  return executor.act({ op: "unsupported", vendor: "openai", type: action.type }, origin(action));
}
