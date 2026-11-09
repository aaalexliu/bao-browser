// A step-by-step page with stored text and pictures. One file, no network.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isElementCrop } from "./redacted-png";
import { targetElementId } from "../../../shared/step-read";
import { locatorValue, targetName, stepInputName, stepTarget, stepTitle, targetRole, type WorkflowStep, type WorkflowV2 } from "./schema";
import { guideShotName, shotFile, workflowShotName } from "./shots";
import { visibleCopy } from "./visible-copy";

/** Outlined element crops, including secret steps. Replay input files are not read. */
export function guideCrops(root: string, doc: WorkflowV2): Map<string, Buffer> {
  const crops = new Map<string, Buffer>();
  const id = safeId(doc.id);
  if (!id) return crops;
  const runs = runIds(root, id);
  for (const step of doc.steps) {
    const names = [
      path.join(root, "shots", "workflows", id, workflowShotName(step.id)),
      ...runs.map((runId) => path.join(root, "shots", "runs", runId, shotFile(step.id, "after"))),
      path.join(root, "shots", "workflows", id, guideShotName(step.id)),
    ];
    for (const name of names) {
      if (!existsSync(name)) continue;
      const png = readFileSync(name);
      if (!isElementCrop(png)) continue;
      crops.set(step.id, png);
      break;
    }
  }
  return crops;
}

/** Self-contained HTML with captured crops unchanged. */
export function guideHtml(doc: WorkflowV2, crops: Map<string, Buffer>): string {
  const title = esc(tidy(doc.name || "") || "Workflow");
  const inputs = inputList(doc);
  const steps = guideSteps(doc).map((entry) => stepBlock(doc, entry.step, crops.get(entry.cropId))).join("");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f5f5f7;
    --ink: #1d1d1f;
    --quiet: #6e6e73;
    --line: #d2d2d7;
    --card: #ffffff;
    --accent: #0071e3;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1c1e;
      --ink: #f5f5f7;
      --quiet: #98989d;
      --line: #3a3a3c;
      --card: #2c2c2e;
      --accent: #0a84ff;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font: 16px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 640px; margin: 0 auto; padding: 40px 24px 72px; }
  h1 { font-size: 28px; font-weight: 600; letter-spacing: -0.02em; margin: 0; }
  h2 {
    margin: 28px 0 8px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--quiet);
  }
  ul.inputs { list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 8px; }
  ul.inputs li {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 4px 10px;
    font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  ol { list-style: none; padding: 0; margin: 8px 0 0; counter-reset: step; }
  li.step {
    counter-increment: step;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 14px 16px;
    margin: 0 0 12px;
  }
  li.step::before {
    content: counter(step);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 22px;
    height: 22px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--accent);
    color: #fff;
    font-size: 12px;
    font-weight: 600;
  }
  li.step .shot {
    margin-top: 10px;
    border-radius: 8px;
    overflow: hidden;
    max-width: 100%;
    line-height: 0;
  }
  li.step .shot img {
    display: block;
    max-width: 100%;
    height: auto;
    background: var(--bg);
  }
  li.step p { margin: 10px 0 0; }
</style>
</head>
<body>
<main id="guide">
  <h1>${title}</h1>
  ${inputs}
  <h2>Steps</h2>
  <ol>${steps}</ol>
</main>
</body>
</html>
`;
}

function stepBlock(doc: WorkflowV2, step: WorkflowStep, png: Buffer | undefined): string {
  const img = png ? `<span class="shot"><img alt="" src="data:image/png;base64,${png.toString("base64")}"></span>` : "";
  return `<li class="step">${img}<p>${esc(instruction(doc, step))}</p></li>`;
}

/** A focus click and the type on that same control are one guide step. */
function guideSteps(doc: WorkflowV2): { step: WorkflowStep; cropId: string }[] {
  const out: { step: WorkflowStep; cropId: string }[] = [];
  const steps = doc.steps;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const next = steps[i + 1];
    if (next && focusInto(doc, step, next)) {
      out.push({ step: next, cropId: next.id });
      i += 1;
      continue;
    }
    out.push({ step, cropId: step.id });
  }
  return out;
}

function focusInto(doc: WorkflowV2, click: WorkflowStep, typed: WorkflowStep): boolean {
  if (click.action !== "click") return false;
  if (typed.action !== "type" && typed.action !== "digits") return false;
  if (!isFieldTarget(doc, click)) return false;
  return sameControl(click, typed);
}

function sameControl(click: WorkflowStep, typed: WorkflowStep): boolean {
  const left = stepTarget(click);
  const right = stepTarget(typed);
  if (left && right) {
    const id = targetElementId(left);
    const testId = locatorValue(left, "testid");
    if (id && id === targetElementId(right)) return true;
    if (left.hint?.nameAttr && left.hint.nameAttr === right.hint?.nameAttr) return true;
    if (testId && testId === locatorValue(right, "testid")) return true;
  }
  const phrase = clickPhrase(click).toLowerCase();
  const names = [stepInputName(typed), targetElementId(right), right?.hint?.nameAttr, targetName(right)]
    .filter((name): name is string => Boolean(name))
    .map((name) => name.toLowerCase());
  return names.includes(phrase);
}

function inputList(doc: WorkflowV2): string {
  if (!doc.inputs.length) return "";
  const rows = doc.inputs.map((input) => {
    const token = `{{${input.name}}}`;
    if (input.type === "choice" && input.choices?.length) {
      const options = input.choices
        .map((choice) => tidy(choice))
        .filter(Boolean);
      const listed = options.length ? ` ${esc(options.join(" / "))}` : "";
      return `<li><code>${esc(token)}</code>${listed}</li>`;
    }
    const value = input.default;
    return `<li><code>${esc(token)}</code>${value ? ` ${esc(value)}` : ""}</li>`;
  });
  return `<h2>Inputs</h2><ul class="inputs">${rows.join("")}</ul>`;
}

function instruction(doc: WorkflowV2, step: WorkflowStep): string {
  const input = doc.inputs.find((item) => item.name === stepInputName(step));
  const name = input && /^[A-Za-z][A-Za-z0-9_]*$/.test(input.name) ? input.name : "";
  const token = name ? `{{${name}}}` : "";
  let text: string;
  if ((step.action === "type" || step.action === "digits") && token) {
    const where = fieldLabel(step, input?.label);
    text = where ? `Type ${token} in ${where}` : `Type ${token}`;
  } else if (step.action === "handoff" && step.reason === "sign-in") text = "Sign in";
  else if (step.action === "handoff") text = step.caption.text || "You press the button";
  else if (step.action === "upload" || step.action === "drop") text = token ? `Add ${token}` : "Add a file";
  else if (step.action === "click") text = clickLine(doc, step);
  else text = stepTitle(step) || step.action;
  const cleaned = tidy(text);
  return cleaned || (token ? `Type ${token}` : "Step");
}

function clickLine(doc: WorkflowV2, step: WorkflowStep): string {
  const phrase = tidy(clickPhrase(step));
  if (isFieldTarget(doc, step)) {
    const label = pretty(phrase.replace(/^the\s+/i, "").replace(/\s+field$/i, ""));
    return label ? `Click the ${label} field` : "Click the field";
  }
  if (/^click$/i.test(phrase)) return "Click";
  const label = pretty(phrase);
  return label ? `Click ${label}` : "Click";
}

function clickPhrase(step: WorkflowStep): string {
  const label = (stepTitle(step) || "").trim();
  const quoted = label.match(/^Click\s+"(.+)"$/i);
  if (quoted?.[1]) return quoted[1];
  const plain = label.match(/^Click\s+(.+)$/i);
  if (plain?.[1]) return plain[1];
  const target = stepTarget(step);
  return locatorValue(target, "text") || targetName(target) || target?.hint?.label || "";
}

function isFieldTarget(_doc: WorkflowV2, step: WorkflowStep): boolean {
  const target = stepTarget(step);
  const role = (targetRole(target) || "").toLowerCase();
  const tag = (target?.hint?.tag || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;
  if (/password|textbox|searchbox|combobox/.test(role) || role === "input") return true;
  return false;
}

function fieldLabel(step: WorkflowStep, inputLabel?: string): string {
  const target = stepTarget(step);
  const candidates = [inputLabel, target?.hint?.label, targetName(target), target?.hint?.nameAttr, stepInputName(step), targetElementId(target)];
  for (const candidate of candidates) {
    const clean = (candidate || "").replace(/\s+/g, " ").trim();
    if (!clean || clean.includes("{{")) continue;
    return pretty(clean);
  }
  return "";
}

function pretty(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[A-Z]/.test(trimmed) || /\s/.test(trimmed)) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function esc(value: string): string {
  return visibleCopy(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
}

function safeId(id: string): string | undefined {
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return;
  return id;
}

function runIds(root: string, workflowId: string): string[] {
  const dir = path.join(root, "runs");
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const rows: { id: string; at: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const run = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as { id?: string; workflowId?: string; at?: number };
      if (run.workflowId !== workflowId) continue;
      const id = safeId(run.id || name.replace(/\.json$/, ""));
      if (id) rows.push({ id, at: run.at || 0 });
    } catch { /* a bad run file is not a crop */ }
  }
  rows.sort((a, b) => b.at - a.at);
  return rows.map((row) => row.id);
}
