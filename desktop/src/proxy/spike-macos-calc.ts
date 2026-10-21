// Calculator button lookup and the scripted 7 + 5 = loops.
// Coordinates are measured from AX frames and passed only as the vendor click.

import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Workflow } from "../../../src/types";
import { AuditTrail } from "./audit";
import { handleClaudeTool } from "./claude-mac";
import type { ClaudeToolUse } from "./claude";
import { MacOsExecutor } from "./macos-exec";
import { replayOsWorkflow, replayUsedCoordinates } from "./macos-replay";
import { handleComputerCall, type ComputerCall } from "./openai";
import { MacOsHelper, targetFrom, type AxNode } from "./os-macos";
import { CALC_BUNDLE, launchIfDown, quitOwned, sleep, workDir } from "./spike-macos-host";

const KEYS: { label: string; names: string[] }[] = [
  { label: "7", names: ["7", "seven"] },
  { label: "+", names: ["+", "plus", "add"] },
  { label: "5", names: ["5", "five"] },
  { label: "=", names: ["=", "equals", "equal"] },
];

const CLEAR_NAMES = ["ac", "all clear", "c", "clear"];

function same(got: string, want: string): boolean {
  return got.trim().toLowerCase() === want.toLowerCase();
}

export function pressable(nodes: AxNode[], names: string[]): AxNode | undefined {
  return nodes.find((n) =>
    n.useful && n.actions.includes("AXPress") && names.some((want) =>
      same(n.name, want) || same(n.title, want) || same(n.description, want) || same(n.identifier, want)
    )
  );
}

export function center(node: AxNode): { x: number; y: number } {
  if (!node.frame) throw new Error(`no frame for ${node.role} ${node.name}`);
  return { x: Math.round(node.frame.x + node.frame.w / 2), y: Math.round(node.frame.y + node.frame.h / 2) };
}

function plain(raw: string): string {
  return raw.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
}

function numericFields(node: AxNode): string[] {
  return [node.value, node.title, node.description, node.name].map(plain).filter((s) => /^-?\d+(\.\d+)?\.?$/.test(s));
}

export function readout(nodes: AxNode[]): string {
  const hits = nodes.filter((n) => !n.actions.includes("AXPress") && numericFields(n).length > 0);
  const display = hits.find((n) => n.role === "AXStaticText") ?? hits[0];
  if (!display) return "";
  return numericFields(display)[0] ?? "";
}

export function isTwelve(value: string): boolean {
  return value === "12" || value === "12.";
}

export async function clearDisplay(helper: MacOsHelper, nodes: AxNode[]): Promise<string> {
  const shown = readout(nodes);
  if (shown === "" || shown === "0" || shown === "0.") return shown || "0";
  const clear = pressable(nodes, CLEAR_NAMES);
  if (!clear) return shown;
  const screen = { w: 0, h: 0 };
  await helper.press(targetFrom(clear, screen));
  await sleep(200);
  const again = await helper.nodes(CALC_BUNDLE);
  return readout(again.nodes ?? []);
}

export async function measureKeys(nodes: AxNode[]): Promise<{ label: string; x: number; y: number; node: AxNode }[]> {
  return KEYS.map((key) => {
    const node = pressable(nodes, key.names);
    if (!node) {
      const seen = nodes.filter((n) => n.useful).map((n) => `${n.role}:${n.name}`).slice(0, 40);
      throw new Error(`no AX button for ${key.label}. useful: ${seen.join(", ")}`);
    }
    return { label: key.label, ...center(node), node };
  });
}

export function outsidePoint(frame: { x: number; y: number; w: number }): { x: number; y: number } {
  const x = frame.x > 80 ? Math.round(frame.x - 40) : Math.round(frame.x + frame.w + 40);
  return { x, y: Math.round(frame.y + 24) };
}

async function openaiClicks(executor: MacOsExecutor, points: { x: number; y: number }[], blank: { x: number; y: number }): Promise<void> {
  const call = (id: string, actions: ComputerCall["actions"]): ComputerCall =>
    ({ type: "computer_call", call_id: id, actions, status: "completed" });
  await handleComputerCall(call("calc-openai", points.map((p) => ({ type: "click", button: "left", x: p.x, y: p.y }))), executor);
  await handleComputerCall(call("calc-openai-blank", [{ type: "click", button: "left", x: blank.x, y: blank.y }]), executor);
}

async function claudeClicks(executor: MacOsExecutor, points: { x: number; y: number }[]): Promise<void> {
  for (const [i, point] of points.entries()) {
    const call: ClaudeToolUse = {
      type: "tool_use",
      id: `calc-claude-${i}`,
      name: "left_click",
      toolset_name: "computer",
      input: { coordinate: [point.x, point.y] },
    };
    await handleClaudeTool(call, executor);
  }
}

export async function recordCalc(
  helper: MacOsHelper,
  vendor: "openai" | "claude",
  points: { x: number; y: number }[],
  blank: { x: number; y: number } | null,
): Promise<{ workflow: Workflow; trail: AuditTrail["events"] }> {
  const trail = new AuditTrail();
  const executor = new MacOsExecutor(trail, helper, CALC_BUNDLE, workDir());
  if (vendor === "openai") {
    if (!blank) throw new Error("openai loop needs a blank point");
    await openaiClicks(executor, points, blank);
  } else {
    await claudeClicks(executor, points);
  }
  return { workflow: executor.workflow(`os://${CALC_BUNDLE}`), trail: trail.events };
}

export async function replayCalc(
  helper: MacOsHelper,
  workflow: Workflow,
  frames: string,
): Promise<{ pressed: number; coordinateReplay: boolean }> {
  const before = helper.calls.length;
  await mkdir(frames, { recursive: true });
  let n = 0;
  const replay = await replayOsWorkflow(helper, workflow, async () => {
    n += 1;
    await helper.shot(CALC_BUNDLE, path.join(frames, `frame-${String(n).padStart(2, "0")}.png`));
    await sleep(120);
  });
  return { pressed: replay.pressed, coordinateReplay: replayUsedCoordinates(helper.calls.slice(before)) };
}

export async function relaunchCalc(owned: number): Promise<number> {
  await quitOwned(owned, "Calculator");
  await sleep(400);
  const pid = await launchIfDown("Calculator", "Calculator");
  if (pid == null) throw new Error("Calculator was still running after quit");
  await sleep(700);
  return pid;
}
