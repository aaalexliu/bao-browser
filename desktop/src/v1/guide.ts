// A shareable step-by-step page. One file, no network.
// Inputs are placeholders. Secrets and absolute paths are left out.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { isElementCrop } from "./redacted-png";
import { looksLikePath, type WorkflowStep, type WorkflowV2 } from "./schema";
import { shotFile, workflowShotName } from "./shots";

const PATH_PREFIX = /\/(?:Users|home|tmp|var|opt|private|workspace|etc|usr)\/[^\s"'<>]*/g;
const FILE_URL = /file:\/\/\S+/gi;
const WIN_PATH = /\b[A-Za-z]:\\[^\s"'<>]*/g;
const HOME_PATH = /~\/[^\s"'<>]*/g;

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

/** Self-contained HTML. `crops` are already-redacted element PNGs. */
export function guideHtml(doc: WorkflowV2, crops: Map<string, Buffer>): string {
  const secrets = secretStrings(doc);
  const title = esc(tidy(scrubText(doc.name || "", secrets)) || "Workflow");
  const inputs = inputList(doc, secrets);
  const steps = doc.steps.map((step) => stepBlock(doc, step, crops.get(step.id), secrets)).join("");
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
  li.step img {
    display: block;
    width: auto;
    max-width: 100%;
    height: auto;
    margin-top: 10px;
    border-radius: 8px;
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

function stepBlock(doc: WorkflowV2, step: WorkflowStep, png: Buffer | undefined, secrets: string[]): string {
  const img = png ? `<img alt="" src="data:image/png;base64,${png.toString("base64")}">` : "";
  return `<li class="step">${img}<p>${esc(instruction(doc, step, secrets))}</p></li>`;
}

function inputList(doc: WorkflowV2, secrets: string[]): string {
  if (!doc.inputs.length) return "";
  const rows = doc.inputs.map((input) => {
    const token = `{{${input.name}}}`;
    if (input.type === "choice" && input.choices?.length) {
      const options = input.choices
        .map((choice) => tidy(scrubText(choice, secrets)))
        .filter(Boolean);
      const listed = options.length ? ` ${esc(options.join(" / "))}` : "";
      return `<li><code>${esc(token)}</code>${listed}</li>`;
    }
    return `<li><code>${esc(token)}</code></li>`;
  });
  return `<h2>Inputs</h2><ul class="inputs">${rows.join("")}</ul>`;
}

function instruction(doc: WorkflowV2, step: WorkflowStep, secrets: string[]): string {
  const input = doc.inputs.find((item) => item.name === step.input);
  const name = input && /^[A-Za-z][A-Za-z0-9_]*$/.test(input.name) ? input.name : "";
  const token = name ? `{{${name}}}` : "";
  const secretish = step.sensitive === true || step.action === "login" || input?.type === "secret";
  let text: string;
  if (secretish) text = token ? `Type ${token}` : "Sign in";
  else if (step.action === "upload" || step.action === "drop") text = token ? `Add ${token}` : "Add a file";
  else if ((step.action === "type" || step.action === "digits") && token) {
    text = (step.label || "").includes(token) ? step.label : `Type ${token}`;
  } else text = step.label || step.action;
  const literal = step.value && !step.value.includes("{{") ? step.value : "";
  if (literal) text = text.split(literal).join(token);
  const cleaned = tidy(scrubText(text, secrets));
  return cleaned || (token ? `Type ${token}` : "Step");
}

function secretStrings(doc: WorkflowV2): string[] {
  const found: string[] = [];
  const keep = (value: string | undefined) => {
    if (!value || value.length < 4 || value.includes("{{")) return;
    found.push(value);
  };
  for (const input of doc.inputs) {
    if (input.type === "secret") keep(input.default);
    if (input.default && looksLikePath(input.default)) keep(input.default);
  }
  for (const step of doc.steps) {
    const input = doc.inputs.find((item) => item.name === step.input);
    if (step.sensitive || step.action === "login" || input?.type === "secret" || (step.value && looksLikePath(step.value))) {
      keep(step.value);
    }
  }
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}

function scrubText(value: string, secrets: string[]): string {
  let out = value;
  for (const secret of secrets) out = out.split(secret).join("");
  out = out.replace(FILE_URL, "{{file}}");
  out = out.replace(WIN_PATH, "{{file}}");
  out = out.replace(PATH_PREFIX, "{{file}}");
  out = out.replace(HOME_PATH, "{{file}}");
  return out;
}

function tidy(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] || ch));
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
