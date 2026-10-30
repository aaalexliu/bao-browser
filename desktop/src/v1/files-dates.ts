// Files and dates. Version 3 when a document uses this revision or data steps.
// schema/workflow-v3.schema.json references this file and schema/data-steps.schema.json.
// workflow-v2.schema.json stays the version 2 contract.
//
// Download follows the same CDP events Playwright uses (Browser.setDownloadBehavior,
// Browser.downloadWillBegin, Browser.downloadProgress). Power Automate Desktop renames a
// finished download after the fact. UiPath's Wait for Download returns the file path.
// The saved name is a template, so a second run does not become "fw9 (1).pdf".
// Open on macOS is `open -a <app> <file>`. Linux runs xdg-open and marks that mac path
// "needs Mac test".

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import type { FileArg, ReplayArgs, WorkflowInput, WorkflowStep, WorkflowV2 } from "./schema";
import {
  addDays,
  civilInZone,
  datePreview,
  defaultZone,
  diffDays,
  formatCivil,
  isoOf,
  looksLikeDateField,
  parseRecordedDate,
  relativeBetween,
  resolveRelative,
  zoneOk,
  type Civil,
} from "./dates";

export { filesDatesErrors } from "./files-dates-check";
export {
  addDays,
  civilInZone,
  datePreview,
  defaultZone,
  diffDays,
  formatCivil,
  isoOf,
  looksLikeDateField,
  parseRecordedDate,
  relativeBetween,
  resolveRelative,
  zoneOk,
  type Civil,
};

export const FILES_DATES_REVISION = 1;
export const FILES_DATES_WORKFLOW_VERSION = 3;
export const NEEDS_MAC_TEST = "needs Mac test";

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface FileOutput {
  kind: "file";
  name: string;
  path: string;
  size: number;
  sha256: string;
}

export interface DownloadSpec {
  output: string;
  /** Filename template. Not a path. Tokens: {{run.date}} {{run.id}} {{suggested}} {{input}} {{output.field}}. */
  name: string;
  url?: string;
}

export interface OpenSpec {
  target: "url" | "file";
  url?: string;
  file?: string;
  app?: string;
}

export interface DatePickerSpec {
  input: string;
  endInput?: string;
}

export interface ShapeEvent {
  id: string;
  ts: number;
  op: string;
  value?: string;
  endValue?: string;
  dateField?: boolean;
  picker?: boolean;
  inputType?: string;
  format?: string;
  suggestedFilename?: string;
  fileName?: string;
  fileFrom?: string;
  identity?: {
    id?: string;
    nameAttr?: string;
    name?: string;
    label?: string;
    text?: string;
    role?: string;
    tag?: string;
    testId?: string;
  };
}

export interface TemplateScope {
  args: ReplayArgs;
  run: { date: string; id: string };
  outputs: Map<string, FileOutput>;
  suggested?: string;
}

export function renderTemplate(template: string, scope: TemplateScope): string {
  return template.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*)\s*\}\}/g, (_all, token: string) => {
    if (token === "run.date") return scope.run.date;
    if (token === "run.id") return scope.run.id;
    if (token === "suggested") return scope.suggested || "";
    const dot = token.indexOf(".");
    if (dot > 0) {
      const head = token.slice(0, dot);
      const tail = token.slice(dot + 1);
      const output = scope.outputs.get(head);
      if (output && tail in output) return String(output[tail as keyof FileOutput]);
    }
    const value = scope.args[token];
    if (typeof value === "string" || typeof value === "number") return String(value);
    if (value && typeof value === "object" && !Array.isArray(value) && "name" in value) return value.name;
    return "";
  });
}

export function downloadFileName(template: string, scope: TemplateScope): string {
  if (/[\\/]|\.\./.test(template)) throw new Error("download name");
  const rendered = renderTemplate(template, scope).trim();
  if (!rendered || rendered === "." || rendered === ".." || /[\\/]|\.\./.test(rendered)) {
    throw new Error("download name");
  }
  return rendered;
}

export function fileDigest(filePath: string): FileOutput {
  const buf = readFileSync(filePath);
  return {
    kind: "file",
    name: path.basename(filePath),
    path: filePath,
    size: buf.length,
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

export interface OpenPlan {
  argv: string[];
  needsMacTest?: typeof NEEDS_MAC_TEST;
  platform: NodeJS.Platform;
}

/** macOS: `open` or `open -a Preview <file>`. Anywhere else: `xdg-open`, and an app name is "needs Mac test". */
export function planOpen(
  req: { target: "url" | "file"; url?: string; path?: string; app?: string },
  platform: NodeJS.Platform,
): OpenPlan {
  if (req.target === "url") {
    const url = req.url || "";
    if (!/^https?:\/\//i.test(url)) throw new Error("open url");
    if (platform === "darwin") return { argv: ["open", url], platform };
    return { argv: ["xdg-open", url], platform };
  }
  const file = req.path || "";
  if (!file || file.includes("\0")) throw new Error("open file");
  if (platform === "darwin") {
    if (req.app) return { argv: ["open", "-a", req.app, file], platform };
    return { argv: ["open", file], platform };
  }
  return {
    argv: ["xdg-open", file],
    platform,
    needsMacTest: req.app ? NEEDS_MAC_TEST : undefined,
  };
}

export function spawnArgv(argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(argv[0]!, argv.slice(1), { timeout: 15_000 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function openTarget(
  req: { target: "url" | "file"; url?: string; path?: string; app?: string },
  opts: { platform?: NodeJS.Platform; exec?: (argv: string[]) => Promise<void> } = {},
): Promise<OpenPlan> {
  const plan = planOpen(req, opts.platform || process.platform);
  await (opts.exec || spawnArgv)(plan.argv);
  return plan;
}

export interface FilesRun {
  runId: string;
  zone: string;
  runDate: string;
  downloadDir: string;
  dates: Map<string, { iso: string; formatted: string }>;
  outputs: Map<string, FileOutput>;
  args: ReplayArgs;
  openExec?: (argv: string[]) => Promise<void>;
}

const runs = new Map<string, FilesRun>();

export function prepareFilesDatesRun(
  workflow: WorkflowV2,
  args: ReplayArgs,
  opts: { now: Date; zone?: string; runId: string; downloadDir: string; openExec?: (argv: string[]) => Promise<void> },
): FilesRun {
  const zone = opts.zone || defaultZone();
  const today = civilInZone(opts.now, zone);
  const dates = new Map<string, { iso: string; formatted: string }>();
  const next: ReplayArgs = { ...args };
  for (const input of workflow.inputs) {
    if (input.type !== "date") continue;
    const inputZone = input.zone || zone;
    const base = civilInZone(opts.now, inputZone);
    const raw = args[input.name];
    const expr = typeof raw === "string" && raw.trim() ? raw : (input.relative || input.default || "today");
    const format = input.format || "YYYY-MM-DD";
    let civil: Civil;
    try {
      civil = resolveRelative(expr, base);
    } catch {
      const parsed = parseRecordedDate(expr);
      if (!parsed) throw new Error(`bad date ${input.name}`);
      civil = parsed.civil;
    }
    const formatted = formatCivil(civil, format);
    dates.set(input.name, { iso: isoOf(civil), formatted });
    next[input.name] = formatted;
  }
  return {
    runId: opts.runId,
    zone,
    runDate: isoOf(today),
    downloadDir: path.join(opts.downloadDir, opts.runId),
    dates,
    outputs: new Map(),
    args: next,
    openExec: opts.openExec,
  };
}

export function beginFilesRun(run: FilesRun): void {
  runs.set(run.runId, run);
}

export function filesRun(runId: string): FilesRun | undefined {
  return runs.get(runId);
}

export function endFilesRun(runId: string): Record<string, FileOutput> {
  const run = runs.get(runId);
  runs.delete(runId);
  if (!run) return {};
  return Object.fromEntries(run.outputs);
}

export function templateScope(run: FilesRun, suggested?: string): TemplateScope {
  return {
    args: run.args,
    run: { date: run.runDate, id: run.runId },
    outputs: run.outputs,
    suggested,
  };
}

export function filesFor(
  runId: string,
  step: WorkflowStep,
  workflow: WorkflowV2,
): FileArg[] | undefined {
  const bound = step.fileFrom || workflow.inputs.find((input) => input.name === step.input)?.fromOutput;
  if (!bound) return undefined;
  const output = runs.get(runId)?.outputs.get(bound);
  if (!output) throw new Error(`file is bound to ${bound}, which has no download yet`);
  return [{ name: output.name, path: output.path }];
}

interface JsonSchema {
  $id?: string;
  title?: string;
  properties?: Record<string, unknown>;
  $defs?: Record<string, unknown>;
  [key: string]: unknown;
}

interface FilesDatesSchema {
  filesDates: number;
  workflowVersion: number;
  inputTypes: string[];
  actions: string[];
  documentProperties: Record<string, unknown>;
  inputProperties: Record<string, unknown>;
  stepProperties: Record<string, unknown>;
  $defs: Record<string, unknown>;
}

/** Clone a schema and add one revision. Stub fragments do not replace full definitions. */
export function composeFilesDatesSchema(base: JsonSchema, addon?: FilesDatesSchema): JsonSchema {
  const extra = addon || (JSON.parse(readFileSync(path.join(process.cwd(), "schema/files-dates.schema.json"), "utf8")) as FilesDatesSchema);
  const schema = structuredClone(base);
  schema.$id = "bao.workflow/v3";
  schema.title = "Bao workflow v3";
  mergeRevision(schema, extra);
  return schema;
}

/** One v3 schema. schema/workflow-v3.schema.json names both revision files. */
export function composeV3Schema(base?: JsonSchema): JsonSchema {
  const index = JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow-v3.schema.json"), "utf8")) as JsonSchema & {
    revisions?: { $ref?: string }[];
  };
  const v2 = base || (JSON.parse(readFileSync(path.join(process.cwd(), "schema/workflow-v2.schema.json"), "utf8")) as JsonSchema);
  const schema = structuredClone(v2);
  schema.$id = typeof index.$id === "string" ? index.$id : "bao.workflow/v3";
  schema.title = typeof index.title === "string" ? index.title : "Bao workflow v3";
  if (typeof index.description === "string") schema.description = index.description;
  for (const revision of index.revisions ?? []) {
    if (!revision.$ref) continue;
    const extra = JSON.parse(readFileSync(path.join(process.cwd(), "schema", revision.$ref), "utf8")) as FilesDatesSchema;
    mergeRevision(schema, {
      filesDates: extra.filesDates ?? FILES_DATES_REVISION,
      workflowVersion: extra.workflowVersion ?? FILES_DATES_WORKFLOW_VERSION,
      inputTypes: extra.inputTypes ?? [],
      actions: extra.actions ?? [],
      documentProperties: extra.documentProperties ?? {},
      inputProperties: extra.inputProperties ?? {},
      stepProperties: extra.stepProperties ?? {},
      $defs: extra.$defs ?? {},
    });
  }
  return schema;
}

function mergeRevision(schema: JsonSchema, extra: FilesDatesSchema): void {
  const properties = schema.properties as Record<string, unknown>;
  properties.version = { enum: [2, 3] };
  Object.assign(properties, extra.documentProperties);
  const defs = schema.$defs as Record<string, { properties?: Record<string, unknown>; enum?: string[] } & Record<string, unknown>>;
  const input = defs.input?.properties;
  const inputType = input?.type as { enum?: string[] } | undefined;
  if (inputType?.enum) for (const type of extra.inputTypes) if (!inputType.enum.includes(type)) inputType.enum.push(type);
  if (input) Object.assign(input, extra.inputProperties);
  const step = defs.step?.properties;
  const action = step?.action as { enum?: string[] } | undefined;
  if (action?.enum) for (const name of extra.actions) if (!action.enum.includes(name)) action.enum.push(name);
  if (step) Object.assign(step, extra.stepProperties);
  for (const [key, value] of Object.entries(extra.$defs)) {
    if (!value || typeof value !== "object") continue;
    const def = value as { type?: unknown };
    if (def.type !== "object" && def.type !== "array") continue;
    defs[key] = value as (typeof defs)[string];
  }
}

/** Same door as migrate(). A plain version 2 document stays version 2. */
export function migrateFilesDates(raw: unknown): WorkflowV2 {
  const { migrate } = require("./schema") as typeof import("./schema");
  return migrate(raw);
}

function lastEvent(group: ShapeEvent[] | undefined): ShapeEvent | undefined {
  if (!group || group.length === 0) return undefined;
  return group[group.length - 1];
}

/**
 * A study search builds an unlabeled <a href="/api/.../download"> and clicks it.
 * That node is gone on the next run, and its query string is the recorded search.
 * The button the person pressed is the trigger replay can press again.
 */
function isGeneratedDownloadLink(identity: WorkflowStep["identity"]): boolean {
  if (!identity || identity.id || identity.testId) return false;
  const tag = (identity.tag || "").toLowerCase();
  if (tag !== "a" && identity.role !== "link") return false;
  if ((identity.text || identity.name || identity.label || "").trim()) return false;
  return /\/download\b|[?&]format=csv/i.test(identity.href || "");
}

function takeDownloadTrigger(
  outSteps: WorkflowStep[],
  outGroups: ShapeEvent[][],
  identity: WorkflowStep["identity"],
): WorkflowStep["identity"] {
  const prev = outSteps[outSteps.length - 1];
  if (!prev || prev.action !== "click" || prev.datePicker) return identity;
  outSteps.pop();
  outGroups.pop();
  if (!isGeneratedDownloadLink(prev.identity)) return prev.identity || identity;
  const button = outSteps[outSteps.length - 1];
  if (!button || button.action !== "click" || button.datePicker || isGeneratedDownloadLink(button.identity)) {
    return prev.identity || identity;
  }
  outSteps.pop();
  outGroups.pop();
  return button.identity || identity;
}

function dateInput(inputs: WorkflowInput[], hint: string, event: ShapeEvent, zone: string): WorkflowInput {
  const parsed = parseRecordedDate(event.value || "");
  if (!parsed) throw new Error("date value");
  const today = civilInZone(new Date(event.ts || 0), zone);
  const name = uniqueName(inputs, hint);
  const input: WorkflowInput = {
    name,
    type: "date",
    required: true,
    label: name,
    format: event.format || parsed.format,
    relative: relativeBetween(today, parsed.civil),
    zone,
  };
  input.default = input.relative;
  inputs.push(input);
  return input;
}

function uniqueName(inputs: WorkflowInput[], hint: string): string {
  const base = NAME_RE.test(hint) ? hint : "date";
  let name = base;
  let n = 2;
  while (inputs.some((input) => input.name === name)) name = `${base}${n++}`;
  return name;
}

function hintFor(event: ShapeEvent, fallback: string): string {
  const hay = [event.identity?.nameAttr, event.identity?.id, event.identity?.label, event.identity?.name]
    .filter(Boolean)
    .join(" ");
  if (/check-?out|departure/i.test(hay)) return "checkOut";
  if (/check-?in|arrival/i.test(hay)) return "checkIn";
  if (event.identity?.nameAttr && NAME_RE.test(event.identity.nameAttr)) return event.identity.nameAttr;
  if (event.identity?.id && NAME_RE.test(event.identity.id)) return event.identity.id;
  return fallback;
}

function outputName(suggested: string, used: Set<string>): string {
  const stem = suggested.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9]+/g, "");
  let name = /^[A-Za-z]/.test(stem) ? stem : "file";
  if (!NAME_RE.test(name)) name = "file";
  const base = name;
  let n = 2;
  while (used.has(name)) name = `${base}${n++}`;
  used.add(name);
  return name;
}

/**
 * Turn a typed or picked date into a date input, fold picker clicks into one cell plan,
 * and turn a download event into a download step. Unrelated workflows stay version 2.
 */
export function shapeFilesDates(
  doc: WorkflowV2,
  groups: ShapeEvent[][],
  zone = "UTC",
): { doc: WorkflowV2; groups: ShapeEvent[][] } {
  const inputs = doc.inputs.map((input) => ({ ...input }));
  const steps = doc.steps.map((step) => ({ ...step }));
  let changed = false;
  const usedOutputs = new Set<string>();
  const outSteps: WorkflowStep[] = [];
  const outGroups: ShapeEvent[][] = [];

  const takePicker = (index: number): { step: WorkflowStep; group: ShapeEvent[] } | undefined => {
    const group = groups[index] || [];
    const event = lastEvent(group);
    if (!event?.picker || !event.value) return undefined;
    const start = dateInput(inputs, hintFor(event, outSteps.some((step) => step.datePicker) ? "checkOut" : "checkIn"), event, zone);
    let endName: string | undefined;
    const bundled = [...group];
    if (event.endValue) {
      const endEvent = { ...event, value: event.endValue };
      const end = dateInput(inputs, "checkOut", endEvent, zone);
      endName = end.name;
    }
    const step = steps[index]!;
    changed = true;
    return {
      group: bundled,
      step: {
        ...step,
        action: "click",
        input: start.name,
        value: `{{${start.name}}}`,
        label: endName ? `Pick {{${start.name}}} to {{${endName}}}` : `Pick {{${start.name}}}`,
        datePicker: endName ? { input: start.name, endInput: endName } : { input: start.name },
        identity: event.identity
          ? {
              surface: "dom",
              ...event.identity,
              role: event.identity.role || "group",
              path: [],
            }
          : step.identity,
      },
    };
  };

  let i = 0;
  while (i < steps.length) {
    const group = groups[i] || [];
    const event = lastEvent(group);
    if (event?.picker && !event.value && !event.endValue) {
      changed = true;
      i += 1;
      continue;
    }
    if (event?.picker && event.value) {
      let chosen = i;
      let j = i + 1;
      const bundled = [...(groups[i] || [])];
      while (j < steps.length) {
        const next = lastEvent(groups[j]);
        if (!next?.picker) break;
        bundled.push(...(groups[j] || []));
        if (next.value || next.endValue) chosen = j;
        j += 1;
      }
      const picked = takePicker(chosen);
      if (picked) {
        picked.group = bundled;
        outSteps.push(picked.step);
        outGroups.push(picked.group);
      }
      changed = true;
      i = j;
      continue;
    }
    if (event?.op === "download") {
      changed = true;
      const suggested = event.suggestedFilename || event.fileName || "download";
      const output = outputName(suggested, usedOutputs);
      const step = steps[i]!;
      const identity = takeDownloadTrigger(outSteps, outGroups, step.identity);
      outSteps.push({
        ...step,
        action: "download",
        label: "Download",
        identity,
        download: { output, name: "{{run.date}}-{{suggested}}" },
        timeoutMs: 30_000,
      });
      outGroups.push(group);
      i += 1;
      continue;
    }
    if (event?.op === "open") {
      changed = true;
      const step = steps[i]!;
      const target = event.value && /^https?:\/\//i.test(event.value) ? "url" : "file";
      outSteps.push({
        ...step,
        action: "open",
        surface: target === "url" ? "dom" : "os",
        label: target === "url" ? "Open url" : "Open file",
        open: target === "url"
          ? { target, url: event.value }
          : { target, file: event.fileFrom ? `{{${event.fileFrom}.path}}` : event.value, app: event.format },
        timeoutMs: 15_000,
      });
      outGroups.push(group);
      i += 1;
      continue;
    }
    const step = steps[i]!;
    if (step.action === "type" && event && (event.dateField || looksLikeDateField(event.identity))) {
      const parsed = event.value ? parseRecordedDate(event.value) : undefined;
      if (parsed && step.input) {
        const input = inputs.find((item) => item.name === step.input);
        if (input && input.type !== "secret") {
          const today = civilInZone(new Date(event.ts || 0), zone);
          input.type = "date";
          input.format = event.format || parsed.format;
          input.relative = relativeBetween(today, parsed.civil);
          input.default = input.relative;
          input.zone = zone;
          changed = true;
          if (event.dateField && event.inputType !== "date") {
            outSteps.push({
              ...step,
              action: "click",
              value: `{{${input.name}}}`,
              label: `Pick {{${input.name}}}`,
              datePicker: { input: input.name },
            });
            outGroups.push(group);
            i += 1;
            continue;
          }
        }
      }
    }
    if ((step.action === "upload" || step.action === "drop") && event?.fileFrom) {
      step.fileFrom = event.fileFrom;
      const input = inputs.find((item) => item.name === step.input);
      if (input) {
        input.fromOutput = event.fileFrom;
        input.required = false;
      }
      changed = true;
    }
    outSteps.push(step);
    outGroups.push(group);
    i += 1;
  }

  if (!changed) return { doc, groups };
  const nextSteps = outSteps.map((step, index) => ({ ...step, index, id: `${doc.id}-${index}` }));
  return {
    doc: {
      ...doc,
      version: FILES_DATES_WORKFLOW_VERSION,
      filesDates: FILES_DATES_REVISION,
      inputs,
      steps: nextSteps,
    },
    groups: outGroups,
  };
}

interface CdpClient {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, handler: (params: Record<string, unknown>) => void): void;
  detach(): Promise<void>;
}

export async function armBrowserDownloads(page: Page, downloadPath: string): Promise<CdpClient> {
  mkdirSync(downloadPath, { recursive: true });
  const browser = page.context().browser();
  if (!browser) throw new Error("download needs a browser");
  // Playwright arms each created context with allowAndName into its own folder.
  // Override that on the browser session, and only pass a context id Chrome has
  // listed. The persistent profile's default id makes setDownloadBehavior hang.
  const root = await browser.newBrowserCDPSession() as unknown as CdpClient;
  const pageSession = await page.context().newCDPSession(page) as unknown as CdpClient;
  let contextId = "";
  try {
    const info = await pageSession.send("Target.getTargetInfo") as { targetInfo?: { browserContextId?: string } };
    contextId = String(info.targetInfo?.browserContextId || "");
  } catch {
    contextId = "";
  }
  await pageSession.detach().catch(() => undefined);
  let created: string[] = [];
  try {
    const listed = await root.send("Target.getBrowserContexts") as { browserContextIds?: string[] };
    created = listed.browserContextIds || [];
  } catch {
    created = [];
  }
  const params: { behavior: string; downloadPath: string; eventsEnabled: boolean; browserContextId?: string } = {
    behavior: "allow",
    downloadPath,
    eventsEnabled: true,
  };
  if (contextId && created.includes(contextId)) params.browserContextId = contextId;
  await root.send("Browser.setDownloadBehavior", params);
  return root;
}

export interface DownloadBegin {
  suggestedFilename: string;
  url: string;
  guid: string;
}

/** Capture keeps listening for the whole session. Replay uses watchDownload for one file. */
export function captureDownloads(client: CdpClient, onFile: (info: DownloadBegin) => void): void {
  const pending = new Map<string, DownloadBegin>();
  client.on("Browser.downloadWillBegin", (params) => {
    const began = {
      guid: String(params.guid || ""),
      url: String(params.url || ""),
      suggestedFilename: String(params.suggestedFilename || "download"),
    };
    pending.set(began.guid, began);
  });
  client.on("Browser.downloadProgress", (params) => {
    if (String(params.state || "") !== "completed") return;
    const began = pending.get(String(params.guid || ""));
    if (began) onFile(began);
  });
}

export interface DownloadWatch {
  done: Promise<DownloadBegin>;
  /** Drop the timer. A trigger that throws must not reject after the caller has moved on. */
  cancel(): void;
}

export function watchDownload(client: CdpClient, timeoutMs: number): DownloadWatch {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectPromise: ((err: Error) => void) | undefined;
  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    fn();
  };
  const done = new Promise<DownloadBegin>((resolve, reject) => {
    rejectPromise = reject;
    timer = setTimeout(() => settle(() => reject(new Error("download timed out"))), timeoutMs);
    let began: DownloadBegin | undefined;
    client.on("Browser.downloadWillBegin", (params) => {
      began = {
        guid: String(params.guid || ""),
        url: String(params.url || ""),
        suggestedFilename: String(params.suggestedFilename || "download"),
      };
    });
    client.on("Browser.downloadProgress", (params) => {
      if (!began || String(params.guid || "") !== began.guid) return;
      const state = String(params.state || "");
      if (state === "completed") settle(() => resolve(began!));
      else if (state === "canceled") settle(() => reject(new Error("download canceled")));
    });
  });
  // Node ends the process on an unhandled rejection. The caller awaits `done`
  // when the trigger works, and cancels it when the trigger throws first.
  done.catch(() => undefined);
  return {
    done,
    cancel() {
      settle(() => rejectPromise?.(new Error("download abandoned")));
    },
  };
}

function newestFinished(dir: string): string | undefined {
  const names = readdirSync(dir).filter((name) => name && !name.endsWith(".crdownload"));
  let best: { file: string; mtime: number } | undefined;
  for (const name of names) {
    const file = path.join(dir, name);
    const mtime = statSync(file).mtimeMs;
    if (!best || mtime >= best.mtime) best = { file, mtime };
  }
  return best?.file;
}

export async function waitForDownloadFile(dir: string, suggested: string, timeoutMs: number): Promise<string> {
  const direct = path.join(dir, suggested);
  const start = Date.now();
  let last = -1;
  let stable = 0;
  while (Date.now() - start < timeoutMs) {
    const candidate = existsSync(direct) ? direct : newestFinished(dir);
    if (candidate && existsSync(candidate)) {
      const size = statSync(candidate).size;
      if (size > 0 && size === last) {
        stable += 1;
        if (stable >= 2) return candidate;
      } else {
        stable = 0;
        last = size;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("download file did not finish");
}

export function placeDownload(found: string, dir: string, filename: string): string {
  const dest = path.join(dir, filename);
  if (path.resolve(found) !== path.resolve(dest)) copyFileSync(found, dest);
  return dest;
}

export interface DatePoint {
  x: number;
  y: number;
}

export interface DatePickInspect {
  status: "nav" | "click" | "drag" | "select" | "error";
  kind?: string;
  x?: number;
  y?: number;
  from?: DatePoint;
  to?: DatePoint;
  /** 1-12. react-datepicker's month <select> stores this minus one. */
  month?: number;
  year?: number;
  error?: string;
}

/** Runs in the page. Self-contained so Playwright can serialize it. */
export function inspectDatePicker(spec: { startIso: string; endIso: string | null }): DatePickInspect {
  const startIso = spec.startIso;
  const endIso = spec.endIso;
  const names = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const parseIso = (iso: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!match) return null;
    return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  };
  const parseLabel = (text: string) => {
    const match = text.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
    if (!match) return null;
    const m = names.indexOf(match[1]!.toLowerCase()) + 1;
    if (!m) return null;
    return { y: Number(match[2]), m };
  };
  const center = (el: Element) => {
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  };
  const cmp = (a: { y: number; m: number }, b: { y: number; m: number }) => (a.y - b.y) || (a.m - b.m);
  const start = parseIso(startIso);
  if (!start) return { status: "error", error: "bad iso" };
  const end = endIso ? parseIso(endIso) : null;
  if (endIso && !end) return { status: "error", error: "bad end iso" };

  const rbc = document.querySelector(".rbc-calendar");
  const popup = document.querySelector(".react-datepicker");
  const fixture = document.querySelector("[data-bao-picker]");
  const root = (popup || rbc || fixture) as HTMLElement | null;
  if (!root) return { status: "error", error: "no date picker" };
  root.scrollIntoView({ block: "center", inline: "nearest" });
  const kind = popup ? "datepicker" : rbc ? "rbc" : "fixture";

  const labelEl = kind === "datepicker"
    ? root.querySelector(".react-datepicker__current-month")
    : kind === "rbc"
      ? root.querySelector(".rbc-toolbar-label")
      : root.querySelector("[data-month-label]");
  let visible = parseLabel(labelEl?.textContent || "");
  const monthSel = kind === "datepicker" ? root.querySelector(".react-datepicker__month-select") as HTMLSelectElement | null : null;
  const yearSel = kind === "datepicker" ? root.querySelector(".react-datepicker__year-select") as HTMLSelectElement | null : null;
  if (monthSel && yearSel && monthSel.value !== "" && yearSel.value !== "") {
    const fromSelect = { y: Number(yearSel.value), m: Number(monthSel.value) + 1 };
    if (fromSelect.m >= 1 && fromSelect.m <= 12 && fromSelect.y > 0) visible = fromSelect;
  }
  if (!visible) return { status: "error", kind, error: "picker month" };
  const target = end && cmp(end, start) !== 0 && cmp(end, visible) === 0 ? end : start;
  if (cmp(visible, target) !== 0) {
    if (monthSel && yearSel) return { status: "select", kind, month: target.m, year: target.y };
    const forward = cmp(visible, target) < 0;
    const nav = kind === "datepicker"
      ? root.querySelector(forward ? ".react-datepicker__navigation--next" : ".react-datepicker__navigation--previous")
      : kind === "rbc"
        ? [...root.querySelectorAll("button")].find((button) => (button.textContent || "").trim().toLowerCase() === (forward ? "next" : "back"))
        : root.querySelector(forward ? "[data-nav=next]" : "[data-nav=prev]");
    if (!nav) return { status: "error", kind, error: "picker nav" };
    const point = center(nav);
    return { status: "nav", kind, x: point.x, y: point.y };
  }

  if (kind === "rbc") {
    const cellFor = (day: number) => {
      const cells = [...root.querySelectorAll(".rbc-date-cell")];
      const cell = cells.find((el) => !el.classList.contains("rbc-off-range") && Number(el.textContent) === day);
      if (!cell) return null;
      const row = cell.closest(".rbc-month-row");
      if (!row) return null;
      const index = [...row.querySelectorAll(".rbc-date-cell")].indexOf(cell);
      return row.querySelectorAll(".rbc-day-bg")[index] || cell;
    };
    const startEl = cellFor(start.d);
    if (!startEl) return { status: "error", kind, error: "start cell" };
    if (end) {
      const endEl = cellFor(end.d);
      if (!endEl) return { status: "error", kind, error: "end cell" };
      return { status: "drag", kind, from: center(startEl), to: center(endEl) };
    }
    const point = center(startEl);
    return { status: "click", kind, x: point.x, y: point.y };
  }

  if (kind === "datepicker") {
    const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][start.m - 1];
    const ordinal = `${start.d}(?:st|nd|rd|th)?`;
    const want = new RegExp(`(?:\\b${start.d}\\s+${month}\\s+${start.y}\\b|\\b${month}\\s+${ordinal},?\\s+${start.y}\\b)`, "i");
    const days = [...root.querySelectorAll(".react-datepicker__day")];
    const day = days.find((el) => want.test(el.getAttribute("aria-label") || "") && !el.classList.contains("react-datepicker__day--outside-month"))
      || days.find((el) => want.test(el.getAttribute("aria-label") || ""));
    if (!day) return { status: "error", kind, error: "start cell" };
    const point = center(day);
    return { status: "click", kind, x: point.x, y: point.y };
  }

  const button = root.querySelector(`button[data-date="${startIso}"]`);
  if (!button) return { status: "error", kind, error: "start cell" };
  if (endIso) {
    const endButton = root.querySelector(`button[data-date="${endIso}"]`);
    if (!endButton) return { status: "error", kind, error: "end cell" };
    return { status: "drag", kind, from: center(button), to: center(endButton) };
  }
  const point = center(button);
  return { status: "click", kind, x: point.x, y: point.y };
}

/** Dates covered by the react-big-calendar "Selected" event, as ISO days in the visible month. */
export function readCalendarSelection(): { isos: string[]; reserve: boolean } {
  const names = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
  const root = document.querySelector(".rbc-calendar");
  const label = root?.querySelector(".rbc-toolbar-label")?.textContent || "";
  const match = label.trim().match(/^([A-Za-z]+)\s+(\d{4})$/);
  const month = match ? names.indexOf(match[1]!.toLowerCase()) + 1 : 0;
  const year = match ? Number(match[2]) : 0;
  const isos: string[] = [];
  if (root && month) {
    for (const row of root.querySelectorAll(".rbc-month-row")) {
      const cells = [...row.querySelectorAll(".rbc-date-cell")].map((el) => ({
        day: Number(el.textContent),
        off: el.classList.contains("rbc-off-range"),
      }));
      const segments = [...row.querySelectorAll(".rbc-row-segment")];
      const eventRow = segments.some((seg) => seg.querySelector(".rbc-event"));
      if (!eventRow) continue;
      let cursor = 0;
      for (const seg of segments) {
        const basis = Number.parseFloat((seg as HTMLElement).style.flexBasis || "0");
        const span = Math.round((basis / 100) * 7) || 0;
        const hit = !!seg.querySelector(".rbc-event");
        for (let i = 0; i < span; i++) {
          const cell = cells[cursor + i];
          if (hit && cell && !cell.off) {
            const m = String(month).padStart(2, "0");
            const d = String(cell.day).padStart(2, "0");
            isos.push(`${year}-${m}-${d}`);
          }
        }
        cursor += span;
      }
    }
  }
  const reserve = [...document.querySelectorAll("button")].some((button) => /reserve/i.test(button.textContent || ""));
  return { isos, reserve };
}
